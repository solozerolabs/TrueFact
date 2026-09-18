// Probe the raw-CDP facts cdpConnectBrowser relies on, against the installed
// Chrome — run after a Chrome/Chromium bump (`npm run probe:targets`). Stdlib
// WebSocket + fetch, no build needed. Exits non-zero if an assumption breaks.
//
// Facts asserted (see src/cdp.ts):
//  1. browser-level Target.setAutoAttach{flatten} attaches existing + new targets
//     over ONE socket, tagged with a sessionId.
//  2. Network is PER SESSION: a child's requestWillBeSent only arrives after that
//     session's own Network.enable.
//  3. an auto-attached popup does NOT load until Runtime.runIfWaitingForDebugger
//     — the observer must resume it or it breaks the user's flow.
//  4. Network.getResponseBody needs the owning sessionId (fails without it).
import { createServer } from "node:http";
import { localBrowser } from "@browserbasehq/stagehand";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
const fails = [];
const check = (name, ok) => { console.log(`${ok ? "✔" : "✖"} ${name}`); if (!ok) fails.push(name); };

const app = createServer((req, res) => {
  if (req.method === "POST") return res.writeHead(500, { "content-type": "application/json" }).end('{"ok":false}');
  if (req.url === "/child") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><p>child</p><script>fetch('/pay',{method:'POST'}).catch(()=>{})</script>`);
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><button style="position:fixed;inset:0" onclick="window.open('/child')">go</button>`);
});
const base = await listen(app);
const PORT = 9466;
const browser = await localBrowser.launch({ headless: true, port: PORT });

const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const events = []; const sessions = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = msg.params; sessions.set(sessionId, targetInfo);
      const t = targetInfo.type;
      if (t === "page" || t === "iframe") { cmd("Network.enable", {}, sessionId); cmd("Target.setAutoAttach", AUTO, sessionId); }
      cmd("Runtime.runIfWaitingForDebugger", {}, sessionId); // fact 3: resume or the popup never loads
    }
    if (msg.method) events.push(msg);
  };
  const cmd = (method, params = {}, sessionId) => new Promise((r) => {
    const i = ++id; pending.set(i, r); setTimeout(() => { if (pending.delete(i)) r({ error: { message: "timeout" } }); }, 4000);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { cmd, events, sessions, ws };
};
const AUTO = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

try {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const b = await connect(ver.webSocketDebuggerUrl);
  const rootNet = await b.cmd("Network.enable"); // fact 2: browser target has no Network domain
  check("browser target has no Network domain (per-session enable required)", !!rootNet.error);
  await b.cmd("Target.setAutoAttach", AUTO);
  await sleep(600);
  const pageSid = [...b.sessions].find(([, t]) => t.type === "page")?.[0];
  check("1. browser-level setAutoAttach attaches the existing page over one socket", !!pageSid);

  await b.cmd("Page.navigate", { url: `${base}/` }, pageSid);
  await sleep(500);
  for (const type of ["mousePressed", "mouseReleased"]) await b.cmd("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 }, pageSid);
  await sleep(1500);

  const post = b.events.find((e) => e.method === "Network.requestWillBeSent" && e.params.request.method === "POST");
  check("2+3. the popup loaded and its POST was seen on a child session (resume + per-session Network.enable work)", !!post && post.sessionId !== pageSid);
  if (post) {
    const noSid = await b.cmd("Network.getResponseBody", { requestId: post.params.requestId });
    const withSid = await b.cmd("Network.getResponseBody", { requestId: post.params.requestId }, post.sessionId);
    check("4. getResponseBody needs the owning sessionId (fails without it, works with it)", !!noSid.error && !withSid.error);
  }
} finally {
  await browser?.close();
  app.closeAllConnections?.(); app.close();
}
console.log(fails.length ? `\nFAILED: ${fails.length} assumption(s) broke — see src/cdp.ts` : "\nAll CDP multi-target assumptions hold.");
process.exit(fails.length ? 1 : 0);
