# Landfall

Runtime wrapper for browser-agent write actions. It reads the live page after every step and returns an independent verdict — **landed / did-not-land / inconclusive** — computed without trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Status: Day 1 of a 7-day MVP.** The wrapper skeleton and two-channel logging exist. Verdicts are stubbed (`inconclusive`) until the three checks land — see [SPEC.md](SPEC.md).

## Benchmark

_The headline is a write-side false-success number. It doesn't exist yet — Day 6 produces it. Table lands here when it does._

| Setup | Reported success | Actually landed | **Reported-success / did-not-land** |
|---|---|---|---|
| _pending Day 6_ | — | — | — |

## Install

```bash
npm install landfall
```

## Use

Wrap your Stagehand instance. Your automation runs unchanged; every `act`/`extract` now emits a landfall step on a channel separate from what the agent claims.

```ts
import { Stagehand } from "@browserbasehq/stagehand";
import { withLandfall } from "landfall";

const stagehand = new Stagehand({ env: "LOCAL" });
await stagehand.init();

const { page, landfall } = withLandfall(stagehand.page);

await page.act("click the submit button");
await page.extract({ instruction: "get the order total", schema });

console.log(landfall.steps);   // per-step: action, verdict, evidence, agent_claim, timestamp
console.log(landfall.verdict); // per-run: landed | did-not-land | inconclusive
```

## The rule

Landfall never trusts the agent. It reads the page. The agent's claim is recorded on a separate channel and compared only at the end. If those two channels touch during measurement, the false-success number is worthless — so they don't.

## License

MIT
