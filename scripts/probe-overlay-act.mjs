// The thesis in one call.
// A checkout form whose "Place order" button sits under a full-viewport cookie
// overlay that swallows clicks. We ask Stagehand to place the order, then print
// its self-report (ActResult.data) beside what the page actually shows.
//   success:true  + page unchanged  -> a reported-success / did-not-land, on Day 2
//   success:false                   -> a kill-signal data point worth knowing early
// Needs a local Chrome and ANTHROPIC_API_KEY (or OPENAI_API_KEY). Costs one LLM call.
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";

const model = process.env.ANTHROPIC_API_KEY
  ? { modelName: "anthropic/claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY }
  : process.env.OPENAI_API_KEY
    ? { modelName: "openai/gpt-5.6-sol", apiKey: process.env.OPENAI_API_KEY }
    : null;
if (!model) { console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY."); process.exit(1); }

const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser, model, logging: { level: "error" } });
const page = await stagehand.browser.context.activePage();

const html = `<html><head><title>Checkout</title></head><body>
<main id="root"><h1>Checkout</h1>
<form id="f" onsubmit="event.preventDefault();document.getElementById('ok').textContent='Order placed';this.reset()">
  <label>Email <input name="email" value="a@b.co"></label>
  <button type="submit" id="submit">Place order</button>
</form><p id="ok"></p></main>
<div id="cookie" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55)">
  <div style="background:#fff;margin:20vh auto;width:320px;padding:16px">We use cookies. <button type="button">Accept</button></div>
</div></body></html>`;
await page.goto("data:text/html," + encodeURIComponent(html));

const truth = () => page.evaluate(() => ({
  confirmation: document.getElementById("ok").textContent,
  email: document.querySelector("[name=email]").value,
  centerHit: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("#cookie") ? "cookie-overlay" : "content",
}));

const before = await truth();
const t = Date.now();
let result;
try { result = await stagehand.act("click the 'Place order' button to submit the order", { timeout: 60000 }); }
catch (e) { console.log("act threw:", String(e).split("\n")[0]); }
const after = await truth();

console.log("AGENT CLAIM  (ActResult.data):", JSON.stringify(result?.data ?? null));
console.log("PAGE TRUTH   before:", JSON.stringify(before));
console.log("PAGE TRUTH   after: ", JSON.stringify(after));
console.log(`act: ${Date.now() - t} ms | usage:`, JSON.stringify(result?.metadata?.usage ?? null));
await browser.close();
