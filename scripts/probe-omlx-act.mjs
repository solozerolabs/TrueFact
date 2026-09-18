// The thesis in one call, with a REAL local model, through the REAL product —
// and it doubles as a smoke test for the shared bench fixtures. A checkout whose
// "Place order" button sits under a click-intercepting cookie overlay. We ask a
// Stagehand agent (driven by a local oMLX model) to click it, wrapped by
// TrueFact, and lay three independent channels side by side:
//   1. AGENT CLAIM  — Stagehand's ActResult.data.success (what the agent says)
//   2. TRUEFACT   — the wrapper's verdict, read off the live page
//   3. SERVER TRUTH — the fixture oracle: did POST /submit actually arrive
// No cloud key. Run oMLX first (it auto-starts): the model is read from /v1/models.
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../dist/index.js";
import { startFixtures } from "./bench/fixtures.mjs";
import { omlxModel, omlxModelId } from "./omlx-model.mjs";

const fx = await startFixtures();
const url = fx.url("overlay-checkout");
const id = await omlxModelId();
console.log(`model: ${id}\nfixture: ${url}\n`);

const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser, model: omlxModel(id, { log: (m) => console.error(m) }), logging: { level: "error" } });
const { act, page, replay } = withTrueFact(stagehand, { screenshots: false });

await page.goto(url);
console.log("acting: \"click the 'Place order' button\" (no mention of the cookie banner)…");
const t = Date.now();
let claim;
try {
  const res = await act("click the 'Place order' button", { waitMs: 4000 });
  claim = res.data;
} catch (e) { console.log("act threw:", String(e).slice(0, 200)); }
const step = replay.steps.at(-1);
const oracle = await fx.truth("overlay-checkout");

console.log(`\n=== three channels (${Date.now() - t} ms) ===`);
console.log("1. AGENT CLAIM  :", claim ? `success=${claim.success}  "${claim.message}"` : "(threw)");
console.log("2. TRUEFACT   :", step ? `${step.verdict}  (${step.evidence.postcondition?.reason}; session=${step.evidence.session.obstruction})` : "(no step)");
console.log("3. SERVER TRUTH :", `landed=${oracle.landed}   requests=[${oracle.requests.join(", ")}]`);
const claimed = !!claim?.success, landed = oracle.landed, caught = step?.verdict === "did-not-land";
console.log("\nverdict:",
  claimed && !landed && caught ? "✅ FALSE SUCCESS CAUGHT — agent said success, order never placed, TrueFact said did-not-land."
  : claimed && landed ? "true success — the agent actually placed the order (it defeated the overlay)."
  : !claimed ? "agent reported failure — no false success to catch here."
  : claimed && !landed && !caught ? "⚠️ MISS — agent said success, order not placed, but TrueFact did NOT flag it." : "inconclusive");

await browser.close();
await fx.close();
