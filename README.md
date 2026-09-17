# TrueReplay

Replay what your browser agent actually did — and get an independent verdict on whether each write **landed / did-not-land / inconclusive**, computed by reading the live page, not by trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Proven on a real agent:** a local model driving Stagehand clicked "Place order" onto a cookie overlay, Stagehand reported `success: true`, the order was never placed, and TrueReplay independently said `did-not-land`. See [docs/FINDINGS.md](docs/FINDINGS.md) and [docs/PROBES.md](docs/PROBES.md).

> **Status: Days 1–6 of a 7-day MVP built.** Session-state detection ([docs/DAY2.md](docs/DAY2.md)), the auto-inferred postcondition ([docs/DAY3.md](docs/DAY3.md)), declared postconditions ([docs/DAY4.md](docs/DAY4.md)), extract grounding ([docs/DAY5.md](docs/DAY5.md)) and the benchmark harness ([docs/DAY6.md](docs/DAY6.md)) ship with 142 hermetic tests (~12 s, real Chrome, no LLM). Day 7 (final day) specced ([docs/DAY7.md](docs/DAY7.md)). Roadmap in [SPEC.md](SPEC.md).

## Benchmark

One local model (Qwen3-27B via oMLX) driving Stagehand across 13 fixtures × 10 runs = **130 writes**, oracle = server-recorded POST, no LLM in the scorer, $0.

| local model, _n_ = 130 | Rate (95% CI) |
|---|---|
| Agent reported success, write never landed (exec) | 46% (60/130) |
| — TrueReplay caught it (`did-not-land`) | 83% (50/60) |
| — residual miss | 17% [9–28] (10/60) |
| **Cry-wolf — `did-not-land` on a write that _did_ land (false halt)** | **0% [0–5.2] (0/70)** — certified |
| Under-confidence — landed but parked `inconclusive` (review, not halt) | 14% (10/70) |

Pre-registered gates: **market exists = true** (the weak model shows a real 14% belief-level false-success rate); **instrument works = null — insufficient-n** (only 10 belief-level silent failures; ≥20 needed); **PUBLISH = false**. What _is_ certified is the false-halt rate — cry-wolf 0 over ≥60 real landings, so the three hard shapes (masked input, stray validation, non-covering modal) held at scale ([test/bench-fixtures.test.ts](test/bench-fixtures.test.ts)). The headline write-side number and full instrument certification need the cloud weak→strong ladder. Ceiling, as predicted: optimistic-UI pages that lie to their user also fool the page reader — belief-level miss is 100% (10/10). Full report: [bench/out/report.md](bench/out/report.md); method in [docs/DAY6.md](docs/DAY6.md); product read in [docs/BUSINESS.md](docs/BUSINESS.md).

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
