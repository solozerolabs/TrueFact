# Day 3 — Postcondition: the auto-inferred default

Spec only (2026-09-16). Nothing for Day 3 is built; this replaces the one-line Day 3 bullet in SPEC.md and is written against the Day 1/2 code that exists in `src/`.

The question Day 3 answers, per write step, with **zero declaration**: *did the write land?* Day 2 can only say "the page was obstructed" or "I don't know". Day 3 is what lets a clean write say **`landed`** — until it ships, every successful write in a replay is `inconclusive` and the wrapper is only useful for catching obstructions.

## 0. Ground truth this spec is written against

Probed on 2026-09-16 against `@browserbasehq/stagehand@4.1.0` with a local Chrome and no model. Everything below cites one of these.

| Fact | Evidence |
|---|---|
| `page.snapshot()` returns `{ formattedTree, xpathMap, urlMap }`. The tree is role-annotated and **includes input values** as `StaticText` children, `option: Pro [selected]`, `checkbox [checked]`, and roles `alert`, `status`, `dialog`, `link`, `button`, `textbox`. Password values are already masked (`••••••`). | probe4 tree dump |
| `snapshot()` costs **9 ms** on a small form page, **346 ms** on a 2000-row page (177 KB, 6003 lines). An `evaluate` reading `innerText.length` is 6 ms. | probe4/probe5 timings |
| An element toggled from `display:none` to visible **enters** the tree; a value typed into a field **appears** in the tree. | probe5 |
| `act` reports `data.actions[]` as `{ selector, description, method?, arguments? }` with `selector` formatted **`xpath=/html[1]/body[1]/…`**. `page.locator()` accepts that verbatim (`parseSelector` strips `^xpath=`), bare xpath, and CSS. `Locator.inputValue()` works. | `ActionSchema`; extension `parseSelector`; probe4 `inputValue` |
| `method` is a free string; the handlers that exist are `click doubleClick fill type press selectOption selectOptionFromDropdown dragAndDrop hover scroll scrollTo scrollIntoView scrollByPixelOffset nextChunk prevChunk mouse.wheel`. | extension `METHOD_HANDLER_MAP` |
| A click that opens a new tab makes `context.activePage()` return the **new** page (`pages()` 1→2, `active !== page`). | probe5 |
| The before/after `Fingerprint` from Day 2 (`href, readyState, bodyTextLength, elementCount, title`) is **length-based**: swapping one digit for another does not change it. Day 2's own settle test had to be rewritten around this. | Day 2 test history |
| `textContent` (which `bodyTextLength` uses) **excludes** input values, so a `fill` that lands is invisible to the fingerprint. | DOM semantics |

## 1. What the one-line plan gets wrong

The SPEC bullet says: *"snapshot before/after each act, diff URL/DOM, detect confirmation-shaped elements and form clearing. Fails when nothing changed."* Four problems, all with evidence:

1. **"Nothing changed" measured with the Day 2 fingerprint would manufacture `did-not-land`.** A landed `fill` changes no `textContent`; a status message replacing another of the same length changes no length. Both read as "nothing changed" → `did-not-land` → straight into the benchmark's headline bucket. The before/after state must be *content*-sensitive: the a11y tree plus a direct form-values read.
2. **"Did anything change?" is necessary, not sufficient.** A click that opens a dropdown, expands an accordion, or shows **"Email is required"** changes the DOM and did not land. The most common silent write failure on real forms is a validation error the agent never reads. Change must be *classified*, not counted.
3. **Every `act` is treated as a write.** `act("scroll down")` or `act("hover the menu")` are `kind: "write"` today. "Nothing changed" after a scroll would be a false `did-not-land`, and a scroll's `inconclusive` would poison the write roll-up. The attempted methods say which acts mutate.
4. **The attempt is thrown away.** `actions[]` says *what field was filled with what*, *what was selected*, *what was clicked*. For `fill`/`type`/`selectOption`, the postcondition is not "did anything change" — it is "does that field now hold that value", readable directly from the page with no declaration. Day 2 already established the rule: the attempt is where to look, never evidence of outcome.

Also missing: a click that opens a new tab (the page we hold goes stale, the active page changes), and the privacy problem that `attempt.arguments` and any form-values snapshot will contain **typed passwords** unless redacted.

## 2. State capture: `captureState(page)`

Replaces the Day 2 `fingerprint()` as the before/after unit. Settle keeps polling the cheap fingerprint (that is what it is for); the full state is captured once before the action and once after settle.

```ts
interface PageState {
  fp: Fingerprint;                 // Day 2, unchanged — cheap, drives settle
  tree: string[];                  // snapshot().formattedTree lines, normalized (§2.1)
  forms: Record<string, FormValue>;// name-or-id → value / checked / selected (§2.2)
  pageId: string;                  // to detect a tab switch (§5)
}
```

**2.1 Tree normalization.** Strip the `[n-m]` node-id prefix and leading indentation from every line before storing. Node ids change between snapshots; without stripping, every diff is "everything changed". Diff is a multiset difference: `added = after − before`, `removed = before − after`. Store at most 40 lines of each on the step (`evidence.postcondition.treeAdded/treeRemoved`) — that *is* the replay: a human reads "these lines appeared".

**2.2 Form values.** One `evaluate`: for every `input, textarea, select` with a `name` or `id`, record `{ value, checked?, selected? }`. `type=password` values are recorded as `"<redacted:N>"` (length only) — see §7. Two reasons the tree alone is not enough: the tree masks passwords with no length, and the tree does not distinguish "field cleared" from "field removed".

Cost per write step: one `snapshot()` before, one after (≈ 10–350 ms each), two small `evaluate`s. Under the "cost > latency" rule and behind a 3–10 s `act`, acceptable. Read and nav steps capture `fp` only (nav also records `Response.status()`, as Day 2 does).

## 3. Attempt-aware postconditions (no declaration needed)

Read `attempt` (= `ActResult.data.actions[]`). Group methods:

| Methods | Class | Auto postcondition |
|---|---|---|
| `fill`, `type` | **field write** | `locator(selector).inputValue()` **includes** `arguments[0]` (`type` may append; `fill` replaces — `includes` covers both; ceiling: a mask/format field that reformats input, e.g. phone numbers, falls through to §4) |
| `selectOption`, `selectOptionFromDropdown` | **field write** | the selected option's text or value equals `arguments[0]` (one `evaluate` on the selector) |
| `click`, `doubleClick`, `press`, `dragAndDrop` | **mutating action** | change classification, §4 |
| `hover`, `scroll*`, `nextChunk`, `prevChunk`, `mouse.wheel`, `scrollIntoView`, `scrollTo`, `scrollByPixelOffset` | **non-mutating** | §6 — not a write |
| no `actions` (act threw, or `success:false` with none) | unknown | change classification, §4 |

Field-write verdicts are **high confidence**: they are a direct read of the field the agent says it targeted. If the selector does not resolve (stale xpath after a re-render), fall through to §4 rather than guessing.

Channel rule, restated: `attempt` picks the selector and the expected value; the *verdict* comes from `inputValue()`/`evaluate`, which are page reads. No verdict function receives `agent_claim`.

## 4. Change classification (for mutating actions)

Inputs: `before`, `after` (§2), `urlChanged = before.fp.href !== after.fp.href`, `pageSwitched` (§5), `treeAdded`, `treeRemoved`, `formsBefore/After`. Evaluate top to bottom; first match wins. Each row names its **confidence** (mechanism-backed = high; regex = heuristic) and the verdict it may produce. The asymmetry is deliberate: a false `landed` under-reports failure (safe for the headline number); a false `did-not-land` inflates it, so only mechanism-backed rows may say `did-not-land`.

| # | Signal | Confidence | Verdict | `reason` |
|---|---|---|---|---|
| 1 | `pageSwitched` (a new tab became active) | high | `landed` | `new-page` |
| 2 | `urlChanged` (any `href` change, hash included) | high | `landed` | `navigated` |
| 3 | error-shaped **added** lines: a line with role `alert` **and** error text (`/required\|invalid\|error\|failed\|incorrect\|try again\|must be\|not (valid\|allowed)/i`), or an `aria-invalid` field appearing in `forms` diff | high (role + text, or ARIA state) | `did-not-land` | `validation-error` |
| 4 | error text in added lines **without** an `alert`/`status` role | heuristic | `inconclusive` | `error-text` |
| 5 | confirmation-shaped added lines: role `status`/`alert`/`dialog` **or** any added line matching `/thank\|success\|confirm\|placed\|saved\|sent\|submitted\|complete\|done\|received\|updated\|created/i` | heuristic (safe direction) | `landed` | `confirmation` |
| 6 | form cleared: ≥ 1 field non-empty before and every one of those fields empty after, with the form still present | high | `landed` | `form-cleared` |
| 7 | some `treeAdded`/`treeRemoved` or `forms` change, none of the above | — | `inconclusive` | `changed-unclassified` (dropdown opened, accordion expanded, spinner…) |
| 8 | **no change at all**: tree, forms, and URL identical after a stable settle | high (identity is exact) | `did-not-land` | `no-change` |

Row 8 is the SPEC's stated default ("fails when nothing changed") and the cookie-overlay case. Its known ceiling: a write that succeeds with **no UI feedback** (silent autosave, a POST with no visible acknowledgment) reads as `did-not-land`. This is the auto-inference gap the SPEC's open questions already anticipate; the `reason` field exists so the Day 6 benchmark can slice `no-change` verdicts and Day 4 overrides can fix them per site. It is not hidden.

Order matters in two places: row 3 before row 5, because an `alert` saying "Email is required" must not read as confirmation; rows 1–2 first, because navigation is the strongest landed signal and the after-tree of a new page is all "added".

## 5. Tab switch

Resolve `activePage()` **again** after the action. If it differs from the page resolved before the action: `pageSwitched = true`, `after` is captured from the **new** page, `evidence.postcondition.newPageUrl` is recorded, and the step verdict is `landed` (§4 row 1). Subsequent steps already resolve `activePage()` fresh, so they follow the agent to the new tab. Without this, a `target=_blank` click reads as "nothing changed on the old page" → a false `did-not-land`.

## 6. Non-mutating acts

If **every** attempted method is in the non-mutating group (§3), the step is reclassified `kind: "read"` with `verdict: "inconclusive"` and `reason: "non-mutating"`, and it is excluded from the write roll-up. This uses `attempt` to *classify*, not to judge outcome — the one place the attempt affects measurement, stated openly. The alternative (keep `kind: "write"`, `verdict: inconclusive`) makes every "scroll down" act turn a run `inconclusive`, which is worse for the number and for the user. If `act` threw before producing actions, the step stays a write.

## 7. Privacy: redaction

Two fields will contain typed passwords unless handled: `attempt[].arguments` (the agent typed them) and `forms` (§2.2). Rule: if a step's attempt selector resolves to `input[type=password]`, replace `arguments[0]` with `"<redacted:N>"`; `forms` always records password fields as `"<redacted:N>"`. Screenshots already mask (browser renders dots); the a11y tree already masks. The step's `field.expected/actual` (§3) follow the same rule. This is a trust-boundary requirement, not a nicety — a replay is meant to be shared.

## 8. Output (additions to the Day 2 `Step`)

```ts
evidence.postcondition = {
  reason: "field-match" | "field-mismatch" | "new-page" | "navigated" | "validation-error"
        | "error-text" | "confirmation" | "form-cleared" | "changed-unclassified"
        | "no-change" | "non-mutating" | "unsettled";
  confidence: "high" | "heuristic";
  urlChanged: boolean;
  pageSwitched: boolean;
  newPageUrl?: string;
  treeAdded: string[];        // ≤ 40 normalized lines
  treeRemoved: string[];      // ≤ 40
  formsBefore: Record<string, FormValue>;
  formsAfter: Record<string, FormValue>;
  field?: { selector: string; expected: string; actual: string | null };
};
```

Verdict precedence for a write step, in order: Day 2 high-confidence obstruction → `did-not-land` · `settled === false` → `inconclusive` (`unsettled`) · §6 non-mutating → reclassified · §3 field write → its verdict · §4 classification. A Day 2 *heuristic* obstruction (overlay, login) is recorded and does not stop §3/§4 — the postcondition is exactly the corroboration Day 2 said it would wait for: `overlay` + `no-change` is the cookie-overlay signature, and both reasons are on the step.

`Replay.verdict` roll-up is unchanged (writes only). With Day 3 a run of clean writes finally rolls up to `landed`.

## 9. Tests

Hermetic, `node:test`, one local Chrome + `Stagehand.create({ browser })` with **no model**, fixtures via `data:` URLs — same harness as Day 2.

**Unit (pure, no browser):** `classifyChange(before, after, flags)` over hand-built `PageState`s — one `it` per row of §4, plus ordering cases (alert-error beats confirmation; navigation beats everything).

**Integration without an LLM:** `withReplay()` takes a duck-typed `Stagehand` whose `act` performs a **real** `page.locator(selector).click()` / `.fill()` and returns an `ActResult`-shaped `{ data: { success: true, actions: [{ selector: "xpath=…", method, arguments }] } }`. That exercises the real `run()` path — before capture, action, settle, session, postcondition — end to end. The fake is only the LLM; the browser, the click, and every page read are real.

| Fixture / action | Expected |
|---|---|
| submit button under a fixed cookie overlay, click | `did-not-land`, `no-change`; session `overlay` (heuristic) also on the step |
| submit that reveals `role=status` "Order placed" | `landed`, `confirmation` |
| click a same-page link (`href="#done"` or a second `data:` URL) | `landed`, `navigated` |
| click `target=_blank` link | `landed`, `new-page`, `newPageUrl` set; next step reads the new tab |
| submit that reveals `role=alert` "Email is required" | `did-not-land`, `validation-error` |
| submit that reveals plain text "error" with no role | `inconclusive`, `error-text` |
| submit that resets the form (`form.reset()`) | `landed`, `form-cleared` |
| `fill` email field, attempt `arguments:["a@b.co"]`, field holds it | `landed`, `field-match` |
| `fill` where the page's handler rewrites the field to `""` | `did-not-land`, `field-mismatch` |
| `selectOption "Pro"`, option selected | `landed`, `field-match` |
| click that opens a `<details>`/menu only | `inconclusive`, `changed-unclassified` |
| `scroll` attempt on a long page | reclassified `kind: "read"`, `non-mutating`, excluded from roll-up |
| page that appends forever (Day 2 fixture) | `inconclusive`, `unsettled` |
| `fill` on `type=password`; attempt arguments and `forms` | both show `<redacted:N>`, never the value |
| stale selector (element removed by the action) on a `fill` | falls through to §4, no throw |
| run of two landed writes + one inconclusive read | `replay.verdict === "landed"` |

**Manual thesis check (needs a key):** `scripts/probe-overlay-act.mjs` already exists. After Day 3 it should print the wrapper's verdict beside `ActResult.data` — the first real reported-success / did-not-land, or the first kill-signal data point.

## 10. Decisions register — with pushback

| # | Decision | Status | Why |
|---|---|---|---|
| D1 | "Did anything change?" via the Day 2 fingerprint | **rejected** | length-based; blind to `fill` and same-length swaps; would fabricate `did-not-land` (§1.1) |
| D2 | a11y tree + form-values as the change unit | adopted | semantic, includes values, masks passwords, hidden→shown enters it, 9–350 ms measured |
| D3 | change is *classified*, with `did-not-land` allowed only from mechanism-backed rows | adopted | validation errors are the common silent failure; regex-only signals may only say `landed` or `inconclusive` |
| D4 | attempt-aware field postconditions for `fill`/`type`/`select` | adopted | direct page read of the targeted field; the attempt is where-to-look, unchanged rule from Day 2 |
| D5 | `no-change` ⇒ `did-not-land` | **kept, with the ceiling named** | it is the SPEC's stated default and the cookie-overlay case; silent-autosave writes will be miscounted until Day 4 overrides — sliceable via `reason` |
| D6 | non-mutating acts reclassified to `kind: "read"` | adopted | otherwise "scroll down" poisons the run verdict; this is the single place attempt affects classification |
| D7 | tab-switch handling | adopted | verified `activePage()` switches; otherwise `target=_blank` writes read as `no-change` |
| D8 | password redaction in `attempt.arguments` and `forms` | adopted | replays are meant to be shared; trust-boundary rule from AGENTS.md |
| D9 | screenshot "judge" | still out | capture per write step stays (Day 2); interpretation of pixels is not a Day 3 signal |

What I would push back on in the SPEC itself: *"detect confirmation-shaped elements"* as a **failure** criterion. Absence of a confirmation is weak evidence (many apps confirm nothing); presence is decent evidence. So confirmation only ever moves a verdict toward `landed` (row 5), never toward `did-not-land`.

## 11. Not in Day 3

Declared overrides (Day 4 — `URL changed / element present / text matches / field equals`, layered on top of this default and able to override `no-change`) · grounding of `extract` values against `snapshot().formattedTree` (Day 5 — the tree capture built here is what Day 5 will read) · screenshot judging · per-site tuning of the confirmation/error regexes (collect `changed-unclassified` and `no-change` rates in Day 6 first) · pixel/visual diffs.

## GSTACK REVIEW REPORT

Runs: 1 — spec-level critique of the SPEC Day 3 bullet against the Day 1/2 code and Stagehand 4.1.0 probes (2026-09-16). Outside voice: not run.

| Section | Status | Findings |
|---|---|---|
| Measurement | 1 rejection | fingerprint-based "no change" would fabricate the headline failure; replaced by tree + forms |
| Classification | adopted | 8 ordered rows; `did-not-land` only from mechanism-backed signals |
| Attempt use | adopted | field-write postconditions; non-mutating reclassification; stated as the one classification use |
| Edge cases | 2 added | tab switch; password redaction |
| Tests | specified | 16 integration rows on a real browser with a fake LLM, plus pure unit rows per classification |

VERDICT: **APPROVED FOR BUILD** — implement per this document; no code written yet.

NO UNRESOLVED DECISIONS
