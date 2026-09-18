// M2 — the CDP network sidecar. A second, independent CDP client on the same
// Chrome sees the response Stagehand v4 cannot: the POST 500 behind an
// optimistic ✅. The page-read verdict is fooled (confirmation → landed); the
// network signal overrides it to did-not-land. And a THIRD-PARTY 500 must NOT
// fire it — same-origin filtering is the cry-wolf guard. Real browser, no LLM.
import { createServer, type Server } from "node:http";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../src/index.js";
import { applyNetwork } from "../src/postcondition.js";
import { verifyChain } from "../src/chain.js";
import { fakeStagehand } from "./helpers.js";

// A page that posts to `postUrl` on click, then shows ✅ regardless (optimistic).
const html = (postUrl: string) =>
  `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1>
   <button id=place>Place order</button><p id=ok></p>
   <script>document.getElementById('place').onclick=async()=>{
     try{await fetch(${JSON.stringify(postUrl)},{method:'POST',keepalive:true});}catch(e){}
     document.getElementById('ok').textContent='✅ Order placed — #4242';};</script>`;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const shut = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

describe("applyNetwork (pure): same-origin server error demotes, never lifts", () => {
  it("landed + a 5xx → did-not-land / network-error / high", () => {
    const o = applyNetwork("landed", [{ url: "http://x/submit", status: 500 }]);
    assert.deepEqual(o, { verdict: "did-not-land", reason: "network-error", confidence: "high" });
  });
  it("landed + no errors → null (nothing to say)", () => assert.equal(applyNetwork("landed", []), null));
  it("did-not-land is left alone → null (keeps its own mechanism reason)", () =>
    assert.equal(applyNetwork("did-not-land", [{ url: "http://x/submit", status: null }]), null));
  it("inconclusive + a failed request → did-not-land", () =>
    assert.equal(applyNetwork("inconclusive", [{ url: "http://x/s", status: null }])?.verdict, "did-not-land"));
});

describe("network sidecar: optimistic UI caught out-of-band", () => {
  const PORT = 9413;
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  let sh: Stagehand;
  let app: Server;
  let third: Server;
  let base = "";
  let thirdBase = "";

  before(async () => {
    // A real cross-origin write API sets CORS headers (its own app must read
    // the response), so a 500 arrives as responseReceived(500), not a wire fail.
    third = createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      return req.url === "/boom" ? res.writeHead(500).end("x") : res.writeHead(404).end();
    });
    thirdBase = await listen(third);
    app = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/submit") return res.writeHead(500).end("upstream exploded");
      if (req.method === "POST" && req.url === "/declined") return res.writeHead(402, { "content-type": "application/json" }).end('{"error":"card declined"}');
      if (req.method === "POST" && req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.url === "/optimistic") return res.writeHead(200, { "content-type": "text/html" }).end(html("/submit"));
      if (req.url === "/declined-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(html("/declined"));
      if (req.url === "/clean") return res.writeHead(200, { "content-type": "text/html" }).end(html("/ok"));
      if (req.url === "/thirdparty") return res.writeHead(200, { "content-type": "text/html" }).end(html(`${thirdBase}/boom`));
      return res.writeHead(404).end("no");
    });
    base = await listen(app);
    browser = await localBrowser.launch({ headless: true, port: PORT });
    sh = await Stagehand.create({ browser, logging: { level: "error" } });
  });
  after(async () => {
    await browser?.close();
    await shut(app);
    await shut(third);
  });

  const run = async (route: "optimistic" | "declined-checkout" | "clean" | "thirdparty", apiOrigins?: string[]) => {
    const page = (await sh.browser.context.activePage())!;
    const fake = fakeStagehand(sh, page, { actions: [{ selector: "#place" }] });
    const w = withTrueFact(fake, { network: { port: PORT, apiOrigins }, screenshots: false, waitMs: 600 });
    await w.page.goto(`${base}/${route}`);
    await w.act("place the order");
    await w.close();
    return w.replay.steps.at(-1)!;
  };

  it("optimistic: page shows ✅ but /submit 500'd — network forces did-not-land", async () => {
    const step = await run("optimistic");
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
    assert.equal(step.evidence.postcondition?.network?.errors[0]?.status, 500);
  });

  it("declined: page shows ✅ but the POST returned 402 — 4xx on a write demotes to did-not-land", async () => {
    const step = await run("declined-checkout");
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
    assert.equal(step.evidence.postcondition?.network?.errors[0]?.status, 402);
  });

  it("cry-wolf guard: a 4xx on a GET (the fixture's 404 for /favicon.ico etc.) never demotes — proven by the clean run staying landed", async () => {
    // /clean POSTs to /ok (200); the browser also GETs the page + any 404s.
    // If 4xx-on-GET demoted, this would flip. It must stay landed.
    const step = await run("clean");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("clean: same click, /ok 200 — the page-read verdict stands, no network demotion", async () => {
    const step = await run("clean");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("the real writer emits a tamper-evident chain (M1): verifyChain over an actual run passes", async () => {
    const page = (await sh.browser.context.activePage())!;
    const fake = fakeStagehand(sh, page, { actions: [{ selector: "#place" }] });
    const w = withTrueFact(fake, { screenshots: false, waitMs: 400 });
    await w.page.goto(`${base}/clean`);
    await w.act("place the order");
    await w.act("place the order");
    await w.close();
    assert.ok(w.replay.steps.length >= 2);
    assert.equal(verifyChain(w.replay.steps).ok, true);
  });

  it("third-party 500: an analytics-shaped cross-origin error does NOT halt (cry-wolf guard)", async () => {
    const step = await run("thirdparty");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("apiOrigins: a declared cross-origin write host DOES demote — the split-origin fix (app -> api.host)", async () => {
    // Same cross-origin 500 as the cry-wolf test above, but now the caller
    // names that origin as its write API. It must flip to did-not-land, while
    // the default (previous test) leaves it landed — the guard stays opt-in.
    const step = await run("thirdparty", [thirdBase]);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
    assert.equal(step.evidence.postcondition?.network?.errors[0]?.status, 500);
  });
});
