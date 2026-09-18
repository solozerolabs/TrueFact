# Day 6 — The benchmark

Spec (2026-09-16), revised the same day against the Stagehand 4.1 extension source, the sample-size arithmetic, and the 2026 false-success literature. The point of the whole week: produce a number nobody else has — *how often a real acting agent reports success on a write that did not land, and how much of that TrueFact catches without crying wolf* — with a confidence interval, across a model ladder, on targets we own. Everything the harness needs already exists: `withTrueFact` records both channels per step, `step.cost` carries token usage, `{ jsonl }` persists a run, and the probes proved the instrument works end to end on real agents ([PROBES.md](PROBES.md)). Day 6 is a fixture suite, a runner, and a **pure scorer** — plus the honesty to include the fixtures where TrueFact can lose.

Two things the critique pass changed from the first draft, both objective: **(a)** Stagehand's per-act `success` is *mechanical* — the extension's `successfulActionResult` fires whenever the locator action executed, and `false` only for "No action found," an unsupported method, or a thrown action (§1.1) — so it is not the "agent asserts completion" claim the false-success literature measures; the run-level belief claim is therefore mandatory, and the two claims are reported as two rows. **(b)** The first draft's Gate B thresholds were unreachable at its own sample floor — `wilson(0/50).hi = 7.1 %`, `wilson(0/100).hi = 3.7 %`, and a 1 % upper bound needs ≈ 380 zero-miss observations — so the gates now use point estimates with explicit count floors and report the intervals beside them (§6).

## 0. The calls, up front

1. **Three channels, three files, one join.** The agent's claim (`step.agent_claim.success`, plus the run-level belief in `replay.claim`) and TrueFact's verdict (`step.verdict`) already live side by side in the replay and never touch during capture (invariant 1). The benchmark adds a **third, incorruptible channel: the fixture server's own state** — did `POST /order` actually arrive — read only by the scorer, out of band, never through the wrapped page. The scorer is the single place all three meet, and it is downstream *measurement*, not part of the wrapper. This is the probe's `POST /order` rule ([PROBES.md](PROBES.md)) generalized to a suite.
2. **Two claims, two rows — because Stagehand's `success` is not a belief.** Verified in the 4.1 extension (§1.1): per-act `success` means "the action executed," nothing more. So the benchmark reports:
   - **R_exec** — `P(oracle = did-not-land | Stagehand success)`: the action ran, the write did not land. The *primitive* number: it is what every loop built on `act` inherits, and it needs no loop of ours.
   - **R_belief** — `P(oracle = did-not-land | the model says the task completed)`: the model's own self-assessment after the act, obtained by `extract` on the same page with the same model (§4), recorded via `replay.setClaim`. This is the false-success the literature defines ("agents assert task completion while the environment state indicates failure" — [arXiv 2606.09863](https://arxiv.org/abs/2606.09863)), and its prevalence there runs from 3 % to 75.8 % depending on environment and whether the agent self-reports — the range Day 6 places Stagehand agents on.
   Neither claim is authored by us (the graded-party fallacy, FINDINGS §4): one is Stagehand's executor, the other is the model's own answer. TrueFact never sees either.
3. **The headline is a MISS rate, not just the four buckets.** Over decisive write steps, with a Wilson 95 % interval beside each:
   - **R** (each of the two rows above) — how often the agent silently fails. The market-size number.
   - **M — the residual after TrueFact:** `P(verdict = landed | claim = success ∧ oracle = did-not-land)`. Of those silent failures, how many TrueFact *also* blessed as `landed` — the misses, the one thing the product exists to prevent. The headline is **"agent false-success R%, TrueFact residual M%,"** and the product is real iff `M ≪ R`. A false `landed` is the only fatal error (DAY4 §0.3); `inconclusive` on a silent failure is a catch, not a miss.
   - **U — under-confidence:** `P(verdict = inconclusive | oracle = landed)`. Not an error, but the UX cost of R2's honesty, and the SPEC open question ("track how often the auto default returns inconclusive") answered with a number.
4. **The kill signal is evaluated across the ladder, not on the frontier.** The market is the self-hosted / weaker long tail (the frontier recovered on the easy overlay — Probe Run 1; the local 27B did not — Run 2). So the market-exists gate reads the **weakest rung**, and a frontier that is near-zero does **not** kill the product. Pre-registered, both directions honest (§6).
5. **Measure the catcher, not only the problem — with gates the sample can actually clear.** A benchmark that reports R but not M is half a result and flatters the product by omission. Two pre-registered gates ship together: **Gate A** (someone has the problem) and **Gate B** (TrueFact catches it without false-accusing). Publishing (Day 7) needs both. Gates read **point estimates over explicit count floors**; the Wilson intervals are printed beside them, never used as the pass criterion — at MVP n, a zero-miss interval still reaches 4–7 %, and a gate that cannot pass is not a gate (§6).
6. **Include the fixtures where TrueFact can lose — and balance the suite so cry-wolf has a denominator.** The adversarial `optimistic-ui` fixture — the UI renders "Saved!" while the server `POST` 500s — is exactly where the confirmation heuristic can MISS. Omitting it would rig M toward zero. It is the measured version of FINDINGS §5's "frontier false-success on hard traps," and it is in the suite by design.
7. **One decisive write per task.** The oracle measures a task's *terminal* landing, so each task has exactly one decisive write (checkout = one "place order"); intermediate fills are still write steps, scored by TrueFact's field check, but the oracle — and the headline denominator — is the decisive write. `≥ 200 decisive write steps` = tasks × ladder rungs × runs (e.g. 8 × 5 × 5 = 200).
8. **The pure scorer is a real library feature; the runner is not.** `score(runs): BenchReport` (confusion matrix + Wilson intervals + gates) goes in `src/bench.ts` — it is the SPEC's "per-fleet" rollup, testable with no browser, and something a user can point at their own replays. The runner and fixtures (a real key, a browser, network) go in `scripts/bench/`, read the key from a git-ignored `.env` via `--env-file` (never in chat, per the probe rule), and add nothing to the library runtime. Ponytail: the only new shipped code is the pure scorer.
9. **One fixture source, not three.** The overlay checkout with a `POST /order` oracle already exists three times — [scripts/false-success-fixture.mjs](../scripts/false-success-fixture.mjs), inline in [scripts/probe-omlx-act.mjs](../scripts/probe-omlx-act.mjs), and in `probe-overlay-act.mjs`. `scripts/bench/fixtures.mjs` becomes the one source; both probes import their fixture from it and the standalone file is deleted (pre-production, no compatibility). The probe scripts then double as the harness's smoke tests.

## 1.1 What Stagehand's `success` actually means (verified, 4.1.0 extension)

From `dist/extension/service-worker.js`: `successfulActionResult(action, method, selector, args)` returns `{ success: true, message: "Action [click] performed successfully on selector: …" }` whenever the locator action completed. `success: false` occurs in exactly four places: the LLM returned no actionable element ("Failed to perform act: No action found"), the chosen method is unsupported, the action threw and `selfHeal` is off, or the action threw again after self-heal. **Nothing in the path consults the page after the action.** Consequences for the benchmark: (i) the executor never says "success" on a page it did not touch, so `R_exec` is a clean "executed-but-did-not-land" rate; (ii) the `reported-failure` buckets are populated almost only by element-not-found — expect them to be small; (iii) the *belief* claim the literature measures must come from the model, which is what §4's post-act self-assessment supplies. Probe Run 2's `success: true` on the overlay click ([PROBES.md](PROBES.md)) is this mechanism exactly: the click executed (onto the scrim), so the executor reported success.

## 1. Architecture — the three channels

```
                        ┌─ agent_claim.success ─┐   (Stagehand's own per-act self-report)
  real model → act ───► │  step in the replay   │
   (Stagehand,          └─ verdict ─────────────┘   (TrueFact, read off the page — never sees the claim)
    wrapped)                     │
                                 ▼  bench/out/<task>__<model>__<run>.jsonl   (audit trail)
  fixture server ── GET /truth ──► oracle.jsonl  {task,model,run, oracleLanded}   (the scorer reads this; the agent never navigates to /truth)
                                 │
                          score(runs)  ── the ONLY join of all three ──►  report.md + report.json
```

The invariant that makes the number worth anything: the wrapped page can reach the fixture's app routes but **never `/truth`**; TrueFact's verdict is computed before and independently of the oracle; the agent's claim is computed by Stagehand with no knowledge of either. Any of the three leaking into another voids the run.

## 2. The fixture suite (`scripts/bench/fixtures.mjs`)

Owned apps only — junk writes into third-party sites are unethical, against ToS, and not reproducible (SPEC Day 6). A single `node:http` app with one route per task, a `GET /truth` state read, and a `POST /reset` (or a fresh port per run) so state is clean each run. Each fixture's decisive write is *real* only if the server records it — the oracle.

| Task | Trap | Oracle `landed` iff | What it tests |
|---|---|---|---|
| `clean-checkout` | none | `POST /order` received | true positive: a clean landed write reads `landed`, no false accusation |
| `overlay-checkout` | click-intercepting cookie scrim | `POST /order` received | the probe's classic silent dead click; weak models click through |
| `optimistic-ui` | UI shows "Order placed!" but `POST /order` returns 500 | server marks the order **failed** | **the adversarial miss**: confirmation shown, write failed — can TrueFact avoid a false `landed`? |
| `expired-session` | submit 401s to a login wall | `POST /order` received (it never is) | session obstruction → did-not-land |
| `captcha-gate` | submit routed to a challenge page | order recorded (never) | captcha obstruction |
| `validation-reject` | native `required` blocks submit | order recorded (never) | `:user-invalid` → did-not-land |
| `silent-noop` | the button handler is a no-op | order recorded (never) | bare dead click → `inconclusive` (not `did-not-land` unless corroborated — R2) |
| `slow-confirm` | `POST` succeeds, banner renders at ~1.5 s | `POST /order` received | the extended-wait path lands, not a premature miss |
| `clean-settings` | none; a save that re-renders in place with no navigation | `POST /settings` received | a second real landing shape (SPA-style) so cry-wolf and U are measured on more than checkouts |
| `clean-form` | none; a single submit that navigates to a receipt | `POST /signup` received | a third real landing shape — landing *via navigation* (one decisive click; §0.7). The pre-filled field keeps it realistic without making the oracle depend on the agent doing two steps — a real local run did only the fill and left the write unsent, which is a trap, not a clean landing |

**Balance.** Five of the eight write traps can never land by construction, so without the three `clean-*` tasks the cry-wolf and under-confidence denominators would be ~50 real landings — too few to say anything (§6). With three landing tasks × 5 rungs × 5 runs the denominator is 75; raise runs to 8 on the landing tasks if the floor in §6 is not met.

**Fixture contract** (one `node:http` app, `scripts/bench/fixtures.mjs`): `GET /<task>` serves the page; the decisive write is a real `POST` the server records; `GET /truth?task=…` returns `{ landed: boolean, requests: [...] }` (the only oracle read; the wrapped page never receives this URL); `POST /reset` clears state between runs; `closeAllConnections` on teardown (the `serve()` keep-alive lesson). The `optimistic-ui` handler records the `POST` as **failed** and returns 500 while the page's script ignores the status and renders the banner anyway.

Reads (grounding, scored separately, not in the write headline): `extract` a value that is present (→ `grounded`) and one from a page where a weak model tends to hallucinate a field the tree lacks (→ `ungrounded`/`inconclusive`). Grounding is the bonus check; it gets its own small table, never the headline (SPEC §"anchor on writes").

## 3. The model ladder

Per-call `model` override (Stagehand `act`/`extract` options; `withTrueFact` records `step.cost.model`). Reads run on a cheap model; each write task runs once per rung, per run.

| Rung | Example (2026) | Key |
|---|---|---|
| Frontier | `anthropic/claude-opus-4-8`, `openai/gpt-5.4` | cloud |
| Mid | `anthropic/claude-haiku-4-5`, `openai/gpt-5-mini` | cloud |
| Open-weight hosted | `cerebras/qwen-3-235b-a22b-instruct-2507`, `groq/openai/gpt-oss-120b` | cloud |
| Local | Qwen3-27B via oMLX (`scripts/omlx-model.mjs`) | **none** — reproduces Probe Run 2 with no cloud key |

The ladder is the experiment: the durable-market hypothesis (FINDINGS §1 corollary) is confirmed iff R rises monotonically-ish down the rungs. Temperature and provider (`local` vs Browserbase) are recorded per run; both change overlay/captcha rates and nondeterminism, which is why N ≥ 5.

## 4. The runner (`scripts/bench/run.mjs`, `npm run bench`)

Deterministic loop, no cleverness:

```
for task in suite: for model in ladder: for run in 1..N:
  reset the fixture (fresh state)
  sh = Stagehand.create({ browser, model: rung })         # local rung → omlxModel()
  { act, extract, replay } = withTrueFact(sh, { jsonl: out/<task>__<model>__<run>.jsonl, screenshots: true })
  await page.goto(fixture[task])
  await act(task.instruction[, { expect }])                # ONE decisive write; declaration only where a task declares one
  belief = await extract(task.completionQuestion,          # the SAME model grades ITSELF from the page it is on:
             z.object({ completed: z.boolean() }))         #   "Was the order placed? Answer from what the page shows."
  replay.setClaim(belief.data.completed)                   # run-level belief claim — the model's, not ours
  oracleLanded = await GET fixture/truth?task=…            # out of band — the wrapped page never sees this
  decisive = replay.steps.findLast(kind === "write")       # the act above (the belief extract is a read step)
  append oracle.jsonl { task, model: rung, run, jsonl, provider, oracleLanded,
                        claimExec: decisive.agent_claim.success,      # Stagehand's executor (§1.1)
                        claimBelief: replay.claim.done,               # the model's self-assessment
                        verdict: decisive.verdict, reason: decisive.evidence.postcondition.reason,
                        cost: decisive.cost }
```

- **Neither claim is ours.** `claimExec` is Stagehand's executor; `claimBelief` is the model answering a fixed yes/no question about the page it just acted on — the self-assessment the SPEC's failure argument is about, produced by the graded party (FINDINGS §4). TrueFact's verdict for the decisive step is already recorded before the belief `extract` runs and never consults either claim (invariant 1). The belief `extract` is itself a read step with its own grounding verdict, which is discarded from the write headline and kept in the audit trail.
- **`model` comes from the runner's rung, not `step.cost.model`.** `step.cost.model` is null whenever the model was set at `Stagehand.create` (every local/oMLX run) rather than per call; the manifest records the rung the runner chose.
- **The belief question is one fixed string per task**, written before any run and stored in `report.json`. Rewording it after seeing R_belief would be tuning the graded party.
- **Declarations:** most tasks run pure `auto` (the headline is an `auto` number — DAY4 §0.6). A separate pass adds a declaration to the `optimistic-ui` and `silent-noop` tasks to measure "declarations needed to reach precision X" (SPEC open question), reported in its own column, never mixed into the `auto` headline.
- **Cost/latency** come free from `step.cost`; the runner only records provider and wall-clock.

## 5. The scorer (`src/bench.ts` — pure, exported, tested)

```ts
export interface RunRecord {
  task: string; model: string; run: number; provider: "local" | "browserbase";
  claimExec: boolean;         // Stagehand's executor success on the decisive write (§1.1)
  claimBelief: boolean | null;// the model's post-act self-assessment; null if the extract threw
  verdict: Verdict;           // the decisive write's TrueFact verdict
  reason?: string;
  oracleLanded: boolean;      // the fixture's own truth — the third channel
  costUsd?: number;           // step.cost priced through the model table
}
export interface Rate { x: number; n: number; p: number; lo: number; hi: number } // point + Wilson 95%
export interface Slice {                       // computed once per claim kind: "exec" | "belief"
  falseSuccess: Rate;         // R: oracle=fail | claim=success
  miss: Rate;                 // M: verdict=landed | claim=success ∧ oracle=fail
  caught: Rate;               // verdict≠landed | claim=success ∧ oracle=fail  (recall, lenient)
  matrix: { claim: boolean; oracle: boolean; n: number }[]; // the four buckets
}
export interface BenchReport {
  byModel: Record<string, {
    exec: Slice; belief: Slice;
    falseAccusation: Rate;    // verdict=did-not-land | oracle=landed  (cry-wolf; claim-independent)
    underConfidence: Rate;    // U: verdict=inconclusive | oracle=landed  (claim-independent)
    usd: number; n: number;
  }>;
  overall: { exec: Slice; belief: Slice; falseAccusation: Rate; underConfidence: Rate };
  gates: { marketExists: Gate; instrumentWorks: Gate; publish: boolean };
}
export type Gate = { pass: boolean; detail: string } | { pass: null; detail: "insufficient-n" };
export function score(runs: RunRecord[], opts?: { z?: number; thresholds?: Partial<Thresholds> }): BenchReport;
export function wilson(x: number, n: number, z?: number): Rate;
```

`falseAccusation` and `underConfidence` do not depend on which claim is used — they compare the verdict to the oracle on real landings — so they are computed once. Everything that conditions on "the agent said success" is computed twice, once per claim kind, and printed as two rows.

Wilson score interval (chosen over normal because the rates sit near 0 and n per rung is small):

```
center = (p̂ + z²/2n) / (1 + z²/n)
half   = (z / (1 + z²/n)) · √( p̂(1−p̂)/n + z²/4n² )
lo, hi = center ∓ half          (clamped to [0,1]);  n = 0 → p = 0, [0,1]
```

The four buckets (SPEC Output) are `claim × oracle`, computed once per claim kind; the product metrics are the M / false-accusation slices above. The `exec` row is the step-level primitive (the headline: it is what every loop built on `act` inherits); the `belief` row is the run-level claim the literature measures. They are always reported as two rows, never pooled, because they measure different primitives (DAY4 §0.6).

`report.md` leads with two lines per rung — `opus-4-8 · exec: false-success 3.1% [1.2–7.4] → TrueFact residual 0.0% [0–24]` and the same for `belief` — then cry-wolf and U per rung, the ladder trend, the per-task matrix, the grounding side-table and $/run.

## 6. The two pre-registered gates (before any run)

Register the thresholds in `report.json` before collecting data; the scorer computes pass/fail, it is not decided after seeing the number. **Gates read point estimates over count floors; intervals are reported beside them, not used as the criterion.** The arithmetic that forces this: `wilson(0/30).hi = 11.4 %`, `wilson(0/50).hi = 7.1 %`, `wilson(0/100).hi = 3.7 %`, `wilson(0/200).hi = 1.9 %`; an upper bound of 1 % needs ≈ 380 observations with zero events. Per-rung silent-failure counts at MVP scale are 5–15, so an interval-based Gate B could never pass and would only ever report "not proven," which is not a decision.

- **Gate A — the market exists.** On the **weakest rung**, `R_belief.x ≥ 3` and `R_belief.p ≥ 0.05` over `n ≥ 30` decisive writes (and `R_exec` reported alongside). At least the long tail silently asserts completion on ≥ 5 % of writes, with enough events that this is not one fluke. A frontier at ~0 does **not** fail this gate (§0.4). Belief, not exec, is the gating claim because it is the one the market complains about — an executor that ran a click nobody trusted is not a customer's silent failure; a model that *said done* is.
- **Gate B — the instrument works,** pooled over rungs that clear A:
  - **miss:** `M.x = 0` over `M.n ≥ 20` silent failures, or `M.p ≤ 0.05` over `M.n ≥ 40`. TrueFact blessed at most one in twenty silent failures as `landed`.
  - **cry-wolf:** `falseAccusation.x = 0` over `n ≥ 60` real landings, or `p ≤ 0.02` over `n ≥ 100`. Invariant 2 made concrete: a false `did-not-land` is as disqualifying as a miss.
  - `underConfidence` is **reported, not gated** — it is the honesty tax, and the number that shapes the product (SPEC open question), not a pass/fail.
- **Publish (Day 7) iff A ∧ B.** If A fails, the problem is too rare — stop (SPEC's kill signal). If A holds but B fails, the problem is real but this instrument is not good enough yet — the honest outcome the graded-party discipline is meant to surface. If a floor is unmet the gate is `insufficient-n` and the fix is more runs, not a lower floor.

Expectation, stated before running so it can be wrong: `optimistic-ui` is where M will come from. TrueFact's `confirmation` row is a heuristic that reads a banner; a page that lies to its own user lies to the heuristic too. A miss there is the product's *known* ceiling (a network/CDP-level check is the upgrade path, DAY4 §10), and the report says so rather than hiding the task.

## 7. Cost

`step.cost` gives tokens per step; a small `PRICES` map (`$/1M in`, `$/1M out` per model, editable — prices move) turns it into `costUsd`. `report.md` shows $/run per rung and the reads-cheap/writes-frontier split (SPEC Day 6). The local rung is $0 (the point). No LLM in scoring, ever (DAY4 §5).

## 8. Ethics, reproducibility, determinism

- **Writes only on owned fixtures**; reads may use owned/public pages. No third-party writes — restated from SPEC because it is the one non-negotiable.
- **Fresh state per run** (`/reset` or a new port) so runs are independent; `closeAllConnections` between (the `serve()` keep-alive lesson).
- **Record everything that moves the number:** model, temperature, provider, Stagehand version, timestamp — into `report.json`, so the table is reconstructible.
- **N ≥ 5** per (task, rung); real agents are nondeterministic (overlay/captcha rates differ by provider). Two runs is noise (SPEC).
- **Headless, `screenshots: true`** for the audit trail; each miss keeps its PNG so a human can see what fooled the heuristic.

## 9. Tests

**`test/bench.test.ts` — the scorer, pure, no browser.** BDD over synthetic `RunRecord[]`:
- given a fleet with known claim/verdict/oracle counts, then the four-bucket matrix, R, M, cry-wolf, U and $/run match hand-computed values — for `exec` and `belief` separately.
- given `wilson(2, 200)`, then `[lo, hi]` matches the closed form; `wilson(0, 30)` is `p 0` with `hi ≈ 0.114`; `wilson(0, 0)` is `[0, 1]`, no divide-by-zero.
- given every silent failure caught (`verdict ≠ landed`), then `M.x === 0`.
- given an `optimistic-ui` run where TrueFact said `landed` on `oracle=false`, then M reflects the miss (the adversarial case is not silently dropped).
- given a real landing TrueFact called `did-not-land`, then `falseAccusation.x > 0` and Gate B can fail on it alone.
- given a real landing TrueFact called `inconclusive`, then U counts it and cry-wolf does not.
- given frontier R ~0 but local R high, then `marketExists` passes (the gate reads the weakest rung, not the pooled mean).
- given local `R_belief.x = 2` over `n = 30`, then Gate A fails on the event floor even though `p > 0.05` (one fluke is not a market).
- given `n < 30` on a rung, then that rung's gate is `insufficient-n`, not a false pass.
- given `claimBelief = null` on some runs, then those runs are excluded from the belief slice only; the exec slice and cry-wolf still count them.

**`test/bench-fixtures.test.ts` — the oracle, real browser, no LLM.** The harness can be wrong before any model runs, so the fixtures get the same treatment as the wrapper: `fakeStagehand` performs the decisive click on each fixture and the test reads `/truth`:
- given `clean-checkout` and a real click on "Place order", then `/truth` reports `landed: true`; after `POST /reset`, `false`.
- given `overlay-checkout` and a click at the button's coordinates, then `/truth` stays `false` (the scrim took it) — and `withTrueFact` says `did-not-land` / `overlay` (Probe Run 2, now a regression test).
- given `optimistic-ui` and the click, then the banner renders, `/truth` is `false`, and the auto verdict is recorded — whatever it is — so the miss ceiling is *measured* in CI, not assumed.
- given each never-lands fixture, then `/truth` is `false` after the click.

## 10. Not in Day 6

Multi-write tasks with per-write oracle attribution (single decisive write is the MVP; a write-log-diff oracle is post-benchmark) · a hosted dashboard (Day 7 publishes a static table) · browser-use / Playwright-MCP adapters (after the number, SPEC) · auto-repair / fixing the agent · a screenshot judge for scoring (deterministic only) · CAPTCHA solving (the fixture gates, it is not solved) · multi-tab task flows (the `activePage()` deferral, DAY5 §0) · continuous/CI benchmarking (a one-shot number this week; automate only if Day 7 ships).

## 11. Open questions this answers, and the one it does not

- **The rate** (FINDINGS §5) — answered: R with an interval, per rung.
- **Frontier false-success on hard traps** (FINDINGS §5) — answered by `optimistic-ui`: does even a frontier model report success when the server rejected the write, and does TrueFact miss it?
- **Auto-inference coverage** (SPEC) — answered: the count of declarations needed to move `optimistic-ui`/`silent-noop` from `no-change`/`changed-unclassified` to a confident verdict.
- **Frontier erosion** (SPEC) — answered: the R trend down the ladder is the whole hypothesis in one column.
- **Does not answer:** whether the number generalizes off our fixtures to production sites. Owned fixtures are the only ethical, reproducible surface; external validity is a claim Day 6 supports but cannot close, and the README will say so.

## 12. AGENTS.md updates (do with the build)

- Stagehand fact: `ActResult.data.success` is **mechanical** (the action executed) — never a judgment about the outcome; `false` only on no-element / unsupported method / thrown action (§1.1). Nothing in TrueFact may read it as "the agent believes it succeeded."
- Benchmark rule: the wrapped page never receives the `/truth` URL; the oracle is read by the runner only. A fixture without a server-side oracle is not a benchmark fixture.
- Commands: `npm run bench` (needs `.env`; local rung runs with none), `npm run bench:score` (pure, re-scores `bench/out/oracle.jsonl`).
- Probes now import their fixture from `scripts/bench/fixtures.mjs`; `scripts/false-success-fixture.mjs` is gone.

## 13. Review

Critique pass against the Stagehand 4.1 extension source, the sample-size arithmetic, and [arXiv 2606.09863](https://arxiv.org/abs/2606.09863) (false success characterized across tau²-bench / AppWorld: 3–75.8 % prevalence, LLM judges ≤ 0.65 AUROC — the same figure DAY4 §5 cites for refusing an LLM judge). What it changed from the first draft: the step-level claim was being presented as an agent's assertion when it is an executor's (§1.1) — fixed by making the model's self-assessment a mandatory second claim and reporting both; Gate B's thresholds were unreachable at the floor the spec itself set (§6) — fixed by gating on point estimates with count floors; the suite had only two landing tasks, starving the cry-wolf denominator (§2) — fixed by adding two landing shapes and a balance rule; under-confidence was unmeasured though the SPEC asks for it — added as U; the overlay fixture existed in three copies — one source; the fixtures themselves were untested — a real-browser oracle test suite. The three original calls stand: a MISS-rate headline over the four raw buckets, the kill gate read on the weakest rung, and the adversarial `optimistic-ui` fixture in the suite with the expected miss written down before the run.

VERDICT: **APPROVED FOR BUILD** — `scripts/bench/{fixtures,run,score}.mjs`, a pure `src/bench.ts` with `test/bench.test.ts`, `test/bench-fixtures.test.ts` on the real browser, probes rewired to the shared fixtures. Publish Day 7 iff Gate A ∧ Gate B on their count floors.
