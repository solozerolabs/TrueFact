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

1. ~18 runs across A–C, real agent, sidecar on, `--jsonl` each.
2. For every write, write down the *actual* outcome (reload / API readback / the
   endpoint's known contract) next to TrueFact's verdict.
3. Confusion matrix: false-landed (the dangerous miss) and false-did-not-land
   (cry-wolf) are the two numbers that decide launch vs redirect (§8).

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
