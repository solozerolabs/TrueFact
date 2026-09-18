# Day 2 — Session-state detection

Revised 2026-09-16 after a code-level critique against the real Stagehand SDK. This supersedes the earlier Day-2 draft and the five eng-review decisions where they conflict (see §11).

Build this before postconditions: highest signal-to-effort in the design, zero declaration. Login walls, CAPTCHA/challenge pages, click-intercepting overlays, and blank/never-navigated pages are silent, common, and detectable by reading the page — exactly the failures the agent's own "success" claim hides.

## 0. Ground truth this spec is written against

Verified on 2026-09-16 by installing `@browserbasehq/stagehand@4.1.0` (npm `latest`; `v3-latest` is 3.7.3) and reading `dist/index.d.mts`, the extension bundle, and running probes with a local Chrome. Every design choice below cites one of these.

| Fact | Evidence |
|---|---|
| `act`/`extract`/`observe` are methods on the **`Stagehand` instance**, not on `page`. `stagehand.page` does not exist. | `index.d.mts:5033-5037` |
| Construction is `await Stagehand.create({ browser })`; the browser comes from `localBrowser.launch()` or `browserbase.launch()`. No `init()`. | `index.d.mts:5026`, migration guide |
| Pages come from `stagehand.browser.context.activePage()` / `.pages()`. `browser.context` **throws** until `Stagehand.create` has attached it (the docs say the raw handle is usable; it is not). | `index.d.mts:4856-4858`; probe: `Error: Browser context is unavailable. Attach the browser with await Stagehand.create({ browser })` |
| `Stagehand.create({ browser })` works **without a model**. Only `act` fails, at call time: `An LLM was not configured during Stagehand initialization`. Launch + create ≈ 0.8 s. | probe2 |
| `act` returns `{ data: { success, message, actionDescription, actions[] }, metadata }`; `actions[]` carry `selector` (xpath), `method`, `arguments`. | `index.d.mts:2153-2164` |
| `agent()` is removed in v4. The orchestration loop is the caller's (scripted "code mode" or tool-calling). | migration guide |
| Playwright is **not** a dependency (deps: `@browserbasehq/sdk`, `@opentelemetry/*`, `zod`). `Page` is Stagehand's own CDP-backed class. | `package.json` of 4.1.0 |
| `Page` runtime methods: `addInitScript click close dragAndDrop evaluate goBack goForward goto hover keyPress locator on reload screenshot scroll setExtraHTTPHeaders setViewportSize snapshot title tools type url waitForLoadState waitForSelector waitForTimeout`. **No** `frames()`, `setContent()`, `waitForURL()`, `content()`. | probe2 prototype dump |
| `page.url()` is **async** (`Promise<string>`). | `Page` decl, line 29 of class |
| `page.on()` supports exactly one event: `console`. No navigation or dialog events. | `PageEventNameSchema` |
| `page.goto()` returns a `Response` with `status()`/`ok()`. | `declare class Response` |
| `page.snapshot()` returns `{ formattedTree, xpathMap, urlMap }` — a role-annotated a11y tree. | `SnapshotResultSchema` |
| `Locator.centroid()` returns an element's center point. `Locator.isVisible()` exists. | `declare class Locator` |
| `waitForLoadState(state, timeout=15000)` is a **future** `Page.lifecycleEvent` listener that **rejects** on timeout. Empirically it resolves in 2 ms on an already-loaded document; `networkidle` costs ≈ 0.7 s even on a static page. | extension `waitForLoadState` body; probe2 timings |
| `domSettleTimeoutMs` (default 5000) is threaded into every action handler and `initialUrl` is captured before the action, so `act` has *some* internal post-action settle. It is undocumented and not exposed. | extension `performUnderstudyMethod` |
| `Page` and `Response` use `#private` fields (75 in the `Page` impl). A `Proxy` whose `get` trap forwards with the proxy as receiver breaks private-field access. | `index.mjs` |
| Chrome is required locally for tests (`/Applications/Google Chrome.app` present here; CI must install it). Fixture pages load via `goto("data:text/html,…")` — verified. | probe2 |
| Browserbase sessions solve CAPTCHAs in the background (`solveCaptchas`, default on, up to ~30 s). Local Chrome does not. | Browserbase docs |

## 1. Consequence: Day 1 targets a dead API — redo it before Day 2

[src/index.ts](../src/index.ts) wraps `page.act`/`page.extract` through a `Proxy`. On 4.1.0 those methods are not on `page`, so the Day-1 "done when" was only ever met against the fake page in its own self-check. This is a scrap-and-redo, not a patch:

- **Wrap the `Stagehand` instance, by composition.** `withTrueFact(stagehand)` returns `{ act, extract, observe, page, replay }` where `act`/`extract`/`observe` delegate to `stagehand.*` and `page` is a thin wrapper over `stagehand.browser.context.activePage()` whose `goto` is also recorded. No `Proxy` (private fields; and there are exactly four methods to wrap — explicit delegation is shorter and boring).
- **Steps carry a `kind`.** `"write"` (`act`), `"read"` (`extract`/`observe`), `"nav"` (`goto`). `landed / did-not-land` is write vocabulary; reads get grounding verdicts on Day 5; nav steps carry session evidence plus the `goto` `Response.status()`. Today's `Replay.verdict` (`src/index.ts:30-34`) lets one `inconclusive` extract poison a run whose writes all landed — the roll-up must be over write steps only.
- **Two claim levels, recorded separately.** *Step claim* = `ActResult.data.success` + `message` (Stagehand's self-report). *Run claim* = whatever the caller's loop concludes, supplied by an explicit `replay.claim({ done, note })` at the end (absent when the automation is scripted). The benchmark counts both; the headline is the step-level write number (see SPEC §Day 6).
- **`agent_claim` and `attempt` are different fields.** `data.success`/`message` is the claim. `data.actions[]` (selector, method, args) is a description of what was *attempted*, not of the outcome. Day 2 uses `attempt` only as "where to look" (§5). Neither is ever read to compute a verdict.

## 2. Where it runs

Inside the wrapper, after every `act`, `extract`, `observe`, and `page.goto`, automatically. No opt-in, no declaration. Detectors read the live page through Stagehand's `Page` (`evaluate`, `url()`, `title()`, `snapshot()`); the agent is never consulted. This fills the `evidence` field Day 1 left empty.

Detectors live in **`src/session.ts`** as pure `(page: Page) => Promise<Obstruction | null>` functions typed against Stagehand's exported `Page`, with one shared `safeRead(page, fn)` that turns a throwing `evaluate` into `inconclusive`. The wrapper calls `detectSession(page)`. Pure functions over `Page` are testable with `localBrowser.launch()` + `Stagehand.create({ browser })` and no model.

## 3. Settle: state fingerprint, not `waitForLoadState`

The eng review chose `waitForLoadState("domcontentloaded", 2000)` before reading. Reversed, on evidence:

- Stagehand's `waitForLoadState` listens for a *future* lifecycle event and resolves immediately when the current document already reached that state (2 ms measured). After `act` returns, the click's navigation usually has not committed yet, so the call returns at once and the read still races the navigation — the exact failure it was meant to prevent. It also **rejects** on timeout, so "swallow" would have meant a try/catch on a call that does nothing useful.
- `networkidle` would help but costs ≥ 0.7 s per step on a static page (measured), and still misses SPA mutations.

Replacement — one function that Day 3 needs anyway (DRY: settle *is* "the after-snapshot stopped changing"):

```
fingerprint(page) := { href, readyState, bodyTextLength, elementCount, title }   // one evaluate, <5 ms

settle(page, budgetMs = 1500):
  prev = fingerprint(page)            // throws → navigation in flight → waitForLoadState("domcontentloaded", 3000) in try/catch, retry
  loop every 100 ms until budget:
    cur = fingerprint(page)
    if cur == prev twice in a row → return { settled: true, after: cur }
    prev = cur
  return { settled: false, after: cur }   // evidence records settled=false; verdict may only be inconclusive from here
```

Typical cost ≈ 200 ms; worst case ≤ 1.5 s, behind a 3–10 s LLM `act`. The before-fingerprint is taken **before** the action (the wrapper already has the hook), so Day 3's "did anything change?" is `before !== after` with no new plumbing.

## 4. Detectors

One pass returns at most one obstruction, first match wins, most unambiguous first. "Confidence" is a property of the *mechanism*, not a score.

| Obstruction | Confidence | How we read it (page-truth only) | Objective discriminators added by this revision | Ceiling |
|---|---|---|---|---|
| `blank` | high | after settle: `url()` still `about:blank` (the initial page — verified) **or** `document.body` has no text and no element children with `readyState === "complete"` | `readyState` guard avoids flagging a page that is still parsing | an app that intentionally renders an empty body |
| `captcha` | high | (a) any `iframe[src]` matching `recaptcha\|hcaptcha\|turnstile\|challenges\.cloudflare` — enumerated via `evaluate` on the main document (`src` is readable cross-origin; there is no `frames()`), **or** (b) the Cloudflare **full-page** interstitial: `document.title` starts with `"Just a moment"`, or `#challenge-running` / `[id^="cf-chl"]` present | (b) is the common Cloudflare case and is not an iframe; the old draft would have missed it | custom challenges; on Browserbase the challenge is transient (auto-solve ≤ 30 s) — re-run detection after settle, and only a challenge that **persists** counts |
| `login-wall` | heuristic → promoted to high when corroborated | a **visible** `input[type=password]` (`el.checkVisibility()`, native) whose form has **no** `autocomplete="new-password"` field; or URL path **segment** ∈ {`login`, `signin`, `sign-in`, `auth`, `sso`, `oauth`} (segment match, not substring — `/author` must not match) | the HTML `autocomplete` contract: `current-password` = login, `new-password` = signup/change-password. This *is* the false-positive guard, by spec rather than by heuristic. Corroboration that promotes to high: the nav step's `goto` `Response.status()` ∈ {401, 403}, or the settle saw the URL change *to* a login path during a write | a login modal rendered off-screen but "visible" by CSS; sites that omit `autocomplete` (falls back to plain password-field rule, stays heuristic) |
| `overlay` | heuristic | (a) `dialog[open]` or `[aria-modal="true"]` present, or the main content root is `inert` / `aria-hidden="true"` — the app itself says content is blocked; or (b) `elementFromPoint` at the **attempt point** (§5; falls back to viewport center) resolves to a `position:fixed/sticky` ancestor with `pointer-events !== none` covering ≥ 80 % of the viewport that does **not** contain the attempted target | (a) is a first-class DOM signal, not a geometry guess; (b) now uses the point that was actually clicked | an intentional modal the agent *meant* to open reads as an overlay — it is recorded, and the verdict is only `inconclusive`, so Day 3 decides |

Not detectable with the 4.1.0 SDK and therefore **out**: JavaScript `alert/confirm/beforeunload` dialogs (`page.on` exposes only `console`; no dialog event). Note it in AGENTS.md so nobody re-plans it.

## 5. The attempt point

`ActResult.data.actions[].selector` is the xpath Stagehand acted on. `page.locator(xpath).centroid()` gives the point it clicked. That closes the "we don't know the coordinate" gap from the first draft.

Rule, stated so the two-channel invariant survives: the attempt is **input to where to look**, never **evidence of what happened**. If the agent reports the wrong selector, the page read at that point still shows the truth (an overlay, or nothing). `attempt` is stored as its own field and no verdict function receives `agent_claim`.

## 6. Output

```ts
type StepKind = "write" | "read" | "nav";
type Verdict  = "landed" | "did-not-land" | "inconclusive";

interface Step {
  kind: StepKind;
  action: string;                 // instruction text, or "goto <url>"
  declaration: "auto" | Postcondition;   // Day 4
  verdict: Verdict;
  evidence: {
    before: Fingerprint;          // taken before the action
    after:  Fingerprint;          // taken after settle
    settled: boolean;
    session: {
      obstruction: "blank" | "captcha" | "login-wall" | "overlay" | null;
      confidence: "high" | "heuristic";
      detail: string;             // matched iframe src / selector / status code / coverage %
      checked: string[];          // detectors that ran — "clear" ≠ "not checked"
    };
    nav?: { status: number | null };          // goto only
    screenshot?: string;          // path; see below
  };
  attempt: Action[] | null;       // ActResult.data.actions — where to look, never evidence
  agent_claim: { success: boolean; message: string } | null;   // null for nav/read steps
  timestamp: string;
}

interface Replay {
  steps: Step[];
  verdict: Verdict;               // roll-up over kind === "write" only
  claim: { done: boolean; note?: string } | null;   // run-level claim, set by the caller
}
```

**Screenshot per write step, on by default, opt-out.** `page.screenshot()` is one call and a few tens of ms. The product is *replay*; a replay without a picture is a log. This is evidence for a human, explicitly not a judge (the "screenshot judge" stays out of scope).

## 7. Verdict mapping

- high-confidence obstruction on a **write** step (`blank`, `captcha`, or `login-wall` after corroboration) → `did-not-land`.
- heuristic obstruction → `inconclusive`, obstruction recorded. Day 3's postcondition can corroborate and promote.
- no obstruction → session contributes `landed`; the step stays `inconclusive` until Day 3 lands.
- `safeRead` threw, or `settled === false` → `inconclusive`, `detail` says why. A checker that cannot read the page says "I don't know"; it never says "landed".
- **read** and **nav** steps never receive `did-not-land` from session-state; they carry the evidence. A nav step whose `Response.status()` ≥ 400 records it in `evidence.nav` and is `inconclusive` (Day 4 can declare it a failure).

Rationale unchanged from the review: a heuristic false positive would land in *reported-success / did-not-land*, the benchmark's headline bucket, and bias the instrument toward its own thesis.

## 8. Tests — BDD on the standard library

- Runner: **`node:test`** + `node:assert/strict` (stdlib, Node 24). `describe("session: login wall") / it("given a visible current-password field, when detected, then obstruction is login-wall and verdict is inconclusive")`. No test framework dependency. Delete the `import.meta.url === argv[1]` self-check block pattern — it is what forced `@types/node` in and it runs on import in some hosts.
- Files: `test/session.test.ts`, `test/replay.test.ts`, run with `node --import tsx --test test/`.
- Browser: one `localBrowser.launch({ headless: true })` + `Stagehand.create({ browser })` per file in `before`/`after` (≈ 2 s once; each test then costs milliseconds). No model configured; `act` is never called in unit tests.
- Fixtures: inline HTML strings loaded with `page.goto("data:text/html," + encodeURIComponent(html))`. No temp files, no server.
- CI: needs Chrome; `setup-chrome` action, then `npm test`.

Matrix (each row is one `it`; all hermetic):

| Fixture | Detector fires | Verdict |
|---|---|---|
| never navigated (`about:blank`) | `blank` | `did-not-land` |
| empty body, `readyState complete` | `blank` | `did-not-land` |
| `<iframe src="https://www.google.com/recaptcha/…">` | `captcha` | `did-not-land` |
| Cloudflare interstitial (`<title>Just a moment…`, `#challenge-running`) | `captcha` | `did-not-land` |
| visible `<input type=password autocomplete=current-password>` | `login-wall` (heuristic) | `inconclusive` |
| same, reached by a nav step whose response is 401 | `login-wall` (corroborated) | `did-not-land` |
| **change-password form** (`new-password` present) — FP guard | none | defers |
| URL `/author/123` — segment-match guard | none | defers |
| `<dialog open>` covering a submit button | `overlay` | `inconclusive` |
| fixed full-viewport cookie div; attempt point under it | `overlay` | `inconclusive` |
| fixed full-viewport div with `pointer-events:none` | none | defers |
| **clean logged-in page** — true negative | none | defers |
| `evaluate` throws mid-navigation (goto not awaited) | `safeRead` | `inconclusive` |
| settle: fixture that rewrites its body 300 ms after load | — | `settled: true`, `after ≠ before` |
| settle: fixture that mutates forever | — | `settled: false` → `inconclusive` |
| roll-up: writes landed + one read inconclusive | — | run `verdict` ignores the read |

The true-negative, FP-guard, and pointer-events rows are the ones that protect the headline number: they prove the instrument does not manufacture `did-not-land`.

## 9. Scripts

Two probe scripts, kept in `scripts/`, not part of the test suite:

- `scripts/probe-stagehand.mjs` — launches local Chrome, attaches Stagehand with no model, loads a fixture, prints `evaluate`/`url()`/`title()`/`snapshot()` results, the `Page` prototype's method list, and `waitForLoadState` timings. Run it whenever Stagehand is bumped; if the method list or the timings change, this spec's §0 is stale.
- `scripts/probe-overlay-act.mjs` — needs `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). One real `act("click 'Place order'")` on a checkout form whose submit button is under a cookie overlay, then prints `ActResult.data` beside the page's before/after state. This is the thesis in one call: if Stagehand reports `success: true` and the page shows nothing changed, Day 2 has its first reported-success/did-not-land. If Stagehand reports `success: false`, that is a Day-6 kill-signal data point worth having on Day 2. Not run here — no key in the environment.

## 10. Repo hygiene required by this spec

- `AGENTS.md` at the root: commands, the two invariants (channels never touch; heuristic ⇒ `inconclusive`), the Stagehand-4.1 facts that matter, and the "no backward compatibility" policy. Written alongside this revision.
- `@browserbasehq/stagehand@^4.1.0` as a **peerDependency** (the user already has it) and a devDependency (tests and scripts).
- Delete `dist/` from the tree if it is tracked (it is git-ignored; keep it that way).
- No compatibility shims for v3 shapes (`stagehand.page`, un-nested results). v4 only.

## 11. Decisions register — including reversals of the eng-review decisions

| # | Decision | Status | Why |
|---|---|---|---|
| D1 | Verdict tiered by confidence | **kept, strengthened** | the `autocomplete` contract and 401/403 corroboration make login-wall promotable on evidence, not on a guess |
| D2 | `waitForLoadState('domcontentloaded', 2000)` settle | **reversed** | resolves immediately on an already-loaded doc (2 ms measured); rejects on timeout; cannot see a navigation that has not started. Replaced by the fingerprint settle (§3), which Day 3 needs anyway |
| D3 | Wrap `goto` | **kept, reshaped** | `act`/`extract` are on the `Stagehand` instance, `goto` on `Page`; no navigation events exist (`page.on` = `console` only), so `goto` must be wrapped explicitly. Click-triggered navigations are observed by the settle's `href` change instead |
| D4 | Detectors as pure functions, "bare Playwright page" | **kept, corrected** | Playwright is not a dependency; type against Stagehand's `Page`, test through `localBrowser.launch` + `Stagehand.create` with no model (verified, 0.8 s) |
| D5 | Full hermetic matrix, ad-hoc asserts | **kept, upgraded** | `node:test` gives `describe/it` BDD naming for free; matrix grows from 7 to 16 rows with the objective cases found in §4 |
| new | Composition instead of `Proxy` | added | `#private` fields in `Page`/`Response`; four methods to wrap |
| new | Step `kind`, roll-up over writes only | added | fixes `Replay.verdict` being poisoned by reads |
| new | Two claim levels (`agent_claim` per step, `replay.claim` per run) | added | `agent()` no longer exists; the loop is the caller's |
| new | `attempt` as a third field, used for *where to look* only | added | closes the coordinate gap without touching the channels |
| new | Screenshot per write step, default on | added | the product is replay; cost is tens of ms and disk |

## 12. Not in Day 2

Postcondition "did anything change?" as a verdict (Day 3 — though its snapshot function ships here as the settle) · declared overrides (Day 4) · grounding via `snapshot().formattedTree` (Day 5) · JS dialogs (not observable in the 4.1.0 SDK) · Browserbase-specific CAPTCHA-wait tuning (record env per run; tune after Day 6) · any v3 compatibility.

## GSTACK REVIEW REPORT

Runs: 2 — eng-review (2026-09-16), then code-level critique against `@browserbasehq/stagehand@4.1.0` with probes (2026-09-16). Outside voice: not run.

| Section | Status | Findings |
|---|---|---|
| Foundation | scrap-and-redo | Day 1 wraps `page.act`, which does not exist on 4.x; `Proxy` breaks `#private` fields |
| Architecture | 3 revised | settle mechanism reversed (D2); `goto` wrap reshaped (D3); step kinds + two claim levels added |
| Detectors | 4 objective upgrades | Cloudflare full-page interstitial; `autocomplete` login discriminator + path-segment match; `dialog`/`aria-modal`/`inert` overlay signal; attempt-point `elementFromPoint` |
| Tests | upgraded | `node:test` BDD, 16-row hermetic matrix, no-model Stagehand attach verified |
| Benchmark (SPEC) | corrected | writes only against targets you control; step-level headline; kill signal as a number with a confidence interval |

VERDICT: **APPROVED AS REVISED** — implement Day 1 redo, then Day 2, per this document.

NO UNRESOLVED DECISIONS
