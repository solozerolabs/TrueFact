// Render the two demo scenes in headless Chromium and record each to webm:
//   1. demo/checkout.html — a real checkout page whose POST /submit gets a real 500
//   2. demo/demo.html     — the terminal: truefact assert catches it (real output)
// Usage: node demo/record.mjs   ->   demo/checkout.webm, demo/terminal.webm
// Stitch + convert in demo/README.md.
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const W = 1000, H = 640;

// Server for scene 1: GET serves the checkout page, POST /submit is the real 500.
const page1 = readFileSync(resolve("demo/checkout.html"), "utf8");
const srv = createServer((req, res) => {
  if (req.method === "POST") { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"ok":false,"error":"payment declined"}'); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page1);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const browser = await chromium.launch();
async function record(url, out) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 2,
    recordVideo: { dir: resolve("demo"), size: { width: W, height: H } },
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__demoDone === true, { timeout: 30000 });
  const vid = page.video();
  await ctx.close();
  const { renameSync } = await import("node:fs");
  renameSync(await vid.path(), resolve("demo", out));
  console.log("wrote demo/" + out);
}

await record(`http://127.0.0.1:${port}/`, "checkout.webm");
await record(pathToFileURL(resolve("demo/demo.html")).href, "terminal.webm");
await browser.close();
srv.close();
