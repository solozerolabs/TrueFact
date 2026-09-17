// Day 5 probe: what does page.snapshot().formattedTree actually contain?
// Decides what grounding can and cannot match against. No LLM needed.
import { createServer } from "node:http";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";

const LONG = "The quick brown fox jumps over the lazy dog and keeps running through the meadow until the sun sets behind the distant purple mountains of the west".repeat(2);
const PAGE = `<!doctype html><meta charset=utf8><title>Receipt 4242</title>
<main>
<h1>Order #4242</h1>
<p>Total: <strong>$1,249.00</strong></p>
<p>Ship to  <span>Ada   Lovelace</span></p>
<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Deluxe Widget</td><td>3</td></tr></table>
<img src="x.png" alt="Widget photo alt text">
<button title="Tooltip title text" aria-label="Aria label text">Btn</button>
<input id=email value="ada@example.com">
<input id=pw type=password value="hunter22">
<select id=sel><option>Red</option><option selected>Green</option></select>
<p>${LONG}</p>
<p style="display:none">Hidden paragraph text</p>
<p aria-hidden="true">Aria hidden text</p>
<div style="height:4000px"></div>
<p>Below the fold text</p>
<p>Unicode: café — 49 €</p>
<p>Split <em>across</em> inline <b>elements</b></p>
<a href="/x">Link text here</a>
<p>Date 2026-09-16 and 09/16/2026</p>
<div id=host></div><iframe src="/inner"></iframe>
<p>Ticker: <span id=tk>100</span></p>
<script>host.attachShadow({mode:'open'}).innerHTML='<p>Shadow DOM text</p>';setInterval(()=>tk.textContent=+tk.textContent+1,50)</script>
</main>`;
const INNER = `<!doctype html><p>Iframe inner text</p>`;
const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/inner" ? INNER : PAGE); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const browser = await localBrowser.launch({ headless: true });
const sh = await Stagehand.create({ browser, logging: { level: "error" } });
const page = await sh.browser.context.activePage();
await page.goto(url);
await new Promise((r) => setTimeout(r, 300));
const t = Date.now();
const snap = await page.snapshot();
console.log(`snapshot keys: ${Object.keys(snap).join(",")}  (${Date.now() - t} ms)`);
console.log("---- formattedTree ----");
console.log(snap.formattedTree);
console.log("---- probes ----");
const tree = snap.formattedTree;
const has = (s) => tree.includes(s);
console.log("alt text in tree        :", has("Widget photo alt text"));
console.log("title attr in tree      :", has("Tooltip title text"));
console.log("aria-label in tree      :", has("Aria label text"));
console.log("input value in tree     :", has("ada@example.com"));
console.log("password masked         :", !has("hunter22"));
console.log("selected option         :", has("Green"));
console.log("display:none excluded   :", !has("Hidden paragraph text"));
console.log("aria-hidden excluded    :", !has("Aria hidden text"));
console.log("below-fold included     :", has("Below the fold text"));
console.log("long text intact        :", has(LONG), " (longest line:", Math.max(...tree.split("\n").map((l) => l.length)), "chars)");
console.log("whitespace collapsed    :", has("Ada Lovelace"), "/ raw:", has("Ada   Lovelace"));
console.log("currency intact         :", has("$1,249.00"));
console.log("unicode intact          :", has("café — 49 €"));
console.log("inline split one line   :", has("Split across inline elements"));
console.log("title in tree           :", has("Receipt 4242"));
console.log("shadow DOM included     :", has("Shadow DOM text"));
console.log("iframe text included    :", has("Iframe inner text"));
console.log("ticker moved (2 snaps)  :", (await page.snapshot()).formattedTree !== tree);
console.log("table cell '3' line     :", tree.split("\n").filter((l) => /\b3\b/.test(l)).map((l) => l.trim()).join(" | "));
await browser.close();
srv.close();
