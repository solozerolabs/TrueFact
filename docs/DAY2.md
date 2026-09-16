# Day 2 — Session-state detection

Build this before postconditions: highest signal-to-effort in the whole design, and it needs zero declaration. Login walls, CAPTCHA frames, click-intercepting overlays, and blank/never-navigated pages are silent, common, and independently detectable by reading the page — exactly the failures the agent's own "success" claim hides.

## Where it runs

Inside the existing `withReplay` wrapper, **after every** `act`/`extract`/`goto`, automatically. No opt-in, no declaration. It reads the live page directly through the Playwright surface Stagehand already exposes (`page.url()`, `page.frames()`, `page.evaluate(...)`) — the agent is never consulted. This is the page-truth channel filling in the `evidence` field that Day 1 left empty.

The Proxy intercept set grows from `act`/`extract` to also include `page.goto`, so an obstruction reached by a bare navigation (a login wall the agent hit with `goto`, or a run that ends on `goto`) is caught, not just one reached mid-`act`.

**Settle before reading.** A write usually navigates or mutates the DOM, so reading immediately races the navigation and `evaluate` throws "execution context destroyed" → every successful write would read as `inconclusive`. Before running detectors: `await page.waitForLoadState("domcontentloaded", { timeout: 2000 })`, swallow the timeout (a page that never fires a load event must not cost a full 2s or block), then read. This turns the common navigate-then-read case into a real reading. SPAs that mutate without a load event still fall to Day-3's before/after diff.

Detectors live in **`src/session.ts`** as pure `(page: Page) => Obstruction | null` functions over a Playwright `Page`, with one shared `safeRead(page, fn)` helper for the evaluate-and-catch plumbing. The wrapper just calls `detectSession(page)`. This keeps them unit-testable against fixture HTML with a bare Playwright page — no Stagehand, no LLM — and removes the repeated read/catch block.

## What it detects

One pass returns at most one obstruction (first match wins, in this order — most unambiguous first):

| Obstruction | Confidence | How we read it (page-truth only) | Ceiling / known gap |
|---|---|---|---|
| `blank` | **high** | `url()` is `about:blank`/empty, **or** `document.body` has no text and no element children | An app that legitimately renders an empty body reads as blank |
| `captcha` | **high** | Any frame whose URL matches `recaptcha`/`hcaptcha`/`turnstile`/`challenges.cloudflare`, or a challenge container in the DOM | Custom/self-hosted challenges are missed |
| `login-wall` | **heuristic** | A visible `input[type=password]`, **or** the URL path matches `/login`,`/signin`,`/auth`, **or** an auth-provider origin | A password field inside a legit "change password" form false-positives; declared overrides (Day 4) can suppress |
| `overlay` | **heuristic** | `document.elementFromPoint(cx,cy)` at viewport center resolves to a `fixed`/`absolute` element with high `z-index` that covers a large fraction of the viewport and is not the page's own content root | Uses center, not the agent's actual click coordinate (Stagehand doesn't hand us the coordinate cleanly). Catches the cookie/consent-overlay case; a small corner popover intercepting one specific button is missed until we can read the click point |

Everything is a heuristic; each detector is a few lines. No ML, no screenshot judge. The **confidence** column drives the verdict (below): a false positive on a heuristic detector must not fabricate a `did-not-land`, because that lands in the benchmark's headline bucket.

## Output

Extends the Day-1 `evidence` on each step:

```ts
evidence.session = {
  obstruction: "login-wall" | "captcha" | "overlay" | "blank" | null,
  detail: string,        // e.g. matched frame URL, selector, or coverage %
  checked: string[],     // which detectors ran, so "clear" ≠ "not checked"
}
```

## Verdict mapping

Session state is **co-primary**, but a heuristic detector must never fabricate a `did-not-land` — that verdict lands in the exact benchmark bucket (reported-success / did-not-land) the product is measured on, so a false positive there biases the headline number toward the thesis. Verdict is therefore **tiered by confidence**:

- **high-confidence** obstruction (`blank`, `captcha`) → step `verdict = "did-not-land"`. A real CAPTCHA frame or a never-loaded page could not have landed a write.
- **heuristic** obstruction (`login-wall`, `overlay`) → step `verdict = "inconclusive"`, recorded with the obstruction in `evidence.session`. A later check (Day 3 postcondition) can corroborate and promote it to `did-not-land`; on its own, Day 2 does not.
- detectors ran and found nothing → session-state contributes `landed`; the final verdict still waits on the Day-3 postcondition check (until then, stays `inconclusive`).
- a detector throws or the page is mid-navigation / not reachable → `inconclusive` with `detail` saying why. A checker that can't read the page says "I don't know," it does not say "landed."

`Replay.verdict` roll-up is unchanged: any `did-not-land` step makes the run `did-not-land`.

## Done when

Full hermetic matrix — one HTML fixture per case, loaded into a bare Playwright chromium page, detectors called directly (no Stagehand, no LLM, no network). Assert-based, same style as Day 1's self-check, no framework:

| Fixture | Detector fires | Asserted verdict |
|---|---|---|
| `about:blank` / empty body | `blank` | `did-not-land` |
| recaptcha/hcaptcha/turnstile iframe | `captcha` | `did-not-land` |
| login form / `/login` URL | `login-wall` | **`inconclusive`** |
| full-viewport high-z overlay | `overlay` | **`inconclusive`** |
| **clean logged-in page** (true negative) | none | defers (no obstruction) |
| **legit change-password form** (FP guard) | `login-wall` at most | **`inconclusive`**, never `did-not-land` |
| mid-navigation read throws | none (safeRead) | `inconclusive` |

Plus the two behavioral checks the original spec named:

1. **Logged-out mid-run is caught on the next step, not at the end.** Wrapper against a page that presents a login wall after step *n*; assert step *n+1* records `obstruction: "login-wall"`, while step *n* is still clear.
2. **Settle works.** A fixture that navigates on the wrapped call reads the settled destination, not `inconclusive`-by-race.

The true-negative and FP-guard rows are the ones that protect the headline number — they prove the instrument does not manufacture `did-not-land`.

## Not in Day 2

Postcondition "did anything change" (Day 3) · declared overrides that suppress a false login-wall (Day 4) · grounding (Day 5) · per-click-coordinate overlay precision (needs a coordinate Stagehand doesn't expose yet — revisit if the center heuristic misses in the Day-6 benchmark) · corroboration that promotes a heuristic `inconclusive` to `did-not-land` (arrives with Day 3's postcondition).

## GSTACK REVIEW REPORT

Runs: 1 (plan-eng-review, claude). Outside voice (Codex): offered, recommended skip for a 180-line surface — not run.

| Section | Status | Findings |
|---|---|---|
| Architecture | 3 findings | verdict-mapping bias (P1), settle race (P1), nav coverage (P2) |
| Code quality | 1 finding | detector shape / DRY / testability (P2) |
| Tests | 1 finding + 1 regression | test-matrix scope (P2); done-when #2 verdict corrected |
| Performance | No issues | bounded, rides behind LLM latency |

Decisions (all user-approved):

1. **Verdict tiered by confidence.** `blank`+`captcha` → `did-not-land`; `login-wall`+`overlay` → `inconclusive`. Keeps heuristic false positives out of the benchmark's headline bucket.
2. **Bounded settle** (`waitForLoadState('domcontentloaded', 2000)`, swallowed) before detectors, so navigate-then-read stops returning race-`inconclusive`.
3. **Wrap `goto`** in addition to `act`/`extract`; detectors run after navigations.
4. **Detectors as pure functions in `src/session.ts`** + shared `safeRead`; unit-testable with bare Playwright, no LLM.
5. **Full hermetic test matrix** (7 fixtures incl. true-negative + change-password FP guard); done-when #2 overlay verdict corrected from `did-not-land` to `inconclusive` to match decision 1.

REGRESSION corrected: original done-when asserted `overlay → did-not-land`, which contradicted the agreed confidence tiering; the overlay fixture now asserts `inconclusive`, and `did-not-land` moves to the blank/captcha fixtures.

VERDICT: **APPROVED** with the five decisions folded in above. Ready to build Day 2.

NO UNRESOLVED DECISIONS
