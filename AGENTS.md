# AGENTS.md — working in this repo

TrueFact is a TypeScript/npm wrapper around Stagehand that records what a browser agent did and computes an independent `landed / did-not-land / inconclusive` verdict per write by reading the live page. Read [SPEC.md](SPEC.md) (product), [docs/FINDINGS.md](docs/FINDINGS.md), [docs/WATCH-PLAN.md](docs/WATCH-PLAN.md) and [docs/SERVE.md](docs/SERVE.md) before changing anything.

The module map (`src/`):
- `index.ts` — `withTrueFact(source, opts)`: the bracket. Per `act`/`extract`/`observe`/`goto` it captures before-state, runs the action, reads the page, composes the verdict, redacts, hash-chains, and attaches `res.truefact`. `whyOf`, `verdictView`, `Replay`/`assertLanded` live here. `evidence.observer` records whether the network channel could see (`watched | blind | off`, plus `lost`); `evidence.context` records the CDP `targetId` + origin read before and after; `Step.actor` (caller-supplied, stored verbatim, never read by a verdict) and `Step.observer` (`truefact@<version>`) are stamped in `recorder()` for the bracket, `openRun` and `watch` alike.
- `postcondition.ts` — pure verdict logic: `classify` (a11y-tree/form diff → outcome), `fieldPostcondition`, `sessionVerdict`, `applyNetwork` (network DEMOTES only), `decideWrite`.
- `session.ts` — obstruction/`settle` (fingerprint) and evidence types. `driver.ts` + `driver-playwright.ts` + `driver-cdp.ts` — the reader/driver seam (Stagehand, Playwright, raw CDP).
- `netwatch.ts` — the one network reader (`trackWrites`): one outcome per mutating request, shared by both consumers. `sidecar.ts` — wrapped-mode policy over it (origin filter, retry-collapse, in-flight settle). `watch.ts` — observe-mode (`truefact watch`, live per-request verdicts).
- `cdp.ts` — raw-CDP transport: `cdpConnect` (single page target, for the reader + `watch`), `cdpConnectBrowser` (browser target + `setAutoAttach{flatten}`, for the sidecar's multi-target network), `cdpConnectFd`/`cdpConnectSocket` (the serve fd bridge).
- `record.ts` — the verdict for a write with no page: `openRun().write(label, action, { read, expect })` (also on `withTrueFact`). The caller's `read` of the system of record, before and after, is the evidence; `expect` is data (subset match / RegExp / `null` = gone). Pure `matchExpect`/`decideRecord`/`changedPaths` + the polled `readBack`. The recorder (redact, chain, sign, jsonl) in `index.ts` is shared by every entry point, so a mixed run is one chain.
- `serve.ts` — `truefact serve`: the bracket as a line-protocol sidecar process. `chain.ts` — hash chain + ed25519 signing. `declaration.ts`/`grounding.ts` — declared postconditions and extract-grounding. `bench.ts` + `scripts/bench/` — the pure scorer, the one fixture source with a server oracle, the runner.
- `scripts/live/` — the real-site false-`landed` campaign (not a library module): `inject.mjs` (manufacture a known did-not-land on its own CDP client), `oracle.mjs` (pure independent truth), `sites.mjs` (pre-registered strata), `run.mjs`/`score.mjs`. Scores with `bench.ts`'s claim-independent `falseLanded`.

A local benchmark pilot validated the harness end to end (exec false-success 60%, cry-wolf 0/12); the publish gate lives in `scripts/bench/`.

Day 5 facts (probed, `npm run probe:tree`):
- `snapshot().formattedTree` splits text across inline markup into separate `StaticText:` lines (`Total: <strong>$1,249.00</strong>` is two lines). Never match a value per line; match over the role-stripped lines joined with a space.
- The tree includes input values, `[selected]`/`[checked]`, `alt`, `aria-label`, shadow DOM, iframe content and below-the-fold text; it omits `title` attributes, `display:none` and `aria-hidden` content; passwords are masked. Whitespace is already collapsed.
- `extract` reads the same accessibility tree (plus a viewport screenshot with `screenshot: true`); its options are a strict object (`model`, `timeout`, `screenshot`, `cache`, `locator`, `ignoreLocators`, `page`). `options.page` can target a non-active tab — read the tree from that page.

Day 4 rules (declared postconditions):
- Declarations are **data** (`Declaration` tagged union), never callbacks. A callback can read `ActResult`; that is the agent's claim inside a verdict.
- `act` options are parsed by Stagehand with `z.strictObject` and **throw on unknown keys** — strip `expect`/`waitMs` before delegating.
- A met declaration lifts only `no-change` / `changed-unclassified` / `hash-only-nav` / heuristic `landed`. It never overrides `validation-error`, a corroborated `no-change`, or the destination gate. `absent` declarations only tighten. Reject vacuous declarations at call time.
- `locator(sel).count()` is the only Locator read that does not throw on zero matches; gate `isVisible()`/`innerText()` behind it. `waitForSelector` **rejects** on timeout.
- Bare `no-change` is `inconclusive`; with a session obstruction it is `did-not-land`. Exception: a heuristic `login-wall` the write never LEFT (same URL, same tab) is the page it operates — an auth form under test — so it neither demotes nor corroborates (`sessionVerdict(..., stayedPut)`); a bounce INTO a wall still does.
- `state-toggled` (landed, heuristic): the only diff is a control's own state marker flipping. `axToLines` emits `[pressed]`/`[expanded]` beside `[checked]`/`[selected]`; `[checked]`/`[selected]` must keep role + name, an ARIA toggle (`[pressed]`/`[expanded]`) may relabel itself ("Show password" → "Hide password").

CI: install a Chrome that `localBrowser.launch` can find (`browser-actions/setup-chrome` or `npx playwright install chrome`); root containers need `--no-sandbox` via `launch({ args })`; `headless: true` always; every test passes `screenshots: false`; no wall-clock assertions, only budget-relative ones; integration fixtures go on the `serve()` HTTP server (a `locator` action costs ~1 s on a `data:` page vs ~9 ms over HTTP); Node ≥ 22.18.

`act` reports selectors as `xpath=/html[1]/…`; `page.locator()` accepts that verbatim, bare xpath, and CSS. `page.snapshot().formattedTree` includes input values (passwords masked) and is the change unit for Day 3 — strip the `[n-m]` node-id prefix before diffing.

Day 3 facts that bite (all probed):
- A submit blocked by native `required`/`pattern` validation changes **nothing** in the a11y tree. `:invalid` matches before and after; only `:user-invalid` (and focus jumping to the field) flips after the attempt.
- **Test fixtures that navigate, redirect, open tabs, or need an HTTP status must be served over `http://`** (`test/helpers.ts` `serve()`, stdlib `node:http`). Chrome silently refuses script navigation to `data:` URLs, and a new tab opened to a `data:` URL reports `url() === ""` forever.
- Detect a tab switch by the stable per-tab `pageId`, never by URL and never by object identity — `context.activePage()` returns a fresh `Page` wrapper every call. Run session detection and take the screenshot on the **final** page after the extended wait. A switch to a tab that existed before the action is `context-changed`, not `new-page`; never fall back to `pages()[0]`.
- Never let a `landed` row fire without `detectSession` on the destination — a write that bounces to a login wall must not read as `navigated → landed`.
- Compute the field-match verdict on real values, **then** redact passwords for storage; the reverse makes every password fill trivially match.

## Commands

```bash
npm run build          # tsc → dist/
npm test               # node --import tsx --test "test/*.test.ts"  (needs local Chrome; no LLM key)
npm run probe          # scripts/probe-stagehand.mjs — API sanity vs installed Stagehand; run after any bump
npm run probe:act      # one real act on a blocked submit; reads ANTHROPIC_API_KEY or OPENAI_API_KEY from a git-ignored .env
npm run probe:omlx     # the same trap through a local oMLX model, no cloud key (docs/PROBES.md run 2)
npm run probe:tree     # what snapshot().formattedTree contains — the Day 5 grounding facts
npm run probe:targets  # raw-CDP multi-target facts (popups/OOPIF) the sidecar relies on — run after a Chrome bump
npm run probe:inject   # failure-injection facts scripts/live/ relies on — run after a Chrome/Playwright bump
npm run bench          # Day 6: run the fixture suite × model ladder (needs .env; local oMLX rung needs none)
npm run bench:score    # re-score bench/out/oracle.jsonl with the pure scorer (no browser, no key)
npm run live           # real-site campaign, scripted+keyless (--agent = autonomous funnel); records, never asserts
npm run live:score     # stratified k/N + Wilson from live/out/manifest.jsonl
```

Day 6 benchmark rules (scripts/bench/):
- Three channels, never crossed: `agent_claim` and `verdict` in the replay, the fixture server's own state as the oracle. **The wrapped page never receives the `/truth` URL** — the runner reads it out of band; a fixture without a server-side oracle is not a benchmark fixture.
- Two claims, two rows: `claimExec` (Stagehand's mechanical `success`) and `claimBelief` (the model's post-act self-assessment via a fixed `extract` question, registered pre-run). The scorer (`src/bench.ts`) is pure and is the only place the three channels meet.
- Gates read point estimates over count floors, never interval bounds (a zero-event 95% upper bound is 3.7% at n=100 — unreachable at MVP scale). `scripts/bench/fixtures.mjs` is the one fixture source; the overlay probes import it.

Live measurement rules (scripts/live/):
- The oracle is independent truth and is **never passed as `expect`** — feeding the verdict it grades would be circular. It reads out of band, like the bench's `/truth`.
- The injector runs on **its own `cdpConnect` client**, never the sidecar's conn and never via `page.route` (CDP `Fetch` is single-owner per session; `netwatch` has no `requestPaused` handler, so sharing would hang the page). One tab per trial browser.
- An injected trial's truth is did-not-land **by construction** (the write never leaves the browser); a trial is valid only if the injector confirmed it paused the write. `unknown` (unconfirmed injection, disagreeing read-back, unreachable site) is **dropped before the scorer, never coerced**.
- The scored metric is the claim-independent `falseLanded` (mirror of `falseAccusation`); the claim-conditioned `miss` reads n=0 without an agent claim.
- Live results **report, never gate** — the `publish` gate stays fixture-only. Claims are stratified `k/N` with a Wilson/rule-of-three bound, never a bare "0%", never pooled across the known S3/S4 ceilings.

Detector functions run inside `page.evaluate`, so Stagehand serializes their source: use plain loops and inline arrows, never a `.find(namedFunction)` reference (it silently returns nothing — see the login detector).

## Invariants (do not negotiate these in a PR)

1. **The two channels never touch.** `agent_claim` (Stagehand's `ActResult.data.success/message`) and `evidence` (what we read from the page) are separate fields. No function that computes a write verdict may receive `agent_claim`. `attempt` (`ActResult.data.actions[]`) may be used only to decide *where* to read the page, never as evidence of outcome. Read verdicts are the designed exception: grounding compares an `extract`'s returned `data` to the page because that data is the object under test — but no write verdict may consume an extraction, and no read verdict may consume `success`/`message`.
2. **Heuristic ⇒ `inconclusive`.** Only a high-confidence, mechanism-backed obstruction (`blank`, persistent `captcha`, corroborated `login-wall`) may produce `did-not-land`. A false `did-not-land` lands in the benchmark's headline bucket and biases the instrument toward its own thesis.
3. **A checker that cannot read the page says `inconclusive`, never `landed`.**
4. **Run verdict rolls up over `kind === "write"` steps only.**
5. **The network only DEMOTES — a 2xx never lifts.** A same-origin 2xx (a first-party analytics beacon) proves that request succeeded, never that THIS action's write did (no click↔request correlation). `applyNetwork` demotes only; the reverted `applyNetworkLift` re-introduced false-landed. Shrink inconclusive via declarations, not lift.
6. **An unresolved watched write at bracket close is never `landed`.** An optimistic ✅ can lie while its POST is still in flight, so the sidecar waits (bounded) for this action's own watched-origin writes; a heuristic `landed` still unresolved at the budget demotes to `inconclusive/unsettled` — never `landed`, never `did-not-land`.
7. **Every auto-attached CDP target is resumed.** `cdpConnectBrowser` sends `Runtime.runIfWaitingForDebugger` to every child session — an observer that attaches but doesn't resume freezes the user's popup (OAuth/3DS). Never attach without resuming.
8. **A record `read` never sees the action's result.** It is called with no arguments, before and after; the action's return value is sealed as `agent_claim` only. Without a declared `expect`, a record write never decides (changed or unchanged ⇒ `inconclusive`): someone else may have written it, or the write was a no-op.
9. **A blind observer never contributes to a verdict.** A reader that cannot read, or a network channel whose socket closed / whose `Network.enable` failed / that never attached, yields `inconclusive / observer-lost` for anything that depended on it. Never `landed`, never `did-not-land`. A write that ran always records a step.

## Stagehand facts that shape the code (verified against 4.1.0)

- `ActResult.data.success` is **mechanical**: the extension's `successfulActionResult` fires whenever the locator action executed; `false` only on "No action found," an unsupported method, or a thrown action. It is never a judgment about the outcome, and nothing may read it as "the agent believes it succeeded".
- `act`/`extract`/`observe` live on the `Stagehand` instance. Pages come from `stagehand.browser.context.activePage()`. Wrap by **composition**, never `Proxy` (`Page` uses `#private` fields).
- `page.url()` is async. No `frames()`, `setContent()`, `waitForURL()`. `page.on` supports only `console`.
- `waitForLoadState` resolves immediately on an already-loaded document and rejects on timeout — do not use it as a post-action settle. Use the fingerprint settle in `src/session.ts`.
- `Stagehand.create({ browser })` works with no model; tests and scripts attach a local Chrome this way. `act`, `extract` and `observe` need a model — tests fake them via `fakeStagehand` and keep the browser real.

- `context.activePage()` returns `undefined` when the active tab closed; `page.pageId` is the CDP targetId.

## CDP multi-target facts (probed, `npm run probe:targets`)

- **Popups and cross-origin iframes are separate CDP targets.** A single page-target client (Stagehand's, and `cdpConnect`) is blind to their network. The sidecar uses `cdpConnectBrowser`: it binds the **browser** target (`/json/version`), not a page, and `Target.setAutoAttach{autoAttach,waitForDebuggerOnStart:false,flatten:true}` routes every child's events over one socket, tagged with `sessionId`.
- **`Network.enable` is per session** — enabling it on the browser/root does nothing for a child (the browser target has no Network domain at all). Enable it on each `page`/`iframe` session on `Target.attachedToTarget`, and re-issue `setAutoAttach` there for nested OOPIFs.
- **Resume every attached target** (`Runtime.runIfWaitingForDebugger`), even with `waitForDebuggerOnStart:false` — a probed fact: an auto-attached popup does not load until resumed. Enable Network *before* resuming (commands run FIFO per session) so the child can't fire its first request unseen.
- **`Network.getResponseBody` needs the owning `sessionId`** — a child's body is unreadable from the root. `netwatch` stores each request's `sessionId` and routes the body read; requestId is globally unique across sessions in practice, so lookups stay keyed on it.
- The reader and `watch` stay on `cdpConnect` (a page target has the Runtime/Accessibility/Page domains a browser target lacks). The `serve` fd bridge stays single-page (the Python side owns any multi-target proxying).
- targetId never changes on navigation, even cross-site (probed); a crashed target accepts commands and never replies; one client's disconnect is invisible to every other client; a popup detaching (`Target.detachedFromTarget`) is not observer loss.

## Style

- KISS, DRY, explicit over clever. Stdlib first: `node:test`, `node:assert/strict`. No new runtime dependencies without a reason written in the PR.
- Tests are BDD-named: `describe("session: login wall")`, `it("given …, when …, then …")`. Every detector branch has an `it`.
- No backward compatibility with Stagehand v3 shapes. Delete, don't shim.
- Cost over latency, UX over both: an extra 200 ms per step is fine; a missing screenshot in a replay is not.
- Mark deliberate shortcuts in code with a `// ponytail:` comment naming the ceiling and the upgrade path.

## Not detectable / not planned

JS `alert/confirm` dialogs (no dialog event in the 4.1.0 SDK). Browser-use and Playwright-MCP adapters (after the benchmark). Screenshot *judging* (screenshot *capture* per write step is in).
