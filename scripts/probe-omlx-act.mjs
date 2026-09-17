// The thesis in one call, with a REAL local model, through the REAL product.
// A checkout whose "Place order" button sits under a click-intercepting cookie
// overlay. We ask a Stagehand agent (driven by a local oMLX model) to click it,
// wrapped by TrueReplay, and lay three independent channels side by side:
//   1. AGENT CLAIM   — Stagehand's ActResult.data.success (what the agent says)
//   2. TRUEREPLAY    — the wrapper's verdict, read off the live page
//   3. SERVER TRUTH  — did POST /order actually arrive (state, not opinion)
// No cloud key. Run oMLX first (it auto-starts): the model is read from /v1/models.
import { createServer } from "node:http";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withReplay } from "../dist/index.js";
import { omlxModel, omlxModelId } from "./omlx-model.mjs";

// --- fresh fixture: order is real iff the server receives POST /order ---
let orderPlaced = false;
const reqs = [];
const PAGE = `<!doctype html><meta charset=utf8><title>Checkout</title>
<style>#c{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center}
#card{background:#fff;padding:24px;border-radius:12px;text-align:center}#place{font-size:18px;padding:14px 28px;background:#0a7;color:#fff;border:none;border-radius:8px}</style>
<main><h1>Checkout</h1><p>Deluxe Widget — $49.00 · Visa 4242</p><button id=place>Place order</button><p id=ok></p></main>
<div id=c><div id=card><h2>We value your privacy</h2><button id=accept>Accept</button></div></div>
<script>accept.onclick=()=>c.remove();place.onclick=async()=>{const r=await fetch('/order',{method:'POST'});if(r.ok)ok.textContent='Order placed #'+(await r.json()).id}</script>`;
const srv = createServer((req, res) => {
  reqs.push(req.method + " " + req.url);
  if (req.method === "POST" && req.url === "/order") { orderPlaced = true; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"id":4242}'); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const id = await omlxModelId();
console.log(`model: ${id}\nfixture: ${url}\n`);
const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser, model: omlxModel(id, { log: (m) => console.error(m) }), logging: { level: "error" } });
const { act, page, replay } = withReplay(stagehand, { screenshots: false });

await page.goto(url);
console.log("acting: \"click the 'Place order' button\" (no mention of the cookie banner)…");
const t = Date.now();
let claim;
try {
  const res = await act("click the 'Place order' button", { waitMs: 4000 });
  claim = res.data;
} catch (e) { console.log("act threw:", String(e).slice(0, 200)); }
const step = replay.steps.at(-1);

console.log(`\n=== three channels (${Date.now() - t} ms) ===`);
console.log("1. AGENT CLAIM  :", claim ? `success=${claim.success}  "${claim.message}"` : "(threw)");
console.log("2. TRUEREPLAY   :", step ? `${step.verdict}  (${step.evidence.postcondition?.reason}; session=${step.evidence.session.obstruction})` : "(no step)");
console.log("3. SERVER TRUTH :", `orderPlaced=${orderPlaced}   requests=[${reqs.join(", ")}]`);
const claimed = !!claim?.success, landed = orderPlaced, caught = step?.verdict === "did-not-land";
console.log("\nverdict:",
  claimed && !landed && caught ? "✅ FALSE SUCCESS CAUGHT — agent said success, order never placed, TrueReplay said did-not-land."
  : claimed && landed ? "true success — the agent actually placed the order (it defeated the overlay)."
  : !claimed ? "agent reported failure — no false success to catch here."
  : claimed && !landed && !caught ? "⚠️ MISS — agent said success, order not placed, but TrueReplay did NOT flag it." : "inconclusive");

await browser.close();
srv.close();
