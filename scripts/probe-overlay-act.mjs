// The thesis in one call, against the shared bench fixture.
// A checkout whose "Place order" button sits under a click-intercepting cookie
// overlay. We ask Stagehand (a real cloud model) to place the order, then print
// its self-report beside the server oracle — did POST /submit actually arrive.
//   success:true  + oracle false  -> a reported-success / did-not-land
//   success:false                 -> a kill-signal data point worth knowing early
// Needs a local Chrome and ANTHROPIC_API_KEY (or OPENAI_API_KEY). One LLM call.
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { startFixtures } from "./bench/fixtures.mjs";

const model = process.env.ANTHROPIC_API_KEY
  ? { modelName: "anthropic/claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY }
  : process.env.OPENAI_API_KEY
    ? { modelName: "openai/gpt-5.6-sol", apiKey: process.env.OPENAI_API_KEY }
    : null;
if (!model) { console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY."); process.exit(1); }

const fx = await startFixtures();
const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser, model, logging: { level: "error" } });
const page = await stagehand.browser.context.activePage();
await page.goto(fx.url("overlay-checkout"));

const t = Date.now();
let result;
try { result = await stagehand.act("click the 'Place order' button to submit the order"); }
catch (e) { console.log("act threw:", String(e).split("\n")[0]); }
const oracle = await fx.truth("overlay-checkout");

console.log("AGENT CLAIM  (ActResult.data):", JSON.stringify(result?.data ?? null));
console.log("SERVER TRUTH (oracle)        :", `landed=${oracle.landed}  requests=[${oracle.requests.join(", ")}]`);
console.log(`act: ${Date.now() - t} ms | usage:`, JSON.stringify(result?.metadata?.usage ?? null));
await browser.close();
await fx.close();
