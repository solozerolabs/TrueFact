# Handoff — `truefact watch` and the network-truth work (2026-09-17)

Read this with [docs/PLAN.md](PLAN.md) (the authoritative product plan),
[docs/WATCH-PLAN.md](WATCH-PLAN.md) (the seven-team analysis + the call on
`watch`), and [docs/EXPERIMENT-SITES.md](EXPERIMENT-SITES.md) (the real-site test
matrix + runs #1–3). This doc is the "where we are / what's next / how to run it."

## Repo state

- Branch: `master`. Remote: `https://github.com/solozerolabs/TrueFact.git`.
- **This session's commits are LOCAL and UNPUSHED:** `639853e` → `fa62954`
  (5 commits, listed below). Push with `git push` when ready. Working tree clean.
- Pre-production, solo — the workflow is commit direct to `master`, no PRs
  required (prior commits did the same). No worktree needed; work in the repo
  root `/Users/sidsharma/TrueReplay`. `dist/` is committed on purpose (Bun git
  installs can't run a build step), so **always `npm run build` before you
  commit** or `dist/` drifts from `src/`.

### Commits this session (newest first)
- `fa62954` feat(watch): `truefact watch` — passive network-truth verdicts (v1)
- `ae05b23` test(chain): prove `canonical()` is RFC 8785 (JCS) conformant
- `aefa0bc` docs(experiment): run #3 — bodyErrors validated live + its CDP ceiling
- `d244dee` feat(sidecar): `bodyErrors` — catch the 200-that-lies
- `639853e` feat(sidecar): `apiOrigins` — catch failed cross-origin API writes

## What TrueFact is (30-second orientation)

Deterministic verification of whether a browser agent's **write** actually
landed (`landed` / `did-not-land` / `inconclusive`), read from the page DOM and
the network out-of-band, **no LLM-as-judge**. The crown jewel is the **cry-wolf
record: 0/279** — it has never falsely said `did-not-land`. Every design choice
protects that zero. Two entry points:
- **Wrapped mode** — `withTrueFact(stagehand | playwrightDriver(page))`. The
  certified, causally-bracketed verdict (DOM + fields + network). `src/index.ts`.
- **Observe mode** — `truefact watch --port N`. New this session. Network-truth
  floor only (below). `src/watch.ts`.

## What we did this session

1. **Widened the network classifier** (the experiment's #1 finding was it was
   too narrow):
   - `apiOrigins` (`639853e`): the same-origin guard was silently dropping failed
     writes to a different-origin API host (`app.x.com`→`api.x.com`,
     `*.supabase.co`, `api.stripe.com`). The sidecar *saw* them; the filter threw
     them away. Now opt-in `network: { apiOrigins: [...] }` demotes on those too.
     Guard intact: undeclared cross-origin never fires.
   - `bodyErrors` (`d244dee`): the 200-that-lies — a mutating request returning
     HTTP 200 whose body says it failed (GraphQL `{"errors":[…]}`,
     `{"success":false}`). Opt-in `network: { bodyErrors: true | RegExp }`, reads
     the body on `loadingFinished`, tests+drops it (never stored).
2. **Ran the real-site experiment** (`aefa0bc`, docs/EXPERIMENT-SITES.md):
   - Run #1 saucedemo: page-read floor generalizes (0 false-landed, 0 cry-wolf,
     caught the real broken write) BUT saucedemo is client-only → the network
     wedge isn't exercised there.
   - Run #2 (hermetic, split-origin): found + fixed the cross-origin false-landed
     → became `apiOrigins`.
   - Run #3 (live GraphQL): `bodyErrors` fires on the fixture but MISSED the live
     cross-origin GraphQL because `Network.getResponseBody` returns empty when
     ANOTHER CDP client (Playwright `connectOverCDP`) owns the request. It
     **fails safe** (empty body → no demote). Documented ceiling in `sidecar.ts`.
3. **Proved the receipt is third-party verifiable** (`ae05b23`): `canonical()`
   was suspected non-standard; testing against the official RFC 8785 (JCS)
   vectors showed it's already conformant. Added `test/chain-jcs.test.ts` +
   `test/fixtures/jcs/`. No code change — proof + doc.
4. **Built `truefact watch` v1** (`fa62954`) — see next section.

## `truefact watch` v1 — what it is and why it's shaped this way

**The call (docs/WATCH-PLAN.md):** ship the **network-truth floor** now, defer
the DOM/boundary verdict. Reasoning from the seven-team analysis:
- The experimental team proved `applyNetwork(current, errors)` needs **no
  `before` snapshot** — a mutating error is tied to the request's own
  origin+method+status. That's the ONE `did-not-land` signal that survives
  passive observation, and it's the same signal that earns wrapped mode's 0/279.
- The devil's-advocate team showed the DOM/boundary path (reconstructing a
  `before` with no `act()` bracket) **will** cry wolf on background traffic
  (analytics 500, token-refresh 401, prefetch 404, debounced overlapping writes)
  — and a single false accusation says "TrueFact" and burns the zero for the
  wrapper too. So that path does not ship until it earns its own cry-wolf proof.
- The codebase team confirmed the floor is nearly free: no new `PageReader`, no
  DOM reader, no boundary detector — just the existing sidecar logic + a loop.

**Cry-wolf preservation in v1** (`src/watch.ts` header comment): `did-not-land`
only on a **watched-origin** (page origin + `--api-origins`) mutating request
that failed, after **retry-collapse** (a `(url,method)` that errors then succeeds
within a grace window is dropped — a miss, never a false accusation). No DOM
`did-not-land` at all in v1.

### Code map (all new/changed files)
- `src/cdp.ts` — **NEW.** `cdpConnect(port)`: the raw-CDP-over-WebSocket client
  (`/json` discovery → ws → `cmd()`/`on()`/`close()`). Extracted from the sidecar
  (the DRY win the codebase team called for) and shared by both.
- `src/sidecar.ts` — refactored onto `cdpConnect` (behavior identical, 13/13
  network tests green). Now **exports** `isWriteError`, `MUTATING`, `originOf`,
  `bodyErrorPattern`, `DEFAULT_BODY_ERR` for `watch` to reuse (one classification,
  no drift).
- `src/watch.ts` — **NEW.** `startWatch(opts)` → `WatchSession`
  (`origins/settle/close`), the per-request observation loop, retry-collapse, the
  chain-valid `Step` builder (`buildStep`), and `runWatchCli(argv)` (the CLI).
- `src/cli.ts` — `watch` subcommand dispatch + usage.
- `src/postcondition.ts` — added `PostReason` `"network-ok"` (a landed network
  write; nothing switches exhaustively on `PostReason`, so it's safe).
- `test/watch.test.ts` — **NEW.** Hermetic: real Chrome, driven by an INDEPENDENT
  raw-CDP client (`Runtime.evaluate`) so watch is a pure observer. 7 cases.

## How to run things

```bash
# Build (ALWAYS before commit — dist/ is committed)
npm run build

# Full test suite (223 tests, ~60s; real headless Chromes, keyless, no LLM)
npm test

# Just the new/relevant tests
node --import tsx --test test/watch.test.ts
node --import tsx --test test/sidecar-network.test.ts
node --import tsx --test test/chain-jcs.test.ts

# The feature-flow harness (every line must exit 0) — the repo's gate:
npm run build
npm test
node -e "const{validateDeclarations}=require('./dist/declaration.js');let t=0;try{validateDeclarations([{kind:'probe',get:'/x'}])}catch(e){t=1};if(!t)throw new Error('vacuous');validateDeclarations([{kind:'probe',get:'/x',text:/y/}]);console.log('probe validation ok')"
grep -q '"probe"' dist/declaration.d.ts
grep -q 'kind: "probe"' README.md

# Try watch by hand: start Chrome with a debug port, drive it however, watch it
/path/to/chrome --headless=new --remote-debugging-port=9222 about:blank &
truefact watch --port 9222 --api-origins api.yoursite.com --jsonl run.jsonl
# then: truefact view run.jsonl / truefact verify run.jsonl
```

Test conventions (see AGENTS.md + MEMORY.md): headless always, `screenshots:false`,
`--test-concurrency=1` (real Chromes contend), fixtures served over `http://`
(not `data:`), and teardown order **browser.close() → server.closeAllConnections()
→ server.close()** or the runner hangs on a leaked Chrome/keep-alive socket
(the fix pattern is in `src/demo.ts:91-99`). **Never** re-run the 520-run bench
ladder to prove a change — prove with tiny hermetic fixtures (MEMORY.md).

Scratch runners `_run-*.mjs` are gitignored; the reusable one is
`_run-saucedemo.mjs` (drives saucedemo keyless via `connectOverCDP` — the pattern
for real-site runs).

## What needs to be done next (ranked)

1. ~~**The real-site cry-wolf experiment, in attach mode** — THE gate.~~ **DONE
   2026-09-18 — GATE PASSED (docs/EXPERIMENT-SITES.md run #4).** Drove `truefact
   watch` (observe mode) against a controllable ground-truth matrix + 20 real
   sites. The residual risk the devil flagged WAS non-trivial: first pass showed
   3 false `did-not-land` / 20 sites — a same-origin 403 JWT probe (vercel) and
   two navigation-canceled beacons (theverge 204, linkedin 200). Tightened
   `watch`'s passive default (observe mode only; wrapped/sidecar untouched): (a)
   exclude 401/403 auth from passive did-not-land, (b) a `loadingFailed` after a
   2xx is `landed` not `did-not-land`. Re-run: **cry-wolf 0/20**, all real
   server-rejection shapes still caught. `src/watch.ts` + 3 tests (226/226).
   npm publish is now unblocked on this axis.
2. **`watch` v2 — multi-target** (`Target.setAutoAttach{flatten:true}` +
   per-`sessionId` routing; browser-use's HAR watchdog is the reference, see
   WATCH-PLAN.md §2/§6). This catches popup/iframe checkout (Stripe iframe) AND
   fixes the run #3 `bodyErrors` ceiling — reading the body on the OWNING session
   is what was missing. `src/cdp.ts` is single-target today; this is where it grows.
3. **`watch` v2 — the DOM/boundary verdict path** (experimental team's Strategy C
   in WATCH-PLAN.md §6: network-anchored window, rolling `before`, `maskVolatile`,
   freshness bit, the N2 validation mechanism). Ship ONLY after #1 gives it a
   passive-mode 0/N corpus. This is the risky surface — do not ship it uncertified.
4. **Small DRY leftovers** (PLAN.md §5, not yet done): one `freePort` helper
   (dup in `launch.ts` + `demo.ts`), one `loadRun(jsonl)` (dup in `cli.ts`/
   `assert.ts`/`view.ts`/`fleet.ts`), one shared `Action` type (defined 3×),
   kill the duplicate `sleep`. Cheap; do them when touching those files.
5. **Reconcile README benchmark claims to the evidence** before npm publish
   (PLAN.md §9): FINDINGS says the multi-rung rate is unmeasured.

## Guardrails (do not break these)
- **cry-wolf 0/279.** Any change that could emit `did-not-land` must be scoped
  and fail-safe. When in doubt, `inconclusive`, never a false accusation.
- **No LLM judge.** The verdict is deterministic; a model may only ever explain.
- **`dist/` committed** → build before commit.
- **npm publish** was paused pending the real-site verdict (#1); that gate PASSED
  2026-09-18 (run #4, cry-wolf 0/20 through observe mode). Still do the README
  benchmark reconciliation (#5) before actually publishing.
