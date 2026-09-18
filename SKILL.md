---
name: truefact-verify
description: Independently verify that a browser write actually landed — for a coding/reviewer agent checking its own or another agent's web change. Use after shipping a UI change, or when a run claims success, to get a landed / did-not-land / inconclusive verdict from the live page and network (no LLM judge), plus a tamper-evident evidence log. Use when asked to "verify the write landed", "check the agent didn't just claim success", "gate CI on the recorded run", or "prove the session is real, not just the redirect".
---

# TrueFact: verify a browser write actually landed

TrueFact reads the live page and the network after an action and returns an
independent verdict — it never trusts what the agent claimed. Three uses:

## 1. Verify a run you drive (Stagehand / Playwright)

```ts
import { launch } from "truefact";
const tr = await launch({ model: { modelName: "anthropic/claude-sonnet-5", apiKey } });
await tr.page.goto(url);
const res = await tr.act("click 'Place order'");
console.log(res.truefact.verdict, res.truefact.why); // landed | did-not-land | inconclusive
tr.replay.assertLanded(); // throws with the reason unless the whole run landed
await tr.close();
```

Declare what "landed" means for a write that matters — most `inconclusive` turns
into a real verdict once you do (a `probe` asks your own server out-of-band):

```ts
await tr.act("sign in", { expect: [
  { kind: "probe", get: "/api/me", text: /"authenticated":true/ },
  { kind: "text", matches: /Signed in as/, role: "status" },
]});
```

## 2. Gate CI on a recorded run (offline, no browser, no tokens)

```bash
truefact verify run.jsonl                 # recompute the hash chain (exit 1 on a break)
truefact assert run.jsonl --with a.mjs    # re-run assertions (exit 1 if any write failed)
truefact view   run.jsonl                 # a standalone HTML timeline
```

## 3. Watch any framework (Browser-Use, Puppeteer, a human)

```bash
truefact watch --port 9222 [--api-origins api.host] [--jsonl run.jsonl]
```

## Reading the verdict
- **landed** — page and/or server confirmed it. Proceed.
- **did-not-land** — a mechanism said it failed (5xx/4xx-on-write, a validation
  error, an unmet declaration). Stop; the write is not there.
- **inconclusive** — couldn't tell. Do NOT blindly retry (it may have landed);
  declare a postcondition or check by hand.

For automatic retries, gate on `res.truefact.retryable` (also on the `serve`
reply): `true` only when repeating the action can't double-apply a write — a
`did-not-land` field write that never took. It is `false` for every
`inconclusive`, every `network-error`, and every `landed`, so a retry loop can't
double-charge a payment.

Scope: TrueFact checks what a browser reaches (the running app, its pages, its
network) — not your unit tests or build.
