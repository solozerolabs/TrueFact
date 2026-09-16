# TrueReplay

Replay what your browser agent actually did — and get an independent verdict on whether each write **landed / did-not-land / inconclusive**, computed by reading the live page, not by trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Status: Day 1 of a 7-day MVP.** The wrapper skeleton and two-channel logging exist. Verdicts are stubbed (`inconclusive`) until the three checks land — see [SPEC.md](SPEC.md).

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

Wrap your Stagehand instance. Your automation runs unchanged; every `act`/`extract` is recorded as a replay step on a channel separate from what the agent claims.

```ts
import { Stagehand } from "@browserbasehq/stagehand";
import { withReplay } from "truereplay";

const stagehand = new Stagehand({ env: "LOCAL" });
await stagehand.init();

const { page, replay } = withReplay(stagehand.page);

await page.act("click the submit button");
await page.extract({ instruction: "get the order total", schema });

console.log(replay.steps);   // per-step: action, verdict, evidence, agent_claim, timestamp
console.log(replay.verdict); // per-run: landed | did-not-land | inconclusive
```

## The rule

TrueReplay never trusts the agent. It reads the page. The agent's claim is recorded on a separate channel and compared only at the end. If those two channels touch during measurement, the false-success number is worthless — so they don't.

## License

MIT
