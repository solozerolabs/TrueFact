# TrueFact: know if your browser agent's write actually landed

Your browser agent said it placed the order. The order wasn't placed. You found out from a customer.

TrueFact wraps a browser agent and reads the live page, and the network under it, after every action. It returns one verdict. Landed, did-not-land, or inconclusive. It never trusts what the agent claims. There is no LLM judge, and no API key to run the check.

The hard case is optimistic UI. The page shows a success screen while the server returned 500. Most agents report that as done. TrueFact catches it out of band, by reading the network the agent cannot hide.

New this week: `truefact watch`. Point it at any Chrome with a debug port. It verifies writes for any framework, whether that is Browser-Use, Puppeteer, Playwright, or a human clicking. It wraps nothing.

The number we protect first is false halts. A verifier that stops a good run is worse than useless. Across a 520-write benchmark over four models, TrueFact raised zero false halts, 0 out of 279. In observe mode, `watch` held the same line across 20 live sites, background telemetry and all. Still zero.

We are honest about the other axis. Recall, catching every lie a page tells, is harder, and that number is still being measured. TrueFact is precision-first by design. It would rather say inconclusive than call a good run bad.

Install from git, no build step. It runs today with Stagehand 4.x. Playwright is next.
