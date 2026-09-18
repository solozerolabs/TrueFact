# Research build — TrueFact vs a Claude-in-Chrome agent

> **Post-MVP research spec. Not built.** This measures a *different* integration
> than the shipped product (a Stagehand wrapper): a Claude agent driving a real
> browser with its own tools, with TrueFact's verdict engine run out-of-band.
> The output is a research result — "we pointed a frontier browser agent at N
> traps and TrueFact independently caught M silent failures" — not a
> certification of `withReplay`.

## Why build it

The whole business question is "agents are getting 10/10 good — what's the point
of an independent verifier?" The local-Qwen benchmark answers it for a weak model
in Stagehand. The cloud ladder ([.env.example](../.env.example)) answers it for
strong models **in Stagehand**. Neither answers it for a strong model **driving a
real browser its own way**, which is the actual thing skeptics mean by
"Claude-in-Chrome is 10/10." This spec closes that gap.

## 0. Ground truth (probed 2026-09-17, built-in browser `read_page`)

A fixture-shaped page (`heading`, a `status` confirmation, an `alert`, a masked
phone field, a checkbox) read through the built-in browser's `read_page`:

```
heading "Checkout" [ref_1]
generic "Deluxe Widget — $49.00" [ref_2]
form [ref_3]
 textbox "email" [ref_4] placeholder="email"
 textbox "(555) 123-4567" [ref_5]
 label "Email me" [ref_6]
  checkbox "on" [ref_7] type="checkbox"
 button "Place order" [ref_8] type="button"
status "✅ Order placed — confirmation #4242" [ref_9]
alert "Card required" [ref_10]
```

Compared to Stagehand's `formattedTree` (the format `classify` was written
against, DAY3 §0):

| Aspect | Stagehand `formattedTree` | built-in `read_page` | Impact on the classifier |
|---|---|---|---|
| Role position | leading (`status: …`) | **leading** (`status "…"`) | `hasRole(role)` = `^role\b` **works unchanged** — the load-bearing check survives |
| Name delimiter | `role: text` | `role "text" [ref_N]` | `treeText`/`normalizeTree` need a `read_page` variant |
| Node id | `[n-m]` prefix | `[ref_N]` **suffix** | `normalizeTree`'s strip regex must change |
| Input value | StaticText child | the textbox's **name** (`textbox "(555)…"`) | value still visible, different extraction |
| Checked/selected | `[checked]` / `[selected]` | attribute / name (`checkbox "on"`) | state markers need re-derivation |

**Conclusion:** the one genuinely new component is a tree-text normalizer for the
`read_page` format. `hasRole` — the check `confirmation`/`validation-error`/
`prompt` all hinge on — already matches because both formats are role-leading.
Everything the classifier reads from the DOM (form values, `:user-invalid`,
fingerprint, `readTarget`) is a `document.querySelector*` eval that ports 1:1
through `javascript_tool`.

## 1. What it measures (and what it does not)

Same three channels as the shipped benchmark, kept strictly separate:
- **agent_claim** — the Claude driver's own yes/no on "did it work?", asked from
  the page it ends on (the belief channel).
- **verdict** — TrueFact's `landed / did-not-land / inconclusive`, computed by
  reading the page out-of-band. The driver never sees it.
- **oracle** — `truth(task)` from the fixture server, the incorruptible POST log.

Does **not** measure: the `withReplay`/Stagehand `act`/`extract` wrapper. That is
the product; this is a research probe of the verdict engine against a different
driver.

## 2. Architecture

Reuse the pure verdict core untouched; add two adapters around a Claude driver.

```
per task × run:
  fx.reset()                                   # existing fixture server
  before = captureBrowser(page)                # NEW adapter -> PageState
  driver.do(task.instruction)                  # NEW: Claude subagent, ONE action
  after  = captureBrowser(page)                # NEW adapter -> PageState
  claim  = driver.ask(task.completionQuestion) # NEW: belief channel
  field  = fieldPostcondition-equivalent(after, action)   # reuse logic, browser read
  verdict = sessionVerdict(classify(before, after, switched), session, reason)  # REUSED, pure
  oracle = fx.truth(task.id)                    # existing
  append manifest row {claimExec/Belief, verdict, reason, oracleLanded}  # existing shape
score: npm run bench:score                       # REUSED, unchanged
```

## 3. The capture adapter (the real work)

`captureBrowser(page) -> PageState` mirrors `captureState` in
[postcondition.ts](../src/postcondition.ts):
- **tree** — `read_page` (or `get_page_text` for a lighter read), passed through a
  new `normalizeReadPageTree` that yields the same `string[]` shape `classify`
  diffs. This is the only novel logic; §0 is its spec.
- **forms / userInvalidCount / activeField / fingerprint** — one `javascript_tool`
  eval running the *exact* in-page function already inlined in `captureState`
  (it is self-contained: `document.querySelectorAll("input,textarea,select")`,
  `:user-invalid`, `activeElement`). Ports verbatim.
- **readTarget** (for `fieldPostcondition`) — the existing selector-read eval,
  run through `javascript_tool`. Ports verbatim.

## 4. The driver loop

One Claude subagent per run (or a pooled one), given the built-in browser tools:
1. `navigate` to `fx.url(task.id)`.
2. Perform **exactly one** decisive instruction, then stop. Constraining the
   agent to a single action is what makes the before/after snapshots bracket the
   write cleanly — otherwise the "decisive write" must be detected among many
   actions (the harder variant, deferred).
3. Report the yes/no claim for `task.completionQuestion` — the belief channel.

Use the **built-in browser** (`mcp__Claude_Browser__*`), not the Chrome
extension: isolated, no user logins in scope, reset between runs.

## 5. Reused vs new

| Reused unchanged | New |
|---|---|
| fixtures + oracle (`fixtures.mjs`) | `normalizeReadPageTree` (§3) |
| `classify` / `sessionVerdict` / `evidenceOf` (pure) | `captureBrowser` adapter (mostly ported evals) |
| `fieldPostcondition` logic | driver loop (subagent, one action + claim) |
| scorer, gates, thresholds (`bench.ts`) | manifest emitter for the driver |
| the hard false-halt fixtures | — |

## 6. Scoring & the pre-registered question

Reuse the scorer as-is. Question, fixed before the run: *on the same trap suite,
how many writes does a frontier Claude browser agent get wrong (exec
false-success), and of those how many does TrueFact independently catch
(1 − residual MISS)?* Headline = the caught fraction on a strong driver. The
`cry-wolf` (false-halt) metric applies unchanged and must stay low, or the verdict
engine is not portable to this driver.

## 7. Cost & n

Each run is a full multi-step agent turn — real Claude Code token cost, far
slower than Qwen-in-Stagehand (~33 s/run). Budget **n ≈ 30–50**, not 130. This is
a signal-grade result, not a tight-CI certification.

## 8. Effort & definition of done

**~2 days** (was 2–3; §0 de-risked the tree adapter — `hasRole` already works,
so no reclassification of the confirmation/error/prompt logic is needed), **+1**
if `read_page`'s checked/selected/value re-derivation is messier than the probe
suggests.

Done when: the driver loop runs the 13 fixtures at n≥30 on the built-in browser,
the scorer emits a report in the same shape as [bench/out/report.md](../bench/out/report.md),
and `cry-wolf` on the clean set stays at the local run's level (0 over the
landings). Ship the result as a short writeup, not a gate.

## 9. Ceiling (unchanged, and worth restating)

This driver swap does **not** move the optimistic-UI ceiling. A page that renders
success before an async server failure lies to the Claude driver and to the
page-reader identically — belief-level MISS stays ~100% on that shape
(measured: 10/10 at n=130). No stronger driver fixes it; only a non-page oracle
does. Say so in the writeup.
