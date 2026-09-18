# TrueFact

**Your browser agent said it placed the order. The order wasn't placed. You found out from a customer.**

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

## What gets stored

The record holds verdicts, the a11y-tree diff, form field values, URLs, and the agent's claim. It never holds cookies, request headers, or response bodies. Those aren't captured at all. Password values are masked at capture. API keys, tokens, and emails are scrubbed from every stored string before a step is written or hashed. For PII that isn't secret-shaped, like a name or an SSN, name the fields and their values are length-masked:

```ts
const tr = withTrueFact(stagehand, { redactFields: ["ssn", /card/] }); // values gone, keys kept
```

## Does it cry wolf?

A verifier that halts a good run is worse than useless. This is the number TrueFact protects first. Across a 520-write benchmark spanning four models weak to strong, it raised **zero false halts (0/279)**. The verdict reads the page, so it's the same whoever drives. In pure observe mode, `truefact watch` held the same line: **zero false halts across 20 live sites** (docs/EXPERIMENT-SITES.md run #4), background telemetry and all. The harder axis is recall, catching every lie a page tells, and that number is still being measured. The network floor and `probe` are the out-of-band checks aimed at the worst case: a page that shows success over a write that failed. Full method and numbers: [docs/BUSINESS.md](docs/BUSINESS.md), [bench/out/report.md](bench/out/report.md).

## The rule

TrueFact never trusts the agent. It reads the page and the network. The agent's claim is recorded on a separate channel and compared only at the end. If those channels touch during measurement, the number is worthless. So they don't.

## Status

Works today with Stagehand 4.x. Playwright and Browser-Use drivers are next. The verdict engine reads through one uniform page seam, so a new driver plugs in behind it without touching the classifier. Each driver brings its own read source: Stagehand's a11y tree, Playwright's CDP. Network verification attaches to Chrome directly over CDP. The test suite is hermetic, runs real Chrome, and uses no LLM. Roadmap: [docs/SPEC-V2.md](docs/SPEC-V2.md).

## License

MIT
