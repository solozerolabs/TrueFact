// API sanity probe against the installed @browserbasehq/stagehand.
// Run after any Stagehand bump. If the method list, result shapes, or timings
// printed here differ from docs/DAY2.md §0, that section is stale.
// Needs a local Chrome. Needs no LLM key.
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";

const t0 = Date.now();
const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser, logging: { level: "error" } });
console.log(`launch + create: ${Date.now() - t0} ms (no model configured)`);

const ctx = stagehand.browser.context;
const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
console.log("initial url():", await page.url());

const html = `<html><head><title>Fixture</title></head><body>
<main id="root"><form><input type="password" autocomplete="current-password"></form></main>
<div id="ov" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5)"></div>
</body></html>`;
await page.goto("data:text/html," + encodeURIComponent(html));

console.log("evaluate:", JSON.stringify(await page.evaluate(() => ({
  ready: document.readyState,
  password: document.querySelector("input[type=password]")?.getAttribute("autocomplete"),
  centerHit: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id,
  iframes: [...document.querySelectorAll("iframe")].map((f) => f.src),
  viewport: [innerWidth, innerHeight],
}))));
console.log("url():", await page.url(), "| title():", await page.title());

let t = Date.now();
await page.waitForLoadState("domcontentloaded", 3000);
console.log(`waitForLoadState(domcontentloaded) on a loaded doc: ${Date.now() - t} ms  (expect ~immediate)`);
t = Date.now();
await page.waitForLoadState("networkidle", 3000);
console.log(`waitForLoadState(networkidle) on a static doc: ${Date.now() - t} ms  (expect ~700 ms)`);

const snap = await page.snapshot();
console.log("snapshot().formattedTree:", snap.formattedTree.split("\n").slice(0, 4).join(" | "));

console.log("Page prototype:", Object.getOwnPropertyNames(Object.getPrototypeOf(page)).filter((k) => k !== "constructor").join(" "));

try { await stagehand.act("click nothing", { timeout: 3000 }); }
catch (e) { console.log("act() without a model ->", String(e).split("\n")[0]); }

await browser.close();
console.log(`done: ${Date.now() - t0} ms`);
