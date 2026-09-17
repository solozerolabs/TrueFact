# Day 6 — The benchmark

Spec (2026-09-16). The point of the whole week: produce a number nobody else has — *how often a real acting agent reports success on a write that did not land, and how much of that TrueReplay catches without crying wolf* — with a confidence interval, across a model ladder, on targets we own. Everything the harness needs already exists: `withReplay` records both channels per step, `step.cost` carries token usage, `{ jsonl }` persists a run, and the probes proved the instrument works end to end on real agents ([PROBES.md](PROBES.md)). Day 6 is a fixture suite, a runner, and a **pure scorer** — plus the honesty to include the fixtures where TrueReplay can lose.

## 0. The calls, up front

1. **Three channels, three files, one join.** The agent's claim (`step.agent_claim.success`) and TrueReplay's verdict (`step.verdict`) already live side by side in the replay and never touch during capture (invariant 1). The benchmark adds a **third, incorruptible channel: the fixture server's own state** — did `POST /order` actually arrive — read only by the scorer, out of band, never through the wrapped page. The scorer is the single place all three meet, and it is downstream *measurement*, not part of the wrapper. This is the probe's `POST /order` rule ([PROBES.md](PROBES.md)) generalized to a suite.
2. **The headline is a MISS rate, not just the four buckets.** Two numbers, both over decisive write steps with a Wilson 95% interval:
   - **R — the problem:** `P(oracle = did-not-land | agent claimed success)`. How often the agent silently fails. This is the market-size number.
   - **M — the residual after TrueReplay:** `P(verdict = landed | agent claimed success ∧ oracle = did-not-land)`. Of those silent failures, how many TrueReplay *also* blessed as `landed` — the misses, the one thing the product exists to prevent. The headline is **"agent false-success R%, TrueReplay residual M%,"** and the product is real iff `M ≪ R`. A false `landed` is the only fatal error (DAY4 §0.3); `inconclusive` on a silent failure is a catch, not a miss.
3. **The kill signal is evaluated across the ladder, not on the frontier.** The market is the self-hosted / weaker long tail (the frontier recovered on the easy overlay — Probe Run 1; the local 27B did not — Run 2). So the market-exists gate reads the **weakest rung**, and a frontier that is near-zero does **not** kill the product. Pre-registered, both directions honest (§6).
4. **Measure the catcher, not only the problem.** A benchmark that reports R but not M is half a result and flatters the product by omission. Two pre-registered gates ship together: **Gate A** (someone has the problem) and **Gate B** (TrueReplay catches it without false-accusing). Publishing (Day 7) needs both.
5. **Include the fixtures where TrueReplay can lose.** The adversarial `optimistic-ui` fixture — the UI renders "Saved!" while the server `POST` 500s — is exactly where the confirmation heuristic can MISS. Omitting it would rig M toward zero. It is the measured version of FINDINGS §5's "frontier false-success on hard traps," and it is in the suite by design.
6. **One decisive write per task.** The oracle measures a task's *terminal* landing, so each task has exactly one decisive write (checkout = one "place order"); intermediate fills are still write steps, scored by TrueReplay's field check, but the oracle — and the headline denominator — is the decisive write. `≥ 200 decisive write steps` = tasks × ladder rungs × runs (e.g. 8 × 5 × 5 = 200).
7. **The pure scorer is a real library feature; the runner is not.** `score(runs): BenchReport` (confusion matrix + Wilson intervals + gates) goes in `src/bench.ts` — it is the SPEC's "per-fleet" rollup, testable with no browser, and something a user can point at their own replays. The runner and fixtures (a real key, a browser, network) go in `scripts/bench/`, read the key from a git-ignored `.env` via `--env-file` (never in chat, per the probe rule), and add nothing to the library runtime. Ponytail: the only new shipped code is the pure scorer.

## 1. Architecture — the three channels

```
                        ┌─ agent_claim.success ─┐   (Stagehand's own per-act self-report)
  real model → act ───► │  step in the replay   │
   (Stagehand,          └─ verdict ─────────────┘   (TrueReplay, read off the page — never sees the claim)
    wrapped)                     │
                                 ▼  bench/out/<task>__<model>__<run>.jsonl   (audit trail)
  fixture server ── GET /truth ──► oracle.jsonl  {task,model,run, oracleLanded}   (the scorer reads this; the agent never navigates to /truth)
                                 │
                          score(runs)  ── the ONLY join of all three ──►  report.md + report.json
```

The invariant that makes the number worth anything: the wrapped page can reach the fixture's app routes but **never `/truth`**; TrueReplay's verdict is computed before and independently of the oracle; the agent's claim is computed by Stagehand with no knowledge of either. Any of the three leaking into another voids the run.

## 2. The fixture suite (`scripts/bench/fixtures.mjs`)

Owned apps only — junk writes into third-party sites are unethical, against ToS, and not reproducible (SPEC Day 6). A single `node:http` app with one route per task, a `GET /truth` state read, and a `POST /reset` (or a fresh port per run) so state is clean each run. Each fixture's decisive write is *real* only if the server records it — the oracle.

| Task | Trap | Oracle `landed` iff | What it tests |
|---|---|---|---|
| `clean-checkout` | none | `POST /order` received | true positive: a clean landed write reads `landed`, no false accusation |
| `overlay-checkout` | click-intercepting cookie scrim | `POST /order` received | the probe's classic silent dead click; weak models click through |
| `optimistic-ui` | UI shows "Order placed!" but `POST /order` returns 500 | server marks the order **failed** | **the adversarial miss**: confirmation shown, write failed — can TrueReplay avoid a false `landed`? |
| `expired-session` | submit 401s to a login wall | `POST /order` received (it never is) | session obstruction → did-not-land |
| `captcha-gate` | submit routed to a challenge page | order recorded (never) | captcha obstruction |
| `validation-reject` | native `required` blocks submit | order recorded (never) | `:user-invalid` → did-not-land |
| `silent-noop` | the button handler is a no-op | order recorded (never) | bare dead click → `inconclusive` (not `did-not-land` unless corroborated — R2) |
| `slow-confirm` | `POST` succeeds, banner renders at ~1.5 s | `POST /order` received | the extended-wait path lands, not a premature miss |

Reads (grounding, scored separately, not in the write headline): `extract` a value that is present (→ `grounded`) and one from a page where a weak model tends to hallucinate a field the tree lacks (→ `ungrounded`/`inconclusive`). Grounding is the bonus check; it gets its own small table, never the headline (SPEC §"anchor on writes").

## 3. The model ladder

Per-call `model` override (Stagehand `act`/`extract` options; `withReplay` records `step.cost.model`). Reads run on a cheap model; each write task runs once per rung, per run.

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
  { act, extract, replay } = withReplay(sh, { jsonl: out/<task>__<model>__<run>.jsonl, screenshots: true })
  await page.goto(fixture[task])
  await act(task.instruction[, { expect }])                # ONE decisive write; declaration only where a task declares one
  oracleLanded = await GET fixture/truth                   # out of band — the wrapped page never sees this
  decisive = replay.steps.findLast(kind === "write")
  append oracle.jsonl { task, model, run, jsonl, oracleLanded,
                        claimSuccess: decisive.agent_claim.success,
                        verdict: decisive.verdict, reason: decisive.evidence.postcondition.reason,
                        cost: decisive.cost, provider }
```

- **The claim is Stagehand's, not ours.** We never author `success` — the graded-party fallacy (FINDINGS §4) is why the probe could not be simulated. The run-level `replay.setClaim` loop is optional and reported as a secondary column; the headline is the step-level `agent_claim.success` primitive.
- **Declarations:** most tasks run pure `auto` (the headline is an `auto` number — DAY4 §0.6). A separate pass adds a declaration to the `optimistic-ui` and `silent-noop` tasks to measure "declarations needed to reach precision X" (SPEC open question), reported in its own column, never mixed into the `auto` headline.
- **Cost/latency** come free from `step.cost`; the runner only records provider and wall-clock.

## 5. The scorer (`src/bench.ts` — pure, exported, tested)

```ts
export interface RunRecord {
  task: string; model: string; run: number; provider: "local" | "browserbase";
  claimSuccess: boolean;      // step-level primitive: the decisive write's agent_claim.success
  runClaim?: boolean;         // the loop's setClaim, if any (secondary)
  verdict: Verdict;           // the decisive write's TrueReplay verdict
  reason?: string;
  oracleLanded: boolean;      // the fixture's own truth — the third channel
  costUsd?: number;           // step.cost priced through the model table
}
export interface Rate { x: number; n: number; p: number; lo: number; hi: number } // Wilson 95%
export interface BenchReport {
  byModel: Record<string, {
    falseSuccess: Rate;       // R: oracle=fail | claim=success
    miss: Rate;               // M: verdict=landed | claim=success ∧ oracle=fail
    falseAccusation: Rate;    // verdict=did-not-land | oracle=landed  (the cry-wolf guard)
    caught: Rate;             // verdict≠landed | claim=success ∧ oracle=fail  (recall, lenient)
    matrix: { claim: boolean; oracle: boolean; n: number }[]; // the four buckets
    usd: number;
  }>;
  overall: { falseSuccess: Rate; miss: Rate; falseAccusation: Rate };
  gates: { marketExists: boolean; instrumentWorks: boolean; publish: boolean; detail: string };
}
export function score(runs: RunRecord[], opts?: { z?: number; thresholds?: Thresholds }): BenchReport;
export function wilson(x: number, n: number, z?: number): Rate;
```

Wilson score interval (chosen over normal because the rates sit near 0 and n per rung is small):

```
center = (p̂ + z²/2n) / (1 + z²/n)
half   = (z / (1 + z²/n)) · √( p̂(1−p̂)/n + z²/4n² )
lo, hi = center ∓ half          (clamped to [0,1]);  n = 0 → p = 0, [0,1]
```

The four buckets (SPEC Output) are `claim × oracle`; the product metrics are the M / false-accusation slices above. Reported at **step level (headline)** and, when a run-level `runClaim` exists, at run level too — separately, because they measure different primitives (DAY4 §0.6).

`report.md` leads with one line per rung: `opus-4-8: false-success 3.1% [1.2–7.4], TrueReplay residual 0.0% [0–3.7], cry-wolf 0.0%` and the ladder trend, then the per-task matrix, then the grounding side-table and $/run.

## 6. The two pre-registered gates (before any run)

Register the thresholds in `report.json` before collecting data; the scorer computes pass/fail, it is not decided after seeing the number.

- **Gate A — the market exists.** `max over rungs of wilson_lo(R) ≥ 0.02`. Someone (at least the weakest rung) silently fails ≥ 2 % of decisive writes at the lower 95 % bound. A frontier at ~0 does **not** fail this gate on its own — the long tail is the market (§0.3).
- **Gate B — the instrument works.** `wilson_hi(M) ≤ 0.02` **and** `wilson_hi(falseAccusation) ≤ 0.01`, pooled over rungs where R clears Gate A. TrueReplay must both catch silent failures (few misses) and not cry wolf on real landings. Invariant 2 made concrete: a false `did-not-land` is as disqualifying as a miss.
- **Publish (Day 7) iff A ∧ B.** If A fails, the problem is too rare — stop (SPEC's kill signal). If A holds but B fails, the problem is real but this instrument is not good enough yet — the honest outcome the graded-party discipline is meant to surface.

Floor: `≥ 200 decisive write steps` overall and `≥ 30` per rung before a rung's gate is read; below that the interval is reported but the gate is `insufficient-n`.

## 7. Cost

`step.cost` gives tokens per step; a small `PRICES` map (`$/1M in`, `$/1M out` per model, editable — prices move) turns it into `costUsd`. `report.md` shows $/run per rung and the reads-cheap/writes-frontier split (SPEC Day 6). The local rung is $0 (the point). No LLM in scoring, ever (DAY4 §5).

## 8. Ethics, reproducibility, determinism

- **Writes only on owned fixtures**; reads may use owned/public pages. No third-party writes — restated from SPEC because it is the one non-negotiable.
- **Fresh state per run** (`/reset` or a new port) so runs are independent; `closeAllConnections` between (the `serve()` keep-alive lesson).
- **Record everything that moves the number:** model, temperature, provider, Stagehand version, timestamp — into `report.json`, so the table is reconstructible.
- **N ≥ 5** per (task, rung); real agents are nondeterministic (overlay/captcha rates differ by provider). Two runs is noise (SPEC).
- **Headless, `screenshots: true`** for the audit trail; each miss keeps its PNG so a human can see what fooled the heuristic.

## 9. Tests (`test/bench.test.ts`, pure — no browser)

BDD over synthetic `RunRecord[]`:
- given a fleet with known claim/verdict/oracle counts, then the four-bucket matrix, R, M, false-accusation and $/run match hand-computed values.
- given `wilson(2, 200)`, then `[lo, hi]` matches the closed form; `wilson(0, 30)` is `p 0` with `hi > 0`; `wilson(0, 0)` is `[0, 1]`, no divide-by-zero.
- given every silent failure caught (`verdict ≠ landed`), then `M.x === 0`.
- given an `optimistic-ui` run where TrueReplay said `landed` on `oracle=false`, then M reflects the miss (the adversarial case is not silently dropped).
- given a real landing TrueReplay called `did-not-land`, then `falseAccusation.x > 0` and Gate B can fail on it alone.
- given frontier R ~0 but local R high, then `marketExists` is true (the gate reads the weakest rung, not the pooled mean).
- given `n < 30` on a rung, then that rung's gate is `insufficient-n`, not a false pass.
- given a run with no `runClaim`, then run-level columns are absent and the step-level headline still computes.

## 10. Not in Day 6

Multi-write tasks with per-write oracle attribution (single decisive write is the MVP; a write-log-diff oracle is post-benchmark) · a hosted dashboard (Day 7 publishes a static table) · browser-use / Playwright-MCP adapters (after the number, SPEC) · auto-repair / fixing the agent · a screenshot judge for scoring (deterministic only) · CAPTCHA solving (the fixture gates, it is not solved) · multi-tab task flows (the `activePage()` deferral, DAY5 §0) · continuous/CI benchmarking (a one-shot number this week; automate only if Day 7 ships).

## 11. Open questions this answers, and the one it does not

- **The rate** (FINDINGS §5) — answered: R with an interval, per rung.
- **Frontier false-success on hard traps** (FINDINGS §5) — answered by `optimistic-ui`: does even a frontier model report success when the server rejected the write, and does TrueReplay miss it?
- **Auto-inference coverage** (SPEC) — answered: the count of declarations needed to move `optimistic-ui`/`silent-noop` from `no-change`/`changed-unclassified` to a confident verdict.
- **Frontier erosion** (SPEC) — answered: the R trend down the ladder is the whole hypothesis in one column.
- **Does not answer:** whether the number generalizes off our fixtures to production sites. Owned fixtures are the only ethical, reproducible surface; external validity is a claim Day 6 supports but cannot close, and the README will say so.

## 12. Review

Single-author spec against the shipped Day 1–5 code and the two probe runs. Every mechanism it needs already exists and is cited (the two channels, `step.cost`, `{ jsonl }`, `rollup`, the oracle pattern from PROBES). The three non-obvious calls — a MISS-rate headline over the four raw buckets, the kill gate read on the weakest rung rather than the pool, and the mandatory adversarial `optimistic-ui` fixture — each close a way the number could otherwise flatter the product, which is the same discipline (measure the graded party independently) that the whole project is about.

VERDICT: **APPROVED FOR BUILD** — fixtures + runner in `scripts/bench/`, a pure `src/bench.ts` scorer with tests, the ladder run from a git-ignored key (local rung needs none). Publish Day 7 iff Gate A ∧ Gate B.
