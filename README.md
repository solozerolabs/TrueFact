# TrueReplay

Replay what your browser agent actually did — and get an independent verdict on whether each write **landed / did-not-land / inconclusive**, computed by reading the live page, not by trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Status: Days 1–3 of a 7-day MVP built; Day 4 specified.** Session-state detection ([docs/DAY2.md](docs/DAY2.md)) and the auto-inferred postcondition ([docs/DAY3.md](docs/DAY3.md)) ship with 51 hermetic tests. Declared postconditions and nine Day 3 revisions are specified in [docs/DAY4.md](docs/DAY4.md). Roadmap in [SPEC.md](SPEC.md).

## Benchmark

_The headline is a write-side false-success number. It doesn't exist yet — Day 6 produces it. Table lands here when it does._

| Setup | Reported success | Actually landed | **Reported-success / did-not-land** |
|---|---|---|---|
| _pending Day 6_ | — | — | — |

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

Each write step's `evidence.postcondition.reason` says *why* — `confirmation`, `navigated`, `form-cleared`, `field-match` → `landed`; `validation-error`, `no-change` → `did-not-land`; `prompt`, `changed-unclassified`, `hash-only-nav` → `inconclusive`. Session obstructions (login wall, CAPTCHA, cookie overlay) and passwords redacted are folded in automatically. See [docs/DAY3.md](docs/DAY3.md).

## The rule

TrueReplay never trusts the agent. It reads the page. The agent's claim is recorded on a separate channel and compared only at the end. If those two channels touch during measurement, the false-success number is worthless — so they don't.

## License

MIT
