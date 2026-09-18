# Findings

What this project established, with the evidence for each. This is the durable
record: empirical facts we verified by probing, the thesis result on real agents,
and the design conclusions that survived review. Spec detail and decisions live in
[SPEC.md](../SPEC.md) and `docs/DAY*.md`; this is the "what did we actually learn."

## 1. The thesis holds — and it is catchable (the headline)

A real acting agent reports success on a write that did not land, and TrueFact
catches it by reading the page. Demonstrated on genuine agents, not asserted — full
runs in [PROBES.md](PROBES.md).

| Agent | Trap: submit under a click-intercepting cookie overlay | Claim | Truth (server `POST /order`) | Verdict |
|---|---|---|---|---|
| Frontier (blind subagent) | dismissed the banner, placed the order for real | success | placed | **true success** — recovered |
| Local Qwen3.8-27B via Stagehand + TrueFact | clicked straight through the overlay | `success: true` | **never placed** (only GETs) | **false success — TrueFact said did-not-land** |

The truth channel is the fixture server's own request log — the agent cannot fake a
`POST` it never sent, so the agent's claim and the page-state truth are structurally
unable to touch. This is the product's core rule, made physical.

**Corollary (the "frontier erosion" open question, answered in miniature):** the
weaker model fell into the exact silent failure the product catches; the frontier one
did not. The durable market tracks the self-hosted / weaker long tail, and any real
benchmark must run one task set across a model ladder. Two anecdotes, not a rate — the
rate is Day 6 — but the instrument now works end to end on real act pipelines.

## 2. Stagehand 4.1 — verified behavior

Everything TrueFact is built on, established by reading `dist/index.d.mts` and the
extension bundle and by live probes against `@browserbasehq/stagehand@4.1.0`. Several
of these contradict or are absent from the published docs.

| Fact | How we know |
|---|---|
| `act` / `extract` / `observe` are methods on the **`Stagehand` instance**, not on `page`. `stagehand.page` does not exist. | `index.d.mts:5033-5037`; the first Day-1 build wrapped `page.act` and only ever passed against a fake. |
| Construction is `await Stagehand.create({ browser })` from `localBrowser.launch()`; **it works with no model** (~0.8 s). Only `act` fails, at call time. | probe; this is what makes the whole test suite hermetic and LLM-free. |
| `context.activePage()` returns a **fresh `Page` wrapper on every call**; `pageId` is stable per tab and survives navigation. | probe (`activePage() !== activePage()`, same `pageId`). Detecting a tab switch by object identity marked every write as a new tab — a real bug caught in the Day-4 build. |
| `page.snapshot()` returns a role-annotated a11y tree that **includes input values** (passwords masked as `••••••`), `[selected]`, `[checked]`. Cost **9 ms** small / **346 ms** on a 2000-row page. A `display:none` element is absent; showing it adds it. | probes; this is the change unit for the postcondition. |
| `waitForLoadState(state, timeout)` resolves in **~2 ms** on an already-loaded document and **rejects on timeout**. It cannot see a navigation that has not committed. | probe; this is why the Day-2 settle is a fingerprint loop, not `waitForLoadState`. |
| `act` reports actions as `{ selector: "xpath=/html[1]/…", method, arguments }`; `page.locator()` accepts `xpath=`, bare xpath, css, and `text=`. | `ActionSchema`; extension `parseSelector`. |
| `Locator.count()` is the **only** element read that does not throw on zero matches; `isVisible()`/`innerText()`/`inputValue()` **reject** on a missing element. `page.on` emits only `console`. No `frames()` / `setContent()` / `waitForURL()`. `page.url()` is async. | `index.d.mts` + probes; shapes the declared-check reads. |
| A submit blocked by native `required`/`pattern` validation changes **nothing** in the a11y tree. `:invalid` matches before and after (useless); `:user-invalid` flips only after a submit attempt, and focus jumps to the field. | probe; the most common real form rejection, invisible without `:user-invalid`. |
| Chrome **blocks script-initiated navigation to `data:` URLs**, and a new tab opened to a `data:` URL reports `url() === ""` indefinitely. | probe; every navigation/redirect/tab test must run over an `http://` fixture, which also runs ~100× faster (a `locator` action is ~1 s on `data:` vs ~9 ms over HTTP). |
| `act` options are parsed with **`z.strictObject` and throw on unknown keys**; there is **no assertion/verify/postcondition primitive** anywhere in the SDK, and `observe()` cannot run without an LLM. | `index.mjs:1523` + grep; this is the gap TrueFact fills, and why a declaration must be stripped from the options before delegating. |
| **No `baseUrl` in `ModelConfig`** — a local model must ride the `ClientLLM.generate` callback, a two-mode contract (text / `json_schema`). | `ModelConfigSchema`, `ClientLLMSchema` in `index.mjs`. |

## 3. Measured numbers

- Snapshot: 9 ms (form) → 346 ms (2000-row page). `evaluate` reading `innerText.length`: ~6 ms.
- `waitForLoadState('domcontentloaded')` on a loaded doc: 2 ms. `networkidle` on a static page: ~730 ms.
- Fingerprint settle: typically ~200 ms, bounded at 1.5 s.
- Full hermetic suite: **92 tests, ~12 s** (real headless Chrome, no LLM) after moving every integration fixture onto the HTTP server (it was 15.8 s with fewer tests on `data:` URLs).
- Local Qwen3.8-27B via oMLX on an M2 Max: **~15 s per structured `act` call** (one call per action). Small chat reply ~18 s including first-load.

## 4. Design conclusions that survived review

Non-obvious calls that emerged from building and from seven-agent review of each day
(rationale in the `docs/DAY*.md` decisions registers).

- **"No change" is not a mechanism.** Concluding `did-not-land` from the absence of a
  visible change is an inference, not a reading — the class of guess reserved for
  heuristics. Bare `no-change` is `inconclusive`; it becomes `did-not-land` only when a
  real obstruction (cookie overlay, login wall, CAPTCHA) or `:user-invalid`
  corroborates it. Probe Run 2 is exactly this: `no-change` **+** `overlay` → caught.
- **A false `landed` is the product failing, not a "safe" error.** The instinct that
  under-reporting failure is safe is backwards here: a false `landed` is a missed silent
  failure, the one thing the product exists to catch. So weak `landed` signals (a bare
  `#` anchor "navigation", a regex confirmation) are held to `heuristic`, and any
  `landed` is gated by a session read on the final page.
- **Declarations are data, never callbacks.** A user callback can close over the agent's
  `ActResult`, which puts the claim inside the verdict. Every deterministic prior-art
  system (Playwright, WebArena, uiuing/browser-agent) uses data; every free-text one
  needed a confidence escape hatch because free text can loosen. Met lifts only the auto
  default's *uncertain* outcomes and never overrides a mechanism-backed failure.
- **The graded-party fallacy applies to our own testing.** We could not "simulate" the
  probe from the session itself, because an agent self-report we author is not evidence
  about real agents — the same reason self-assessment fails to catch false success, one
  level up. The valid probe needs a genuinely independent agent (a blind subagent, or a
  real model driving Stagehand).
- **A local model can drive Stagehand reliably via constrained decoding.** A plain
  `json_object` request to Qwen3.8-27B returned garbage (`[1.0]`); the same request with
  a `json_schema` `response_format` returned valid structure. Passing Stagehand's action
  schema through oMLX's constrained decoding is what makes a local model usable for
  `act` — and it means the whole thesis is reproducible with no cloud key
  (`npm run probe:omlx`).

## 4a. First measured pilot (N=3, one local rung — not the benchmark)

A single-rung, N=3 run of the Day-6 harness (Qwen3.8-27B via oMLX, 10 tasks, 30
decisive writes) — enough to validate the instrument end to end on a real model,
far short of the ≥200-write, multi-rung floor the real number needs. It is recorded
because the *shape* is the point, not the values:

| Metric | Value | Reading |
|---|---|---|
| exec false-success | 60 % [42–75] (18/30) | Stagehand's mechanical executor reports success on writes that never landed |
| residual MISS (exec) | 16.7 % [6–39] (3/18) | **all three misses are `optimistic-ui`** — the named ceiling, nothing else |
| belief false-success | 20 % [7–45] (3/15) | the model itself believed done on the three optimistic-ui runs |
| cry-wolf | 0 % (0/12) | zero false accusations on the 12 real landings |
| under-confidence | 0 % (0/12) | — |
| gate | `insufficient-n → publish:false` | the gate refuses to publish on one rung, as designed |

The instrument caught overlay, expired-session, captcha, validation-reject and
silent-noop, and missed only the fixture built to be its ceiling — the cleanest
possible confirmation that the harness measures what it claims. The rate itself is
still Day 6's job.

## 5. Not yet established

- **The rate.** The pilot above is one local rung at N=3. The write-side false-success rate
  with a confidence interval is Day 6 proper: ≥ 200 write steps on owned fixtures, one task set
  across a model ladder, `auto` steps only in the headline, gates read on their count floors.
- **Frontier false-success on hard traps.** Run 1 shows a frontier agent recovering from
  an *easy* overlay. Whether it lies on harder silent failures (a POST that fails with no
  UI change, an optimistic-UI rollback) is the number that decides whether the product's
  market is only the long tail or broader. Unmeasured.
- **Multi-tab races.** `activePage()` re-resolution is correct for single-tab flows;
  a caller juggling tabs between calls is untested and deferred to the Day-6 harness.
