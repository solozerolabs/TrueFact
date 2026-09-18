# TrueFact

**Your browser agent said it placed the order. The order wasn't placed. You found out from a customer.**

![TrueFact catching an optimistic-UI failure: the agent reported success, the server returned 500, `truefact assert` exits 1](demo/truefact-demo.gif)

TrueFact wraps your browser agent. After every action it reads the live page itself, and the network under it. Then it returns an independent verdict: **landed / did-not-land / inconclusive**. It never trusts what the agent claims. The gap between "agent said done" and "the world says done" is the whole product.

- **Silent failures caught.** A click that lands on a cookie overlay. A form that quietly rejected. A page that shows success while the server returned 500. The agent reports all of these as done. TrueFact doesn't.
- **Not another LLM judge.** The verdict is a deterministic read of the page and the network, not a model grading a model. Sub-second, no extra tokens.
- **A receipt, not a log.** Every step is recorded on a tamper-evident chain. You can replay it, assert against it offline, and verify it.

## Quickstart

```bash
npm install github:solozerolabs/TrueFact   # or: bun add github:solozerolabs/TrueFact
```

Installs straight from git. The compiled `dist/` is committed, so no build step runs on your machine.

```ts
import { launch } from "truefact";

// Owns the browser so network verification just works. No port to configure.
const tr = await launch({ model: { modelName: "anthropic/claude-sonnet-5", apiKey } });

await tr.page.goto("https://shop.example/checkout");
await tr.act("click 'Place order'");

console.log(tr.replay.verdict);   // "did-not-land", even though the page showed success
console.log(tr.replay.steps);     // per-step: verdict, why, evidence, what the agent claimed
await tr.close();
```

That's the whole runtime API. Call `launch()`, then your agent runs unchanged. Every `act` / `extract` / `goto` becomes a recorded step, on a channel separate from anything the agent says.

## See what happened

```bash
truefact view run.jsonl
```

Opens a standalone timeline. Every step shows its verdict. For each one you also get the page diff, the network errors, the screenshot, and what the agent claimed, boxed off as the untrusted channel. It opens on the first step that didn't land. Save a run with `launch({ jsonl: "run.jsonl" })`.

## Gate CI on it

Turn a flaky run into a deterministic test. Write assertions once. Re-run them against any recorded run with no browser and no tokens:

```ts
// assertions.mjs: a function over what the world showed, never the agent's claim
export default (v) =>
  v.network.some((n) => (n.status ?? 500) >= 500)
    ? { ok: false, message: "a request failed behind this step" }
    : { ok: true };
```

```bash
truefact assert run.jsonl --with assertions.mjs   # exits 1 if any write step fails
```

## Let a coding agent verify its own feature

Your coding agent said it wired up "Sign in." The redirect works, the dashboard renders, the tests are green. But the session cookie was never set — the first protected request 401s in production. Green tests pass on code that looks logged in. TrueFact is the acceptance check the agent can't fake: after it ships a web change, drive the real flow and ask the server who you are.

```ts
// the agent just implemented login — prove the session is real, not just the redirect
await tr.page.goto("http://localhost:3000/login");
await tr.act("sign in as the demo user");
await tr.act("open the dashboard", {
  expect: [
    { kind: "probe", get: "/api/me", text: /"authenticated":true/ }, // the server agrees you're in
    { kind: "text", matches: /Signed in as/, role: "status" },        // and the UI reflects it
  ],
});
if (tr.replay.verdict !== "landed") process.exit(1);   // auth is broken — fail the PR
```

"I implemented it, tests pass" is the untrusted channel. The verdict is whether the server actually knows you're authenticated. Wired into the same `truefact assert` gate, a coding agent can't merge a feature that only works in its own description.

> Scope: TrueFact checks what a browser reaches — the running app, its pages, its network. Not your unit tests or your build; the thing your users actually touch.

## Precision, when a write matters

Auto verdicts need no setup. For the writes you can't get wrong, declare what "landed" means. Pass data, never a callback:

```ts
await tr.act("click 'Place order'", {
  expect: [
    { kind: "text", matches: /Order #\d+/, role: "status" },   // confirmation under a status role
    { kind: "element", selector: "#pay", absent: true },        // the pay button is gone
    { kind: "probe", get: "/api/orders/latest", text: /"placed":true/ }, // ask the server itself
  ],
});
```

`probe` is the out-of-band check for optimistic UI that a page read can't beat. TrueFact GETs a status endpoint itself and matches real server state. A broken or unreachable endpoint reads `inconclusive`, never a false alarm.

## Prove the record wasn't touched

```bash
truefact verify run.jsonl     # recomputes the hash chain, exits 1 at the first break
```

Every step commits to the one before it, including what the agent claimed. Alter a field, drop a step, or reorder two, and verification fails at that point.

## Bring your own browser

Already launch Chrome yourself? Wrap the Stagehand instance directly. Network verification is then opt-in, since you own the launch:

```ts
import { withTrueFact } from "truefact";
const tr = withTrueFact(stagehand, { network: { port } }); // port = your Chrome's --remote-debugging-port
```

Driving with **Playwright** instead of Stagehand? Pass a `playwrightDriver`. Same verdict engine, no code change to how it reads the page:

```ts
import { withTrueFact, playwrightDriver } from "truefact";
const tr = withTrueFact(playwrightDriver(page)); // page = a Playwright Page
await tr.page.goto(url);
await tr.act({ selector: "#submit", method: "click" }); // verified: did it actually land?
```

A Playwright action carries no self-report, so there's no claim to disbelieve. You still get the independent "did it land" read. It catches did-not-land, optimistic UI, and obstruction. The page tree is read over CDP. The classifier is byte-for-byte the same one Stagehand runs through.

## Watch any framework (no wrapping)

Not using Stagehand or Playwright? Run your agent (Browser-Use, Puppeteer, a human) against a Chrome started with `--remote-debugging-port=9222`, then:

```bash
truefact watch --port 9222 [--api-origins api.yoursite.com] [--body-errors] [--jsonl run.jsonl]
```

`watch` attaches out-of-band. Per write request, it reports whether the **server** accepted it. A clean 2xx reads `landed`. A 5xx, a 4xx on a write, or a wire failure reads `did-not-land`. With `--body-errors`, so does a 200 whose body says it failed. This is the **network-truth floor**. It verifies writes that hit the network, scoped to your page origin plus any `--api-origins`. Retry-collapse means a transient error that then succeeds never accuses.

Observe mode has no wrapped action to bracket. So it stays conservative, to protect the zero-false-halt record. Two same-origin background patterns are excluded by default. One is a 401 or 403 auth probe. The other is a beacon the browser canceled after the server already accepted it. It does not yet render the DOM-based verdict the wrapper does. See [docs/WATCH-PLAN.md](docs/WATCH-PLAN.md). `--jsonl` writes the same tamper-evident chain that `view`, `verify`, and `fleet` consume.

## Bracket a browser you drive yourself

`watch` is the passive network floor. `serve` is the full verdict for a browser TrueFact didn't launch — a Python Playwright bridge, Puppeteer, anything that can start Chrome with `--remote-debugging-port`. Send `before`, do the action, send `after`, get the Step. Protocol in [docs/SERVE.md](docs/SERVE.md).

```bash
truefact serve --port 9222 --jsonl run.jsonl
```

## What gets stored

The record holds verdicts, the a11y-tree diff, form field values, URLs, and the agent's claim. It never holds cookies, request headers, or response bodies. Those aren't captured at all. Password values are masked at capture. API keys, tokens, and emails are scrubbed from every stored string before a step is written or hashed. For PII that isn't secret-shaped, like a name or an SSN, name the fields and their values are length-masked:

```ts
const tr = withTrueFact(stagehand, { redactFields: ["ssn", /card/] }); // values gone, keys kept
```

## Does it cry wolf?

A verifier that halts a good run is worse than useless. This is the number TrueFact protects first. Across a 520-write benchmark spanning four models weak to strong, it raised **zero false halts (0/279)**. The verdict reads the page, so it's the same whoever drives. In pure observe mode, `truefact watch` held the same line: **zero false halts across 20 live sites** (docs/EXPERIMENT-SITES.md run #4), background telemetry and all. The harder axis is recall, catching every lie a page tells, and that number is still being measured. The network floor and `probe` are the out-of-band checks aimed at the worst case: a page that shows success over a write that failed. Full method and numbers: [docs/BUSINESS.md](docs/BUSINESS.md), [bench/out/report.md](bench/out/report.md).

## The rule

TrueFact never trusts the agent. It reads the page and the network. The agent's claim is recorded on a separate channel and compared only at the end. If those channels touch during measurement, the number is worthless. So they don't.

## What it works with

Two reads, two reaches. **Network truth** — the 500 behind a green checkmark — comes from a CDP client attached to the Chrome the agent drives. It is framework-agnostic: anything on a real Chrome with a debug port gets it. **Page truth** — a click that hit an overlay, a form that silently rejected — needs an in-process page handle, so it is per-driver.

| Framework | Network verdict | Page/DOM verdict | Disbelieves the agent's claim |
|---|---|---|---|
| **Stagehand 4.x** | ✅ | ✅ a11y tree | ✅ Stagehand reports a self-claim to check |
| **Playwright** | ✅ | ✅ CDP `getFullAXTree` | — a Playwright `act` is your own call, so there is no claim to contradict |
| **Browser-Use, Puppeteer, a human** | ✅ via `truefact watch` | — | — |

```ts
import { withTrueFact, playwrightDriver } from "truefact";
const tr = withTrueFact(playwrightDriver(page), { network: { port } }); // your Playwright page, verified
```

The verdict engine reads through one uniform page seam, so a new driver plugs in behind it without touching the classifier. Network verification attaches to Chrome directly over CDP. The test suite is hermetic, runs real Chrome, and uses no LLM. Roadmap: [docs/SPEC-V2.md](docs/SPEC-V2.md).

## License

MIT
