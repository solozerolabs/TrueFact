# TrueReplay — 1-Week MVP Spec

## What TrueReplay is (one sentence)

A runtime wrapper for browser-agent write actions that reads the live page itself after every step and returns an independent verdict — **landed / did-not-land / inconclusive** — computed without trusting anything the agent claims. The gap between "agent said done" and "page says done" is the product.

## The rule that governs every design choice

TrueReplay never trusts the agent. It reads the page. The agent's claim is recorded on a **separate channel** and compared only at the end. If those two channels ever touch during measurement, the false-success number is worthless — so they don't touch.

## Delivery form (decided)

**Wrapper library (TypeScript/npm), imported.** Not a CLI, not an API/API-key service.

- Stagehand is a Node/TS framework; TrueReplay wraps its `act`/`extract` in the same process and language.
- A wrapper can't be skipped, so the benchmark number stays true. An agent-called tool (including an API-key service) is skippable, which corrupts the measurement — and a remote service couples the two channels through a boundary we don't control.
- A CLI is the wrong shape: you wrap function calls, not shell invocations.
- Hosting/API is a company, not a 7-day MVP. Revisit only if Day 6 clears the kill signal.

## What changed from the original plan, and why

1. **Anchor on writes, not reads.** Postcondition verification (did the write land?) is the durable core; grounding erodes as models stop hallucinating. Grounding stays, demoted to a bonus check. The headline benchmark number is a write number.
2. **Postconditions are auto-inferred by default.** Requiring a declared postcondition per write kills adoption at the second write. The default is "did anything change after the write?" (URL delta, DOM mutation, confirmation-shaped element appearing, form clearing). Engineers override for precision; they don't start with declaration.
3. **Session-state is co-equal with postcondition.** Blank windows, dropped sessions, CAPTCHA walls, click-intercepting overlays are silent, common, catchable with no declaration. Best effort-to-signal ratio in the design.
4. **One framework (Stagehand), benchmark front-loaded.** The benchmark is the only artifact that produces a fact nobody else has, and it's both distribution and kill signal. Build for Stagehand only, run the benchmark, then decide on browser-use / Playwright-MCP adapters.

## The three checks

| Check | Question | Default (no declaration) | Fails when | Inconclusive? |
|---|---|---|---|---|
| **Postcondition** (primary) | Did the write land? | "Did anything change after the action?" — URL delta, DOM mutation, new confirmation-shaped element, form fields cleared | Nothing changed, or declared condition is false after the action | Yes — page still loading, ambiguous state |
| **Session state** (co-primary) | Was the agent even logged in and unobstructed? | Always on, no declaration | Login wall, CAPTCHA frame, click-intercepting overlay, blank/never-navigated page | Yes — can't classify the obstruction |
| **Grounding** (bonus) | Was the extracted value actually on the page? | Match claimed values against the a11y tree | A returned value is absent from the accessibility tree at that moment | Yes — normalization ambiguity |

A checker that never says "I don't know" is lying somewhere. **Inconclusive is a first-class verdict**, tracked separately from landed / did-not-land.

## Output

- **Per step:** `{action, declaration (or "auto"), verdict, evidence, agent_claim, timestamp}`
- **Per run:** a replay — the ordered list of steps plus a single landed / did-not-land
- **Per fleet (benchmark):** four buckets — reported-success/actually-landed, reported-success/did-not-land (**the product**), reported-failure/actually-failed, reported-failure/actually-landed

## The 7-day build

- **Day 1 — Wrapper skeleton, two-channel logging.** Wrap Stagehand `act` and `extract`. Emit a landfall object per step with verdicts stubbed. Record the agent's claim and the page snapshot on separate channels from the first commit. *Done when:* a real automation runs unchanged through the wrapper and produces replays (verdicts empty).
- **Day 2 — Session-state detection** (build first; highest signal, no declaration). Login walls, CAPTCHA frames, click-intercepting overlays, blank/never-navigated pages, every step. *Done when:* a logged-out page mid-run is caught on the next step; an overlay intercepting clicks at a coordinate is flagged.
- **Day 3 — Postcondition: the auto-inferred default.** "Did anything change?" — snapshot before/after each act, diff URL/DOM, detect confirmation-shaped elements and form clearing. *Done when:* a submit onto a blocked overlay reports did-not-land with before/after frames, zero postcondition declared.
- **Day 4 — Postcondition: declared overrides.** Four declarable types on top of the default: URL changed, element present, text matches, field value equals. *Done when:* an engineer overrides the default on one write for a stricter verdict; un-overridden writes still get the auto default.
- **Day 5 — Grounding (bonus) + inconclusive plumbing.** Read the a11y tree at extract time, match claimed values: exact, then whitespace/case-normalized, else inconclusive. Wire inconclusive as a tracked verdict across all three checks.
- **Day 6 — The benchmark** (the point of the whole week). 20 real sites, reads and writes, Stagehand only. 5+ runs per site. Agent claim and page truth as separate channels. Count the four buckets. Test against a current frontier setup, not just an old default. **KILL SIGNAL:** if the write-side false-success rate comes back near zero, stop and do not publish.
- **Day 7 — Publish** (only if Day 6 cleared the kill signal). Repo + README led by the benchmark table (write number in the headline). Registry listing. One import line to install.

## Explicitly not building this week

Browser-use adapter · Playwright-MCP adapter · dashboard · screenshot judge · second-model verification · evals · simulation · auto-repair · fixing the agent. Adapters come after the benchmark proves the number, not before.

> TrueReplay says whether it landed. It never says whether it should have.

## Open questions carried forward

- **Wrapper vs agent-called tool.** Wrapper for the MVP — it can't be skipped, and the benchmark number has to be true.
- **Auto-inference coverage.** SPAs that mutate the DOM without a meaningful state change may need per-site tuning. Track how often the auto default returns inconclusive; if high, that's the real product-shaping signal.
- **Frontier-model erosion.** Run against a Claude-for-Chrome-class setup as well as a self-hosted Stagehand default. If the gap is large, the durable market is the self-hosted long tail.

## The strongest failure argument, stated plainly

The acting models may already be good enough that the write-side silent-failure rate is low on the sites people run in production, and vendors are baking confirmation steps into the agents themselves. Counter: a safety step inside the agent is still the graded party grading itself, and self-assessment is exactly what fails to catch false success. Independent verification is structurally different. The benchmark settles this — which is why it's Day 6, not month 6.
