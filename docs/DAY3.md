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
| **Native constraint validation is invisible to the tree.** A real click on submit with an empty `required` field: tree diff `[]`, no `alert`, the browser bubble is not in the a11y tree. `:invalid` matches before *and* after (useless). **`:user-invalid`** goes 0 → 1 after the click, and `document.activeElement` moves to the invalid field. | probe (a) |
| **A new tab over HTTP** is the active page with its URL and title within 100 ms; `pages()` lists both; `detectSession` on it is clear. The same over a `data:` URL reports `url() === ""` for 2 s+ even after `waitForLoadState("load")`, and reads as `blank`. | probe (b), (b′) |
| **Chrome blocks script-initiated top-frame navigation to `data:` URLs.** `location.href = "data:…"` from a `data:` page silently does nothing. Navigation, redirect, and new-tab behaviour can only be tested from an `http://` origin. | probe (c) vs (c′) |
| **A write that redirects into a login wall 1.2 s after the click** settles clean at 1.5 s (`href` unchanged), then the URL changes to `/login` (served 401). `detectSession` on the destination finds `login-wall` (heuristic, password field). A click-triggered navigation carries **no** `Response`, so the 401 is not observable — only the destination page is. | probe (c′) |
| A `<dialog>` prompt adds the lines `dialog`, `StaticText: Confirm delete?`, `button: Confirm`, `button: Cancel` — a prompt is distinguishable from a confirmation by the presence of `button:` lines in the same added block. | probe (d) |

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

**2.2 Form values and validity.** One `evaluate`: for every `input, textarea, select` with a `name` or `id`, record `{ value, checked?, selected?, userInvalid }` where `userInvalid = el.matches(":user-invalid")`, plus two page-level fields: `userInvalidCount = document.querySelectorAll(":user-invalid").length` and `activeField` (the `name`/`id` of `document.activeElement` if it is a form control). `type=password` values are recorded as `"<redacted:N>"` (length only) — see §7. Three reasons the tree alone is not enough: the tree masks passwords with no length; the tree does not distinguish "field cleared" from "field removed"; and **a submit blocked by native `required`/`pattern` validation changes nothing in the tree at all** (probe (a)) — the only page-truth signals are `:user-invalid` and focus jumping to the offending field.

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

Field-write verdicts are **high confidence**: they are a direct read of the field the agent says it targeted. Two rules keep them honest: if the read fails for **any** reason — selector does not resolve (stale xpath after a re-render), the target is a `contenteditable` or other non-input where `inputValue()` throws — fall through to §4 rather than guessing; and if `arguments[0]` is the empty string (the agent cleared a field), compare with `actual === ""`, because `includes("")` is always true and would make every clear a trivial `field-match`.

Channel rule, restated: `attempt` picks the selector and the expected value; the *verdict* comes from `inputValue()`/`evaluate`, which are page reads. No verdict function receives `agent_claim`.

## 4. Change classification (for mutating actions)

Inputs: `before`, `after` (§2), `urlChanged`, `hashOnlyChange` (only the `#…` fragment differs), `pageSwitched` (§5), `treeAdded`, `treeRemoved`, `formsBefore/After`. Evaluate top to bottom; first match wins. Each row names its **confidence** (mechanism-backed = high; regex/weak = heuristic) and the verdict it may produce.

Two asymmetries, not one. A false `did-not-land` inflates the headline bucket, so only mechanism-backed rows may say `did-not-land`. But a false `landed` is TrueReplay **missing a silent failure — the one thing it exists to catch**, so a `landed` verdict is only `high` confidence when the signal is mechanism-backed (real navigation, new tab, form cleared); weak `landed` signals (regex confirmation, a bare `#` anchor) are `heuristic`, and a hash-only URL change with nothing else is `inconclusive`, not a false clear.

| # | Signal | Confidence | Verdict | `reason` |
|---|---|---|---|---|
| 1 | `pageSwitched` (a new tab became active) — subject to the destination gate (§4.2) | high | `landed` | `new-page` |
| 2 | `urlChanged` in **path / origin / search** (a real navigation, not a `#` fragment) — subject to §4.2 | high | `landed` | `navigated` |
| 3 | **native constraint validation blocked the submit**: `userInvalidCount` rose, or `activeField` moved to a field with `userInvalid` — with no other change (probe (a): the tree diff is empty in this case) | high (`:user-invalid` is a UA state, set only after a submit attempt) | `did-not-land` | `validation-error` |
| 4 | error-shaped **added** lines: a line with role `alert` **and** error text (`/required\|invalid\|error\|failed\|incorrect\|try again\|must be\|not (valid\|allowed)/i`), or a field whose `userInvalid` flipped to true in the `forms` diff | high (role + text, or UA state) | `did-not-land` | `validation-error` |
| 5 | error text in added lines **without** an `alert`/`status` role | heuristic | `inconclusive` | `error-text` |
| 6 | **a prompt appeared**: added lines contain a `dialog` (or `[aria-modal]`) **and** one or more `button:` lines in the same block (probe (d): `dialog / StaticText: Confirm delete? / button: Confirm / button: Cancel`) | high (structure) | `inconclusive` | `prompt` — the write is not done until the prompt is answered |
| 7 | confirmation-shaped added lines: role `status`/`alert`/`dialog` **or** any added line matching `/thank\|success\|confirm\|placed\|saved\|sent\|submitted\|complete\|done\|received\|updated\|created/i` — subject to §4.2 | heuristic | `landed` | `confirmation` |
| 8 | form cleared: ≥ 1 field non-empty before and every one of those fields empty after, with the form still present — subject to §4.2 | heuristic (some apps reset on failure) | `landed` | `form-cleared` |
| 9 | `hashOnlyChange` and no tree/forms change | heuristic | `inconclusive` | `hash-only-nav` |
| 10 | some `treeAdded`/`treeRemoved` or `forms` change, none of the above | — | `inconclusive` | `changed-unclassified` (dropdown opened, accordion expanded, spinner…) |
| 11 | **no change at all**: tree, forms, URL, and validity identical, after the extended wait (§4.1) | high (identity is exact) | `did-not-land` | `no-change` |

Row 3 is the most common way a real form refuses a submit, and before this revision it would have read as `no-change` (correct verdict, wrong reason, and only after the full extended wait); with `:user-invalid` it resolves instantly and says why. Row 6 exists because "Confirm your order" with Confirm/Cancel buttons is a question, not an acknowledgment — the regex in row 7 would otherwise read it as success. Row 9 exists because a broken `<a href="#">` button "navigates" the fragment while landing nothing. Row 11 is the SPEC's stated default ("fails when nothing changed") and the cookie-overlay case. Its known ceiling: a write that succeeds with **no UI feedback** (silent autosave, a POST with no visible acknowledgment) reads as `did-not-land`; the `reason` field lets Day 6 slice `no-change` and Day 4 overrides fix it per site. It is not hidden.

Order matters: rows 3–4 before row 7 (an `alert` "Email is required" must not read as confirmation); row 6 before row 7 (a prompt containing the word "confirm" is not a confirmation); rows 1–2 first (navigation is the strongest landed signal and a new page's after-tree is all "added"); row 9 before row 11 so a hash change is not mistaken for "no change at all".

### 4.2 Destination gate — no `landed` into an obstruction

Probe (c′): a Save whose handler redirects to `/login` 1.2 s after the click settles clean, then the extended poll sees the URL change, and row 2 would say `navigated → landed`. That is a write that **bounced to a login wall**, cleared as success — the exact silent failure the product exists to catch. So every `landed` row (1, 2, 7, 8) is gated: run Day 2's `detectSession` on the **final** page (the new tab, or the page after the poll). If it reports an obstruction, the Day 2 mapping wins — high-confidence (`captcha`, `blank`, corroborated `login-wall`) → `did-not-land`; heuristic (`login-wall`, `overlay`) → `inconclusive` with both reasons on the step (`navigated` + `login-wall`). A click-triggered navigation carries no `Response`, so the 401 that would corroborate is not observable; the destination page is, and that is enough to refuse a false `landed`.

### 4.1 Extended wait before `no-change` (write steps only)

The Day-2 `settle` budget (1.5 s) is tuned to catch DOM quiescence, not a server round-trip. A real submit shows its confirmation at 2–5 s, during which the DOM is quiet (a CSS spinner mutates nothing), so a bare settle would report `no-change` and row 9 would fire on a **successful** write — a false `did-not-land` straight into the headline bucket.

So: after settle, classify once. If the result is `no-change`, keep polling up to an extended budget (`postconditionWaitMs`, default **8000 ms**) and return the first non-`no-change` classification, or `no-change` only if the page is still identical at the end. Poll cheaply: the Day-2 `fingerprint` every 250 ms, and **re-capture the full `PageState` (§2) only when the fingerprint differs from the last capture** — or once at the end of the budget. A `snapshot()` is 10–350 ms; ten blind re-captures on a big page would be 3.5 s of CPU to learn nothing. This runs **only** on write steps that first look like `no-change` — a write that already navigated, cleared, errored, or tripped `:user-invalid` (row 3) returns immediately, so the full wait is paid only by outcomes that are genuinely silent. Cost: a dead write (cookie overlay) waits the full budget before `did-not-land`; under the SPEC's "cost > latency, UX above all" that is the right trade, and the overlay case still resolves correctly (it will never change).

## 5. Tab switch

Resolve `activePage()` **again** after the action (today `run()` resolves it once, before the action — `src/index.ts:138` — and reads the stale page for everything after). If it differs from the page resolved before the action: `pageSwitched = true`, run `settle` on the **new** page, capture `after` from it, record `evidence.postcondition.newPageUrl`, and the step verdict is `landed` (§4 row 1) unless the destination gate (§4.2) says the new tab is an obstruction. Subsequent steps already resolve `activePage()` fresh, so they follow the agent to the new tab. Without this, a `target=_blank` click reads as "nothing changed on the old page" → a false `did-not-land`.

Detect the switch by **page identity** (`after !== before` object, or `pages().length` grew), never by URL: over HTTP a new tab reports its URL within 100 ms, but a new tab opened to a `data:` URL reports `url() === ""` indefinitely (probe (b)) and would read as `blank`. That quirk is confined to `data:` tabs, which only exist in tests — and is one reason the tests use an HTTP fixture server (§9).

## 6. Non-mutating acts

If **every** attempted method is in the non-mutating group (§3), the step is reclassified `kind: "read"` with `verdict: "inconclusive"` and `reason: "non-mutating"`, and it is excluded from the write roll-up. This uses `attempt` to *classify*, not to judge outcome — the one place the attempt affects measurement, stated openly. The alternative (keep `kind: "write"`, `verdict: inconclusive`) makes every "scroll down" act turn a run `inconclusive`, which is worse for the number and for the user. If `act` threw before producing actions, the step stays a write.

## 7. Privacy: redaction

Two fields will contain typed passwords unless handled: `attempt[].arguments` (the agent typed them) and `forms` (§2.2). Rule: if a step's attempt selector resolves to `input[type=password]`, replace `arguments[0]` with `"<redacted:N>"`; `forms` always records password fields as `"<redacted:N>"`. Screenshots already mask (browser renders dots); the a11y tree already masks. The step's `field.expected/actual` (§3) follow the same rule.

**Compute before you redact.** The §3 field verdict is `inputValue().includes(arguments[0])`. Redacting first would compare `"<redacted:8>".includes("<redacted:8>")` → always true → every password fill reads `landed` even when it did not land. So the order is fixed: run the field-match on the **real** values, decide the verdict, **then** redact `expected`/`actual`/`arguments`/`forms` for storage. This is a trust-boundary requirement, not a nicety — a replay is meant to be shared.

### Module boundary

The new code lives in **`src/postcondition.ts`** (parallel to `src/session.ts`): `captureState(page)`, `classifyChange(before, after, flags)` (pure, no browser — the §4 rows), `fieldPostcondition(page, attempt)`, `redact(step)`. The wrapper's `run()` in `src/index.ts` calls them and stays thin. `classifyChange` being a pure function of two `PageState`s is what makes every §4 row unit-testable without a browser (§9).

## 8. Output (additions to the Day 2 `Step`)

```ts
evidence.postcondition = {
  reason: "field-match" | "field-mismatch" | "new-page" | "navigated" | "validation-error"
        | "error-text" | "prompt" | "confirmation" | "form-cleared" | "hash-only-nav"
        | "changed-unclassified" | "no-change" | "non-mutating" | "unsettled";
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

Verdict precedence for a write step, in order:

1. §6 non-mutating attempt → reclassified to `read`, stop.
2. §3 field write → its verdict (a direct field read is conclusive whether or not the rest of the page settled).
3. §4 classification on the current `after`. **`settled === false` blocks only row 11 (`no-change`) and the §4.1 wait** — a ticking clock or carousel must not turn a write that plainly navigated, cleared its form, or tripped `:user-invalid` into `unsettled`. If nothing conclusive fires and the page is unsettled → `inconclusive` (`unsettled`).
4. §4.1 extended wait if the first look is `no-change`.
5. §4.2 destination gate: Day 2 `detectSession` runs on the **final** page (after the wait, on the new tab if switched) — not once after the first settle as `run()` does today (`src/index.ts:150`). High-confidence obstruction → `did-not-land`; heuristic obstruction demotes any `landed` to `inconclusive` and is otherwise recorded alongside the postcondition reason.

The screenshot is taken **after** step 5, so the picture in the replay shows the confirmation, the error, or the login wall that decided the verdict — not the pre-poll frame `run()` captures today (`src/index.ts:151`). A Day 2 heuristic obstruction never silences §3/§4; the postcondition is the corroboration Day 2 said it would wait for: `overlay` + `no-change` is the cookie-overlay signature, and both reasons are on the step.

`Replay.verdict` roll-up is unchanged (writes only). With Day 3 a run of clean writes finally rolls up to `landed`.

## 9. Tests

Hermetic, `node:test`, one local Chrome + `Stagehand.create({ browser })` with **no model** — same harness as Day 2, with one addition forced by the probes.

**Fixtures are served over HTTP, not `data:` URLs.** Chrome blocks script-initiated navigation to `data:` URLs, and a new tab opened to one never reports a URL (§0). Every row involving navigation, redirect, a new tab, or an HTTP status is untestable on `data:`. So `test/helpers.ts` gets a stdlib `node:http` fixture server: `serve({ "/checkout": html, "/login": { status: 401, html } })` → `base` URL, closed in `after`. It also lets the Day 2 login-corroboration test hit a **real** 401 instead of injecting `navStatus` by hand. Static single-page rows may stay on `data:`; anything that moves uses the server. Standard library, no dependency.

**DRY helpers, one file:** `serve()` above; `state({ href, tree, forms })` to build `PageState`s for unit rows; `fakeStagehand(page, { method, selector, args, success })` returning a duck-typed `Stagehand` whose `act` performs a **real** `page.locator(selector).click()` / `.fill()` and returns `{ data: { success, actions: [{ selector: "xpath=…", method, arguments }] } }`. Sixteen tests should not each hand-roll an `ActResult`.

**Unit (pure, no browser):** `classifyChange(before, after, flags)` over hand-built `PageState`s — one `it` per row of §4, plus ordering cases (alert-error beats confirmation; prompt beats confirmation; navigation beats everything; destination gate demotes `navigated`).

**Integration without an LLM:** `withReplay()` takes the fake from `fakeStagehand()`; that exercises the real `run()` path — before capture, action, settle, session, postcondition, extended wait, destination gate — end to end. The fake is only the LLM; the browser, the click, and every page read are real.

| Fixture / action | Expected |
|---|---|
| submit button under a fixed cookie overlay, click | `did-not-land`, `no-change` (after the §4.1 wait); session `overlay` (heuristic) also on the step |
| **agent returns `success:false`, but the submit reveals a confirmation** | `landed`, `confirmation` — proves the verdict ignores `agent_claim` (the reported-failure / actually-landed bucket) |
| **slow confirm: `role=status` "Order placed" appears at ~3 s** (past the settle budget) | `landed`, `confirmation` via the §4.1 extended poll — **not** a premature `no-change` |
| **click a `href="#"` anchor that lands nothing** (hash-only change) | `inconclusive`, `hash-only-nav` — not a false `landed` |
| **submit with an empty `required` field** (native validation blocks; tree diff is empty) | `did-not-land`, `validation-error` via `:user-invalid`, resolved **immediately**, not after the 8 s wait |
| **Save whose handler redirects to `/login` (401) 1.2 s later** (probe (c′)) | `inconclusive`, reasons `navigated` + `login-wall` — the destination gate refuses the false `landed` |
| **click that opens a `<dialog>` with Confirm/Cancel buttons** | `inconclusive`, `prompt` — not `confirmation` despite the word "confirm" |
| new tab over **HTTP** (`target=_blank` to `/tab2`) | `landed`, `new-page`; `newPageUrl` is the HTTP URL; next step reads the new tab |
| page with a ticking clock (mutates forever) **that also navigates on submit** | `landed`, `navigated` — unsettled must not mask a conclusive row |
| submit that reveals `role=status` "Order placed" | `landed`, `confirmation` |
| click a real navigation (a second `data:` URL / path change) | `landed`, `navigated` |
| click `target=_blank` link | `landed`, `new-page`, `newPageUrl` set; next step reads the new tab |
| submit that reveals `role=alert` "Email is required" | `did-not-land`, `validation-error` |
| submit that reveals plain text "error" with no role | `inconclusive`, `error-text` |
| submit that resets the form (`form.reset()`) | `landed`, `form-cleared` |
| `fill` email field, attempt `arguments:["a@b.co"]`, field holds it | `landed`, `field-match` |
| `fill` where the page's handler rewrites the field to `""` | `did-not-land`, `field-mismatch` |
| **`fill` with `arguments:[""]`** (clearing a field) | not a trivial `field-match`; `includes("")` short-circuit guarded |
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
| D10 | `no-change` concluded at the 1.5 s settle | **revised (eng-review)** | 1.5 s < a real server round-trip; a slow-confirming success would read `no-change` → false `did-not-land`. §4.1 adds an extended re-capture poll (default 8 s) that runs only on a first-look `no-change` |
| D11 | any `href` change → `landed` (high) | **revised (eng-review)** | a bare `#` anchor "navigates" and lands nothing; counting it high-confidence `landed` is TrueReplay missing a silent failure. Split: path/origin/search → high `landed`; hash-only → `inconclusive` (row 7) |
| D12 | redaction vs. the field-match compare | **added (eng-review)** | redacting before comparing makes every password fill trivially `field-match`. Fixed order: compute on real values, then redact for storage (§7) |
| D13 | new `src/postcondition.ts` module | added (eng-review) | `captureState` / `classifyChange` (pure) / `fieldPostcondition` / `redact`; keeps `run()` thin and `classifyChange` unit-testable |
| D14 | test matrix | **expanded (eng-review)** | +reported-failure/actually-landed (the 4th benchmark bucket), +slow-confirm, +hash-only, +empty-fill |
| D15 | native constraint validation via `:user-invalid` + focus jump | **added (code critique)** | probe (a): a `required`-blocked submit changes nothing in the tree; `:invalid` is useless (matches before and after); `:user-invalid` flips only after a submit attempt. Resolves instantly instead of after the 8 s wait |
| D16 | destination gate on every `landed` row | **added (code critique)** | probe (c′): a write that redirects into a 401 login wall would have been `navigated → landed`. `detectSession` on the final page refuses it |
| D17 | `unsettled` blocks only `no-change`, not conclusive rows | **revised (code critique)** | a ticking widget was turning every write on the page `inconclusive`; navigation / form-cleared / `:user-invalid` are conclusive regardless |
| D18 | session detection + screenshot on the **final** page/state | **revised (code critique)** | `run()` today runs both after the first settle (`src/index.ts:150-151`); with the extended wait and tab switch that is the wrong page and the wrong frame |
| D19 | prompt (`dialog` + `button:` lines) → `inconclusive` | **added (code critique)** | probe (d): "Confirm delete? [Confirm] [Cancel]" would match the confirmation regex and read `landed` before anyone clicked Confirm |
| D20 | form-cleared demoted to heuristic | **revised (code critique)** | some apps reset the form on failure; under D11 a weak `landed` signal is not high confidence |
| D21 | extended poll re-captures only when the cheap fingerprint changes | **revised (code critique)** | 10 blind `snapshot()`s on a 2000-row page is 3.5 s of CPU to learn nothing; fingerprint every 250 ms, full capture on change or at the end |
| D22 | HTTP fixture server (`node:http`) in `test/helpers.ts`, plus `state()` / `fakeStagehand()` builders | **added (code critique)** | Chrome blocks script navigation to `data:` and `data:` new tabs never report a URL; every navigation/redirect/tab/status row needs an `http://` origin. Stdlib, no dependency; DRY across 20+ integration rows |

What I would push back on in the SPEC itself: *"detect confirmation-shaped elements"* as a **failure** criterion. Absence of a confirmation is weak evidence (many apps confirm nothing); presence is decent evidence. So confirmation only ever moves a verdict toward `landed` (row 5), never toward `did-not-land`. And the SPEC's implicit "false `landed` is safe" is wrong for this product: a false `landed` is a missed silent failure, so weak `landed` signals are held to `heuristic`/`inconclusive`, not waved through.

## 11. Not in Day 3

Declared overrides (Day 4 — `URL changed / element present / text matches / field equals`, layered on top of this default and able to override `no-change`) · grounding of `extract` values against `snapshot().formattedTree` (Day 5 — the tree capture built here is what Day 5 will read) · screenshot judging · per-site tuning of the confirmation/error regexes (collect `changed-unclassified` and `no-change` rates in Day 6 first) · pixel/visual diffs.

## GSTACK REVIEW REPORT

Runs: 3 — (1) spec-level critique of the SPEC Day 3 bullet against the Day 1/2 code and Stagehand 4.1.0 probes; (2) plan-eng-review of the resulting spec, 4 findings; (3) code-level critique against `src/index.ts` / `src/session.ts` with four new probes over `data:` and a real HTTP origin (2026-09-16). Outside voice: not run.

| Section | Status | Findings (run 3) |
|---|---|---|
| Measurement | 1 gap closed | native constraint validation is invisible to the tree diff; `:user-invalid` + focus jump added as a high-confidence row (D15) |
| Classification | 1 false-`landed` fixed, 2 rows added | a write redirecting into a 401 login wall read `navigated → landed` — destination gate on every `landed` row (D16); prompt vs confirmation (D19); form-cleared demoted (D20) |
| Precedence | 2 revisions | `unsettled` only blocks `no-change` (D17); session detection and screenshot move to the final page/state — `run()` today does both after the first settle, `src/index.ts:150-151` (D18) |
| Performance | 1 revision | extended poll gated on the cheap fingerprint, full re-capture only on change (D21) |
| Tests | infra + 6 rows | `data:` cannot navigate or open addressable tabs → `node:http` fixture server and DRY builders in `test/helpers.ts` (D22); rows for native validation, nav-into-login, prompt, HTTP new tab, ticking-page-that-navigates, real-401 corroboration |

Decisions runs 2–3: D10–D22. Runs 2 decisions user-approved; run 3 decisions are evidence-backed revisions folded per the "push back and change" instruction.

VERDICT: **APPROVED FOR BUILD** — implement per this document; no code written yet.

NO UNRESOLVED DECISIONS
