# AGENTS.md — working in this repo

TrueReplay is a TypeScript/npm wrapper around Stagehand that records what a browser agent did and computes an independent `landed / did-not-land / inconclusive` verdict per write by reading the live page. Read [SPEC.md](SPEC.md) (product), [docs/DAY2.md](docs/DAY2.md) (built: session detection, verified Stagehand facts) and [docs/DAY3.md](docs/DAY3.md) (next: auto postcondition — spec only, not built) before changing anything.

`act` reports selectors as `xpath=/html[1]/…`; `page.locator()` accepts that verbatim, bare xpath, and CSS. `page.snapshot().formattedTree` includes input values (passwords masked) and is the change unit for Day 3 — strip the `[n-m]` node-id prefix before diffing.

Day 3 facts that bite (all probed, see docs/DAY3.md §0):
- A submit blocked by native `required`/`pattern` validation changes **nothing** in the a11y tree. `:invalid` matches before and after; only `:user-invalid` (and focus jumping to the field) flips after the attempt.
- **Test fixtures that navigate, redirect, open tabs, or need an HTTP status must be served over `http://`** (`test/helpers.ts` `serve()`, stdlib `node:http`). Chrome silently refuses script navigation to `data:` URLs, and a new tab opened to a `data:` URL reports `url() === ""` forever.
- Detect a tab switch by the stable per-tab `pageId`, never by URL and never by object identity — `context.activePage()` returns a fresh `Page` wrapper every call. Run session detection and take the screenshot on the **final** page after the extended wait.
- Never let a `landed` row fire without `detectSession` on the destination — a write that bounces to a login wall must not read as `navigated → landed`.
- Compute the field-match verdict on real values, **then** redact passwords for storage; the reverse makes every password fill trivially match.

## Commands

```bash
npm run build          # tsc → dist/
npm test               # node --import tsx --test "test/*.test.ts"  (needs local Chrome; no LLM key)
npm run probe          # scripts/probe-stagehand.mjs — API sanity vs installed Stagehand; run after any bump
node scripts/probe-overlay-act.mjs      # one real act on a blocked submit; needs ANTHROPIC_API_KEY or OPENAI_API_KEY
```

Detector functions run inside `page.evaluate`, so Stagehand serializes their source: use plain loops and inline arrows, never a `.find(namedFunction)` reference (it silently returns nothing — see the login detector).

## Invariants (do not negotiate these in a PR)

1. **The two channels never touch.** `agent_claim` (Stagehand's `ActResult.data.success/message`) and `evidence` (what we read from the page) are separate fields. No function that computes a verdict may receive `agent_claim`. `attempt` (`ActResult.data.actions[]`) may be used only to decide *where* to read the page, never as evidence of outcome.
2. **Heuristic ⇒ `inconclusive`.** Only a high-confidence, mechanism-backed obstruction (`blank`, persistent `captcha`, corroborated `login-wall`) may produce `did-not-land`. A false `did-not-land` lands in the benchmark's headline bucket and biases the instrument toward its own thesis.
3. **A checker that cannot read the page says `inconclusive`, never `landed`.**
4. **Run verdict rolls up over `kind === "write"` steps only.**

## Stagehand facts that shape the code (verified against 4.1.0 — see DAY2.md §0)

- `act`/`extract`/`observe` live on the `Stagehand` instance. Pages come from `stagehand.browser.context.activePage()`. Wrap by **composition**, never `Proxy` (`Page` uses `#private` fields).
- `page.url()` is async. No `frames()`, `setContent()`, `waitForURL()`. `page.on` supports only `console`.
- `waitForLoadState` resolves immediately on an already-loaded document and rejects on timeout — do not use it as a post-action settle. Use the fingerprint settle in `src/session.ts`.
- `Stagehand.create({ browser })` works with no model; tests and scripts attach a local Chrome this way. `act` needs a model.
- Fixtures load via `page.goto("data:text/html," + encodeURIComponent(html))`.

## Style

- KISS, DRY, explicit over clever. Stdlib first: `node:test`, `node:assert/strict`. No new runtime dependencies without a reason written in the PR.
- Tests are BDD-named: `describe("session: login wall")`, `it("given …, when …, then …")`. Every detector branch and every row of the DAY2 matrix has an `it`.
- No backward compatibility with Stagehand v3 shapes. Delete, don't shim.
- Cost over latency, UX over both: an extra 200 ms per step is fine; a missing screenshot in a replay is not.
- Mark deliberate shortcuts in code with a `// ponytail:` comment naming the ceiling and the upgrade path.

## Not detectable / not planned

JS `alert/confirm` dialogs (no dialog event in the 4.1.0 SDK). Browser-use and Playwright-MCP adapters (after the benchmark). Screenshot *judging* (screenshot *capture* per write step is in).
