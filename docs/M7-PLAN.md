# M7 — the second driver: the call, and the plan

Status: decided 2026-09-17, from a 7-lens review (docs/context7, web research, GitHub peers, codebase, tests, an empirical CDP spike, devil's advocate). Pre-production; anything may be rewritten.

## The decision

**Build a driver seam. Each driver brings its own read source behind it (Stagehand → native `formattedTree`; Playwright → CDP). Do NOT migrate the certified Stagehand path onto CDP, and do NOT market a lie-detector to drivers that don't lie.**

> **CORRECTION 2026-09-17.** Axis 1 below originally called for *one CDP-native reader for every driver*, migrating Stagehand onto it. That rested on a false premise — Stagehand v4 exposes no raw CDP (it brand-locks the browser handle), so "one reader, no port, serves all" is unreachable. See the dropped **Phase 1** note. The seam (Axis 2) and the UX call (Axis 3) stand; the reader-transport axis is superseded by **per-driver readers**.

This is not "Option A (Playwright adapter)" or "Option B (CDP reader)" as posed. The review dissolved that framing into three separable axes, decided below.

### Axis 1 — reader transport: ~~CDP-native, for every driver~~ → per-driver (superseded, see correction above)

The spike showed a raw-CDP reader reproduces every classifier signal and is ~6x faster (1.0ms vs 5.5ms) — but reaching CDP *through Stagehand* is impossible (no `sendCDP`; the handle is brand-locked). So the "one reader serves all" prize is gone. The classifier only needs before/after self-consistency from *one* reader, and `formattedTree` already provides that for Stagehand (byte-identical form reads, all role signals). Each driver therefore keeps whatever read source it natively has; the `PageReader` seam hides the difference. Playwright, which removed `page.accessibility` in v1.57, brings CDP via `newCDPSession` (natively available there, unlike Stagehand).

### Axis 2 — the seam: adopt the codebase review's `PageReader` / `Driver`.

- `PageReader` = the verdict channel's reads: `snapshotTree()`, `evaluate(fn,arg)`, `url()`, `count(sel)`, `screenshot()`, `waitForLoadState()`, `id`.
- `Driver` = the agent channel + tab resolution: `act`/`extract`/`observe` (optional — see Axis 3), `goto()→{status}`, `activePage()`, `readerFor(handle)`, and **`cdp(method,params)`** — the CDP session the shared reader uses.
- The reader gets its CDP handle **from the driver**, not from a launch port. Stagehand exposes a CDP session (`page.sendCDP`); Playwright has `newCDPSession(page)`. This means **CDP reads work for `withReplay(stagehand)` with no port** — fixing today's rule that network needs `launch({port})`. Independence is preserved where it matters: the reader reads the *page*, never the agent's claim. A separate CDP *client* (the current network sidecar) is a nice-to-have, not the thesis.

### Axis 3 — the product/UX question the devil's advocate raised (and it is right to). "Above all, best UX."

TrueFact's flagship framing — "your agent said done; it wasn't" — needs an **agent with a claim**. A hand-written Playwright script (`page.click('#submit')`) has no self-report to disbelieve, so the "independent channel" has nothing to be independent *from*. Therefore:

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

**Phase 1 — DROPPED 2026-09-17. The premise was false; per-driver readers instead.**

The plan assumed the CDP reader would get its handle *from the driver* via `stagehand.sendCDP`, "so CDP reads work for `withReplay(stagehand)` with no port." **That method does not exist.** Stagehand v4 brand-locks its browser handle and exposes no raw CDP anywhere on `Page`/`BrowserContext`/`StagehandBrowser` — its own source comment: *"The private brand prevents arbitrary CDP connections from being passed to Stagehand."* The only way to reach CDP on Stagehand's Chrome is a second, independent CDP client over the debug port (what `sidecar.ts` already does), which needs `launch({port})`.

So "one CDP reader, no port, serves every driver" is **unreachable**: Stagehand and a future Playwright driver will always have different transports. Once the unification prize is gone, migrating the *certified* Stagehand path onto CDP buys ~4.5ms/read and costs a full re-certification of the verdict engine — the trade the devil's advocate flagged and KISS rejects.

**The call (user, 2026-09-17): per-driver readers. Skip the Stagehand rewrite.** Stagehand keeps its native `formattedTree` reader — the spike already showed it reads forms byte-identically and reproduces every classifier signal, and the classifier only needs before/after self-consistency from *one* reader, which per-driver readers preserve. The Phase 0 seam (`PageReader`) is exactly what makes this clean: each driver brings its own read source behind a uniform interface, and the classifier never knows the difference. Iframe stitching stays a standalone §12 gap fix, attached to whichever reader needs it, not a blocker here.

**Phase 1.5 — redaction gate (before Phase 2, per user).** Capture-time redaction: drop auth/cookie headers, hash cookie values, mask declared fields, opt-in bodies. The devil ranked this above a second driver for adoption (§11.2); an ops/fintech ICP cannot instrument a tool that writes cookies to disk.

**Phase 2 — the second driver. ✅ DONE 2026-09-17.**
`src/driver-playwright.ts`: duck-typed `playwrightDriver(page)` + `playwrightReader(page)` (tree via `newCDPSession`→`Accessibility.getFullAXTree`, normalized by the pure `axToLines` to the classifier's line grammar) + `axToLines`. `act` takes an action object and drives the locator with no claim (agent_claim degrades to null via a one-line gate in `run()`: only a result carrying `success` seals a claim). No Playwright dependency in `src` — the caller brings the Page; `playwright-core` is a devDep for the test. **202 tests green (+2: the pure normalizer + a real headless-Chromium write to `landed` with a valid chain).** Original sketch:
`playwrightDriver(page)`: drive verbs wrap `page.click/fill/goto`; `evaluate` is Playwright's native `page.evaluate` (spike: drop-in); its `PageReader.snapshotTree()` comes from Playwright's own CDP (`newCDPSession(page)` → `Accessibility.getFullAXTree`, normalized to the same `role: text [markers]` line grammar) — Playwright exposes CDP where Stagehand does not; tab identity via object identity + `context.on('page')`. The seam is already proven, so this is a self-contained driver + its own reader, no change to the Stagehand path. Add `playwright` as a devDep + a `withPlaywrightBrowser` test fixture. First target: LLM-driven Playwright / Playwright-MCP (claim present); document the honest degrade for scripted use.

Estimate: Phase 0 ~0.5d (done), Phase 1.5 ~1d, Phase 2 ~1.5d (Playwright's AXTree→line-grammar normalizer is the new cost that the dropped Phase 1 would have shared). Phase 1's ~2–3d rewrite is gone.

## Open questions — answered

1. **Trustworthy verdict vs zero-config breadth (§11.1).** The seam gives breadth (any driver plugs in) without touching the verdict logic, so trust is preserved by *not* rewriting the certified path. Whether buyers *pay* is a user question; this plan doesn't substitute for the three conversations §10b ordered.
2. **Default capture size / redaction (§11.2, §12).** This is the **more urgent adoption blocker than a second driver** (devil, correctly). v2 capture stores DOM/bodies/cookies/storage = tokens + PII by default. Fix redaction-at-capture *before or alongside* Phase 2 — an ops/fintech ICP cannot instrument a tool that writes cookies to disk. Elevated to a Phase-1.5 gate.
3. **Which second driver first (§11.3).** Playwright (Node, same process, lowest friction, matches the request) — but aimed at *LLM-driven* Playwright usage, not hand scripts. Browser-Use (Python, largest LLM-agent community, already CDP-native) is the strong second; being CDP-native it brings its own reader the same way Playwright does.

## The honest strategic caveat (unchanged)

The spec's §10b already ordered outreach before more building, and §11.1 says only users settle the breadth question. This plan is the *right thing to build if we are committing to multi-driver* — and it also makes the current single-driver product faster and its headline claim true, which is meaningful on its own. But it is still building over selling. Recommendation stands: the three conversations and the redaction fix outrank Phase 2 in priority, even though Phase 0/1 are worth doing regardless because they harden and speed the product we already have.
