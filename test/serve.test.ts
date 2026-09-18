// `truefact serve` + the CDP driver — hermetic, keyless. A playwright-core
// Chromium is launched with --remote-debugging-port (the caller-owns-the-browser
// shape Syndai's Python patchright bridge uses); the test performs the actions
// itself via Playwright, exactly as an external client would, and only the
// before/after bracket goes through serve. Asserts: a click that lands
// (role=status confirmation) reads landed; a submit whose POST 500s reads
// did-not-land via the network sidecar even though the page shows ✅; a fill is
// field-verified; the chain verifies; a second `before` while parked is refused.
import { createServer, type Server } from "node:http";
import { createServer as createNet } from "node:net";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServe, type ServeSession } from "../src/serve.js";
import { verifyChain } from "../src/chain.js";
import type { Step } from "../src/index.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNet();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const page = (body: string) => `<!doctype html><meta charset=utf8><title>t</title>${body}`;

describe("truefact serve: DOM+network bracket over raw CDP for a caller-owned browser", () => {
  let browser: { newContext(): Promise<{ newPage(): Promise<PwPage> }>; close(): Promise<void> };
  let pw: PwPage;
  let app: Server;
  let base = "";
  let port = 0;
  let serve: ServeSession;
  const steps: Step[] = [];

  interface PwPage {
    goto(u: string): Promise<unknown>;
    click(sel: string): Promise<void>;
    fill(sel: string, v: string): Promise<void>;
  }

  before(async () => {
    app = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/order") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"error":"boom"}');
      }
      const routes: Record<string, string> = {
        "/ok": page(`<button id=go>Go</button><script>go.onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);}</script>`),
        "/optimistic": page(`<button id=buy>Buy</button><script>buy.onclick=async()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Order placed!';document.body.appendChild(p);await fetch('/order',{method:'POST'});}</script>`),
        "/form": page(`<label>City <input name=city></label>`),
      };
      const html = routes[req.url ?? ""];
      res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
      res.end(html ?? "nope");
    });
    base = await new Promise<string>((r) => app.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(app.address() as { port: number }).port}`)));

    port = await freePort();
    const { chromium } = (await import("playwright-core")) as unknown as {
      chromium: { launch(o: { headless: boolean; args: string[] }): Promise<typeof browser> };
    };
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    pw = await (await browser.newContext()).newPage();
    await pw.goto("about:blank"); // a page target must exist before serve attaches
    const s = await startServe({ port, waitMs: 400 });
    assert.ok(s, "serve must attach to the caller-owned Chrome by port");
    serve = s;
  });
  after(async () => {
    await serve?.close();
    await browser?.close();
    app.closeAllConnections?.();
    await new Promise<void>((r) => app.close(() => r()));
  });

  // The client protocol: before → (client acts) → after → step.
  async function bracket(kind: "write" | "nav", body: Record<string, unknown>, perform: () => Promise<unknown>): Promise<Step> {
    const id = steps.length + 1;
    const b = await serve.handle({ id, op: "before", kind, ...body } as never);
    assert.equal(b.ok, true, JSON.stringify(b));
    let threw: string | undefined;
    try {
      await perform();
    } catch (e) {
      threw = String(e);
    }
    const a = await serve.handle({ id, op: "after", ...(threw ? { threw } : {}) });
    assert.equal(a.ok, true, JSON.stringify(a));
    const step = (a as { step?: Step }).step!;
    // The recovery contract rides on the serve reply too (the one integration
    // that reads it), so a caller can gate an auto-retry without the full step.
    assert.equal(typeof (a as { retryable?: boolean }).retryable, "boolean", "serve reply carries retryable");
    steps.push(step);
    return step;
  }

  it("nav + a landed click: role=status confirmation read over CDP", async () => {
    const nav = await bracket("nav", { url: `${base}/ok` }, () => pw.goto(`${base}/ok`));
    assert.equal(nav.kind, "nav");
    const step = await bracket("write", { action: { selector: "#go", method: "click" } }, () => pw.click("#go"));
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "landed");
    assert.equal(step.agent_claim, null); // no self-report on this channel, ever
  });

  it("optimistic UI: page shows ✅ but the POST 500s → did-not-land via the network sidecar", async () => {
    await bracket("nav", { url: `${base}/optimistic` }, () => pw.goto(`${base}/optimistic`));
    const step = await bracket("write", { action: { selector: "#buy", method: "click" } }, async () => {
      await pw.click("#buy");
      await new Promise((r) => setTimeout(r, 300)); // let the POST finish
    });
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
  });

  it("a fill is field-verified against the targeted input", async () => {
    await bracket("nav", { url: `${base}/form` }, () => pw.goto(`${base}/form`));
    // a non-secret value: emails/keys are length-masked by the redactor (by design)
    const step = await bracket("write", { action: { selector: "[name=city]", method: "fill", arguments: ["Lisbon"] } }, () => pw.fill("[name=city]", "Lisbon"));
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.field?.actual, "Lisbon");
  });

  it("the recorded steps form a valid chain; a nested before is refused", async () => {
    assert.equal(verifyChain(steps as never).ok, true);
    const b = await serve.handle({ id: 99, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
    assert.equal(b.ok, true);
    const dup = await serve.handle({ id: 100, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
    assert.equal(dup.ok, false);
    await serve.handle({ id: 99, op: "after" });
  });

  it("a before with an invalid declaration fails fast (ok:false), never deadlocks", async () => {
    await bracket("nav", { url: `${base}/ok` }, () => pw.goto(`${base}/ok`));
    // a vacuous probe (no matcher) throws in run() BEFORE the before-state parks.
    const r = await serve.handle({ id: 500, op: "before", kind: "write", action: { selector: "#go", method: "click" }, expect: [{ kind: "probe", get: "/x" }] } as never);
    assert.equal(r.ok, false);
    // the pipeline is not stuck: a normal bracket still works afterwards.
    const ok = await bracket("write", { action: { selector: "#go", method: "click" } }, () => pw.click("#go"));
    assert.equal(ok.verdict, "landed");
  });

  it("an unknown op is rejected, not treated as after", async () => {
    const r = await serve.handle({ id: 600, op: "sideways" } as never);
    assert.equal(r.ok, false);
  });
});
