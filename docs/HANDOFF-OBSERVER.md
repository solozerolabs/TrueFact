# Handoff: observer liveness / context identity / actor identity (2026-09-23)

For the session that picks this up. Everything here is on branch **`feat/observer`** in the git worktree **`/Users/sidsharma/TrueReplay-observer`** (created off `origin/master` at `e0dab19`, v0.2.0). The main checkout `/Users/sidsharma/TrueReplay` is on `master` and has one unpushed commit (`a8aa4a1`, the `originOf` fix) that is already cherry-picked onto this branch as `ddb1a2b`. Work in the worktree, not in the main checkout.

`node_modules` in the worktree is a symlink to the main checkout's (excluded via `.git/info/exclude`). Run `npm run build` before any test that shells out to `dist/cli.js` (`chain.test.ts`, `cost-persist.test.ts` do).

## Commits on the branch (oldest first)

| Commit | What |
|---|---|
| `ddb1a2b` | `fix(netwatch)`: opaque origins (`about:blank`, `data:`) read as "" not `"null"` (cherry-pick of master `a8aa4a1`) |
| `fdd78dc` | `docs`: the spec, [docs/OBSERVER-PLAN.md](OBSERVER-PLAN.md) rev 2. Read it first; it explains every decision and what was rejected |
| `4897952` | `feat(observer)`: the implementation (src + tests) |
| `c4d4f0f` | `docs(observer)`: AGENTS.md invariant 9, README, SERVE.md, WATCH-PLAN.md, SPEC.md |
| `5d4c78f` | `docs(observer)`: two wording fixes so docs match code |
| `dee3eca` | `docs`: this handoff |
| `c2f651f` | `fix(driver-playwright)`: targetId lookup inside a promise; a page without `context()` (the demo hands a Stagehand Page to this driver) falls back to its `pageId`. Found by the full suite: the eager lookup threw at construction and hung `truefact demo` |

## What was built, and why

The review found five ways TrueFact produced a wrong record when its own observer went blind (all reproduced, see OBSERVER-PLAN §1). The fix is one principle, now **invariant 9** in [AGENTS.md](../AGENTS.md): *a blind observer never contributes to a verdict; a write that ran always records a step.*

### A. Observer liveness
- [src/cdp.ts](../src/cdp.ts): `CdpConn.lost()` / `onLost()` via the `liveness()` helper. Set by socket close/error (both transports, including our own `close()`), by `Inspector.detached` / `Inspector.targetCrashed` on page-level conns, and by a failed `Network.enable` (non-fatal). Once dead, `cmd()` resolves `undefined` immediately: a crashed target never replies, so without this every read waited `CMD_TIMEOUT_MS` (10 s).
- **Every connector enables Network itself** (`cdpConnect` on connect; the fd bridge on construction; `cdpConnectBrowser` per child session). `attachSidecarConn` no longer sends `Network.enable`: on a browser target that command has no domain, resolves `undefined`, and was being read as "enable-failed" on every healthy run (the cause of the first round of red tests).
- [src/postcondition.ts](../src/postcondition.ts): `PageState.readable` (replaces the never-read `pageId`); `decideWrite` returns `inconclusive / observer-lost` before `classify` sees an empty read (an empty fingerprint's `href: ""` looked like a navigation → `landed/navigated/high`). `classify` is untouched except its third parameter is now `Tab = "same" | "new" | "existing"`.
- [src/driver-cdp.ts](../src/driver-cdp.ts) `evalIn` throws on a missing reply. [src/driver.ts](../src/driver.ts): the `?? pages()[0]` fallback is **deleted** (it read another tab and produced `landed/new-page/high`).
- [src/index.ts](../src/index.ts) `run()`: the post-action `activePage()` is wrapped; on failure a step `inconclusive / observer-lost` with `lost: "no-active-page"` is recorded, then the error rethrown (before: the write vanished from the chain). `blind` is computed outside `if (sc)` so "requested but never attached" also demotes. A blind network demotes only a **heuristic** `landed` (`confirmation` / `form-cleared`); a high-confidence landed never leaned on the network and stands, with `evidence.observer.network: "blind"` recorded.
- [src/watch.ts](../src/watch.ts): records through `recorder()` (its own chain/sign/redact code is gone), appends a `kind: "observer"` step on loss, exits 1. Its own `close()` is guarded (`closing` flag) so shutdown doesn't read as loss.

### B. Context identity
- `evidence.context = { before: { target, origin }, after: { target, origin } }`. `target` is the CDP targetId on every driver: Stagehand's `pageId` already is one; Playwright and the CDP reader now resolve it via `Target.getTargetInfo` before `activePage()` returns (serve's reader id was the constant `"cdp"`).
- The rule, in `run()` + `classify`: `tab = "same" | "new" | "existing"` from the set of `driver.pageIds()` taken before the action. `new` → `landed/new-page` (as before); `existing` → `inconclusive/context-changed`. Loader/frame ids and a generation counter were rejected (plan §4).

### C. Actor identity
- `Actor` type + `parseActor("agent=x,run=y")` in index.ts; `Step.actor` (optional, **stored verbatim**, never redacted: `redactText` scrubs emails and a principal is often one) and `Step.observer = "truefact@<version>"` (from package.json via `createRequire`), stamped once in `recorder()`. `--actor` on `serve` and `watch`. OTel name mapping is in the README.

### Tests
24 new `it`s, BDD-named, across `test/cdp-fd`, `postcondition`, `driver`, `driver-playwright`, `serve`, `sidecar-network`, `watch`, `chain`, `replay`. `test/helpers.ts` `state()` now defaults `readable: true`. **Full suite at `c2f651f`: 364/364 green** (`npm test`, ~10 min, local Chrome, no key). `test/bench-fixtures.test.ts`, which pins TrueFact's verdict on every benchmark fixture, is in that run and unchanged, so the benchmark's inconclusive rate did not move.

## What is left (in order)

Nothing is blocking. The branch is complete and green; what remains is integration and one probe.

1. **`npm run bench:score` is informational only** (done: PUBLISH true, cry-wolf 0/279). It re-scores the *committed* oracle run, so it cannot see a verdict change; the real gate for "did the verdict logic move" is `test/bench-fixtures.test.ts`, which is green.
2. **Merge**: push `feat/observer`, open the PR against `master` (repo `solozerolabs/TrueFact`, public; nothing from `strategy/` may go in). Then `git worktree remove ../TrueReplay-observer`. Master's local `a8aa4a1` will be redundant after merge (same change as `ddb1a2b`); rebase or drop it.
3. **Browserbase teardown probe** (plan §10, separate change): Stagehand's own sidecar warns that closing an auxiliary browser-level WebSocket ends a Browserbase session; `withTrueFact.close()` closes one. Probe on a remote endpoint before claiming Browserbase support.
4. Optional cleanups the plan listed: none pending (the `sidecar.ts` re-export, `readTree`, `PageState.pageId`, the `pages()[0]` fallback are all gone).

## How to run things

```bash
cd /Users/sidsharma/TrueReplay-observer
npm run build                                   # tsc → dist/ (chain/cost tests shell out to dist/cli.js)
node --import tsx --test test/postcondition.test.ts test/cdp-fd.test.ts   # fast, pure
node --import tsx --test test/sidecar-network.test.ts test/watch.test.ts test/serve.test.ts  # browser-backed, ~1 min
npm test                                        # everything, >10 min
npm run bench:score                             # pure scorer over the committed oracle
```

Rules that bit during this work (also in AGENTS.md): tests fix Chrome debug ports per file (9417, 9418, 9431…) so two browser-backed files can collide if run in parallel; a test that imports Stagehand must live under `test/` (its package `exports` rejects imports from elsewhere); `node --import tsx` does not type-check, run `npx tsc --noEmit -p .` too.

## Decisions you should not reopen without new evidence

- No generation counter (nothing reconnects). No loader/frame ids (no verdict reads them; bfcache reuses a loaderId). No orphan-event rule (lazy attach makes orphans normal). No per-run header (a sampled step must stand alone). No attestation format. Actor not redacted. High-confidence landed survives a blind network. All argued in OBSERVER-PLAN.md.
