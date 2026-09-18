// Flow: declared `probe` postcondition. The optimistic-UI page lies to the
// browser (shows "✅ Order placed" while the server recorded FAILED). A page
// read — auto or declared text/element — is fooled. A `probe` GET against the
// server's own /verify reveals the truth and forces did-not-land. Real browser,
// no LLM. See docs/flows/optimistic-ui-probe.md.
import { createServer, type Server } from "node:http";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTrueFact, type Declaration } from "../src/index.js";
import { fakeStagehand, withBrowser } from "./helpers.js";

// One server: two checkout pages (optimistic lies, clean is honest), a /verify
// that reflects true server state, and a /boom that 5xxes.
function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  let placed = false;
  const page = (task: string) =>
    `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1>
     <button id=place type=button>Place order</button><p id=ok></p>
     <script>document.getElementById('place').onclick=async()=>{try{await fetch('/submit?task=${task}',{method:'POST',keepalive:true});}catch(e){}document.getElementById('ok').textContent='✅ Order placed — confirmation #4242';};</script>`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "POST" && path === "/submit") {
      placed = url.searchParams.get("task") === "clean"; // optimistic: recorded FAILED
      return res.writeHead(200).end("{}");
    }
    if (path === "/optimistic") return res.writeHead(200, { "content-type": "text/html" }).end(page("optimistic"));
    if (path === "/clean") return res.writeHead(200, { "content-type": "text/html" }).end(page("clean"));
    if (path === "/verify") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ placed }));
    if (path === "/boom") return res.writeHead(500).end("upstream exploded");
    return res.writeHead(404).end("no");
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({
        base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () =>
          new Promise((rr) => {
            server.closeAllConnections?.();
            server.close(() => rr());
          }),
      }),
    ),
  );
}

describe("declared probe: out-of-band reconciliation catches optimistic UI", () => {
  const b = withBrowser();
  let srv: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    await b.start();
    srv = await startServer();
  });
  after(async () => {
    await b.stop();
    await srv.close();
  });

  // Click #place, then compose the auto verdict with the given probe expectation.
  const run = async (page: "optimistic" | "clean", expect: Declaration | Declaration[]) => {
    const sh = fakeStagehand(await b.start(), await b.page(), { actions: [{ selector: "#place" }] });
    const { act, replay } = withTrueFact(sh, { screenshots: false, waitMs: 900 });
    await (await b.page()).goto(`${srv.base}/${page}`);
    await act("place the order", { expect });
    return replay.steps.at(-1)!;
  };

  it("optimistic UI: the page shows ✅ but /verify shows no order — probe forces did-not-land", async () => {
    const step = await run("optimistic", { kind: "probe", get: "/verify", text: /"placed":true/ });
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "declared-unmet");
  });

  it("clean checkout: the same probe confirms the order landed", async () => {
    const step = await run("clean", { kind: "probe", get: "/verify", text: /"placed":true/ });
    assert.equal(step.verdict, "landed");
  });

  it("relative get resolves against the page origin (the two cases above already use it); absolute works too", async () => {
    const step = await run("clean", { kind: "probe", get: `${srv.base}/verify`, text: /"placed":true/ });
    assert.equal(step.verdict, "landed");
  });

  it("unreachable probe endpoint → inconclusive, never a false halt", async () => {
    const step = await run("clean", { kind: "probe", get: "http://127.0.0.1:9/nope", text: /"placed":true/ });
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "declared-unreadable");
  });

  it("a broken (5xx) verify endpoint → inconclusive, not a false did-not-land", async () => {
    const step = await run("clean", { kind: "probe", get: "/boom", text: /whatever/ });
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "declared-unreadable");
  });

  it("status-only probe: the verify endpoint responding 2xx counts as met", async () => {
    const step = await run("clean", { kind: "probe", get: "/verify", status: "ok" });
    assert.equal(step.verdict, "landed");
  });
});
