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
    let flaky = 0;
    app = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/submit") return res.writeHead(500).end("upstream exploded");
      if (req.method === "POST" && req.url === "/declined") return res.writeHead(402, { "content-type": "application/json" }).end('{"error":"card declined"}');
      if (req.method === "POST" && req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.method === "POST" && req.url === "/gql-err") return res.writeHead(200, { "content-type": "application/json" }).end('{"data":null,"errors":[{"message":"mutation rejected"}]}');
      if (req.method === "POST" && req.url === "/flaky") return res.writeHead(flaky++ === 0 ? 500 : 200, { "content-type": "application/json" }).end("{}");
      // 200, then the body load is canceled (navigation/beacon shape): send a
      // content-length longer than the bytes, then destroy the socket.
      if (req.method === "POST" && req.url === "/truncate") { res.writeHead(200, { "content-type": "application/json", "content-length": "100" }); res.write("{}"); setTimeout(() => res.socket?.destroy(), 120); return; }
      if (req.url === "/optimistic") return res.writeHead(200, { "content-type": "text/html" }).end(html("/submit"));
      if (req.url === "/declined-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(html("/declined"));
      if (req.url === "/clean") return res.writeHead(200, { "content-type": "text/html" }).end(html("/ok"));
      if (req.url === "/gql") return res.writeHead(200, { "content-type": "text/html" }).end(html("/gql-err"));
      if (req.url === "/thirdparty") return res.writeHead(200, { "content-type": "text/html" }).end(html(`${thirdBase}/boom`));
      if (req.url === "/truncate-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(html("/truncate"));
      // clicks POST /flaky twice: 500 then 200 (a retry that recovers).
      if (req.url === "/retry-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1><button id=place>Place order</button><p id=ok></p>
         <script>document.getElementById('place').onclick=async()=>{try{await fetch('/flaky',{method:'POST'})}catch(e){}try{await fetch('/flaky',{method:'POST'})}catch(e){}document.getElementById('ok').textContent='✅ Order placed';};</script>`);
      // page CHANGES in an unclassified way (a new row, not a status/confirm) AND POSTs 200.
      if (req.url === "/lift") return res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><meta charset=utf8><title>x</title><ul id=l></ul><button id=place>Go</button>
         <script>document.getElementById('place').onclick=async()=>{document.getElementById('l').insertAdjacentHTML('beforeend','<li>added row</li>');await fetch('/ok',{method:'POST'});};</script>`);
      // page does NOTHING on click but a same-origin write 2xx fires (the dead-click trap).
      if (req.url === "/noop-post") return res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><meta charset=utf8><title>x</title><button id=place>Go</button>
         <script>document.getElementById('place').onclick=async()=>{await fetch('/ok',{method:'POST'});};</script>`);
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

  const run = async (route: "optimistic" | "declined-checkout" | "clean" | "thirdparty" | "gql" | "truncate-checkout" | "retry-checkout" | "lift" | "noop-post", apiOrigins?: string[], bodyErrors?: boolean) => {
    const page = (await sh.browser.context.activePage())!;
    const fake = fakeStagehand(sh, page, { actions: [{ selector: "#place" }] });
    const w = withTrueFact(fake, { network: { port: PORT, apiOrigins, bodyErrors }, screenshots: false, waitMs: 600 });
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

  it("bodyErrors off (default): a 200 whose body is a GraphQL error stays landed — no body read, no demote", async () => {
    const step = await run("gql");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("bodyErrors on: the 200-that-lies (GraphQL errors[]) demotes to did-not-land", async () => {
    // POST /gql-err returns HTTP 200 with {"errors":[{…}]} — status says ok, body
    // says failed. With bodyErrors the sidecar reads the body and catches it.
    const step = await run("gql", undefined, true);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
    assert.equal(step.evidence.postcondition?.network?.errors[0]?.status, 200);
  });

  it("cry-wolf (wrapped): a 2xx whose body load is canceled must NOT demote a good write", async () => {
    // POST /truncate returns 200 then the socket dies mid-body (navigation/beacon
    // shape). The old wrapped sidecar recorded that loadingFailed as status:null
    // and cried wolf; the shared 2xx-then-cancel guard keeps it landed.
    const step = await run("truncate-checkout");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("retry-collapse (wrapped): 500 then 200 to one endpoint in the bracket nets landed", async () => {
    const step = await run("retry-checkout");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("network-lift: an unclassified page change + a clean 2xx write lifts inconclusive -> landed", async () => {
    // the page adds a plain row (changed-unclassified, not a confirmation) and
    // POSTs /ok 200 — the accepted write lifts the uncertain page verdict.
    const step = await run("lift");
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "network-ok");
  });

  it("network-lift guard: a dead click (no page change) + a background 2xx stays inconclusive, never a false landed", async () => {
    const step = await run("noop-post");
    assert.equal(step.verdict, "inconclusive"); // no-change is NOT liftable
    assert.notEqual(step.evidence.postcondition?.reason, "network-ok");
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
