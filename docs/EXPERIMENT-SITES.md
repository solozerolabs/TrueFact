# The generalization experiment — the test sites (2026-09-17)

Feeds PLAN.md §8: run TrueFact + a real agent against real, unfixtured sites and
hand-score verdict vs truth. Every URL below was checked live on 2026-09-17
(status + write behavior). The design constraint drives the whole list:

> **We can only hand-score a write whose truth we can know without a real-world
> side effect.** No real orders, no real money, no spam. So the matrix is
> sandboxes, controllable-failure infra, and fake-persist demos — chosen so each
> one exercises a failure shape we actually sell, with a *knowable* ground truth.

Two things an agent needs: a **page** it can drive (button/form), and a write
whose real outcome we can pin. Raw API endpoints (httpbin/jsonplaceholder) are
kept only as the network layer behind a driven page or as sidecar unit fixtures.

## A. Agent-drivable pages — the core run (score these by hand)

| Site | Write the agent does | Ground truth | Shape it proves |
|---|---|---|---|
| saucedemo.com (`error_user`) | add-to-cart / checkout | UI shows success, action is broken | **optimistic-UI, no honest signal** — the flagship |
| saucedemo.com (`standard_user`) | full checkout | genuinely completes | negative control (must stay `landed`) |
| demoqa.com/automation-practice-form | submit the form | modal confirms; POST behavior observable | real form write, DOM+network agree |
| checkout.stripe.dev/checkout | pay with decline card `4000 0000 0000 0002` | declined (cross-origin iframe) | **cross-origin checkout** — needs §4.3 multi-target |
| checkout.stripe.dev/checkout | pay with `4242 4242 4242 4242` | succeeds | cross-origin negative control |
| todomvc.com/examples/react/dist | add a todo | persists client-side only, **zero network** | control: network sees nothing → must be `inconclusive`, not false `did-not-land` |
| github.com (throwaway repo, token) | create an issue | knowable via API readback | real optimistic-UI + GraphQL in the wild |

## B. Controllable-failure endpoints — force each shape deterministically

Drive a one-button page that POSTs to these; truth is the endpoint's contract.

| Endpoint | Returns | Proves | Old sidecar | Now |
|---|---|---|---|---|
| the-internet.herokuapp.com/status_codes/500 | 500 | server crash | caught | caught |
| httpbin.org/status/402 (POST) | 402 | declined write (4xx) | **missed** | **caught (this session)** |
| httpbin.org/status/{422,429,403} | 4xx | invalid / throttled / forbidden write | missed | caught |
| httpbin.org/post | 200 | real success | landed | landed (control) |

## C. Fake-persist traps — the hardest, most realistic case

Network says success; nothing actually landed. This is where the verdict is
*supposed* to be honest and probably is not yet — the highest-value rows.

| Endpoint | POST returns | Truth | Why it's hard |
|---|---|---|---|
| jsonplaceholder.typicode.com/posts | **201** + fabricated body | nothing persists (reload = gone) | 2xx with a plausible body — no error signal anywhere in the network |
| reqres.in/api/users | **201**, body: `"read-only demo"` | nothing persists | 2xx, but the **body** carries the tell → the §4.2 body-read case |
| countries.trevorblades.com (bad field) | **200** `{"errors":[…]}` | mutation failed | GraphQL 200-with-errors → the §4.2 body-read case, live |

## How to score

The campaign is now a tracked harness — `scripts/live/` (was four gitignored
`_run-*.mjs` scratch scripts, superseded and removed):

1. `npm run live` — scripted, keyless: drives each pre-registered trial in
   `scripts/live/sites.mjs` (the A–C sites below plus injected did-not-lands),
   sidecar on, one hash-chained `--jsonl` per trial. `--agent` runs the autonomous
   funnel. Records, never asserts.
2. Ground truth is read out of band by `scripts/live/oracle.mjs`: `injected`
   (did-not-land by construction), `contract` (the endpoint's known outcome), or
   `get` (re-read ×2). An `injected` trial needs no account and no read-back — the
   write never leaves the browser (`npm run probe:inject`).
3. `npm run live:score` — stratified `k/N` with a Wilson bound. **false-landed**
   (the dangerous miss) and **cry-wolf** (false did-not-land) are the two numbers
   that decide launch vs redirect (§8), reported per stratum×config and never
   pooled across the known S3/S4 ceilings; `unknown` trials are dropped.

## What each site tells us about the roadmap

- **B passes, A/C fail on 2xx** → the deterministic floor is sound; the gap is
  body/fake-persist. Prioritize PLAN.md §4.2 (200-with-body).
- **Stripe rows false-land** → §4.3 multi-target is the blocker, as predicted.
- **todomvc false-flags did-not-land** → the `inconclusive` path is broken; fix
  before anything else (a cry-wolf on a client-only app kills trust instantly).

## Not in the matrix, on purpose

Real production checkouts (Amazon, a live Shopify store), real account
sign-ups, real sends. A true write there is a real side effect we can't take,
and its truth isn't cleanly knowable. Stripe/PayPal **sandbox** is the honest
stand-in for the cross-origin-payments market.

---

# Run log

## Run #1 — saucedemo (Swag Labs), keyless Playwright driver, 2026-09-17

Identical script for both users; only the username differs. 11 writes each.
Driver: real Playwright page over CDP (Stagehand's `page.locator` is xpath-only
and unusable — connect a genuine Playwright via `connectOverCDP` to the Chrome
`localBrowser.launch` starts). Sidecar on the same port.

**The controlled diff (working vs broken flow):** the *only* verdicts that differ
between `standard_user` and `error_user` land exactly on the two steps that
actually differ — nothing else moves.

| Step | standard_user | error_user | Ground truth | Score |
|---|---|---|---|---|
| enter last name | `landed` field-match | **`did-not-land` field-mismatch** | error_user's field is sabotaged | **real catch** |
| click Finish | `landed` navigated → complete | **`inconclusive` no-change** (stayed on step-two) | order placed vs **not placed** | under-call (safe) |
| all 9 other writes | identical | identical | matched | ✓ |

**Score across both runs (22 writes):**
- False-`landed` (the dangerous miss): **0 / 22**
- Cry-wolf (false `did-not-land`): **0 / 22**
- Real broken write caught: **1** (error_user last-name) — no fixture, real site
- Under-calls (`inconclusive` where a firmer verdict was available): add-to-cart
  (both, reason `changed-unclassified`) and error_user's dead Finish (reason
  `no-change`). Honest, not wrong — but see the gap below.

### The two findings that matter

1. **`network signal in any verdict: false` on both runs.** Swag Labs is
   client-only (localStorage cart, no server write). **The network sidecar — our
   entire differentiator — contributed nothing.** Every correct verdict came from
   the page-read / field-verification path. So this run validates the *page-read*
   floor on a real site, and says nothing about the network wedge. A large slice
   of "agents clicking SPAs" will give the sidecar zero to see. **Scoping truth:
   the network wedge only pays off on server-backed writes; for client-only apps
   the DOM/field postcondition *is* the product.** → Run #2 must be a
   server-write site (tier B/C or Stripe); it's the only thing that tests the
   differentiator.

2. **The flagship "did the order land" question came back `inconclusive`, not
   `did-not-land`, for the broken flow.** error_user's dead Finish button = no
   DOM change → `no-change` → `inconclusive`. Safe (not a cry-wolf) but soft: the
   agent claimed success, the order did not place, and we said "can't tell"
   instead of "no." A dead control with an unchanged URL after a submit is a
   demotable signal we currently leave on the table. Candidate fix, page-read
   side: treat "post-submit, zero DOM delta, URL unchanged" as `did-not-land`
   when there was a mutating intent — but only where it can't cry-wolf.

**Verdict on run #1:** the page-read floor generalizes cleanly (0 false-landed,
0 cry-wolf, caught the one real bug). The network wedge is untested here by
construction. Prioritize a server-write site next.

## Run #2 — the cross-origin write API (hermetic), 2026-09-17

Not saucedemo's problem (that's client-only). The question run #1 forced: does
the network wedge work when the write goes to a **different origin than the
page** — the ubiquitous split-origin app (`app.x.com` → `api.x.com`, Supabase
`*.supabase.co`, Firebase, `api.stripe.com`)? Two local servers = two origins:
page on A, `fetch` POST to B, B returns 500, page shows ✅ anyway. Sidecar
attached directly and queried under both origins.

```
errors filtered by PAGE origin (what TrueFact uses today): []
errors filtered by API  origin (the real write host)     : [{status:500}]
```

**Finding: the cross-origin 500 is captured in the sidecar buffer but thrown
away by the same-origin filter.** So today, on any split-origin app, an
optimistic ✅ over a failed cross-origin write reads as **`landed` (false)** —
the exact dangerous miss, on the most common real-world architecture. The guard
that gives us cry-wolf 0/279 is also blinding us to the primary write API.

**The fix is small in LOC but is a cry-wolf judgment call, not a blind
one-liner.** Can't just drop the filter (a third-party analytics POST that 500s
inside the action window would then cry wolf). Can't use same-*site* either —
Supabase/Stripe are cross-*site* from the app. The signal isn't origin; it's
"did this write action cause this mutating request." Recommended KISS fix that
preserves cry-wolf 0/279:

> **Opt-in API origins.** `network: { port, apiOrigins?: string[] }`. Default
> stays same-origin (safe). A split-origin app names its write host(s); mutating
> errors to those origins demote too. ~5 lines, zero cry-wolf risk (explicit
> allowlist), and it directly unlocks the Supabase/Stripe/Firebase majority.

**Shipped 2026-09-17.** `apiOrigins` added to the network option; `errorsSince`
now takes an origin allowlist (page origin + declared apiOrigins). Regression
test in `test/sidecar-network.test.ts`: the same cross-origin 500 stays `landed`
when undeclared (cry-wolf guard) and flips to `did-not-land` when declared.
Full suite 206/206.

This reframes PLAN.md §4.3: cross-origin isn't just popups/iframes — it's the
normal API subdomain, and it's a false-`landed` today, not a missing feature.

## Run #3 — the 200-that-lies on a LIVE GraphQL API, 2026-09-17

Validates `bodyErrors` + `apiOrigins` against real third parties, not fixtures.
Local page POSTs to two live endpoints; optimistic ✅ regardless.

| Target | Real behavior | Verdict | Right? |
|---|---|---|---|
| countries.trevorblades.com (bad field) | HTTP 200 + `{"errors":[…]}` | `landed` (body unread) | **miss — see ceiling** |
| jsonplaceholder.typicode.com/posts | HTTP 201, clean body, never persists | `landed`/`inconclusive` | ✓ correct — fake-persist is invisible to *any* network read |

**What the miss taught us (verified by raw-CDP debug):** the POST returned 200,
the sidecar *saw* it, but `Network.getResponseBody` came back **empty** — because
the page was driven by a separate Playwright CDP client (`connectOverCDP`, the
same shape as a user's own Playwright), which owns the request's body. A second
CDP client can't read it. It **fails safe**: empty body → no demote → `landed`,
never a cry-wolf (net was `[]`).

**Conclusions:**
1. `bodyErrors` on the Playwright path is **partially** fixed. Multi-target
   sessionId-routed body reads (6900cca) let the sidecar read a child session's
   body **when the body actually finishes loading** — same-origin writes, any write
   whose response the page consumes, and injector-fulfilled responses all demote
   now (`npm run probe:inject` realbody row; `test/live-harness.test.ts`). BUT Run
   #5 found the ceiling still holds for a **cross-origin fire-and-forget** write:
   the page calls `fetch()` and never reads the response, so Chrome withholds the
   cross-origin body and never emits `loadingFinished` — `Network.getResponseBody`
   never runs, and a real GraphQL `200 {"errors":[…]}` reads as `landed`. Status-
   based detection (5xx / 4xx-on-write) is unaffected: `responseReceived` always
   fires. See Run #5.
2. **jsonplaceholder is the honest boundary of the whole network wedge:** a clean
   2xx with a plausible body that simply doesn't persist is invisible to network
   truth. Only a post-write **read-back** (re-query the resource) can catch it —
   a different mechanism than the sidecar. Worth noting in the roadmap.
3. Status-based detection (5xx, 4xx-write, `apiOrigins`) is unaffected by the
   body-read ceiling — those ride `responseReceived`, which always arrives.

## Run #4 — the real-site cry-wolf experiment, through `truefact watch`, 2026-09-18

THE launch gate (PLAN.md §8, HANDOFF #1): drive `truefact watch` itself — observe
mode, wrapping nothing — against real sites and controllable ground truth, score
verdict vs truth, and specifically measure the residual risk the devil's-advocate
flagged: a one-off **same-origin background** mutating failure (token-refresh 401,
a canceled analytics beacon) that passive mode can't tie to an intent and would
false-fire `did-not-land`. Two parts, both run against the tightened build.

### Part A — confusion matrix on controllable ground truth (`_run-crywolf-matrix.mjs`)

A local page (its own origin) issues one POST per case; watch attached with
`--api-origins` for the external write hosts (the realistic split-origin config).
Truth = each endpoint's known contract. `bodyErrors` off (default).

| truth | watch verdict | case | cell |
|---|---|---|---|
| landed | landed | local 200 (same-origin success) | OK |
| did-not-land | did-not-land | local 500 (same-origin crash) | OK (real catch) |
| landed | landed | httpbin `/post` 200 | OK |
| did-not-land | did-not-land | httpbin 500 | OK |
| did-not-land | did-not-land | httpbin 402 (declined) | OK |
| did-not-land | did-not-land | httpbin 422 (invalid) | OK |
| did-not-land | did-not-land | httpbin 429 (throttled) | OK |
| did-not-land | did-not-land | httpbin 403 (forbidden, CORS-blocked cross-origin) | OK |
| did-not-land | **landed** | jsonplaceholder 201 (fake-persist) | **false-landed — network-invisible** |
| — | (silent) | reqres 201 | dropped: reqres now key-gates the write |

**Matrix score:** correct 8/10 · **cry-wolf (false did-not-land): 0** · false-landed:
1, and that one is the fake-persist boundary from run #3 (a clean 2xx that simply
never persists — invisible to *any* network read; only a post-write read-back can
catch it, a different mechanism than the sidecar). Every real server-rejection
shape (5xx, 4xx-on-write, cross-origin failure) is caught.

### Part B — residual cry-wolf on 20 real sites, DEFAULT config (`_run-crywolf-real.mjs`)

20 popular sites (HN, Wikipedia, GitHub, MDN, Stack Overflow, Reddit, NYT, CNN,
Amazon, YouTube, npm, Vercel, Stripe, Cloudflare, BBC, The Verge, Medium, Airbnb,
Shopify, LinkedIn), all loaded, default watch config (page-origin only, no
`--api-origins`, `bodyErrors` off). The "agent" load+scroll+waits — **no
intentional writes** — so every same-origin mutating verdict watch emits is
BACKGROUND traffic, and any `did-not-land` is by construction a cry-wolf.

Real sites emit a LOT of same-origin background POSTs (telemetry, RUM,
challenge-platform, tracking beacons): ~57–61 per 20-site pass.

**First pass exposed 3 false `did-not-land` (3/20 sites, ~5% of verdicts) — NON-trivial:**

| site | request | status | mechanism |
|---|---|---|---|
| vercel.com | `POST /api/jwt` | 403 | same-origin auth/JWT probe for a logged-out visitor — the pure devil's-advocate case |
| theverge.com | `POST /metrics/…` | 204 | analytics beacon **canceled by navigation** (2xx header seen, then `loadingFailed`) |
| linkedin.com | `POST /li/track` | 200 | tracking beacon **canceled by navigation** (2xx header seen, then `loadingFailed`) |

### The tightening (observe mode only — `src/watch.ts`)

Passive mode has no `act()` bracket to attribute a failure to intent, so its
`did-not-land` is now deliberately narrower than wrapped mode's (wrapped/sidecar
keeps its sharp full-4xx classification — it has the causal bracket that earns
0/279). Two exclusions, each tied to a real case above:

1. **Auth 401/403 excluded** (`isPassiveWriteError`): a same-origin background
   JWT/token probe returning 403 is pervasive on logged-out pages. A genuinely
   forbidden intended write becomes a MISS here, never a false accusation.
2. **A `loadingFailed` after a 2xx is `landed`, not `did-not-land`**: the server
   already accepted the write; a later body-load failure is a canceled/aborted
   beacon (navigation, `sendBeacon`), not a failed write. Only a wire failure with
   **no** response (`status == null`) is still a failed write.

Hermetic proof in `test/watch.test.ts` (3 new cases): a 403 write is not accused;
a 2xx-then-canceled body is `landed`; a genuine pre-response socket reset still
→ `did-not-land`. Suite 226/226.

### Re-run against the tightened build — the gate result

| | before | after |
|---|---|---|
| sites loaded | 20/20 | 20/20 |
| same-origin mutating verdicts | 57 | 61 |
| **false `did-not-land` (cry-wolf)** | **3** | **0** |

**Verdict: GATE PASSED.** Through `truefact watch`, in pure observe mode: cry-wolf
0 on both the controllable matrix and 20 real sites; every real server-rejection
shape still caught; the sole false-landed is the known fake-persist ceiling. The
crown-jewel 0-false-did-not-land record holds in observe mode. This unblocks npm
publish (PLAN.md §8/§9).

**Scope / honesty (what this run does and does not cover):**
- Intentional-write scoring used the controllable matrix (Part A), not live
  logged-in flows — real logged-in writes are real side effects with no cleanly
  knowable truth (the matrix's ethics rule). Part B measures exactly the surface
  the devil flagged: same-origin *background* mutating failures.
- `bodyErrors` on the Playwright-driven path stays best-effort (run #3 ceiling);
  unchanged here.
- Fake-persist (clean 2xx that never persists) remains a false-landed — needs a
  post-write read-back, a different mechanism. Documented, not a `watch` defect.
- Stripe/GitHub cross-origin-iframe & credentialed rows still need v2 multi-target
  (HANDOFF #2) before they can be scored; out of scope for the gate.

## Run #5 — the tracked `scripts/live/` campaign, first execution, 2026-09-19

First run of the consolidated harness (`npm run live && npm run live:score`),
scripted + keyless, sidecar on, one hash-chained `--jsonl` per trial (all
`chainOk:true`). Artifacts: `live/out/report.md` · `report.json` · `manifest.jsonl`.
9 trials, 0 dropped-unknown.

| stratum | trial | config | verdict | truth | result |
|---|---|---|---|---|---|
| S1 | the-internet /status/500 | zero | did-not-land | false | ✓ |
| S1 | httpbin /status/402 | zero | did-not-land | false | ✓ (the 4xx-on-write the old sidecar MISSED, caught live) |
| S1 | httpbin /post + inject 500 | zero | did-not-land | false | ✓ |
| S2 | httpbin /post + inject wire | zero | did-not-land | false | ✓ |
| S3 | trevorblades bad-field | zero | landed | false | expected miss (bodyErrors off) |
| S3 | trevorblades bad-field | bodyErrors | **landed** | false | **FINDING — bodyErrors did NOT catch it** |
| S4 | jsonplaceholder /posts | zero | landed | false | expected ceiling (fake-persist, network-invisible) |
| S5 | todomvc add | zero | inconclusive | true | ✓ (client-only; never a false did-not-land) |
| S6 | httpbin /post clean | zero | landed | true | ✓ (no cry-wolf) |

**Headline (S1/S2/S6 + the S3-bodyErrors we claimed to catch): false-landed 1/5,
cry-wolf 0/2.** The single miss is the S3 finding below; every real server
rejection (5xx, live 4xx-on-write, injected 5xx, wire drop) was caught, and the
client-only app was correctly `inconclusive`, not a false halt.

### The finding: cross-origin fire-and-forget defeats the body read

`countries.trevorblades.com` returns `200 {"errors":[{"code":"GRAPHQL_VALIDATION_FAILED"}]}`
for a bad field (CORS is allowed; the write is genuinely rejected server-side).
With `bodyErrors:true` it should demote — it did not. Root cause (raw-CDP debug):
the shim fires `fetch()` and never reads the response, and the endpoint is
cross-origin, so **Chrome withholds the cross-origin body from the renderer and
never emits `Network.loadingFinished`** for that POST. `netwatch` reads the body
in the `loadingFinished` handler, so the read never runs → no demote. Consuming
the body (or a same-origin write, or an injector-fulfilled response) makes
`loadingFinished` fire and the demote works — which is why the probe and the
hermetic test pass. So the run #3 "ceiling" is only partially closed (see run #3,
conclusion 1, corrected).

**Why this matters:** the split-origin API (`app.x` → `api.x`) is the case
`apiOrigins` exists for, and a fire-and-forget optimistic write to it is common.
Status-based detection (5xx / 4xx-on-write) is unaffected — those ride
`responseReceived`, which always arrives — so the core verdict is intact; only the
opt-in 200-with-body-lie detection has this gap.

**Candidate fix (not yet done):** on `settle`, for a mutating 2xx that got
`responseReceived` but no `loadingFinished`, attempt `Network.getResponseBody`
anyway (it may already be buffered), or enable `Network.streamResourceContent` for
watched-origin writes. Feasibility unverified — Chrome may withhold the body
regardless (ORB); probe before building. Until then the body-lie on a cross-origin
fire-and-forget write is a documented miss, and the honest public claim stays
status-based (S1/S2/S6): **0 false-landed across every real server-rejected write**.
