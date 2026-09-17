# TrueReplay

Replay what your browser agent actually did — and get an independent verdict on whether each write **landed / did-not-land / inconclusive**, computed by reading the live page, not by trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Proven on a real agent:** a local model driving Stagehand clicked "Place order" onto a cookie overlay, Stagehand reported `success: true`, the order was never placed, and TrueReplay independently said `did-not-land`. See [docs/FINDINGS.md](docs/FINDINGS.md) and [docs/PROBES.md](docs/PROBES.md).

> **Status: Days 1–6 of a 7-day MVP built.** Session-state detection ([docs/DAY2.md](docs/DAY2.md)), the auto-inferred postcondition ([docs/DAY3.md](docs/DAY3.md)), declared postconditions ([docs/DAY4.md](docs/DAY4.md)), extract grounding ([docs/DAY5.md](docs/DAY5.md)) and the benchmark harness ([docs/DAY6.md](docs/DAY6.md)) ship with 142 hermetic tests (~12 s, real Chrome, no LLM). Day 7 (final day) specced ([docs/DAY7.md](docs/DAY7.md)). Roadmap in [SPEC.md](SPEC.md).

## Benchmark

First measured pilot — one local model driving Stagehand across the fixture suite, oracle = server-recorded POST, no LLM in the scorer. **Not yet certified:** _n_ is below the pre-registered publish gate, which still reads `PUBLISH: false — insufficient-n`. The headline write-side false-success number is Day 6 proper (_n_ ≥ 200); this pilot is the direction, not the claim.

| Pilot — local model via Stagehand, _n_ = 30 | Rate |
|---|---|
| Agent reported success, write never landed | 60% (18/30) |
| — TrueReplay caught it (`did-not-land`) | 83% (15/18) |
| — residual miss | 17% (3/18) |
| Cry-wolf — `did-not-land` on a write that **did** land (false halt) | 0% (0/12) |

Three hard false-halt shapes — masked input, stray validation, non-covering modal — are closed and regression-tested ([test/bench-fixtures.test.ts](test/bench-fixtures.test.ts)). Full pilot: [bench/out/report.md](bench/out/report.md); method in [docs/DAY6.md](docs/DAY6.md); what it means for the product in [docs/BUSINESS.md](docs/BUSINESS.md).

## Install

```bash
npm install truereplay
```

## Use

Wrap your Stagehand instance (4.x). Your automation runs unchanged; every `act`/`extract`/`observe`/`goto` is recorded as a replay step on a channel separate from what the agent claims.

```ts
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withReplay } from "truereplay";

const browser = await localBrowser.launch();
const stagehand = await Stagehand.create({ browser, model: { modelName: "anthropic/claude-sonnet-5", apiKey } });

const { act, extract, page, replay } = withReplay(stagehand);

await page.goto("https://shop.example/checkout");
await act("click the 'Place order' button");
await extract("get the order total", schema);

console.log(replay.steps);   // per-step: kind, action, verdict, evidence, attempt, agent_claim, timestamp
console.log(replay.verdict); // per-run over write steps: landed | did-not-land | inconclusive
```

Each write step's `evidence.postcondition.reason` says *why* — `confirmation`, `navigated`, `form-cleared`, `field-match` → `landed`; `validation-error`, or `no-change` under a cookie overlay / login wall → `did-not-land`; `prompt`, `changed-unclassified`, `hash-only-nav`, bare `no-change` → `inconclusive`. Session obstructions and password redaction are automatic. See [docs/DAY3.md](docs/DAY3.md).

For the writes that matter, declare what "landed" means — data, never a callback:

```ts
await act("click 'Place order'", {
  expect: [
    { kind: "text", matches: /Order #\d+/, role: "status" },  // a11y-tree line under a status role
    { kind: "element", selector: "#pay", absent: true },       // negations only tighten
  ],
});
await replay.finalize({ expect: { kind: "url", matches: "/thank-you" } }); // run-level; can only demote
```

Unmet → `did-not-land`. Met lifts only the auto default's uncertain outcomes and never overrides a validation error or an obstruction. Vacuous declarations throw before the write. One shared `waitMs` budget (default 5 s), read-only retries. See [docs/DAY4.md](docs/DAY4.md).

## The rule

TrueReplay never trusts the agent. It reads the page. The agent's claim is recorded on a separate channel and compared only at the end. If those two channels touch during measurement, the false-success number is worthless — so they don't.

## License

MIT
