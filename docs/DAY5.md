# Day 5 — Grounding (the bonus check) + inconclusive, audited end to end

Spec (2026-09-16), revised the same day against a code read, a probe of what `page.snapshot().formattedTree` actually contains (`npm run probe:tree`, results in §1), the Stagehand v4 `extract` docs, and the installed `4.1.0` types. The first draft matched values per tree *line*; the probe shows a value split across inline markup never sits on one line, so §2 matches over a role-stripped text blob instead. The probe also killed one of the draft's reasons for "the tree is lossy" (below-the-fold content *is* in the tree) and replaced it with the real list. Still the smallest day: one new file (`src/grounding.ts`, ~50 lines), the read branch of `run()`, one evidence field, one DRY fix, and one Day 4 bug the probe surfaced.

## 0. The calls, up front

1. **Grounding checks the *read*, and that is not a two-channel violation — but the invariant needs the carve-out written down.** For a write, `agent_claim` and page-truth never touch. For an `extract`, the returned `data` *is* the object under test; comparing it to the page is grounding's whole job. What is preserved: the tree is read independently (`page.snapshot()`), the comparison is deterministic string matching, no LLM, and **no write verdict ever consumes an extraction.** AGENTS.md invariant 1 is amended to say so explicitly (§8) rather than leaving the read path looking like an exception nobody wrote down. Scoped to `extract` only; `observe` returns candidate actions, not values → `non-grounding`.
2. **Grounding emits `landed` or `inconclusive`, never `did-not-land`.** This reverses the first-draft check-table row in SPEC ("fails when a returned value is absent from the a11y tree"). Two evidence-backed reasons, not taste:
   - **The tree is lossy in specific, common ways** (§1): `title` attributes are absent; `display:none` and `aria-hidden` content is absent; a `screenshot: true` extraction can legitimately read pixels the tree never had. A value the model read from a `title` tooltip is correct and ungroundable.
   - **"At that moment" is real:** two consecutive snapshots of a page with a live ticker differ (probe), and Stagehand's own snapshot for `extract` is taken before ours. Absence is an inference from absence — the R2 principle (DAY4 §0.5) — and by AGENTS invariant 2 a heuristic never produces `did-not-land`.
   Ungrounded → `inconclusive` with the unmatched values attached. Day 6 counts them; the instrument does not accuse.
3. **The only error grounding can make is a false `landed`, so the match is strict on that side, and numbers get a token boundary.** A naive substring rule grounds an extracted `49` against `$1,249.00`. Numbers match as whole digit tokens (§2); strings must be ≥ 3 characters and whole-value present. Short strings and enums (`"ok"`, `"USD"`, a status word) are not groundable — they match everything and would turn `landed` into a rubber stamp. Same "a false landed is the product failing" rule Day 4 applied to writes (DAY4 §0.3).
4. **Long strings are summaries, not values — skip them, or the no-schema path is permanently `ungrounded`.** `extract(instruction)` with no schema returns `{ extraction: string }`, a free-text paragraph that is never a substring of the tree. Grounding values longer than 120 characters would mark every summary extraction `ungrounded` — a false alarm on every call, the worst UX in the product. Strings > 120 chars are `skipped` (counted, not judged). A summary is not a fact to ground; the facts inside it are what a schema is for.
5. **Confidence tracks the match kind.** All exact → `high`. Any value matched only after normalization → `heuristic`. The Day 6 filter field, as for writes.
6. **"Wire inconclusive across all three checks" is an audit, not a build.** Session and postcondition already return `inconclusive` first-class and `rollup` already buckets it (§5). Day 5 adds the third check and confirms the other two. Nothing to re-plumb.
7. **Reads still never enter the headline roll-up.** `rollup` counts write steps only (SPEC §Output, AGENTS invariant 4). A grounding verdict lives on the read step and is a separate Day 6 column, the same separation Day 4 gave `auto` vs `declared`.

## 1. What the a11y tree contains — verified (`npm run probe:tree`)

Everything grounding can and cannot match against, established on `4.1.0` with real headless Chrome. This is the evidence for §0.2–§0.3 and the reason the draft's line-level match was wrong.

| Fact | Consequence for grounding |
|---|---|
| Text inside inline markup is split across lines: `Split <em>across</em> inline <b>elements</b>` becomes four `StaticText:` lines. Likewise `Total: <strong>$1,249.00</strong>`. | **Never match per line.** Build one text blob: strip the role prefix from each normalized line, join with a single space. `"Split across inline elements"` and `"Total: $1,249.00"` then match. |
| Whitespace is already collapsed (`Ada   Lovelace` → `Ada Lovelace`). | Normalize the *extracted* value's whitespace; the tree side is already clean. |
| Present: input values (`ada@example.com`), `[selected]` option text, `alt` text (`image: …`), `aria-label` (`button: …`), document title (`RootWebArea: …`), shadow-DOM text, iframe content (nested `RootWebArea`), **below-the-fold content**, unicode/currency intact (`$1,249.00`, `café — 49 €`), long text unbroken (321-char line). | The tree is a good target: most real extractions are groundable; no viewport scrolling needed; no `frames()` dance (the SDK has none anyway). |
| Absent: `title` attribute text, `display:none`, `aria-hidden="true"`. Passwords masked as `••••••••`. | The concrete lossy list. A miss on these is a correct extraction we cannot confirm → `inconclusive`, never `did-not-land`. A password value returned by an extraction can never ground (masked) — it lands in `absent`, and is redacted in stored evidence like every other password (§3). |
| A live page changes between two back-to-back snapshots (ticker probe). | "At that moment" is a property of the page, not a flaw in the check; another reason absence is not a mechanism. |
| Numbers appear as bare tokens: `cell: 3`, `StaticText: $1,249.00`, `Date 2026-09-16 and 09/16/2026`. | Substring matching on digits is unsafe (`3`, `49`, `16` are everywhere). Token-boundary rule in §2. |
| `extract` itself reads the accessibility tree (Stagehand v4 docs: "the page accessibility tree"; `screenshot: true` adds the viewport image). Options (`z.strictObject`): `model`, `timeout`, `screenshot`, `cache`, `locator`, `ignoreLocators`, `page`. | The model's input and our target are the same representation, which is what makes a deterministic check meaningful. `locator` scopes the model to a subtree — grounding against the whole page is a superset, correct as-is. `page` can point the extraction at a non-active tab — grounding must snapshot **that** page. `screenshot: true` is recorded on the evidence so Day 6 can separate visual misses. No option is added to `extract` (strict object; and there is nothing to declare). |

## 2. The grounding algorithm

```ts
// src/grounding.ts
export type GroundingReason = "grounded" | "ungrounded" | "non-grounding" | "nothing-to-ground";
export interface GroundedValue { value: string; match: "exact" | "normalized" | "absent" }
export interface Grounding {
  verdict: Verdict;              // landed | inconclusive — never did-not-land
  reason: GroundingReason;
  confidence: Confidence;
  values: GroundedValue[];       // the judged leaves, in walk order (capped)
  skipped: number;               // leaves not judged: booleans, null, < 3 chars, > 120 chars, beyond the cap
  visual?: true;                 // extract ran with screenshot: true
}

export function groundValues(data: unknown, tree: string[]): Grounding;   // pure; tree = normalizeTree(...)
```

One pass:

1. **Blob.** From the normalized tree lines (node ids and indentation already stripped by `normalizeTree`), drop the role prefix (`^[A-Za-z]+(?:, [a-z]+)*: ` — `StaticText: `, `cell: `, `heading: `, `scrollable, html`) and the `[selected]`/`[checked]` markers, join with one space. Keep an exact blob and a lowercased copy.
2. **Leaves.** Walk `data` (objects, arrays). Judge `string`s with `3 ≤ trim().length ≤ 120` and finite `number`s. Everything else — booleans, `null`/`undefined`, empty/short/long strings — increments `skipped`. Stop judging after 50 leaves (the rest count as `skipped`). Password redaction of stored leaves is decided at the seam in `run()`, not here (§3).
3. **Match, per leaf.** A numeric leaf (a `number`, or a string matching `/^[\d.,\s$€£]+$/` containing a digit) is grounded when its digit-and-dot core appears in the blob with **non-digit boundaries** on both sides, after removing thousands separators from both (`1249` and `1249.00` match `$1,249.00`; `49` does not). A text leaf is grounded **exact** when it is a substring of the exact blob; **normalized** when its whitespace-collapsed, lowercased form is a substring of the lowercased blob; else **absent**.
4. **Verdict.**
   - no judged leaves → `inconclusive` / `nothing-to-ground` (cannot verify; do not pretend).
   - every judged leaf matched → `landed` / `grounded`; `high` if all exact, `heuristic` if any normalized.
   - any leaf absent → `inconclusive` / `ungrounded`, `heuristic`; the absent values are in `values`.

Zod transforms: `data` is `z.output<Schema>`, so a `.transform()` or `z.coerce.number()` can yield a value that was never literally on the page. That is an `absent` → `inconclusive`, which is right: grounding reports what the page shows, and a transformed value is the caller's derivation. Not special-cased.

## 3. Where it runs

The read branch of `run()` (`src/index.ts:188`) hard-codes `verdict: "inconclusive"` and records only a fingerprint. Change it to:

```
page := options.page ?? activePage()          // extract can target a non-active tab
… invoke, re-resolve, settle (unchanged) …
if this is an extract step and it returned:
  tree := await readTree(page)                // one snapshot, 9–350 ms
  g := groundValues(claim.data, tree); if options.screenshot then g.visual = true
  verdict = g.verdict; evidence.grounding = g
else (observe, extract that threw):
  verdict = "inconclusive"; evidence.grounding = { reason: "non-grounding", … }
```

- The `extract` wrapper passes `{ ground: true }` and the extract options into `run()`; `observe` passes nothing. No prefix-sniffing of the action string.
- **Redaction.** `values` can carry whatever the model returned. Rule, same seam as Day 3: if the tree contains a masked password line (`••••`), any `absent` leaf whose length equals a masked run is stored as `<redacted:N>`. Cheap, and it is the only case where a returned value can be a password we would otherwise write to disk. Grounded leaves are by definition already visible on the page.
- **DRY: `readTree(page)`.** `captureState` (`postcondition.ts:100-105`) and `checkDeclarations`'s cached `tree()` (`declaration.ts:120-128`) both do `normalizeTree((await page.snapshot()).formattedTree)` in a try/catch. Extract it once as `readTree(page): Promise<string[] | null>` in `postcondition.ts`; all three call it. Grounding on `null` (snapshot threw mid-navigation) → `inconclusive` / `non-grounding`, per AGENTS invariant 3.
- `Step.evidence` gains `grounding?: Grounding`. Additive. `Wrapped.extract` keeps Stagehand's exact signature — the overloads are passed through as today.

## 4. Day 4 revision the probe forces (do with the build)

**R10 — `text` declarations with a `role` must match over the role's subtree as one string, not line by line.** `checkOne` (`declaration.ts:83-93`) tests `matches(d.matches, lines[j])` for each of up to six lines under the role. Per §1, `Order #<strong>4242</strong>` inside a `status` element is two lines, so `{ kind: "text", role: "status", matches: /Order #\d+/ }` — the README's own example — is unmet on markup that any real confirmation banner uses. Fix: join the up-to-six role-prefix-stripped lines with a space and match once. Same blob rule as grounding; ~4 lines. Test row in §7.

Not changed: the role-less `text` path reads `innerText` (already one string) and is unaffected.

## 5. Inconclusive plumbing — the audit (the second deliverable)

Confirming, not building. `inconclusive` must be a first-class, separately counted verdict on every check.

| Check | Emits `inconclusive`? | Where | Status |
|---|---|---|---|
| Session (Day 2) | yes | `sessionVerdict` demotes `landed` → `inconclusive` on a heuristic-confidence obstruction (`postcondition.ts:262`) | correct |
| Postcondition (Day 3/4) | yes | `no-change`, `changed-unclassified`, `hash-only-nav`, `prompt`, `unsettled`, `error-text`, `non-mutating`, `declared-unreadable` | correct |
| Grounding (Day 5) | yes | `ungrounded`, `nothing-to-ground`, `non-grounding` | this build |
| Roll-up | yes | `rollup` returns `inconclusive` when any write is inconclusive and when there are no writes (`index.ts:87`) | correct |

The one plumbing change beyond grounding: a read step that did not ground (observe, threw, snapshot null) is tagged `non-grounding`, so Day 6 can tell "did not ground" from "grounded and could not confirm." That is the whole of it.

## 6. Cost, latency, performance

One `readTree` per extract: 10 ms on a form, ~350 ms on a 2000-row page (FINDINGS §3). The walk and matching are microseconds; the blob is built once per step. No LLM (SPEC's cost-over-latency rule; judges cap at 0.65 AUROC — DAY4 §5). Reads previously recorded no page state, so this adds one snapshot to the read path and nothing to the write path.

## 7. Tests

**Helpers.** `fakeStagehand` today forwards `extract`/`observe` to the real model-less instance, which throws. Extend `FakeSpec` with `extract?: unknown` (the `data` to return) so the read branch is testable with a real browser and no LLM — same "only the LLM is fake" rule the write tests use. Add `groundValues` fixtures alongside `state()`/`form()` only if a builder is needed; a `tree` is just `string[]`.

**Pure `groundValues` (`test/grounding.test.ts`, no browser):**
- given `{ total: "$1,249.00", id: 4242 }` and lines `["StaticText: Total:", "strong", "StaticText: $1,249.00", "heading: Order #4242"]`, then `landed` / `grounded` / `high` (the inline-split case is the happy path on purpose).
- given the value `"Total: $1,249.00"` spanning two lines, then `exact` — the blob rule.
- given `49` against `$1,249.00`, then `absent` (token boundary); given `1249` and `1249.00`, then grounded.
- given `3` against `cell: 3` and `2026-09-16` elsewhere, then grounded once and not by the date.
- given a value differing only in case/whitespace, then `grounded` / `heuristic` (`normalized`).
- given a value absent from the tree, then `inconclusive` / `ungrounded`, the value in `values` with `match: "absent"`, and never `did-not-land`.
- given only booleans, 2-char strings, and a 300-char summary, then `nothing-to-ground` with `skipped === 3`.
- given `{ extraction: "<200-char paragraph>" }` (the no-schema shape), then `nothing-to-ground`, not `ungrounded`.
- given nested `{ items: [{ name }, { name }] }`, then both leaves judged; given 60 leaves, then 50 judged and `skipped === 10`.
- given a tree with a masked password line and an absent 8-char leaf, then the stored value is `<redacted:8>`.

**Integration (`test/replay.test.ts`, on `serve()`, real Chrome, fake `extract`):**
- given an extract whose returned values are all on the page, then the read step is `landed` / `grounded` and `evidence.grounding.values` lists them.
- given an extract returning one value the tree lacks, then `inconclusive` / `ungrounded`; and a run with one landed write and that read still rolls up `landed` (reads never move the headline).
- given an `observe` step, then `grounding.reason === "non-grounding"`.
- given `extract(…, { page: otherTab })`, then the tree is read from that tab (the value exists only there).
- given `extract(…, { screenshot: true })`, then `grounding.visual === true`.
- **R10:** given `{ kind: "text", role: "status", matches: /Order #\d+/ }` against `<p role=status>Order #<strong>4242</strong></p>`, then met.

## 8. AGENTS.md updates (do with the build)

- Invariant 1 gains: *"Read verdicts are the exception by design: grounding compares an `extract`'s returned `data` to the page, and that data is the object under test. No write verdict may consume an extraction, and no read verdict may consume `ActResult.data.success/message`."*
- The Stagehand-facts line "Fixtures load via `page.goto("data:text/html," …)`" contradicts the Day 3 rule three lines above it (HTTP fixtures only) — delete it.
- Add the §1 tree facts (inline split; `title`/hidden absent; shadow/iframe/below-fold present) and `npm run probe:tree`, `npm run probe:omlx` to the commands list.
- "Next:" → Day 6.

## 9. Not in Day 5

Declared grounding / `expect` on `extract` (advisory check; Stagehand's extract options are a strict object anyway, and Day 6 decides whether the auto match is too loose) · matching against attributes or the raw DOM (`title` is the only common attribute the tree drops; widening the target is a Day-6-measured decision) · fuzzy or semantic matching (a judge) · a run-level grounding roll-up (per-step + Day 6 counting) · grounding `observe` · special-casing zod transforms · a `cache.status === "HIT"` cross-check (a stale-cache extraction shows up as `ungrounded` already; naming it is a Day 6 column, not code).

## 10. Review

One-author critique pass against the code and a live probe, not a fresh seven-agent fan-out — every hard call here is an application of a conclusion the Day 4 review already litigated (R2, DAY4 §0.3, the two-channel rule, invariants 2–4), and the new facts came from the probe rather than from opinion. What the pass changed from the first draft: line-level matching (wrong — §1), the below-the-fold "lossy" reason (wrong — §1), numeric substring matching (a false-`landed` generator — §2), no treatment of the no-schema summary shape (a false-alarm generator — §0.4), no `page`/`screenshot` option handling (§1), a duplicated tree read (§3), and a latent Day 4 bug in role-scoped `text` declarations that the same probe exposed (§4).

VERDICT: **APPROVED FOR BUILD** — one file, one branch change, one evidence field, one DRY extraction, one Day 4 fix.

**Built 2026-09-16** ([src/grounding.ts](../src/grounding.ts), the read branch of [src/index.ts](../src/index.ts), `readTree`/`treeText` in [src/postcondition.ts](../src/postcondition.ts), R10 in [src/declaration.ts](../src/declaration.ts)); 111 tests green in ~14 s. Two adjustments the build made to this spec: (1) `leaves` yields non-groundable primitives (boolean/null) too, so `skipped` counts them rather than dropping them silently; (2) grounding values are scrubbed by the existing `redactStep` second-net on storage — an extracted email grounds correctly (match computed before storage) but is written as `[REDACTED:email]`, so §3's masked-password rule is now the *narrow* case it handles, not the only redaction. The `options.page` cross-tab path is implemented but tested only via `screenshot: true` (the visual flag) — a genuine second-tab assertion is deferred to the Day-6 multi-tab harness, consistent with the existing `activePage()` multi-tab stance.
