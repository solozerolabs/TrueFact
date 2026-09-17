import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { classify, captureState } from "../src/postcondition.js";
import { withReplay } from "../src/index.js";
import { serve, state, form, fakeStagehand, type Fixture } from "./helpers.js";

// ---------------------------------------------------------------------------
// Unit: classify() is pure — no browser. One `it` per §4 row + ordering.
// ---------------------------------------------------------------------------
describe("classify (pure §4 rows)", () => {
  const base = state({ fp: { href: "http://x/a", readyState: "complete", bodyTextLength: 0, elementCount: 0, title: "" } });

  it("row 1: a new tab -> landed / new-page", () => {
    const c = classify(base, base, true);
    assert.equal(c.verdict, "landed");
    assert.equal(c.post.reason, "new-page");
  });
  it("row 2: a path change -> landed / navigated", () => {
    const c = classify(base, state({ fp: { ...base.fp, href: "http://x/b" } }), false);
    assert.equal(c.verdict, "landed");
    assert.equal(c.post.reason, "navigated");
  });
  it("row 3: :user-invalid rose -> did-not-land / validation-error (empty tree diff)", () => {
    const c = classify(base, state({ userInvalidCount: 1 }), false);
    assert.equal(c.verdict, "did-not-land");
    assert.equal(c.post.reason, "validation-error");
  });
  it("row 4: alert + error text -> did-not-land / validation-error", () => {
    const c = classify(base, state({ tree: ["alert", "StaticText: Email is required"] }), false);
    assert.equal(c.verdict, "did-not-land");
    assert.equal(c.post.reason, "validation-error");
  });
  it("row 5: error text with no role -> inconclusive / error-text", () => {
    const c = classify(base, state({ tree: ["StaticText: Something failed"] }), false);
    assert.equal(c.verdict, "inconclusive");
    assert.equal(c.post.reason, "error-text");
  });
  it("row 6: dialog + buttons -> inconclusive / prompt (beats confirmation)", () => {
    const c = classify(base, state({ tree: ["dialog", "StaticText: Confirm your order?", "button: Confirm", "button: Cancel"] }), false);
    assert.equal(c.verdict, "inconclusive");
    assert.equal(c.post.reason, "prompt");
  });
  it("row 7: status role -> landed / confirmation", () => {
    const c = classify(base, state({ tree: ["status", "StaticText: Order placed"] }), false);
    assert.equal(c.verdict, "landed");
    assert.equal(c.post.reason, "confirmation");
  });
  it("row 8: form cleared -> landed / form-cleared", () => {
    const b = state({ forms: { email: form("a@b.co") } });
    const c = classify(b, state({ forms: { email: form("") } }), false);
    assert.equal(c.verdict, "landed");
    assert.equal(c.post.reason, "form-cleared");
  });
  it("row 9: hash-only change, nothing else -> inconclusive / hash-only-nav", () => {
    const c = classify(base, state({ fp: { ...base.fp, href: "http://x/a#done" } }), false);
    assert.equal(c.verdict, "inconclusive");
    assert.equal(c.post.reason, "hash-only-nav");
  });
  it("row 10: unclassified change -> inconclusive / changed-unclassified", () => {
    const c = classify(base, state({ tree: ["menu", "menuitem: Copy"] }), false);
    assert.equal(c.verdict, "inconclusive");
    assert.equal(c.post.reason, "changed-unclassified");
  });
  it("row 11: nothing changed -> did-not-land / no-change", () => {
    const c = classify(base, base, false);
    assert.equal(c.verdict, "did-not-land");
    assert.equal(c.post.reason, "no-change");
  });
  it("ordering: navigation beats a stale validation flag", () => {
    const c = classify(base, state({ fp: { ...base.fp, href: "http://x/b" }, userInvalidCount: 1 }), false);
    assert.equal(c.post.reason, "navigated");
  });
  it("ordering: an alert-error beats confirmation text on the same page", () => {
    const c = classify(base, state({ tree: ["alert", "StaticText: invalid — order not placed"] }), false);
    assert.equal(c.post.reason, "validation-error");
  });
});

// ---------------------------------------------------------------------------
// Integration: real browser, real clicks, fake LLM. Exercises the whole run().
// ---------------------------------------------------------------------------
describe("withReplay: postcondition end to end", () => {
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  let stagehand: Stagehand;
  let fx: Fixture;

  // Always operate on the CURRENTLY active tab: activePage() returns a fresh
  // wrapper each call, and earlier tests may have opened a new tab.
  const cur = async () => (await stagehand.browser.context.activePage())!;
  const load = async (html: string) => (await cur()).goto("data:text/html," + encodeURIComponent(html));
  // act via a fake that performs the real action on the active tab, read the step back
  const runAct = async (spec: Parameters<typeof fakeStagehand>[2], budget = 1200) => {
    const { act, replay } = withReplay(fakeStagehand(stagehand, await cur(), spec), {
      postconditionWaitMs: budget,
      screenshots: false,
    });
    await act("do it");
    return replay.steps.at(-1)!;
  };

  before(async () => {
    browser = await localBrowser.launch({ headless: true });
    stagehand = await Stagehand.create({ browser, logging: { level: "error" } });
    fx = await serve({
      "/anchor": `<html><head><title>Anchor</title></head><body><main><a id="dead" href="#x">dead</a></main></body></html>`,
      "/checkout": `<html><head><title>Checkout</title></head><body><main><form id="f" onsubmit="event.preventDefault();document.body.insertAdjacentHTML('beforeend','<p role=status>Order placed</p>')">
        <input name="email" required><button id="s" type="submit">Place order</button></form></main></body></html>`,
      "/done": `<html><head><title>Done</title></head><body><main><h1>done</h1></main></body></html>`,
      "/tab2": `<html><head><title>Tab2</title></head><body><main><h1>tab2</h1></main></body></html>`,
      "/login": { status: 401, html: `<html><head><title>Sign in</title></head><body><main><form><input type="password" autocomplete="current-password"></form></main></body></html>` },
      "/redirect": `<html><body><main><form onsubmit="event.preventDefault();setTimeout(()=>location.href='/login',400)"><button id="s" type="submit">Save</button></form></main></body></html>`,
    });
  });
  after(async () => {
    await browser.close(); // frees sockets to the fixture server first
    await fx.close();
  });

  it("required field blocks submit -> did-not-land / validation-error, resolved fast", async () => {
    await (await cur()).goto(fx.base + "/checkout");
    const t = Date.now();
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "validation-error");
    assert.ok(Date.now() - t < 1000, "should not wait the full budget");
  });

  it("submit that reveals a confirmation -> landed / confirmation", async () => {
    const p = await cur();
    await p.goto(fx.base + "/checkout");
    await p.locator("[name=email]").fill("a@b.co");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "confirmation");
  });

  it("agent claims success:false but the page confirms -> landed (ignores agent_claim)", async () => {
    const p = await cur();
    await p.goto(fx.base + "/checkout");
    await p.locator("[name=email]").fill("a@b.co");
    const s = await runAct({ selector: "#s", method: "click", success: false, message: "I could not click it" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.agent_claim?.success, false); // recorded on its own channel
  });

  it("a real navigation -> landed / navigated", async () => {
    await load('<html><body><main><a id="go" href="' + fx.base + '/done">go</a></main></body></html>');
    const s = await runAct({ selector: "#go", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "navigated");
  });

  it("a href='#x' anchor that lands nothing -> inconclusive / hash-only-nav", async () => {
    await (await cur()).goto(fx.base + "/anchor");
    const s = await runAct({ selector: "#dead", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "hash-only-nav");
  });

  it("submit that redirects into a 401 login wall -> inconclusive, navigated + login-wall", async () => {
    await (await cur()).goto(fx.base + "/redirect");
    const s = await runAct({ selector: "#s", method: "click" }, 2000);
    assert.equal(s.verdict, "inconclusive"); // destination gate demoted the navigation
    assert.equal(s.evidence.postcondition?.reason, "navigated");
    assert.equal(s.evidence.session.obstruction, "login-wall");
  });

  it("a new tab -> landed / new-page with newPageUrl", async () => {
    await load('<html><body><main><a id="ext" href="' + fx.base + '/tab2" target="_blank">open</a></main></body></html>');
    const s = await runAct({ selector: "#ext", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "new-page");
    assert.match(s.evidence.postcondition?.newPageUrl ?? "", /\/tab2$/);
  });

  it("cookie overlay swallows the click -> did-not-land / no-change", async () => {
    await load('<html><body><main><button id="s">Buy</button></main><div id="cookie" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5)"></div></body></html>');
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "no-change");
    assert.equal(s.evidence.session.obstruction, "overlay"); // recorded alongside
  });

  it("field fill that holds -> landed / field-match", async () => {
    await load('<html><body><main><input id="e" name="email"></main></body></html>');
    const s = await runAct({ selector: "#e", method: "fill", args: ["a@b.co"] });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "field-match");
    assert.equal(s.evidence.postcondition?.field?.actual, "a@b.co");
  });

  it("field fill the page rewrites to empty -> did-not-land / field-mismatch", async () => {
    await load('<html><body><main><input id="e" name="email" oninput="this.value=\'\'"></main></body></html>');
    const s = await runAct({ selector: "#e", method: "fill", args: ["a@b.co"] });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "field-mismatch");
  });

  it("password fill is redacted in attempt and field, never stored plain", async () => {
    await load('<html><body><main><input id="p" name="pw" type="password"></main></body></html>');
    const s = await runAct({ selector: "#p", method: "fill", args: ["hunter2secret"] });
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes("hunter2secret"), "raw password must not appear anywhere on the step");
    assert.equal(s.attempt?.[0].arguments?.[0], "<redacted:13>");
    assert.equal(s.evidence.postcondition?.field?.expected, "<redacted:13>");
  });

  it("a scroll act is reclassified to a read, out of the write roll-up", async () => {
    await load('<html><body><main style="height:3000px"><button id="s">x</button></main></body></html>');
    const { act, replay } = withReplay(fakeStagehand(stagehand, await cur(), { selector: "#s", method: "scroll" }), { screenshots: false });
    await act("scroll down");
    const s = replay.steps.at(-1)!;
    assert.equal(s.kind, "read");
    assert.equal(s.evidence.postcondition?.reason, "non-mutating");
    assert.equal(replay.verdict, "inconclusive"); // no write steps
  });

  it("a prompt dialog -> inconclusive / prompt, not confirmation", async () => {
    await load(`<html><body><main><button id="s">Delete</button><dialog id="d">Confirm delete? <button>Confirm</button><button>Cancel</button></dialog>
      <script>document.getElementById('s').onclick=()=>document.getElementById('d').showModal()</script></main></body></html>`);
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "prompt");
  });

  it("slow confirmation past the settle window -> landed via the extended poll", async () => {
    await load(`<html><body><main><button id="s">Save</button>
      <script>document.getElementById('s').onclick=()=>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p role=status>Saved</p>'),700)</script></main></body></html>`);
    const s = await runAct({ selector: "#s", method: "click" }, 4000);
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "confirmation");
  });
});
