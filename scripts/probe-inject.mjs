// Probe: the failure-injection facts scripts/live/ relies on, checked against a
// real Chrome. Run after a Chrome/Playwright bump (like npm run probe:targets).
//   npm run probe:inject     (needs `npm run build` first)
// Asserts: a SEPARATE CDP client can force a known did-not-land the sidecar sees
// independently, the server truly never receives the write, and a real 200-with-
// errors body now demotes on the Playwright path (the EXPERIMENT-SITES run #3
// ceiling, closed by multi-target sessionId routing).
import net from "node:net";
import http from "node:http";
import { chromium } from "playwright-core";
import { localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../dist/index.js";
import { playwrightDriver } from "../dist/driver-playwright.js";
import { cdpConnect } from "../dist/cdp.js";
import { arm } from "./live/inject.mjs";

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

let serverErrBody = false, hits = 0;
const srvPort = await freePort();
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/save") { hits++; res.writeHead(200, { "content-type": "application/json" }); return res.end(serverErrBody ? '{"errors":[{"message":"rejected"}]}' : '{"ok":true}'); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset=utf8><title>Profile</title><h1>Profile</h1><button id=save type=button>Save</button><p id=ok role=status></p>
<script>document.getElementById('save').onclick=()=>{fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});document.getElementById('ok').textContent='✅ Saved successfully';}</script>`);
});
await new Promise((r) => server.listen(srvPort, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${srvPort}/`;

const port = await freePort();
const chrome = await localBrowser.launch({ headless: true, port });
const pw = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = pw.contexts()[0].pages()[0] ?? (await pw.contexts()[0].newPage());

const rows = [];
for (const mode of ["none", "status:500", "wire", "body-lie", "realbody"]) {
  hits = 0; serverErrBody = mode === "realbody";
  const w = withTrueFact(playwrightDriver(page), { network: { port, bodyErrors: true }, screenshots: false, waitMs: 1500 });
  await w.page.goto(PAGE);
  let injector, conn;
  if (mode !== "none" && mode !== "realbody") { conn = await cdpConnect(port); injector = await arm(conn, { urlPattern: "*/save", mode }); }
  const res = await w.act({ selector: "#save", method: "click" });
  const banner = (await page.locator("#ok").textContent()) || "";
  await injector?.disarm(); conn?.close();
  await new Promise((r) => setTimeout(r, 250));
  rows.push({ mode, verdict: res.truefact.verdict, reason: res.truefact.reason, serverHits: hits, confirmed: injector?.confirmed() ?? "-", banner: banner.includes("✅") });
  await w.close();
}
console.table(rows);

const by = Object.fromEntries(rows.map((r) => [r.mode, r]));
const checks = [
  ["control: no injection → landed, server got the write", by.none.verdict === "landed" && by.none.serverHits === 1],
  ["status:500 → did-not-land, server NEVER got the write, confirmed", by["status:500"].verdict === "did-not-land" && by["status:500"].serverHits === 0 && by["status:500"].confirmed === true],
  ["wire → did-not-land, server NEVER got the write", by.wire.verdict === "did-not-land" && by.wire.serverHits === 0],
  ["body-lie (injected 200+errors) → did-not-land, server NEVER got it", by["body-lie"].verdict === "did-not-land" && by["body-lie"].serverHits === 0],
  ["REAL server 200+errors on the Playwright path → did-not-land (run #3 ceiling closed)", by.realbody.verdict === "did-not-land"],
  ["optimistic ✅ shown in every case (the lie is real)", rows.every((r) => r.banner)],
];
let fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fail++; }
pw.close?.(); await chrome.close(); server.closeAllConnections?.(); server.close();
process.exit(fail ? 1 : 0);
