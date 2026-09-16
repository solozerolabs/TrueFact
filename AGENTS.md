# AGENTS.md — working in this repo

TrueReplay is a TypeScript/npm wrapper around Stagehand that records what a browser agent did and computes an independent `landed / did-not-land / inconclusive` verdict per write by reading the live page. Read [SPEC.md](SPEC.md) (product) and [docs/DAY2.md](docs/DAY2.md) (current build target, incl. verified Stagehand facts) before changing anything.

## Commands

```bash
npm run build          # tsc → dist/
npm test               # node --import tsx --test test/   (needs local Chrome; no LLM key)
npm run check          # legacy Day-1 self-check; goes away with the Day-1 redo
node scripts/probe-stagehand.mjs        # API sanity against the installed Stagehand; run after any bump
node scripts/probe-overlay-act.mjs      # one real act on a blocked submit; needs ANTHROPIC_API_KEY or OPENAI_API_KEY
```

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
