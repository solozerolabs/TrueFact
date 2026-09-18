# TrueFact

**Your browser agent said it placed the order. The order wasn't placed. You found out from a customer.**

TrueFact wraps your browser agent and, after every action, reads the live page itself — and the network under it — to give an independent verdict: **landed / did-not-land / inconclusive**. It never trusts what the agent claims. The gap between "agent said done" and "the world says done" is the whole product.

- **Silent failures caught.** A click that lands on a cookie overlay, a form that rejected, a page that shows ✅ while the server returned 500 — the agent reports success for all of them. TrueFact doesn't.
- **Not another LLM judge.** The verdict is a deterministic read of the page and the network, not a model grading a model. Sub-second, no extra tokens.
- **A receipt, not a log.** Every step is recorded on a tamper-evident chain you can replay, assert against offline, and verify.

## Quickstart

```bash
npm install github:solozerolabs/TrueReplay   # or: bun add github:solozerolabs/TrueReplay
```

Installs straight from git; the compiled `dist/` is committed, so no build step runs on your machine.

```ts
import { launch } from "truefact";

// Owns the browser so network verification just works — no port to configure.
const tr = await launch({ model: { modelName: "anthropic/claude-sonnet-5", apiKey } });

await tr.page.goto("https://shop.example/checkout");
await tr.act("click 'Place order'");

console.log(tr.replay.verdict);   // "did-not-land"  ← even though the page showed ✅
console.log(tr.replay.steps);     // per-step: verdict, why, evidence, what the agent claimed
await tr.close();
```

That's the whole runtime API: `launch()`, then your agent runs unchanged. Every `act` / `extract` / `goto` becomes a recorded step on a channel separate from anything the agent says.

## See what happened

```bash
truefact view run.jsonl
```

Opens a standalone timeline: every step with its verdict, and for each one the page diff, the network errors, the screenshot, and — boxed off as the untrusted channel — what the agent claimed. It opens on the first step that didn't land. Save a run with `launch({ jsonl: "run.jsonl" })`.

## Gate CI on it

Turn a flaky run into a deterministic test. Write assertions once; re-run them against any recorded run with no browser and no tokens:

```ts
// assertions.mjs — a function over what the world showed, never the agent's claim
export default (v) =>
  v.network.some((n) => (n.status ?? 500) >= 500)
    ? { ok: false, message: "a request failed behind this step" }
    : { ok: true };
```

```bash
truefact assert run.jsonl --with assertions.mjs   # exits 1 if any write step fails
```

## Precision, when a write matters

Auto verdicts need no setup. For the writes you can't get wrong, declare what "landed" means — data, never a callback:

```ts
await tr.act("click 'Place order'", {
  expect: [
    { kind: "text", matches: /Order #\d+/, role: "status" },   // confirmation under a status role
    { kind: "element", selector: "#pay", absent: true },        // the pay button is gone
    { kind: "probe", get: "/api/orders/latest", text: /"placed":true/ }, // ask the server itself
  ],
});
```

`probe` is the out-of-band check for optimistic UI a page read can't beat: TrueFact GETs a status endpoint itself and matches real server state. A broken or unreachable endpoint is `inconclusive`, never a false alarm.

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

Driving with **Playwright** instead of Stagehand? Pass a `playwrightDriver` — same verdict engine, no code change to how it reads the page:

```ts
import { withTrueFact, playwrightDriver } from "truefact";
const tr = withTrueFact(playwrightDriver(page)); // page = a Playwright Page
await tr.page.goto(url);
await tr.act({ selector: "#submit", method: "click" }); // verified: did it actually land?
```

A Playwright action carries no self-report, so there's no claim to disbelieve — you still get the independent "did it land" read (did-not-land detection, optimistic-UI catch, obstruction detection). The page tree is read over CDP; the classifier is byte-for-byte the same one Stagehand runs through.

## What gets stored

The record holds verdicts, the a11y-tree diff, form field values, URLs and the agent's claim — never cookies, request headers or response bodies (they aren't captured at all). Password values are masked at capture; API keys, tokens and emails are scrubbed from every stored string before a step is written or hashed. For PII that isn't secret-shaped — a name, an SSN — name the fields and their values are length-masked:

```ts
const tr = withTrueFact(stagehand, { redactFields: ["ssn", /card/] }); // values gone, keys kept
```

## Does it cry wolf?

A verifier that halts a good run is worse than useless. Across a 520-write benchmark spanning four models weak to strong, TrueFact raised **zero false halts (0/279)** — its verdict reads the page, so it's the same whoever drives. The one thing a page read alone can't catch is a page that lies (optimistic UI); the network sidecar and `probe` are the out-of-band answers to exactly that. Full method and numbers: [docs/BUSINESS.md](docs/BUSINESS.md), [bench/out/report.md](bench/out/report.md).

## The rule

TrueFact never trusts the agent. It reads the page and the network. The agent's claim is recorded on a separate channel and compared only at the end. If those channels touch during measurement, the number is worthless — so they don't.

## Status

Works today with Stagehand 4.x. Playwright and Browser-Use drivers are next: the verdict engine reads through one uniform page seam, so a new driver plugs in behind it without touching the classifier — each driver brings its own read source (Stagehand's a11y tree; Playwright's CDP). Network verification attaches to Chrome directly over CDP. Hermetic test suite, real Chrome, no LLM. Roadmap: [docs/SPEC-V2.md](docs/SPEC-V2.md).

## License

MIT
