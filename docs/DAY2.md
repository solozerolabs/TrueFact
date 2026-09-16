# Day 2 — Session-state detection

Build this before postconditions: highest signal-to-effort in the whole design, and it needs zero declaration. Login walls, CAPTCHA frames, click-intercepting overlays, and blank/never-navigated pages are silent, common, and independently detectable by reading the page — exactly the failures the agent's own "success" claim hides.

## Where it runs

Inside the existing `withReplay` wrapper, **after every** `act`/`extract`, automatically. No opt-in, no declaration. It reads the live page directly through the Playwright surface Stagehand already exposes (`page.url()`, `page.frames()`, `page.evaluate(...)`) — the agent is never consulted. This is the page-truth channel filling in the `evidence` field that Day 1 left empty.

## What it detects

One pass returns at most one obstruction (first match wins, in this order — most unambiguous first):

| Obstruction | How we read it (page-truth only) | Ceiling / known gap |
|---|---|---|
| `blank` | `url()` is `about:blank`/empty, **or** `document.body` has no text and no element children | An app that legitimately renders an empty body reads as blank |
| `captcha` | Any frame whose URL matches `recaptcha`/`hcaptcha`/`turnstile`/`challenges.cloudflare`, or a challenge container in the DOM | Custom/self-hosted challenges are missed |
| `login-wall` | A visible `input[type=password]`, **or** the URL path matches `/login`,`/signin`,`/auth`, **or** an auth-provider origin | A password field inside a legit "change password" form false-positives; declared overrides (Day 4) can suppress |
| `overlay` | `document.elementFromPoint(cx,cy)` at viewport center resolves to a `fixed`/`absolute` element with high `z-index` that covers a large fraction of the viewport and is not the page's own content root | Uses center, not the agent's actual click coordinate (Stagehand doesn't hand us the coordinate cleanly). Catches the cookie/consent-overlay case; a small corner popover intercepting one specific button is missed until we can read the click point |

Everything is a heuristic; each detector is a few lines. No ML, no screenshot judge.

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

Session state is **co-primary**, so it can decide the step verdict on its own:

- obstruction detected → step `verdict = "did-not-land"` (the write could not have landed through a login wall / CAPTCHA / overlay, or nothing was ever loaded).
- detectors ran and found nothing → session-state contributes `landed`; the final verdict still waits on the Day-3 postcondition check (until then, stays `inconclusive`).
- a detector throws or the page is mid-navigation / not reachable → `inconclusive` with `detail` saying why. A checker that can't read the page says "I don't know," it does not say "landed."

`Replay.verdict` roll-up is unchanged: any `did-not-land` step makes the run `did-not-land`.

## Done when

Two runnable checks (assert-based, same style as Day 1's self-check — no framework):

1. **Logged-out mid-run is caught on the next step, not at the end.** Drive the wrapper against a page that presents a login wall after step *n*; assert step *n+1* records `obstruction: "login-wall"` and `verdict: "did-not-land"`, while step *n* is still clear.
2. **A click-intercepting overlay is flagged.** Against a page with a full-viewport high-z-index cookie/consent overlay, assert the step records `obstruction: "overlay"` and `verdict: "did-not-land"`.

Both run headless against tiny local HTML fixtures (data-URL or a temp file served to Stagehand's `LOCAL` env) — no live sites, no network, no flake.

## Not in Day 2

Postcondition "did anything change" (Day 3) · declared overrides that suppress a false login-wall (Day 4) · grounding (Day 5) · per-click-coordinate overlay precision (needs a coordinate Stagehand doesn't expose yet — revisit if the center heuristic misses in the Day-6 benchmark).
