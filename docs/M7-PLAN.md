# M7 — the second driver: the call, and the plan

Status: decided 2026-09-17, from a 7-lens review (docs/context7, web research, GitHub peers, codebase, tests, an empirical CDP spike, devil's advocate). Pre-production; anything may be rewritten.

## The decision

**Build a driver seam and a single CDP-native reader. Migrate the Stagehand driver onto it and re-certify. Then add the second driver as a thin layer. Do NOT write per-framework readers, and do NOT market a lie-detector to drivers that don't lie.**

This is not "Option A (Playwright adapter)" or "Option B (CDP reader)" as posed. The review dissolved that framing into three separable axes, decided below.

### Axis 1 — reader transport: CDP-native, for every driver. (was the A/B question)

The empirical spike settles it. A raw-CDP reader:
- reads **form values byte-identically** to today (because `safeRead` is already `page.evaluate` = CDP `Runtime.evaluate` underneath);
- reproduces **every role signal** the classifier keys on (`status`/`alert`/`dialog`/`button`/`textbox`/`checkbox`), because the classifier needs self-consistency between before/after from one reader, not byte-parity with Stagehand;
- is **~6x faster** (1.0ms vs 5.5ms per full read), which is latency the write hot path polls repeatedly.

The ecosystem confirms it: Stagehand and Browser-Use **both** build their a11y tree from CDP `Accessibility.getFullAXTree`; Playwright **removed** `page.accessibility` in v1.57 and points you at CDP via `newCDPSession`. One CDP reader serves any Chrome driver from one codebase. This makes the README's already-published claim — "the reader attaches to Chrome, not the framework" — **true**, where today it is ~20% true (only the network sidecar is CDP; the tree/forms/session/field reads all run through Stagehand's `page.snapshot().formattedTree`).

Rejected: keeping Stagehand's `formattedTree` and writing a second reader for Playwright. That is N readers forever, leaves the core claim aspirational, keeps the slow path, and — per the spike — forces byte-matching Stagehand's idiosyncratic vocabulary (`combobox`→`select`, whitespace, collapsed StaticText) which is exactly the fragile work.

### Axis 2 — the seam: adopt the codebase review's `PageReader` / `Driver`.

- `PageReader` = the verdict channel's reads: `snapshotTree()`, `evaluate(fn,arg)`, `url()`, `count(sel)`, `screenshot()`, `waitForLoadState()`, `id`.
- `Driver` = the agent channel + tab resolution: `act`/`extract`/`observe` (optional — see Axis 3), `goto()→{status}`, `activePage()`, `readerFor(handle)`, and **`cdp(method,params)`** — the CDP session the shared reader uses.
- The reader gets its CDP handle **from the driver**, not from a launch port. Stagehand exposes a CDP session (`page.sendCDP`); Playwright has `newCDPSession(page)`. This means **CDP reads work for `withReplay(stagehand)` with no port** — fixing today's rule that network needs `launch({port})`. Independence is preserved where it matters: the reader reads the *page*, never the agent's claim. A separate CDP *client* (the current network sidecar) is a nice-to-have, not the thesis.

### Axis 3 — the product/UX question the devil's advocate raised (and it is right to). "Above all, best UX."

TrueReplay's flagship framing — "your agent said done; it wasn't" — needs an **agent with a claim**. A hand-written Playwright script (`page.click('#submit')`) has no self-report to disbelieve, so the "independent channel" has nothing to be independent *from*. Therefore:

- **The core transfers fully; the framing does not.** The independent read-after-write verdict (did-not-land detection, optimistic-UI catch, obstruction detection) is valuable for *any* driver — an overlay-swallowed click or a silently-rejected form is a silent failure whether or not an LLM issued it. What needs an agent is only the *"the agent lied"* narrative.
- **Target LLM-driven usage first, not hand-written scripts.** The second-driver ICP is *LLM agents that happen to drive via Playwright / Browser-Use / Playwright-MCP* — those carry an intent string and a claim, so the full product applies. Marketing the lie-detector to deterministic-script users is selling to the wrong persona (devil's sharpest point).
- **Degrade honestly.** When a write carries no claim, `agent_claim` is `null`, the claim-sealing invariant is a no-op (nothing to seal), and the verdict is a pure page/network read. That is honest and still useful; we pitch it as *"did your action actually land."* We never fabricate a claim to keep the narrative.
- **Don't force `act`.** The wrapper's verbs are driver-provided. Stagehand keeps `act/extract/observe`. A Playwright driver records the user's own `click/fill/goto` (intent = a caller description or the selector; claim = null). `intent` stays the assertion/timeline key; for scripted use it's the description, not a natural-language `act`.

## Why this order retires the risk (answering tests + devil)

The devil's decisive catch: "a second driver on the same reader" secretly contains a rewrite of the certified verdict path, and the 1-day estimate never priced it. **True — so we make the rewrite explicit and do it on Stagehand first, where we have 198 tests and can A/B the old reader against the new one on identical fixtures.** We find any verdict regression on the driver we know best, before a second driver exists. The devil's nightmare (shipping an uncertified reader on a new driver with the old cert stapled on) is exactly what phase order prevents.

Re-certification is tiny-run, per the standing preference ([[prove-with-tiny-runs]]): run the existing hermetic trap fixtures + the sidecar/probe suites through the CDP reader, confirm identical verdicts and zero false halts, and A/B-diff old-vs-new reader on every fixture. No full ladder.

## Phases

**Phase 0 — the seam (zero behavior change). ✅ DONE 2026-09-17.**
`src/driver.ts` has `PageReader`/`Driver` and `stagehandReader`/`stagehandDriver`. Read path (session/postcondition/declaration) retyped `Page`→`PageReader`; `readTree` delegates to `reader.snapshotTree()`; `pageId`→`reader.id`. `withReplay(source)` accepts a Stagehand (wrapped via `stagehandDriver`) **or** a ready `Driver` (the Phase 2 entry point), so all call sites and `launch()` are unchanged. `normalizeTree` stays in postcondition.ts (still tested there) and the Stagehand reader uses it — a CDP reader will emit normalized lines directly. **199 tests green (was 198, +1 proving the Driver boundary); the Stagehand path still calls `page.snapshot()`, so behavior is identical.**

**Phase 1 — the shared CDP reader + Stagehand onto it + re-cert.**
- `src/reader-cdp.ts`: `snapshotTree()` from `Accessibility.getFullAXTree` (spike sketch — DFS `childIds`, drop `ignored`/`none`/`generic`/`InlineTextBox`, append `[selected]`/`[checked]` from AX `properties`), and `evaluate()` via `Runtime.evaluate`. Reader takes a `cdp(method,params)` from the driver.
- **Iframe stitching** — the one real cost. Enumerate frames, `getFullAXTree` per `frameId`, splice at the iframe node; cross-origin OOPIFs via `Target.attachedToTarget`. This reuses (and finally builds) the multi-target machinery `sidecar.ts` already flags as missing — which is also the §12 fintech-popup gap, so it pays double.
- Switch `stagehandDriver` to source the reader from CDP (`stagehand.sendCDP`). A/B-diff vs `formattedTree` on all fixtures; update the ~15-20 assertions that hardcode Stagehand's line vocabulary to the CDP grammar; re-cert cry-wolf on the hermetic traps.
- Opportunity (only if clean): drop the launch port and route the network sidecar through `driver.cdp` too, deleting `freePort`/`{port}`. Leave the proven port path if migration isn't clean.

**Phase 2 — the second driver.**
`playwrightDriver(page)`: drive verbs wrap `page.click/fill/goto`; `evaluate` is Playwright's native `page.evaluate` (spike: drop-in); `cdp` from `newCDPSession(page)`; tab identity via object identity + `context.on('page')`. The reader is already shared and proven, so this is thin. Add `playwright` as a devDep + a `withPlaywrightBrowser` test fixture. First target: LLM-driven Playwright / Playwright-MCP (claim present); document the honest degrade for scripted use.

Estimate: Phase 0 ~0.5d, Phase 1 ~2–3d (iframe stitching dominates), Phase 2 ~1d. The old "M7 = 1 day" was mispriced because it hid Phase 1.

## Open questions — answered

1. **Trustworthy verdict vs zero-config breadth (§11.1).** Less of a tradeoff than feared: the CDP reader gives *both* — faster (trustworthy-cheap) and broader (any Chrome driver). Still, whether buyers *pay* is a user question; this plan doesn't substitute for the three conversations §10b ordered. It does make the eventual breadth real instead of claimed.
2. **Default capture size / redaction (§11.2, §12).** This is the **more urgent adoption blocker than a second driver** (devil, correctly). v2 capture stores DOM/bodies/cookies/storage = tokens + PII by default. Fix redaction-at-capture *before or alongside* Phase 2 — an ops/fintech ICP cannot instrument a tool that writes cookies to disk. Elevated to a Phase-1.5 gate.
3. **Which second driver first (§11.3).** Playwright (Node, same process, lowest friction, matches the request) — but aimed at *LLM-driven* Playwright usage, not hand scripts. Browser-Use (Python, largest LLM-agent community, already CDP-native) is the strong second, and the shared CDP reader makes it a drive-verb shim.

## The honest strategic caveat (unchanged)

The spec's §10b already ordered outreach before more building, and §11.1 says only users settle the breadth question. This plan is the *right thing to build if we are committing to multi-driver* — and it also makes the current single-driver product faster and its headline claim true, which is meaningful on its own. But it is still building over selling. Recommendation stands: the three conversations and the redaction fix outrank Phase 2 in priority, even though Phase 0/1 are worth doing regardless because they harden and speed the product we already have.
