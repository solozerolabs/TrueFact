// M0 — CDP sidecar experiment. Question: while Stagehand drives Chrome, can a
// SECOND, independent CDP client observe the network response (a 500 behind a
// ✅ page) that Stagehand v4 cannot see? If yes, optimistic-UI stops being the
// 40/40 miss and the reader can attach to any Chrome driver.
//
// Stdlib only: global WebSocket (Node 24) + fetch for the /json target list.
import { createServer } from "node:http";
import { localBrowser } from "@browserbasehq/stagehand";
import assert from "node:assert/strict";

const DEBUG_PORT = 9347;

// Optimistic-UI-on-the-wire: the POST 500s, the page shows success anyway.
function startServer() {
  const html = `<!doctype html><meta charset=utf8><title>Checkout</title><h1>Checkout</h1>
    <button id=place>Place order</button><p id=ok></p>
    <script>document.getElementById('place').onclick=async()=>{
      try{await fetch('/submit',{method:'POST',keepalive:true});}catch(e){}
      document.getElementById('ok').textContent='✅ Order placed — #4242';};</script>`;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/submit") return res.writeHead(500).end("upstream exploded");
    if (req.url === "/optimistic") return res.writeHead(200, { "content-type": "text/html" }).end(html);
    return res.writeHead(404).end("no");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () =>
    r({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((rr) => { server.closeAllConnections?.(); server.close(() => rr()); }) })));
}

// Minimal raw-CDP client over the page target's WebSocket.
async function attachSidecar(port) {
  // The browser writes its endpoints to /json; find the first page target.
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("no page target with a ws url — port not exposed?");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, events, close: () => ws.close(), wsUrl: page.webSocketDebuggerUrl };
}

async function main() {
  const srv = await startServer();
  const browser = await localBrowser.launch({ headless: true, port: DEBUG_PORT });
  let sidecar;
  try {
    // Stagehand owns the page. Drive it to the fixture first.
    const { Stagehand } = await import("@browserbasehq/stagehand");
    const sh = await Stagehand.create({ browser, logging: { level: "error" } });
    const page = (await sh.browser.context.activePage());
    await page.goto(`${srv.base}/optimistic`);

    // SECOND client attaches independently and starts listening BEFORE the click.
    sidecar = await attachSidecar(DEBUG_PORT);
    console.log("sidecar attached:", sidecar.wsUrl.split("/").pop());
    await sidecar.send("Network.enable");

    // Stagehand performs the write. Its own channel will see success; the wire won't.
    await page.locator("#place").click();

    // Give the fetch a moment, then read what the sidecar captured.
    await new Promise((r) => setTimeout(r, 800));

    const responses = sidecar.events
      .filter((e) => e.method === "Network.responseReceived")
      .map((e) => ({ url: e.params.response.url, status: e.params.response.status }));
    console.log("sidecar saw responses:", JSON.stringify(responses, null, 2));

    const submit = responses.find((r) => r.url.endsWith("/submit"));
    assert.ok(submit, "sidecar did NOT observe the /submit request at all");
    assert.equal(submit.status, 500, `expected 500 on /submit, saw ${submit.status}`);

    // And confirm the page itself lies (the exact blindness we're beating).
    const okText = await page.locator("#ok").innerText();
    assert.match(okText, /Order placed/, "page should show the optimistic ✅");

    console.log("\nRESULT: PASS — second CDP client saw /submit 500 while the page showed:", JSON.stringify(okText));
    console.log("=> optimistic-UI is observable out-of-band. M0 unlocks M2/M5/M7.");
  } finally {
    sidecar?.close();
    await browser.close();
    await srv.close();
  }
}

main().catch((e) => { console.error("\nRESULT: FAIL —", e.message); process.exitCode = 1; });
