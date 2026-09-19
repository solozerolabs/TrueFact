// The live measurement harness, proven hermetically (no internet). The pure
// oracle decides truth from captured reads; the injector + verdict path runs a
// real Chrome against a local optimistic page, mirroring scripts/probe-inject.mjs.
// The live campaign itself (scripts/live/run.mjs against real sites) records and
// never asserts — only the harness LOGIC is pinned here. See the spec §6.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer, type Server } from "node:http";
import { localBrowser } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import { withTrueFact } from "../src/index.js";
import { playwrightDriver } from "../src/driver-playwright.js";
import { cdpConnect } from "../src/cdp.js";
// The harness modules depend on nothing in src/dist (arm takes a conn; the oracle
// is pure), so the test drives the exact code the runner ships.
import { arm } from "../scripts/live/inject.mjs";
import { decide, evalGet } from "../scripts/live/oracle.mjs";

const freePort = (): Promise<number> => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

describe("live oracle (pure)", () => {
  it("evalGet: status / text / absent / unreadable", () => {
    assert.equal(evalGet({ status: 200 }, { status: 200, text: "" }), true);
    assert.equal(evalGet({ status: 200 }, { status: 404, text: "" }), false);
    assert.equal(evalGet({ text: "tf-1" }, { status: 200, text: "hi tf-1 there" }), true);
    assert.equal(evalGet({ text: "tf-1" }, { status: 200, text: "gone" }), false); // sentinel absent ⇒ did-not-land
    assert.equal(evalGet({ status: 200 }, null), "unknown");
  });
  it("decide: injected is did-not-land iff confirmed", () => {
    assert.equal(decide({ kind: "injected" }, { injectorConfirmed: true }), false);
    assert.equal(decide({ kind: "injected" }, { injectorConfirmed: false }), "unknown");
  });
  it("decide: contract is its declared landing", () => {
    assert.equal(decide({ kind: "contract", landed: false }), false);
    assert.equal(decide({ kind: "contract", landed: true }), true);
  });
  it("decide: get needs two agreeing reads, else unknown", () => {
    const o = { kind: "get", url: "x", landedIf: { status: 200 } };
    assert.equal(decide(o, { get: [{ status: 200, text: "" }, { status: 200, text: "" }] }), true);
    assert.equal(decide(o, { get: [{ status: 404, text: "" }, { status: 404, text: "" }] }), false);
    assert.equal(decide(o, { get: [{ status: 200, text: "" }, { status: 404, text: "" }] }), "unknown"); // disagree
    assert.equal(decide(o, { get: [null, { status: 200, text: "" }] }), "unknown"); // unreadable
  });
});

describe("live injector + verdict (real Chrome, local optimistic page)", () => {
  let server: Server, base = "", chrome: Awaited<ReturnType<typeof localBrowser.launch>>, page: Page, port = 0;
  let postHits = 0, getHits = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/save" && req.method === "POST") { postHits++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
      if (req.url === "/save" && req.method === "GET") { getHits++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"read":true}'); }
      res.writeHead(200, { "content-type": "text/html" });
      // Optimistic: a GET read then a POST write, banner shown regardless.
      res.end(`<!doctype html><meta charset=utf8><title>Profile</title><h1>Profile</h1><button id=save type=button>Save</button><p id=ok role=status></p>
<script>document.getElementById('save').onclick=async()=>{try{await fetch('/save',{method:'GET'});}catch(e){}fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});document.getElementById('ok').textContent='✅ Saved successfully';};</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    port = await freePort();
    chrome = await localBrowser.launch({ headless: true, port });
    const { chromium } = await import("playwright-core");
    const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = cdp.contexts()[0].pages()[0] ?? (await cdp.contexts()[0].newPage());
  });
  after(async () => { await chrome?.close(); server?.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); });

  const drive = async (mode: string | null, opts: { bodyErrors?: boolean; urlPattern?: string } = {}) => {
    postHits = 0; getHits = 0;
    const w = withTrueFact(playwrightDriver(page), { network: { port, bodyErrors: opts.bodyErrors }, screenshots: false, waitMs: 1500 });
    await w.page.goto(base + "/");
    let injector;
    if (mode) { const conn = await cdpConnect(port); injector = await arm(conn!, { urlPattern: opts.urlPattern ?? "*/save", mode }); (injector as { _conn?: unknown })._conn = conn; }
    const res = await w.act({ selector: "#save", method: "click" });
    await new Promise((r) => setTimeout(r, 250));
    const confirmed = injector?.confirmed();
    const paused = injector?.paused();
    await injector?.disarm();
    (injector as { _conn?: { close(): void } })?._conn?.close();
    await w.close();
    return { verdict: res.truefact.verdict, reason: res.truefact.reason, confirmed, paused, postHits, getHits };
  };

  it("control: no injection → landed, the server received the write", async () => {
    const r = await drive(null);
    assert.equal(r.verdict, "landed");
    assert.equal(r.postHits, 1);
  });
  it("status:500 → did-not-land/network-error, server never got the write, confirmed", async () => {
    const r = await drive("status:500");
    assert.equal(r.verdict, "did-not-land");
    assert.equal(r.reason, "network-error");
    assert.equal(r.postHits, 0);
    assert.equal(r.confirmed, true);
  });
  it("wire (dropped write) → did-not-land, server never got it", async () => {
    const r = await drive("wire");
    assert.equal(r.verdict, "did-not-land");
    assert.equal(r.postHits, 0);
    assert.equal(r.confirmed, true);
  });
  it("body-lie (200 + errors[]) with bodyErrors on → did-not-land", async () => {
    const r = await drive("body-lie", { bodyErrors: true });
    assert.equal(r.verdict, "did-not-land");
    assert.equal(r.postHits, 0);
  });
  it("only the mutating request is counted — the page's GET /save is passed through", async () => {
    const r = await drive("status:500");
    assert.equal(r.paused, 1); // the POST only; the GET to the same URL was continued
    assert.equal(r.getHits, 1); // and reached the server
  });
  it("a pattern that never matches → not confirmed, the write lands (trial is discarded, not scored)", async () => {
    const r = await drive("status:500", { urlPattern: "*/nonexistent-endpoint*" });
    assert.equal(r.confirmed, false);
    assert.equal(r.paused, 0);
    assert.equal(r.postHits, 1); // the real write went through untouched
    assert.equal(r.verdict, "landed");
    assert.equal(decide({ kind: "injected" }, { injectorConfirmed: r.confirmed }), "unknown"); // ⇒ dropped by the scorer
  });
});
