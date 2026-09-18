# Day 4 — Declared postconditions, and the Day 3 revisions they force

Spec (2026-09-16). **Built the same day** — `src/declaration.ts`, `decideWrite`/`pollUntil`/`evidenceOf`/`sessionVerdict` in `src/postcondition.ts`, thin `run()`; R1–R9 applied; 92 tests green in ~12 s (the HTTP-fixture move alone took the suite from 15.8 s to 11.8 s while adding 41 tests). Two things the build caught that the spec did not: a `FieldResult` stored whole as `auto` carried the plaintext password into evidence, and `step.declaration` stored the caller's original object, not the redacted copy — both now redacted at the seam (§7). Synthesized from seven parallel reviews — official Stagehand docs + installed types, 2025–26 research, an open-source survey via the GitHub API, a deep codebase read, a test-suite audit, an experimental pass, and a devil's advocate — against the shipped Day 1–3 code. Where they disagreed, the call is made below and the reason given.

## 0. The calls, up front

1. **Declarations are data, never callbacks.** A tagged union of four kinds plus an `absent` modifier. A user callback can close over `ActResult`, which puts the agent's claim inside a verdict — the one thing the product forbids. Every deterministic system surveyed (Playwright, WebArena, BrowserGym/webarena-verified, uiuing/browser-agent) uses data; every callback/free-text system (browser-use `ground_truth`, Skyvern criteria, Stagehand's eval rubrics) needed a confidence escape hatch because free text can loosen.
2. **A declaration rides on `act(instruction, { expect })`.** Stagehand parses `act` options with `z.strictObject` and **throws on an unknown key**, so the wrapper strips `expect` before delegating. Four lines; keeps "your automation runs unchanged."
3. **Composition is asymmetric and explicit.** Unmet → `did-not-land` (high). Met lifts only `no-change`, `changed-unclassified`, `hash-only-nav`, and heuristic `landed`. Met never overrides a high-confidence `did-not-land` (validation error, obstruction). Unreadable → `inconclusive`. The destination gate stays last and unconditional. Negations only tighten.
4. **One budget, one poll.** `waitMs` default **5000** (Playwright's default; 8 s stalls an agent loop on every dead click). Declared checks are cheap in-page reads polled at 250 ms; the auto path re-captures only when the fingerprint moves. Retries are read-only — the write is never re-issued.
5. **Bare `no-change` is demoted to `inconclusive`.** "No visible change" is an inference from absence, the class of guess Day 2 reserved for heuristic. `no-change` + a Day 2 obstruction (cookie overlay, login wall) stays `did-not-land` — two independent signals, the cookie-overlay signature Day 3 named. A declaration is how an engineer turns a silent dead click into `did-not-land` on purpose.
6. **The benchmark headline counts `auto` steps only.** Declared steps are a separate column with their own interval; only `auto` can trip the kill signal. Otherwise the fixture author and the declaration author are the same person and the instrument grades against its own crib sheet.
7. **Day 4 is the right next day, but small.** Roughly 120 lines of new code plus the Day 3 refactor it needs. Run `scripts/probe-overlay-act.mjs` with a real key *in parallel* — it is independent of Day 4 and has never run. It does not gate this build.

## 1. Day 3 revisions folded in (do these first — they are the same change)

Ordered by how much they matter. Each is evidence-backed, not taste.

| # | Change | Why (file:line) |
|---|---|---|
| R1 | **Field short-circuit only when *every* attempted action is a field write.** Mixed `fill` + `click` runs `classify` too; the final verdict is the stricter of field result and classification. | `src/index.ts:239` short-circuits on `methods[0]`. A fill-then-submit that trips validation reads `field-match / landed` — a missed silent failure. |
| R2 | **`no-change` → `inconclusive` unless corroborated.** Corroborated = session `overlay`/`login-wall`/`captcha` on the final page, or `:user-invalid` (already its own row). With corroboration → `did-not-land`, `high`. | `src/postcondition.ts:245` gives absence-of-feedback `high` confidence. Silent autosaves and fire-and-forget POSTs inflate the headline bucket — the bias Day 2 fought. Day 3's done-when (overlay + no-change) survives unchanged. |
| R3 | **`resolveNoChange` treats a null fingerprint as "changed."** | `src/index.ts:155`: a mid-navigation read returns null, the `fp && lastFp` guard is false, no re-capture happens, and a write that bounces to a login wall pays the whole budget instead of resolving at ~1.2 s. The `/redirect` test passes only via the terminal capture. |
| R4 | **`waitMs` default 8000 → 5000.** One budget shared by the auto poll and declared checks. | Playwright's default; every dead click in a live loop stalls 8 s today and the default is untested (tests use 1200–4000). |
| R5 | **Extract `pollUntil(page, budgetMs, probe)` and export `evidenceOf(before, after, pageSwitched)`.** | `src/index.ts:145-164` is a generic poll with the predicate hardcoded; `run()` calls `classify()` twice purely to manufacture the evidence block then overwrites `reason`/`confidence` (`:234-236`, `:245-248`). |
| R6 | **Move the write decision out of `run()` into `decideWrite()` in `postcondition.ts`.** `run()` becomes capture → invoke → decide → declare → gate → redact → record. | `run()` is 146 lines with five concerns; D13 promised it stays thin; Day 4 adds a sixth. |
| R7 | **Redaction keyed on the target, at the seam.** Any read of a field (auto or declared) resolves `isPassword` and redacts `expected`/`actual`/`arguments`. | `src/index.ts:249,281-287` keys only on the auto field result; a `field` declaration against a password would store plaintext. |
| R8 | **One in-page resolver, one `evaluate`, branching inline on `{ selector, want }`.** | `src/postcondition.ts:275-313` is exactly what `element` and `field` declarations need, but the serialized function cannot call an outer helper (AGENTS.md rule), so it is extracted as a single evaluate with a mode switch, not a shared function. Also fixes `:289` passing the unstripped selector to `querySelector`. |
| R9 | Housekeeping: `Confidence` declared twice (`session.ts:7`, `postcondition.ts:25`) → one; `Wrapped` declared after use → move up; README still says "Day 1, being redone" → fix; `evidence.before/after` stay `Fingerprint` (decorative on writes now — the tree diff is on `postcondition`; leave, note). | codebase read |

Not changed, deliberately: the type-only circular import (`postcondition.ts` ↔ `index.ts`) is erased at build and no value crosses it; `activePage()` re-resolution racing a multi-tab agent is real but needs a `pages()`-delta strategy that belongs with the Day 6 harness, where multi-tab flows first appear.

## 2. The declaration API

```ts
// src/declaration.ts
export type Declaration =
  | { kind: "url";     matches: string | RegExp }                    // string = base-path substring (WebArena rule), never equality
  | { kind: "element"; selector: string; absent?: boolean }         // css | xpath= | text=
  | { kind: "text";    matches: string | RegExp; role?: string; absent?: boolean }  // over normalized tree lines; role narrows to e.g. "status"
  | { kind: "field";   selector: string; equals: string | RegExp };

export interface DeclaredResult {
  declaration: Declaration;
  met: boolean | null;       // null = could not read the page
  actual: string | null;     // last observed value; redacted for password targets
  elapsedMs: number;
}

// src/index.ts — public act signature
export type ActOptions = StagehandClientActOptions & {
  expect?: Declaration | Declaration[];   // AND
  waitMs?: number;                        // per-call override of TrueFactOptions.waitMs
};
```

**Vacuity is rejected at declaration time, loudly.** Empty strings, a `RegExp` that matches `""`, an `element` with an empty selector — `withTrueFact` throws synchronously with the offending declaration. The engineer wrote it; failing fast beats a silent `landed` on every write.

**`text` matches over the normalized a11y tree** (the same lines `classify` diffs), not `innerText`: it survives re-renders, ignores `display:none`, masks passwords, and `role` lets "a `status` line matching /Order #\d+/" be one declaration. **`element` uses Stagehand's selector parser** (`css`, `xpath=`, `text=`), read with `locator(sel).count()` — the one primitive that does not throw on zero matches; `isVisible()` and friends reject on a missing element, so `count()` gates them. **`url`** with a string is base-path substring plus any query keys present (WebArena's `GOLD in PRED`); with a `RegExp`, the regex. **`field`** reuses the R8 resolver (`value`, `select` selected option, `isPassword`).

No callbacks, no fifth kind, no instruction-text inference. A predicate over `PageState` was proposed and rejected: it is a judge with a nicer type signature.

## 3. Where it runs, and the composition rule

In `run()` (post-R6): after the three-way write branch closes and **before** `sessionVerdict`. After, so it sees the settled page; before, so a declared `landed` into a login wall is still demoted; and before redaction, same compute-then-redact rule as Day 3 §7.

```
auto := decideWrite(before, after, attempt)        // Day 3, with R1–R2
if expect:
  results := pollUntil(page, waitMs, all declarations met | deadline)   // cheap reads every 250 ms; read-only
  if any result.met === null           → verdict = inconclusive, reason = declared-unreadable   (never did-not-land)
  else if any positive unmet, or any negative violated
                                       → verdict = did-not-land, reason = declared-unmet, confidence = high
  else if all met:
      if auto.verdict ∈ {landed}       → landed, confidence = high, reason = auto.reason  (confidence raised, reason kept)
      if auto.reason ∈ {no-change, changed-unclassified, hash-only-nav}
                                       → landed, reason = declared-met, confidence = high
      if auto.verdict = did-not-land, auto.confidence = high (validation-error, corroborated no-change)
                                       → unchanged: did-not-land. A declaration does not argue with a mechanism.
      negatives alone never lift: if every declaration is `absent`, verdict = auto.verdict
verdict := sessionVerdict(verdict, detectSession(finalPage))   // last, unconditional
```

`evidence.postcondition` keeps the auto outcome in full (`auto: { verdict, reason, confidence }`, tree diff, forms) and adds `declared: DeclaredResult[]`. Day 6 can count how often a declaration contradicted the default — that number is the auto-inference gap, measured instead of papered over.

**Why met may lift `no-change` but not `validation-error`.** A declared element that is present is a direct page read on the same footing as `field-match` — mechanism-backed, `high`. `:user-invalid` rising is also a mechanism. Two mechanisms disagreeing is not a case to resolve in favor of the engineer's guess; it is a case for `did-not-land` and a loud reason. A heuristic row (`confirmation` regex) disagreeing with a mechanism is resolved in favor of the mechanism, which is what "met lifts heuristic `landed` to high" and "unmet beats `confirmation`" both express.

## 4. Run-level declaration

`replay.finalize({ expect })` — same `Declaration` type, evaluated once on `activePage()` after a settle (one `captureState`, 10–350 ms, plus `detectSession`). `Replay.verdict` becomes the AND of the step roll-up and the run declaration: a run declaration can only demote. It never launders a step `did-not-land`. About 30 lines; ships in Day 4 because "by the end, the URL matches /thank-you" is the one declaration most flows actually have.

## 5. Cost, latency, performance — the long-term stance

Declared checks cost one `evaluate` (~5 ms) or one `count()` per poll tick, at 250 ms, for at most `waitMs`. No snapshot is taken for a declared check; the auto path re-captures (10–350 ms) only when the fingerprint moves (Day 3 D21). Worst case per write is `waitMs` — 5 s — paid only when nothing happens on the page and nothing declared appears. No LLM anywhere in verification, ever: judges cap at 0.65 AUROC and anchor on confident language; deterministic checkers hit 84 % precision. Cost > latency is the SPEC's rule and this honors it; the 8 → 5 s default is the one latency concession, and it is Playwright's number.

## 6. Benchmark rules (SPEC Day 6 amendments)

- Every step carries `declaration` (`"auto"` or the declaration) — already on the type since Day 1. Report `auto` and `declared` as separate columns with separate intervals.
- The kill signal is pre-registered on the `auto` column only.
- On owned fixture apps, declarations are written *after* the auto run, from the `no-change`/`changed-unclassified` rows, and reported as "declarations needed to reach precision X" — that is the product-shaping number SPEC §open-questions asked for, not a way to raise the headline.

## 7. Tests

**Day 3 hygiene (from the audit; do with R1–R9):** assert `confidence` on every pure row (it is the load-bearing field and no test checks it); add `normalizeTree`/`multisetDiff` tests (same page twice with different node ids → empty diff; the 40-line cap); close the extra tab in the new-tab test and assert `pages().length`; replace the wall-clock assertion with "resolved without polling" against a large budget; **move every integration fixture onto `serve()`** — `locator.fill()/click()` costs ~1 s on a `data:` page vs ~9 ms over HTTP, so this halves the suite (~15.8 s → ~8 s) and retires `load()`; add `withBrowser()` to helpers so a fourth file does not add a fourth launch; add the missing §9 rows (empty-string fill, stale selector, `selectOption`, form-cleared, changed-unclassified, `unsettled`, error-text, D17 ticking-page-that-navigates, a real roll-up). Move `session()`/`step()` builders into helpers beside `state()`/`form()`.

**Day 4 matrix** (BDD `it` names, all on `serve()`, `waitMs` 600 except where the poll is the subject):

Happy path, one per kind:
- given a declared `url` /done and the click navigates there, then `landed` / `navigated` at high
- given a declared `element` `#receipt` and the submit renders it on a page whose auto reason was `no-change`, then `landed` / `declared-met`
- given a declared `text` /Order #\d+/ with role `status`, then `landed` / `declared-met`
- given a declared `field` equals `a@b.co` after a mixed fill + click, then `landed`

Unmet beats auto `landed`:
- given a declared element that never appears though a confirmation did, then `did-not-land` / `declared-unmet`
- given a declared `url` /done but the click navigates to /error, then `did-not-land` / `declared-unmet`

Met cannot argue with a mechanism:
- given a declaration that passes while `:user-invalid` rose, then `did-not-land` / `validation-error` stays
- given a declaration that passes into a 401 login wall, then the destination gate still yields `inconclusive`
- given only `absent` declarations that hold on a `no-change` page, then the verdict is the auto verdict (negatives never lift)

Semantics:
- given a declared element that appears at 700 ms, then it is met within the budget, not a premature `declared-unmet`
- given a declared element that never appears, then `declared-unmet` at the deadline and elapsed < budget + slack
- given a declaration on a scroll act, then the step is still `kind: read` and the declaration is recorded, not evaluated
- given a declaration with a selector that cannot be resolved, then `inconclusive` / `declared-unreadable`, never `landed`
- given a `field` declaration against a password input, then `expected`/`actual` are `<redacted:N>` and the verdict is still correct
- given an empty-string `text` declaration, then `withTrueFact` throws before any browser call
- given no declaration, then `declaration === "auto"` and the Day 3 verdict is unchanged (regression guard)

Roll-up:
- given one declared-landed write and one auto-landed write, then `replay.verdict` is `landed`
- given `finalize({ expect: url /thank-you })` on a run whose steps landed but whose final URL is /cart, then `replay.verdict` is `did-not-land`

Day 3 revision rows: R1 (fill + click with `required` → `did-not-land` / `validation-error`, not `field-match`); R2 (bare `no-change` → `inconclusive`; `no-change` + overlay → `did-not-land`); R3 (`/redirect` resolves in well under the budget — assert elapsed).

## 8. CI (add to AGENTS.md)

Install a Chrome `localBrowser.launch` can find (`browser-actions/setup-chrome` or `npx playwright install chrome`); containers running as root need `--no-sandbox` via `launch({ args })`; `headless: true` always; every test passes `screenshots: false` or `.truefact/` appears in CI; no wall-clock assertions (CI boxes are 2–5× slower), only budget-relative ones; Node ≥ 20.6 for `--import tsx`; close the browser before the fixture server.

## 9. Open questions, answered

- **Wrapper vs agent-called tool.** Wrapper, still — and Day 4 makes it stronger: a declaration lives in the caller's code next to the `act`, where the engineer who knows the site writes it once, not in a tool the agent may skip.
- **Auto-inference coverage.** Now measurable: the count of declarations needed on the fixture apps to reach the target precision, plus the `declared-met`-over-`no-change` rate. R2 makes the auto default honest (`inconclusive` when it does not know) instead of biased.
- **Frontier-model erosion.** Unchanged from SPEC: step-level, per-call `model` override, `auto` column only.
- **Does per-write declaration contradict the adoption argument?** No — because it is optional and the auto default is the product. The SPEC's line was about *requiring* declaration. Declarations are the precision knob for the writes that matter (checkout, delete, send), not a tax on every click. If Day 6 shows most writes need one, that is the kill signal for the auto default, not for the API.
- **Can a declaration make the instrument lie?** Downward, yes — a stale selector fails every real success. That is the engineer's explicit statement, reported as `declared-unmet` in its own benchmark column, never mixed into the headline. Upward, no — vacuous declarations are rejected, negatives never lift, and no declaration overrides a mechanism-backed `did-not-land`.
- **Should the week be reordered?** No. Day 4 is small and the Day 3 fixes are needed regardless. The probe should run today, in parallel, when a key is available; it is thirty seconds and it is the thesis in one call.

## 10. Not in Day 4

Instruction-text inference as a verdict input (never; an evidence tag at most, later) · per-site declaration packs learned from the benchmark (circular; only from owned fixtures, after Day 6) · network/CDP-level checks (webarena-verified's `NetworkEventSpec`; out of scope) · `list_count_delta` / `element_state` kinds (add when a fixture needs them, not before) · multi-tab race strategy for `activePage()` (with the Day 6 harness) · grounding for `extract` (Day 5).

## GSTACK REVIEW REPORT

Runs: 1 — seven-agent parallel review (docs, research, oss, codebase, tests, experimental, devil's advocate) synthesized into this spec (2026-09-16). Outside voice: the devil's-advocate agent served as the adversarial pass; three of its five objections were accepted into §1 (R1, R2, R4) and §6.

| Section | Status | Findings |
|---|---|---|
| API shape | decided | data-only tagged union; `expect` on `act` options, stripped before delegation (Stagehand `z.strictObject` throws on unknown keys) |
| Composition | decided | unmet → `did-not-land` high; met lifts only `no-change`/`changed-unclassified`/`hash-only-nav`/heuristic `landed`; unreadable → `inconclusive`; negatives never lift; destination gate last |
| Day 3 revisions | 9 folded | R1 mixed fill+click missed silent failures; R2 bare `no-change` demoted; R3 null-fingerprint poll bug; R4 5 s budget; R5–R6 `pollUntil`/`evidenceOf`/`decideWrite`; R7 redaction at the seam; R8 one resolver; R9 housekeeping |
| Benchmark | amended | `auto` vs `declared` columns; kill signal on `auto` only |
| Tests | specified | Day 3 hygiene (confidence asserted, tree tests, HTTP fixtures halve the suite) + 20-row Day 4 matrix |
| Rejected | 3 | predicate-over-PageState (a judge in disguise); instruction-text inference; reordering the week |

VERDICT: **APPROVED FOR BUILD** — Day 3 revisions R1–R9 and Day 4 in one build; run the real-key probe in parallel.

NO UNRESOLVED DECISIONS
