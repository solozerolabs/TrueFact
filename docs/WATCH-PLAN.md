# `truefact watch` — the authoritative plan (2026-09-17)

Written after a seven-team parallel analysis (library docs/Context7, web research
2026, OSS via GitHub API, codebase, tests, experimental, devil's advocate). This
is the call for PLAN.md §4.1. It is deliberately smaller than that item implied,
and the reason is the whole point of the analysis.

## 0. The one-line product

`truefact watch --port 9222` attaches to an already-running Chrome and passively
verifies whether writes land — for **any** framework (Browser-Use, Puppeteer,
Playwright, a human clicking) — wrapping nothing, no LLM.

## 1. The call: ship the network floor, defer the DOM verdict

`watch` v1 is a **network-truth observer**. Per mutating request (POST/PUT/
PATCH/DELETE) on a watched origin it emits a per-write verdict from the
**already-certified sidecar classification** (`isWriteError`: 5xx / 4xx-on-write
/ `loadingFailed`; plus opt-in `bodyErrors`), with retry-collapse. It does **not**
build a DOM reader, a rolling before-snapshot, or a write-boundary detector in
v1. Those are deferred behind the attach-mode cry-wolf experiment (§6).

Why this exact line, from the analysis:

- **The experimental team proved the split.** `applyNetwork(current, errors)` is
  a function of `(verdict, errors)` only — it needs **no `before` snapshot**. A
  mutating error on a watched origin is tied to the request's own origin+method+
  status, not to any DOM bracket. This is the one `did-not-land` signal that
  survives passive observation, and it is *the same signal* that earns wrapped
  mode's 0/279. Everything else (`classify` tree-diff, `fieldPostcondition`,
  obstruction) needs the causal bracket `act()` provides and `watch` cannot.
- **The devil's advocate is right about the rest.** Passive DOM attribution has
  no causal anchor, so a reconstructed bracket *will* cry wolf on background
  same-origin traffic, debounced overlapping writes, prefetch, and retries — and
  a single false `did-not-land` says "TrueFact" and burns the crown jewel for
  the wrapper too. You cannot partition brand trust by entry point. So the DOM
  verdict path does not ship until a passive cry-wolf corpus on real sites earns
  its own zero.
- **The codebase team confirmed the floor is nearly free.** A network-only
  `watch` needs the existing sidecar plus a thin loop — **no new `PageReader`, no
  `axToLines`, no `evaluate` plumbing, no boundary detector.** The big new
  surface is exactly the deferred part.

Net: `watch` v1 = one command, any framework, sound network-truth verdict, zero
new verdict semantics, the sidecar's guarantees intact.

## 2. Architecture (latency / performance / cost / UX)

- **Attach primitive: raw CDP over WebSocket** (reuse `src/sidecar.ts`'s
  connection), **not** `chromium.connectOverCDP`. Confirmed by teams 1 and 3:
  `connectOverCDP` runs its own auto-attach and owns the request sessions, which
  is exactly why our run #3 `getResponseBody` came back empty. Raw CDP lets
  `watch` own its own `Network` domain per session and read bodies on the owning
  session. browser-use's HAR watchdog is the working reference for this topology.
- **Single page target in v1; multi-target deferred.** Run #2 proved a
  cross-origin **API subdomain** (`app.x.com` → `api.x.com`, `*.supabase.co`) is
  main-frame network and is already seen by the single page-target session +
  `apiOrigins`. Separate CDP targets are needed only for **popups and
  cross-origin iframes** (Stripe-iframe checkout) — that is v2 via
  `Target.setAutoAttach{flatten:true}` + per-`sessionId` routing (teams 1/3).
- **Latency/cost:** passive, event-driven, no LLM, ~$0. Per-write latency is a
  short retry-collapse grace (~1s) before finalizing a failure; a clean write is
  reported on `loadingFinished`. No hot-path poll.
- **UX:** `truefact watch --port 9222` prints a live line per write and a
  summary on exit; `--jsonl` records the same tamper-evident chain (`chain.ts`,
  RFC 8785, third-party verifiable) that `view`/`verify`/`assert`/`fleet`
  already consume. Zero code change to the agent under test. This is the best
  possible adoption UX: nothing to wrap.

## 3. Cry-wolf preservation (the non-negotiable)

`watch` v1 emits `did-not-land` in exactly one situation: a **watched-origin
mutating request returned a write-error** (5xx / 4xx-on-mutating / `loadingFailed`
/ opt-in error-body), after retry-collapse. Guards:

1. **Origin allowlist** (existing `errorsSince` guard): default = the page's
   origin + `--api-origins`. A third-party analytics/telemetry 500 never fires.
2. **Retry-collapse** (from the experimental team): if the same `(url, method)`
   errors then succeeds within a short grace, the error is dropped. Biases toward
   a miss, never a false accusation — consistent with the sidecar's stated
   "a MISS, never a false demote."
3. **No DOM `did-not-land`.** The bracket-dependent mechanisms do not run in v1,
   so none of the devil's DOM cry-wolf scenarios are reachable.
4. **Honest labelling.** `watch`'s `did-not-land` means precisely "an observed
   failed write request on a watched origin." A clean 2xx is reported `landed`
   ("the server accepted the write"); a mutating request with no wire error and
   no body check is `landed`; anything the network can't speak to (a client-only
   write) simply produces no network record — `watch` never invents a verdict for
   it. This is a slightly weaker claim than the wrapper's causally-bracketed
   verdict, and the docs say so.

## 4. Open questions — answered

1. **Wrapper or observer?** Both, with distinct jobs. `withTrueFact()` is the
   certified, causally-bracketed verdict (landed/did-not-land/inconclusive across
   DOM + network + fields). `watch` is the zero-integration **network-truth**
   observer for any framework, and the harness for the real-site experiment.
2. **Does `watch` render a full landed/did-not-land/inconclusive verdict?** In
   v1, only the network-grounded subset: `did-not-land` (failed write request),
   `landed` (accepted write request). The DOM-grounded verdict and `inconclusive`
   reconstruction wait for §6.
3. **Attach: raw CDP or `connectOverCDP`?** Raw CDP. (§2)
4. **Multi-target now?** No. Single page target covers the API-subdomain
   majority (run #2). `setAutoAttach` multi-target is v2 for iframe/popup.
5. **A Browser-Use driver?** Still no. `watch` covers Browser-Use (and every
   framework) generically — this is the answer PLAN §7.3 anticipated.
6. **`bodyErrors` in `watch`?** It should work where `watch` owns the `Network`
   domain on the session (it enables its own), unlike the run #3 `connectOverCDP`
   case. Keep the documented ceiling until a hermetic test proves it per Chrome
   version (team 1's caveat).

## 5. What to build (v1), in order

1. **DRY first (codebase team):** extract `cdpConnect(port)` — the `/json`
   discovery + WS open + `id`/`pending`/`cmd()` correlation — from `sidecar.ts`
   so `watch` reuses it instead of copy-pasting. `sidecar.ts` then consumes it.
2. **Sidecar `onWrite` stream:** extend the sidecar to track each mutating
   request to a watched origin and, on its terminal event, emit
   `{url, method, status, verdict, reason}` via an optional `onWrite` callback —
   with the origin allowlist and retry-collapse applied. `errorsSince`/`settle`/
   `mark` semantics stay unchanged (wrapped mode is untouched).
3. **`src/watch.ts`:** attach the sidecar with `{apiOrigins, bodyErrors, onWrite}`,
   record each write as a `Step` (reuse `chain.ts` hashing) to `--jsonl`, print a
   live line, and a summary on SIGINT.
4. **`truefact watch` CLI** in `cli.ts` (+ usage + README `kind:"probe"` grep
   stays intact).
5. **Hermetic test (tests team):** clone `test/sidecar-network.test.ts`; drive
   the write from an **independent raw-CDP client** (`Runtime.evaluate` click) so
   `watch` is a pure observer; assert `did-not-land` on the optimistic 500,
   `landed` on the clean 200, no fire on an undeclared cross-origin 500, and
   `did-not-land` when that origin is declared via `--api-origins`.

## 6. Deferred behind the real-site proof (v2+)

- **The DOM/boundary verdict path** (Strategy C from the experimental team:
  network-anchored window, rolling `before`, `maskVolatile`, freshness bit, the
  N2 validation mechanism). It is well-designed and cry-wolf-aware, but it is new
  uncertified surface with no shared code with the proven path. It ships only
  after a **passive-mode cry-wolf corpus on real sites** (the PLAN §8 experiment,
  run in attach mode using `watch` itself) reaches its own published 0/N.
- **Multi-target** (`setAutoAttach{flatten:true}`) for popup/iframe checkout, and
  the per-`sessionId` `getResponseBody` fix that also closes the `bodyErrors`
  Playwright-path ceiling from run #3.

## 7. Why this is the right long-term call

It ships the useful, differentiated thing (framework-agnostic network truth) at
the smallest sound footprint, keeps one certified verdict path instead of two
that drift, preserves the 0/279 asset that is the whole company, and turns
`watch` into the tool that unblocks the real gate — proof on real sites — rather
than a second thing to prove. KISS and DRY, and it deletes nothing that works.
