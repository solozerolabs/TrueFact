// Playwright + TrueFact: no LLM, no agent claim to disbelieve — just the
// independent "did it land?" read. Pass your own Chrome's debug port for the
// network verdict. Run: node examples/playwright.mjs
import { chromium } from "playwright";
import { withTrueFact, playwrightDriver } from "truefact";

const port = 9222;
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
const page = await browser.newPage();

const tr = withTrueFact(playwrightDriver(page), { network: { port } });
await tr.page.goto("https://shop.example/checkout");

const res = await tr.act({ selector: "#place-order", method: "click" });
console.log(res.truefact.verdict, "—", res.truefact.why);

// Handy in a test: throws with the reason unless the last write landed.
tr.replay.assertLanded();

await tr.close();
await browser.close();
