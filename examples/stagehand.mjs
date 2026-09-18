// Stagehand + TrueFact: launch() owns the browser, so network verification is
// on with no port to configure. Run: node examples/stagehand.mjs
import { launch } from "truefact";

const tr = await launch({
  model: { modelName: "anthropic/claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY },
  jsonl: "run.jsonl", // an evidence log you can view / assert / verify offline
});

await tr.page.goto("https://shop.example/checkout");

// act() returns Stagehand's result with TrueFact's independent verdict attached.
const res = await tr.act("click 'Place order'");
console.log(res.truefact.verdict, "—", res.truefact.why);
// e.g. "did-not-land — POST /api/orders returned 500 while the page showed 'Order placed'"

await tr.close();
process.exit(tr.replay.verdict === "landed" ? 0 : 1);
