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

// The truly optimistic shape: the ✅ paints AT ONCE and the POST is fired but not
// awaited — so a verdict read the instant the banner appears sees a clean page and
// a request still in flight (the §1 in-flight case).
const htmlOpt = (postUrl: string) =>
  `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1>
   <button id=place>Place order</button><p id=ok></p>
   <script>document.getElementById('place').onclick=()=>{
     fetch(${JSON.stringify(postUrl)},{method:'POST'}).catch(()=>{});
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
      if (req.url === "/boom") return res.writeHead(500).end("x");
      if (req.url === "/slow-boom") return void setTimeout(() => res.writeHead(500).end("x"), 1500); // a slow cross-origin 500
      return res.writeHead(404).end();
    });
    thirdBase = await listen(third);
    let flaky = 0;
    app = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/submit") return res.writeHead(500).end("upstream exploded");
      if (req.method === "POST" && req.url === "/declined") return res.writeHead(402, { "content-type": "application/json" }).end('{"error":"card declined"}');
      if (req.method === "POST" && req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      // §1 in-flight cases: a write that answers (or never does) AFTER the banner.
      if (req.method === "POST" && req.url === "/slow-reject") return void setTimeout(() => res.writeHead(500).end("late boom"), 800);
      if (req.method === "POST" && req.url === "/slow-ok") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 800);
      if (req.method === "POST" && req.url === "/never") return; // hold the socket open — a write that never answers
      if (req.method === "POST" && req.url === "/slow-body") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); setTimeout(() => res.end("}"), 1500); return; } // 2xx headers now, body later
      if (req.method === "POST" && req.url === "/gql-err") return res.writeHead(200, { "content-type": "application/json" }).end('{"data":null,"errors":[{"message":"mutation rejected"}]}');
      if (req.method === "POST" && req.url === "/flaky") return res.writeHead(flaky++ === 0 ? 500 : 200, { "content-type": "application/json" }).end("{}");
      // 200, then the body load is canceled (navigation/beacon shape): send a
      // content-length longer than the bytes, then destroy the socket.
      if (req.method === "POST" && req.url === "/truncate") { res.writeHead(200, { "content-type": "application/json", "content-length": "100" }); res.write("{}"); setTimeout(() => res.socket?.destroy(), 120); return; }
      if (req.url === "/optimistic") return res.writeHead(200, { "content-type": "text/html" }).end(html("/submit"));
      if (req.url === "/declined-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(html("/declined"));
      if (req.url === "/clean") return res.writeHead(200, { "content-type": "text/html" }).end(html("/ok"));
      // Optimistic pages (✅ at once, POST not awaited) for the §1 in-flight tests.
      if (req.url === "/slow-reject-co") return res.writeHead(200, { "content-type": "text/html" }).end(htmlOpt("/slow-reject"));
      if (req.url === "/slow-ok-co") return res.writeHead(200, { "content-type": "text/html" }).end(htmlOpt("/slow-ok"));
      if (req.url === "/never-co") return res.writeHead(200, { "content-type": "text/html" }).end(htmlOpt("/never"));
      if (req.url === "/slow-body-co") return res.writeHead(200, { "content-type": "text/html" }).end(htmlOpt("/slow-body"));
      if (req.url === "/slow-third-co") return res.writeHead(200, { "content-type": "text/html" }).end(htmlOpt(`${thirdBase}/slow-boom`));
      if (req.url === "/gql") return res.writeHead(200, { "content-type": "text/html" }).end(html("/gql-err"));
      if (req.url === "/thirdparty") return res.writeHead(200, { "content-type": "text/html" }).end(html(`${thirdBase}/boom`));
      if (req.url === "/truncate-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(html("/truncate"));
      // clicks POST /flaky twice: 500 then 200 (a retry that recovers).
      if (req.url === "/retry-checkout") return res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1><button id=place>Place order</button><p id=ok></p>
         <script>document.getElementById('place').onclick=async()=>{try{await fetch('/flaky',{method:'POST'})}catch(e){}try{await fetch('/flaky',{method:'POST'})}catch(e){}document.getElementById('ok').textContent='✅ Order placed';};</script>`);
      // page changes in an UNCLASSIFIED way (a plain row, no confirmation) AND
      // fires a clean same-origin 2xx (a first-party analytics beacon shape).
      if (req.url === "/unclassified-write") return res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><meta charset=utf8><title>x</title><ul id=l></ul><button id=place>Go</button>
         <script>document.getElementById('place').onclick=async()=>{document.getElementById('l').insertAdjacentHTML('beforeend','<li>added row</li>');await fetch('/ok',{method:'POST'});};</script>`);
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

  const run = async (route: "optimistic" | "declined-checkout" | "clean" | "thirdparty" | "gql" | "truncate-checkout" | "retry-checkout", apiOrigins?: string[], bodyErrors?: boolean) => {
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

  it("no false-landed: an unclassified page change + a clean same-origin 2xx stays inconclusive (the network never lifts)", async () => {
    // The removed applyNetworkLift would have read the same-origin POST /ok 200 as
    // "the write landed" — but a 2xx (a first-party analytics beacon) proves only
    // that request succeeded, not that THIS action's write did. Must stay uncertain.
    const step = await run("unclassified-write");
    assert.equal(step.verdict, "inconclusive");
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

  // §1 — a write still in flight when the optimistic banner appears. The verdict
  // must wait for it (bounded), then never read `landed` on an unanswered write.
  const runInflight = async (route: string, waitMs: number, apiOrigins?: string[]) => {
    const page = (await sh.browser.context.activePage())!;
    const fake = fakeStagehand(sh, page, { actions: [{ selector: "#place" }] });
    const w = withTrueFact(fake, { network: { port: PORT, apiOrigins }, screenshots: false, waitMs });
    await w.page.goto(`${base}/${route}`);
    const t = Date.now();
    await w.act("place the order");
    const ms = Date.now() - t;
    await w.close();
    return { step: w.replay.steps.at(-1)!, ms };
  };

  it("in-flight: ✅ shown at once but the POST 500s a beat later → did-not-land (the false-landed §1 closes)", async () => {
    const { step } = await runInflight("slow-reject-co", 2000);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
    assert.equal(step.evidence.postcondition?.network?.errors[0]?.status, 500);
  });

  it("in-flight: ✅ shown at once and the POST 200s a beat later → stays landed (the wait does not false-halt a slow success)", async () => {
    const { step } = await runInflight("slow-ok-co", 2000);
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
    assert.equal(step.evidence.postcondition?.network, undefined);
  });

  it("in-flight: a watched write that never answers within the budget → inconclusive/unsettled, never landed, never did-not-land", async () => {
    const { step } = await runInflight("never-co", 600);
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "unsettled");
    assert.ok((step.evidence.postcondition?.network?.pending ?? 0) > 0);
  });

  it("in-flight: a slow write to a THIRD origin (not in apiOrigins) never holds the bracket — stays landed, no wait (cry-wolf + latency guard)", async () => {
    const { step, ms } = await runInflight("slow-third-co", 2000);
    assert.equal(step.verdict, "landed");
    assert.ok(ms < 1400, `bracket waited ${ms}ms for an unwatched third-party write`); // < the 1500ms server delay
  });

  it("in-flight: a 2xx whose HEADERS arrive at once but body streams later resolves at headers — landed, no wait for the body", async () => {
    const { step, ms } = await runInflight("slow-body-co", 2000);
    assert.equal(step.verdict, "landed");
    assert.ok(ms < 1400, `bracket waited ${ms}ms for a 2xx body`); // < the 1500ms body delay
  });
});
