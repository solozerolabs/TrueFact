# Which direction? Online complaint evidence, 2026-09-17

Three candidate directions were on the table:

- **A — BUSINESS.md:** post-action correctness. "Did the write land?" read from the page, agent never trusted.
- **B — Meter & Receipt:** tamper-evident meter/ledger for outcome-priced agent work; async out-of-band reconciliation + cross-customer portal-drift corpus; insurers as buyers.
- **C — SPEC-V2:** one evidence packet, three readers in order: dev (verdict, timeline, re-assert) → ops (true success rate, failed-run queue, canary) → compliance (signed export).

Method: three parallel web-research passes (~40 searches, ~60 page fetches). Reddit was unreachable from this environment; Reddit quotes are second-hand. No first-hand "I would pay for X" quote was found for any direction. Willingness to pay is inferred from pricing pages, funding, and policy conditions.

## Verdict

**C wins, and it wins because it contains the only parts of A and B that have complaints behind them.**

| | Pain is first-hand & recent | Pain is unmet | Someone pays | Fit with what TrueReplay does |
|---|---|---|---|---|
| A verdict | strongest (5 GitHub issues in last 2 weeks) | frameworks absorbing it (Stagehand PR #2901 same day, browser-use Judge) | none shown | exact |
| B meter | real, recurring money disputes | vendors answer with their own meter; nobody asks for a neutral one | insurers: logs are a policy condition | weak: disputes are chat resolutions, not browser writes |
| C packet | 306-practitioner survey: reliability unsolved | "which runs actually failed" is unmet; tracing tools "have no opinion on correctness" | tracing market pays heavily ($80M Braintrust B; $3.9k–$50k/mo LangSmith) | exact for rungs 1–2; rung 3 commoditizing |

## A — the in-session verdict

Complaints (dev, GitHub/dev.to, Aug–Sep 2026 unless noted):
- Vercel agent-browser click "returned success while the page never received the click: no submit, no network request, no DOM change." https://github.com/seasonedcc/seasoned-skills/issues/336 (2026-09-17)
- jiuwenswarm: `success=True` while browser status is `failed`. https://github.com/openJiuwen-ai/jiuwenswarm/issues/6008 (2026-09-15)
- AMD GAIA loop guard stops the agent then reports "Task completed." https://github.com/amd/gaia/issues/3750 (2026-09-14)
- browser-use: agent says "Successfully … added to the cart", built-in Judge says FAIL. https://github.com/browser-use/browser-use/issues/3615 (2025-11)
- "My Agent Returned Success. The Browser State Said Otherwise" https://dev.to/raju_dandigam/my-agent-returned-success-the-browser-state-said-otherwise-5eb1
- "Applied to 10 jobs. Task complete." — zero submitted. https://dev.to/zubair_khalid_e44298e6f0f/why-your-agent-says-it-finished-when-it-didnt-2g0n
- Skyvern docs: agent may "optimistically assume that clicking a Submit button completed the task." https://www.skyvern.com/docs/getting-started/prompting-guide
- arXiv 2512.07497: 75.8% of failures with a status claim were false-success.
- arXiv 2604.17849: 78% single-attempt pass, 36% pass all 10 repeats.

Read: the pain is the most vivid of the three, but every poster solved it with a DIY before/after check, and the frameworks are now shipping judges. Nobody asked for a third-party verifier. Nobody found checked page **and** network; that gap is real but small. **A is the mechanism, not a product.**

## B — the meter and receipt

Complaints (buyer, community forums, 2025–2026):
- Intercom Fin: "16 marked resolved by Fin … 9 of 16 are not solved by Fin at all … actual resolve rate 12.5%." https://community.intercom.com/fin-product-feedback-member-group-49/fin-s-flawed-resolution-assumption-10516
- Intercom Fin: "Lower customer satisfaction. Longer resolve times. Incorrect Fin statistics. More expensive invoices." https://community.intercom.com/ask-the-intercom-team-about-fin-54/fin-s-flawed-assumed-resolved-pricing-design-8929
- r/SaaS (second-hand): "$4k/month … now it's shot up to $9k." https://clearfeed.ai/blogs/intercom-pricing
- r/Zendesk (second-hand): "ARs are a rip off." https://www.getmacha.com/blog/zendesk-reddit-opinions
- Siena buyer: "I spend 5 hours a week arguing with our vendor about what counts as resolved." https://www.siena.cx/blog/conversation-vs-outcome-based-pricing-ai-agent
- Salesforce Flex Credits: >10k-token actions counted multiple times. https://www.salesforceben.com/understanding-common-agentforce-pain-points-and-how-salesforce-addresses-them/

How the market answered:
- Zendesk (2026-05-14) now bills only "Verified" resolutions, verified by **its own** evaluation model. https://support.zendesk.com/hc/en-us/articles/10677925692698-Announcing-changes-to-AI-agent-reporting
- Salesforce: Digital Wallet dashboard (its own meter).
- Advisors name the third-party option (Nevermined checklist; Deloitte "agreed-upon method"), buyers don't. https://nevermined.ai/blog/ai-agent-outcome-based-pricing https://dart.deloitte.com/USDART/home/publications/deloitte/industry/technology/accounting-outcome-based-pricing-agentic-ai

Insurers (the only clear pay signal):
- "A policy that requires tamper-evident logging … will not pay a claim if those logs do not exist or have been altered." https://agentinsured.eu/articles/how-ai-insurance-claims-work-what-triggers-payment
- Armilla/AIUC ask "whether every action leaves an audit trail, before they'll even quote a price." https://startupfortune.com/how-does-ai-agent-liability-insurance-actually-work/
- arXiv 2606.05449: performance-trigger metrics "must be independently measurable and resistant to manipulation."

Receipts are already a category: 15+ products at $19–$599/mo, driven by EU AI Act Art. 12, not billing disputes. https://github.com/JaredKlopstein/provenant/issues/6

Read: the disputes are real and cost money, but (1) they are about **chat resolutions**, where there is no page write for TrueReplay to read; (2) the winning fix so far was the vendor's own model, not a neutral party; (3) **zero complaints** mention out-of-band reconciliation (batch files, EDI acks) or portal drift. The moat pieces of B have no demand evidence at all. The receipt piece is commoditizing. The insurer channel is real but it wants a signed log, which already exists (chain.ts).

## C — packet, three readers

Complaints:
- arXiv 2512.04123 (306 practitioners, Dec 2025): "Reliability remains unsolved"; 74% rely primarily on human evaluation; every team using LLM-as-judge also uses humans.
- "I Had Thousands of Agent Traces and Still Couldn't Tell Which Sessions Failed" — tracing tools "have no opinion on whether the output was correct." https://daily.dev/posts/i-had-thousands-of-agent-traces-and-still-couldn-t-tell-which-sessions-failed-5cga5d8xt
- arXiv 2606.14589: 4,286 tests green during 22 incidents; ~70% of silent failures caught by a human eyeballing output.
- HN (2026-03): "Zero errors, plausible output, wrong result." https://news.ycombinator.com/item?id=47358618
- arXiv 2606.10315: production LLM judge surfaced 22% of human-confirmed problems; gate flagged 0 of 100 rounds with 23 defects.
- browser-use #2808: user re-ran WebVoyager, "success rate did not reach 89.1%." https://github.com/browser-use/browser-use/issues/2808
- Browserbase on its own replay: "looked correct at first glance while lying about what actually happened." https://www.browserbase.com/blog/session-recordings
- Stagehand #1558: cache replay skips credential fill and custom tools. https://github.com/browserbase/stagehand/issues/1558
- LangChain #35357 and Langfuse #12774: requests for hash-chained/signed traces, no maintainer action. https://github.com/langchain-ai/langchain/issues/35357 https://github.com/langfuse/langfuse/issues/12774
- LangSmith customers "sample down to 0.1%" to afford it; $50k/mo cited. https://pydantic.dev/articles/ai-observability-pricing-comparison

Served vs unmet:
- Served: span tracing, video replay (Browserbase, Jan 2026), crash-resume (Temporal/Inngest).
- **Unmet:** knowing which runs actually failed without humans or a judge; deterministic offline re-assertion; signed logs from an incumbent.
- Commoditizing: signed export (IETF draft-sharif-agent-audit-trail, agentrust/LF, 15+ receipt products).

Negative signal: Show HNs for replay/evidence tools got 3–4 points each. Pain posts get engagement, solution posts don't.

## What this means for sequencing

1. **Keep A as the engine, not the pitch.** The verdict is done and benchmarked. Frameworks will ship a judge; the deterministic page+network read is the differentiator, and it is what makes rung 2 possible without humans.
2. **Build C rung 2 next: the fleet number and the failed-run queue**, computed from deterministic verdicts, not a judge. That is the empty box with the largest population (every team on LangSmith/Langfuse at 0.1% sampling) and the only need nobody serves.
3. **Rung 3 is already built enough.** chain.ts + `verify` is what insurers ask for. Pitch it as a channel; do not build a ledger, reconciliation adapters, or a drift corpus until a customer with a batch-ack workflow exists. No complaint found asks for them.
4. **B's disputes live in chat support.** If you want that market you need a resolution reader, not a page reader. Different product.
5. **The title agency is a separate bet.** Nothing in this research supports or refutes it.

## Gaps
Reddit direct threads unreachable; no compliance-officer or CFO first-hand quote; no explicit willingness-to-pay quote for any direction.
