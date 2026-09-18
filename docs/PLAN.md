# TrueFact — the authoritative plan (2026-09-17)

Written after a seven-team analysis (codebase, tests, web research, OSS comparison
via GitHub API, library docs via Context7, devil's advocate, experimental). This
supersedes the scattered direction in BUSINESS.md and the deferral list in
SPEC-V2 §12. It is a call, not a menu.

## 0. Scope note

This is a ~2,700-line TypeScript CLI + library. There is no backend service, no
database, no Supabase, no web frontend, no mobile app. The "backend/database/web/
mobile" framing does not apply; those teams were not run. The real surfaces are:
the verdict engine, the network sidecar, the wrapper seam, the CLI, and the docs.

## 1. The one-sentence product

TrueFact is the independent, deterministic record of whether a browser agent's
**write** actually landed — read from the page and the network, never from the
agent's claim, with no LLM judge.

That sentence is validated by the research. It is NOT a billing meter, NOT a
compliance-receipt vendor, NOT an observability platform. Those are adjacent
markets that already have funded incumbents (§6).

## 2. The single most important finding

**The network sidecar was too narrow, and it was narrow on exactly the flows we
sell.** It only demoted on a same-origin HTTP ≥500. Real failed writes are:

| Failure shape | Example | Old sidecar | Now |
|---|---|---|---|
| Server crash | 500/502/503 | caught | caught |
| **Write rejected** | 402 declined, 422 invalid, 429 throttled, 401/403 | **missed** | **caught (4xx on POST/PUT/PATCH/DELETE)** |
| 200-with-error-body | GraphQL `{"errors":[…]}`, Stripe `{success:false}` | missed | **caught, opt-in `network.bodyErrors`** |
| Cross-origin API host | app.x.com → api.x.com, *.supabase.co, api.stripe.com | missed | **caught, opt-in `network.apiOrigins`** |
| iframe / popup (no readable response) | Stripe iframe, PayPal popup | missed | **planned, multi-target (§4)** |
| Delayed / websocket | webhook confirm, async fraud check | missed | **planned (§4)** |

The devil's-advocate and experimental agents reached the 4xx/body/cross-origin
gap **independently**. Web research corroborated it ("every API call may have
returned 200"). This is a correctness bug on the demo's own premise, not a
feature request.

**Shipped this session:** 4xx-on-mutating-method demotion, with the cry-wolf
guard preserved (a 4xx on a GET — a 404 favicon, a probed asset — never
demotes). `src/sidecar.ts`, tests in `test/sidecar-network.test.ts`.

## 3. The architecture call (latency / performance / cost / UX)

**Hybrid wrapper + out-of-band CDP sidecar. Keep it. It is correct and now
confirmed by external consensus.**

- **Wrapper for the *when*.** Deciding which network response and which DOM
  delta belong to a given write needs a start/stop boundary around the action.
  Playwright's own guidance ("arm the waiter before the click") and the 2026
  literature both say the postcondition must be scoped to an action window. A
  pure ambient observer cannot attribute a response to a write without
  heuristics. This is where the wrapper earns its coupling.
- **Out-of-band CDP client for the *what*.** Confirmed by Context7 against
  Stagehand v4.1.0 docs: `page.on()` is `"console"`-only, there is no CDP escape
  hatch, no network events. The second CDP client is not a hack — it is the only
  way, and it sees the 500/402 the driver is blind to. Cost: one WebSocket per
  run, best-effort, returns null on failure (never crashes, never fabricates).
- **Deterministic, no LLM judge.** 2026 consensus (FutureAGI, Stagehand PR #2901,
  the judge-reliability papers) is "deterministic floor decides, LLM only
  explains." Our stance is dead-on. Latency sub-second, cost ~$0, and for "did
  the write land" the network read is a structural check, so the usual
  deterministic-misses-semantics caveat mostly does not bite us.

**Latency/perf/cost verdict:** the current design is the low-latency, low-cost,
high-trust option. The only performance smell is the synchronous in-hot-path
poll in `decideWrite` (`postcondition.ts`), which caps per-write latency at
`waitMs`. That is acceptable for a gate and is the price of a synchronous
verdict. Do not rewrite it into an async observer until a customer's run length
forces it (§5, `watch`).

## 4. What to build, in order

Ranked by (developer UX impact) × (de-risks the "does it generalize" question) ÷ effort.

1. **`truefact watch --port 9222` — attach to a running Chrome, wrap nothing.**
   The biggest time-to-first-catch win. Removes the integration wall entirely:
   any framework (Browser-Use in Python, Puppeteer, a human clicking) becomes
   verifiable with one command. The sidecar already proves you can observe a
   Chrome you did not launch. New work: a CDP-based `PageReader` (a third reader
   on the existing seam) and a write-boundary heuristic (frame-nav or a
   DOM-mutation burst after settle); reuse `settle`/`classify`/`decideWrite`
   unchanged. Effort: S–M. This also answers the Browser-Use question (§7) far
   better than a bespoke driver would.

2. **200-with-error-body network demotion (opt-in). SHIPPED 2026-09-17.** Closes
   the GraphQL/Stripe hole. `Network.getResponseBody` (read after
   `loadingFinished`, per the CDP timing rule) for mutating 2xx requests, matched
   against a caller-overridable pattern (default: non-empty GraphQL
   `"errors":[{` and `"success":false`). Opt-in via `network.bodyErrors`, only
   ever demotes, never stores the body. Tests in `test/sidecar-network.test.ts`
   (off by default = stays landed; on = the 200-that-lies demotes).

3. **Multi-target sidecar (popups / cross-origin iframes).** `Target.setAutoAttach
   {flatten:true}`, keyed event map across sessionIds. Without this the flagship
   catch is a false-landed on any Stripe-iframe / PayPal-popup checkout — the
   exact market named. Effort: M. Treat as a bug fix, not an experiment.
   **Update (experiment run #2, 2026-09-17):** the more common cross-origin case
   is not iframes but the plain **API subdomain** (app.x.com -> api.x.com,
   *.supabase.co, api.stripe.com). The sidecar already *captures* those failed
   writes; the same-origin filter was dropping them. **Shipped `apiOrigins`** (an
   opt-in origin allowlist) to close that — see docs/EXPERIMENT-SITES.md run #2.
   Multi-target (popups/iframes, where the write has no readable response at all)
   remains the harder, still-open part.

4. **RFC 8785 (JCS) canonical JSON in `chain.ts`.** Today `canonical()` is a
   custom scheme, so **no third party can verify a TrueFact chain and we can't
   verify anyone else's** — which defeats the entire point of a tamper-evident
   receipt. JCS is ~60 lines, no dependency, and it aligns us with the emerging
   interop spec and IETF draft-sharif. Highest leverage per line among the
   receipt work. Effort: S. (Breaks existing recorded chains — fine, pre-production.)

5. **`truefact fleet --html` — a static daily board.** Reuse the `view.ts`
   single-file pattern at the run level: landed-rate sparkline, the `needReview`
   queue as clickable rows into each run's timeline. Turns the existing pure
   rollup into something a developer opens every morning. The enterprise wedge
   for ~a day of work, no server, no auth. Effort: S.

**Deliberately NOT building** (no demand evidence, incumbents reach first):
hosted multi-tenant fleet service, billing/reconciliation adapters, a
cross-customer corpus at scale, 21 CFR Part 11, hosted counter-signing. Pull any
of these forward only when a paying customer funds it.

## 5. What to delete / simplify (KISS, DRY) — pre-production

The devil argued to kill 60%. That is overshoot. Most of the code is earned (two
real drivers, a well-tested classifier). But these are real:

- **Delete committed junk.** `demo-run.jsonl`, `.truereplay/screenshots/` (orphan
  from the TrueReplay→TrueFact rename). **Done this session.**
- **DRY: one `freePort` helper** (duplicated in `launch.ts` and `demo.ts`) and
  **one `loadRun(jsonl)` helper** (the `readFileSync…split…map(JSON.parse)` dance
  is repeated in `cli.ts`, `assert.ts`, `view.ts`, `fleet.ts`). Effort: S.
- **One shared `Action` type** (defined three times: `postcondition.ts`,
  `driver-playwright.ts`, plus Stagehand's import). Effort: S.
- **Kill the duplicate `sleep`** (`postcondition.ts` exports one, `session.ts`
  has an identical private one).
- **Do NOT delete** `view.ts`, `fleet.ts`, `chain.ts`, `declaration.ts`, or the
  second driver. They are small, differentiated ("a receipt, not a log"), and
  each is either the demo's payoff or the enterprise on-ramp. Deleting working,
  tested, differentiated UX to save 200 lines pre-PMF is not KISS, it is
  self-harm. `chain.ts` gets fixed (JCS), not cut.
- **`bench/` stays under `scripts/`** but stop citing its numbers as if the
  publish gate cleared (§8).

## 6. Why the enterprise tier is real but must wait

The devil is right that LangSmith / Langfuse / Braintrust / Browserbase can add a
"verdict" column to spans they already collect, and they own the buyer. Our only
defensible enterprise position is: **be the neutral, in-path, deterministic
network-truth source they do not have** — nobody shipped reads the network as the
decider. That advantage is real today and evaporates if we wait. So the sequence
is: win the OSS wedge on generalization first (§4.1–3), ship the free daily board
(§4.5), and only build hosting when a fleet owner asks. The corpus moat accrues
only after we are in-path; it cannot be the thing that gets us in-path.

## 7. Open questions — answered

1. **Wrapper or observer?** Both. Wrapper is the default and correct for causal
   attribution. `watch` (observer) is the zero-code adoption on-ramp, not a
   replacement. (§3, §4.1)
2. **Publish to npm?** Stay paused. Git install works for npm and Bun. Publish
   once the verdict is proven on real sites (§8), so the first `npm install` is
   backed by evidence, not a fixture.
3. **A Browser-Use driver?** No. `truefact watch` covers Browser-Use (and every
   other framework) generically. Build a bespoke driver only if a specific user
   needs in-process wrapping.
4. **Enterprise tier now?** No. `fleet --html` is the cheap version. Hosted tier
   waits for a converted paying user. (§6)
5. **The name. RESOLVED → TrueFact everywhere.** The GitHub repo was renamed
   solozerolabs/TrueReplay → solozerolabs/TrueFact (GitHub keeps a redirect, so
   old install URLs still resolve); the README install line, package.json URLs,
   and the git remote were updated. Only the local working-directory folder name
   still reads `TrueReplay` — cosmetic, left as-is to avoid disrupting tooling.

## 8. The experiment that matters more than any feature

Every agent, and BUSINESS.md's own last line, converges here: **there is no
evidence the classifier works on a single real, unfixtured third-party site.**
The 520-run ladder proved the *problem* (models claim false success ~26%) and
that TrueFact has zero false accusations (cry-wolf 0/279) — but the residual
miss (39/51) predates the sidecar, and everything is our own fixtures.

**Action, before writing more features or publishing:** run TrueFact (with the
now-widened sidecar) against 15–20 real sites with a real agent, record the
runs, and hand-score verdict vs truth. Two outcomes:
- If it generalizes → that evidence is the launch, the outreach proof, and the
  enterprise pitch, all at once.
- If it does not → we learn exactly which of §4.1–3 to prioritize, on real data
  instead of guesses.

Benchmark to change course (from the earlier direction research): if within 90
days no real developer keeps TrueFact in their pipeline for a month, the verdict
is a devtool feature, not a company — and the fleet/enterprise layer has no buyer.

## 9. Corrections this plan makes to prior docs

- BUSINESS.md "land: checkout/payments" — the sidecar structurally could not see
  cross-origin checkout. §2/§4.3 fix this.
- SPEC-V2 §12 lists observe-mode, multi-target, learned postconditions, and
  RFC 3161 as "deferred." §4 promotes `watch`, multi-target, and JCS to the
  critical path; the rest stay deferred with intent.
- README benchmark claims read as if the publish gate cleared; FINDINGS says the
  multi-rung rate is unmeasured. Reconcile the README to the evidence (§8) before
  publish.
- The demo's driver choice (Playwright driver on a Stagehand page) is
  **intentional and load-bearing**: Stagehand v4 refuses to initialize without an
  LLM even to replay a deterministic action, so the Playwright driver is the only
  keyless path. The honest page-read result is `inconclusive`, not `landed`;
  wording fixed this session.
