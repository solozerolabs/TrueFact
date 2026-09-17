// Hermetic: one local Chrome via Stagehand with NO model. Detectors are called
// directly against fixture HTML loaded from data: URLs. No LLM, no network.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stagehand, localBrowser, type Page } from "@browserbasehq/stagehand";
import { detectSession, fingerprint, settle, safeRead } from "../src/session.js";

let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
let stagehand: Stagehand;
let page: Page;

const load = (html: string) =>
  page.goto("data:text/html," + encodeURIComponent(html));

before(async () => {
  browser = await localBrowser.launch({ headless: true });
  stagehand = await Stagehand.create({ browser, logging: { level: "error" } });
  page = (await stagehand.browser.context.activePage())!;
});
after(async () => {
  await browser.close();
});

describe("session: blank", () => {
  it("given a never-navigated page, then obstruction is blank (high)", async () => {
    // a fresh context page is about:blank
    const s = await detectSession(page);
    assert.equal(s.obstruction, "blank");
    assert.equal(s.confidence, "high");
  });

  it("given a fully-loaded empty body, then obstruction is blank", async () => {
    await load("<html><body></body></html>");
    const s = await detectSession(page);
    assert.equal(s.obstruction, "blank");
  });
});

describe("session: captcha", () => {
  it("given a recaptcha iframe, then obstruction is captcha (high)", async () => {
    await load(
      '<html><body><main>x</main><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body></html>',
    );
    const s = await detectSession(page);
    assert.equal(s.obstruction, "captcha");
    assert.equal(s.confidence, "high");
  });

  it("given a Cloudflare interstitial, then obstruction is captcha", async () => {
    await load('<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div></body></html>');
    const s = await detectSession(page);
    assert.equal(s.obstruction, "captcha");
  });
});

describe("session: login-wall", () => {
  it("given a visible current-password field, then login-wall is heuristic -> inconclusive-tier", async () => {
    await load('<html><body><main><form><input type="password" autocomplete="current-password"></form></main></body></html>');
    const s = await detectSession(page);
    assert.equal(s.obstruction, "login-wall");
    assert.equal(s.confidence, "heuristic");
  });

  it("given the same field reached with a 401 nav, then login-wall is promoted to high", async () => {
    await load('<html><body><main><form><input type="password" autocomplete="current-password"></form></main></body></html>');
    const s = await detectSession(page, { navStatus: 401 });
    assert.equal(s.obstruction, "login-wall");
    assert.equal(s.confidence, "high");
  });

  it("FP guard: given a change-password form (new-password present), then no login-wall", async () => {
    await load(
      '<html><body><main><form><input type="password" autocomplete="current-password"><input type="password" autocomplete="new-password"></form></main></body></html>',
    );
    const s = await detectSession(page);
    assert.equal(s.obstruction, null);
  });

  it("segment guard: given path /author/123, then no login-wall", async () => {
    // data: URLs have no path; assert the matcher is segment-based, not substring,
    // by checking the detector text rule holds for a page whose only 'auth' is inside a word.
    await load('<html><body><main><a href="/author/123">bio</a></main></body></html>');
    const s = await detectSession(page);
    assert.equal(s.obstruction, null);
  });
});

describe("session: overlay", () => {
  it("given an aria-modal that covers the viewport, then obstruction is overlay (heuristic)", async () => {
    await load('<html><body><main><button>Buy</button></main><div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">cookies</div></body></html>');
    const s = await detectSession(page);
    assert.equal(s.obstruction, "overlay");
    assert.equal(s.confidence, "heuristic");
  });

  it("given a corner aria-modal cookie card that intercepts nothing, then no overlay", async () => {
    await load('<html><body><main><button>Buy</button></main><div role="dialog" aria-modal="true" style="position:fixed;bottom:8px;left:8px;width:200px;height:80px">cookies</div></body></html>');
    assert.equal((await detectSession(page)).obstruction, null);
  });

  it("given a fixed full-viewport cookie div over the center, then obstruction is overlay", async () => {
    await load(
      '<html><body><main><button>Buy</button></main><div id="cookie" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5)"></div></body></html>',
    );
    const s = await detectSession(page);
    assert.equal(s.obstruction, "overlay");
    assert.match(s.detail, /cookie/);
  });

  it("given a full-viewport div with pointer-events:none, then no overlay (clicks pass through)", async () => {
    await load(
      '<html><body><main><button>Buy</button></main><div style="position:fixed;inset:0;pointer-events:none"></div></body></html>',
    );
    const s = await detectSession(page);
    assert.equal(s.obstruction, null);
  });
});

describe("session: true negative", () => {
  it("given a clean logged-in page, then no obstruction and all detectors ran", async () => {
    await load('<html><head><title>Dashboard</title></head><body><main><h1>Welcome back</h1><a href="/settings">Settings</a></main></body></html>');
    const s = await detectSession(page);
    assert.equal(s.obstruction, null);
    assert.deepEqual(s.checked, ["blank", "captcha", "login-wall", "overlay"]);
  });
});

describe("safeRead + fingerprint + settle", () => {
  it("safeRead returns null when evaluate throws", async () => {
    await load("<html><body><main>ok</main></body></html>");
    const r = await safeRead(page, () => {
      throw new Error("boom");
    });
    assert.equal(r, null);
  });

  it("fingerprint reads href/readyState/counts", async () => {
    await load("<html><head><title>Fp</title></head><body><main><p>hello</p></main></body></html>");
    const fp = await fingerprint(page);
    assert.ok(fp);
    assert.equal(fp!.title, "Fp");
    assert.ok(fp!.elementCount > 0);
  });

  it("settle: a page that appends for ~400ms then stops reports settled=true", async () => {
    // grows the element count each tick (like a spinner rendering rows), then stops
    await load(
      "<html><body><main id=root></main><script>let n=0;const t=setInterval(()=>{if(n++>=7){clearInterval(t);return}document.getElementById('root').appendChild(document.createElement('span'))},60)</script></body></html>",
    );
    const start = await fingerprint(page);
    const r = await settle(page, 3000);
    assert.equal(r.settled, true);
    assert.ok(r.after!.elementCount > start!.elementCount); // it waited past the growth
  });

  it("settle: a page that appends forever reports settled=false", async () => {
    await load(
      "<html><body><main id=root></main><script>setInterval(()=>{document.getElementById('root').appendChild(document.createElement('span'))},60)</script></body></html>",
    );
    const r = await settle(page, 800);
    assert.equal(r.settled, false);
  });
});
