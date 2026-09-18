# TrueFact: know if your browser agent's write actually landed

Your browser agent said it placed the order. The order wasn't placed. You found out from a customer.

TrueFact wraps a browser agent and reads the live page, and the network under it, after every action. It returns one verdict. Landed, did-not-land, or inconclusive. It never trusts what the agent claims. There is no LLM judge, and no API key to run the check.

The hard case is optimistic UI. The page shows a success screen while the server returned 500. Most agents report that as done. TrueFact catches it out of band, by reading the network the agent cannot hide.

New this week: `truefact watch`. Point it at any Chrome with a debug port. It verifies writes for any framework, whether that is Browser-Use, Puppeteer, Playwright, or a human clicking. It wraps nothing.

The number we protect first is false halts. A verifier that stops a good run is worse than useless. Across a 520-write benchmark over four models, TrueFact raised zero false halts, 0 out of 279. In observe mode, `watch` held the same line across 20 live sites, background telemetry and all. Still zero.

We are honest about the price. To hold zero false halts, TrueFact returns inconclusive on ~14% of good writes rather than guess. It is precision-first by design: it would rather say inconclusive than call a good run bad. Declare a postcondition (`expect`, including a `probe` against your server) on the writes that matter and most of that inconclusive turns into a real landed / did-not-land.

Runs today with Stagehand 4.x and Playwright. Install from npm, or from git (a `prepare` step builds it).
