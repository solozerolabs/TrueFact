// `truefact watch` (observe mode) — hermetic, keyless. A real Chrome is driven
// by an INDEPENDENT raw-CDP client (Runtime.evaluate) so watch is a pure
// observer that wraps nothing, exactly like production. Watch attaches by port
// and emits a per-write verdict from the network alone. Asserts: optimistic 500
// → did-not-land, clean 200 → landed, 402-on-write → did-not-land, an undeclared
// cross-origin 500 is NOT watched (cry-wolf guard), a declared apiOrigin IS,
// retry-collapse (500-then-200 to one endpoint) nets landed, and the opt-in
// bodyErrors catches a 200-that-lies. See src/watch.ts.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { localBrowser } from "@browserbasehq/stagehand";
import { startWatch, type WatchSession, type WriteObservation } from "../src/watch.js";
import { cdpConnect, type CdpConn } from "../src/cdp.js";
import type { Step } from "../src/index.js";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const shut = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A page that defines window.__go(): does the fetch(es) and resolves — so the
// driver can awaitPromise and know the network is done before watch settles.
const page = (body: string) => `<!doctype html><meta charset=utf8><title>t</title><script>window.__go=async()=>{${body}};</script>`;

describe("truefact watch: passive network-truth verdicts", () => {
  const PORT = 9417;
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  let app: Server, third: Server, base = "", thirdBase = "";
  let watch: WatchSession, drv: CdpConn;

  before(async () => {
    // cross-origin "API" with CORS, returns 500 on POST (a real API host shape).
    third = createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      return req.url === "/boom" ? res.writeHead(500).end("x") : res.writeHead(404).end();
    });
    thirdBase = await listen(third);

    let flaky = 0;
    app = createServer((req, res) => {
      const j = { "content-type": "application/json" };
      if (req.method === "POST" && req.url === "/submit") return res.writeHead(500, j).end('{"ok":false}');
      if (req.method === "POST" && req.url === "/ok") return res.writeHead(200, j).end("{}");
      if (req.method === "POST" && req.url === "/declined") return res.writeHead(402, j).end('{"error":"declined"}');
      if (req.method === "POST" && req.url === "/gql-err") return res.writeHead(200, j).end('{"data":null,"errors":[{"message":"no"}]}');
      if (req.method === "POST" && req.url === "/flaky") return res.writeHead(flaky++ === 0 ? 500 : 200, j).end("{}");
      if (req.method === "POST" && req.url === "/forbidden") return res.writeHead(403, j).end('{"error":"auth"}');
      // a 2xx whose body load then fails: send 200 + a longer content-length than
      // the bytes written, then destroy the socket → responseReceived 200 then
      // Network.loadingFailed (the canceled-beacon shape from real sites).
      if (req.method === "POST" && req.url === "/truncate") { res.writeHead(200, { "content-type": "application/json", "content-length": "100" }); res.write("{}"); setTimeout(() => res.socket?.destroy(), 120); return; }
      // a genuine pre-response wire failure: kill the socket before any headers.
      if (req.method === "POST" && req.url === "/reset") return res.socket?.destroy();
      const html =
        req.url === "/optimistic" ? page("try{await fetch('/submit',{method:'POST'})}catch(e){}")
        : req.url === "/clean" ? page("await fetch('/ok',{method:'POST'})")
        : req.url === "/declined-page" ? page("try{await fetch('/declined',{method:'POST'})}catch(e){}")
        : req.url === "/gql" ? page("try{await fetch('/gql-err',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}catch(e){}")
        : req.url === "/retry" ? page("try{await fetch('/flaky',{method:'POST'})}catch(e){};await fetch('/flaky',{method:'POST'})")
        : req.url === "/forbidden-page" ? page("try{await fetch('/forbidden',{method:'POST'})}catch(e){}")
        : req.url === "/truncate-page" ? page("try{await fetch('/truncate',{method:'POST'})}catch(e){}")
        : req.url === "/reset-page" ? page("try{await fetch('/reset',{method:'POST'})}catch(e){}")
        : req.url === "/xorigin" ? page(`try{await fetch('${thirdBase}/boom',{method:'POST'})}catch(e){}`)
        : page("");
      res.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    base = await listen(app);
    browser = await localBrowser.launch({ headless: true, port: PORT });
    drv = (await cdpConnect(PORT))!;
    await drv.cmd("Page.enable");
  });

  after(async () => {
    await watch?.close();
    drv?.close();
    await browser?.close();
    await shut(app);
    await shut(third);
  });

  // Navigate the driver's own CDP client, run window.__go() to completion, let
  // CDP events propagate, then flush watch deterministically. Returns the writes
  // watch observed for this drive.
  const run = async (route: string, opts?: { apiOrigins?: string[]; bodyErrors?: boolean }): Promise<WriteObservation[]> => {
    const obs: WriteObservation[] = [];
    watch = (await startWatch({ port: PORT, graceMs: 300, onWrite: (w) => obs.push(w), ...opts }))!;
    await drv.cmd("Page.navigate", { url: `${base}/${route}` });
    await sleep(250); // let the page load and watch see the main-frame origin
    await drv.cmd("Runtime.evaluate", { expression: "window.__go && window.__go()", awaitPromise: true });
    await sleep(150); // CDP terminal events reach watch
    await watch.settle();
    await watch.close();
    return obs;
  };

  it("optimistic: POST /submit 500 → did-not-land", async () => {
    const o = await run("optimistic");
    assert.equal(o.length, 1);
    assert.equal(o[0].verdict, "did-not-land");
    assert.equal(o[0].status, 500);
  });

  it("clean: POST /ok 200 → landed", async () => {
    const o = await run("clean");
    assert.equal(o.length, 1);
    assert.equal(o[0].verdict, "landed");
    assert.equal(o[0].status, 200);
  });

  it("declined: POST /declined 402 → did-not-land", async () => {
    const o = await run("declined-page");
    assert.equal(o.at(-1)?.verdict, "did-not-land");
    assert.equal(o.at(-1)?.status, 402);
  });

  it("cry-wolf guard: an UNDECLARED cross-origin 500 is not watched → no verdict", async () => {
    const o = await run("xorigin");
    assert.equal(o.length, 0);
  });

  it("apiOrigins: the same cross-origin 500, declared, → did-not-land", async () => {
    const o = await run("xorigin", { apiOrigins: [thirdBase] });
    assert.equal(o.at(-1)?.verdict, "did-not-land");
    assert.equal(o.at(-1)?.status, 500);
  });

  it("retry-collapse: 500 then 200 to one endpoint nets landed, never did-not-land", async () => {
    const o = await run("retry");
    assert.ok(!o.some((w) => w.verdict === "did-not-land"), "a recovered retry must not accuse");
    assert.ok(o.some((w) => w.verdict === "landed"));
  });

  // Cry-wolf tightenings from the real-site experiment (run #4). Passive observe
  // mode must not accuse on pervasive same-origin BACKGROUND traffic.
  it("cry-wolf: a 403 auth failure on a write is a MISS — neither accused nor falsely landed", async () => {
    const o = await run("forbidden-page");
    assert.equal(o.length, 0, "401/403 auth is dropped in passive mode: no did-not-land, and no false landed either");
  });

  it("cry-wolf: a 2xx whose body load is then canceled is landed, not did-not-land (beacon abort)", async () => {
    const o = await run("truncate-page");
    assert.ok(!o.some((w) => w.verdict === "did-not-land"), "server accepted (2xx) → a canceled body load must not accuse");
    assert.equal(o.at(-1)?.verdict, "landed");
  });

  it("preserved: a genuine pre-response wire failure on a write still → did-not-land", async () => {
    const o = await run("reset-page");
    assert.equal(o.at(-1)?.verdict, "did-not-land");
    assert.equal(o.at(-1)?.status, null);
  });

  it("bodyErrors: a 200 whose body is a GraphQL error → did-not-land", async () => {
    const o = await run("gql", { bodyErrors: true });
    assert.equal(o.at(-1)?.verdict, "did-not-land");
    assert.equal(o.at(-1)?.status, 200);
  });
  // Plan §5 (feature C): watch records through the same recorder as the
  // bracket, so every appended step carries the caller's actor and the
  // observer stamp.
  it("given startWatch({ actor: { agent: 'bu' }, jsonl }), then every appended step has actor.agent 'bu' and an observer stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-watch-actor-"));
    try {
      const jsonl = join(dir, "run.jsonl");
      watch = (await startWatch({ port: PORT, graceMs: 300, jsonl, actor: { agent: "bu" } } as Parameters<typeof startWatch>[0]))!;
      await drv.cmd("Page.navigate", { url: `${base}/clean` });
      await sleep(250);
      await drv.cmd("Runtime.evaluate", { expression: "window.__go && window.__go()", awaitPromise: true });
      await sleep(150);
      await watch.settle();
      await watch.close();
      const steps = readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(steps.length >= 1, "at least one write step was appended");
      for (const s of steps) {
        assert.equal(s.actor?.agent, "bu");
        assert.match(s.observer ?? "", /^truefact@\d+\.\d+\.\d+/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §A10 — observer liveness in observe mode (docs/OBSERVER-PLAN.md §3 "watch").
// `watch` binds ONE page target; when that target goes (tab closed, browser
// gone) its socket closes and watch is blind. Today it keeps "watching" and
// exits 0. It must say so: a `kind: "observer"` step (verdict inconclusive,
// reason observer-lost, before/after null) appended to the jsonl chain, and
// `session.lost()` reporting the reason. Own browser: the case kills the tab.
describe("truefact watch: observer lost", () => {
  const PORT = 9418;
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  let app: Server, base = "";

  before(async () => {
    app = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page("")));
    base = await listen(app);
    browser = await localBrowser.launch({ headless: true, port: PORT });
  });
  after(async () => {
    await browser?.close().catch(() => {}); // the tab is already gone; the browser may be too
    await shut(app);
  });

  const jsonlSteps = (file: string): Step[] =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Step) : [];
  // Bounded wait for the chain to carry a line matching `pred` — file sync only; the assertions are on the step.
  const untilStep = async (file: string, pred: (s: Step) => boolean, ms = 3000): Promise<Step | undefined> => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const hit = jsonlSteps(file).find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return undefined;
  };

  it("given watch is attached to a page target, when that tab is closed, then a kind=observer step inconclusive/observer-lost is chained to the jsonl and session.lost() names the reason", async () => {
    const jsonl = join(mkdtempSync(join(tmpdir(), "tf-watch-lost-")), "run.jsonl");
    const drv = (await cdpConnect(PORT))!;
    await drv.cmd("Page.navigate", { url: `${base}/x` });
    await sleep(200);
    const session = (await startWatch({ port: PORT, graceMs: 200, jsonl }))! as WatchSession & { lost(): string | null };
    drv.close(); // the driver's own client must not be what keeps the tab alive
    // Kill the page target from the outside, via the DevTools HTTP endpoint —
    // its socket closes under watch; the browser stays up so no other client sees a "crash".
    const targets = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())) as { id: string; type: string }[];
    const tab = targets.find((t) => t.type === "page")!;
    await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);

    const obs = await untilStep(jsonl, (s) => (s.kind as string) === "observer");
    assert.ok(obs, "no kind=observer step was chained to the jsonl after the target closed");
    assert.equal(obs.verdict, "inconclusive");
    assert.equal(obs.evidence.postcondition?.reason, "observer-lost");
    assert.equal(obs.evidence.before, null);
    assert.equal(obs.evidence.after, null);
    assert.ok(obs.hash, "the observer step is part of the chain");
    // A closed tab reaches a page-level conn as Inspector.detached first, then
    // the socket close; either is observer loss. The session names ONE reason and
    // the chained step carries the same one.
    const reason = session.lost();
    assert.ok(reason, "session.lost() must name the reason once the target is gone");
    const recorded = (obs.evidence as Step["evidence"] & { observer?: { lost?: string } }).observer?.lost;
    if (recorded !== undefined) assert.equal(recorded, reason);
    await session.close();
  });
});
