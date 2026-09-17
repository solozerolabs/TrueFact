# TrueReplay

Replay what your browser agent actually did — and get an independent verdict on whether each write **landed / did-not-land / inconclusive**, computed by reading the live page, not by trusting anything the agent claims.

The gap between "agent said done" and "page says done" is the product.

> **Proven on a real agent:** a local model driving Stagehand clicked "Place order" onto a cookie overlay, Stagehand reported `success: true`, the order was never placed, and TrueReplay independently said `did-not-land`. See [docs/FINDINGS.md](docs/FINDINGS.md) and [docs/PROBES.md](docs/PROBES.md).

> **Status: Days 1–6 of a 7-day MVP built.** Session-state detection ([docs/DAY2.md](docs/DAY2.md)), the auto-inferred postcondition ([docs/DAY3.md](docs/DAY3.md)), declared postconditions ([docs/DAY4.md](docs/DAY4.md)), extract grounding ([docs/DAY5.md](docs/DAY5.md)) and the benchmark harness ([docs/DAY6.md](docs/DAY6.md)) ship with 142 hermetic tests (~12 s, real Chrome, no LLM). Day 7 (final day) specced ([docs/DAY7.md](docs/DAY7.md)). Roadmap in [SPEC.md](SPEC.md).

## Benchmark

Four models — weak → strong — each driving Stagehand across 13 fixtures × 10 runs = **520 writes**, oracle = server-recorded POST, no LLM in the scorer, $4.91 total.

**TrueReplay's verdict is model-independent** (it reads the page, not the agent), so its behavior per trap is the same whoever is driving:

| Trap (write never lands) | TrueReplay verdict, all 4 drivers | |
|---|---|---|
| click-intercepting cookie overlay | `did-not-land` (40/40) | caught |
| captcha / bot-gate | `did-not-land` (40/40) | caught |
| validation-reject | `did-not-land` (40/40) | caught |
| expired session, dead-click no-op | `inconclusive` (40/40) | parked — never claims success |
| **optimistic UI (page shows ✅, server 500s)** | **`landed` (40/40)** | **missed — the page-lie ceiling** |

**The model curve** is how often the *agent itself* is fooled (believes success from the page when the write didn't land), and TrueReplay's catch of those:

| Driver | Agent believed success, but didn't land | TrueReplay caught | Cry-wolf (false halt) |
|---|---|---|---|
| Claude Haiku 4.5 | 26% (21/80) | **11/21** | 0% (0/69) |
| Qwen3-27B (local) | 14% (10/70) | 0/10 | 0% (0/70) |
| Claude Sonnet 4.5 | 14% (10/70) | 1/10 | 0% (0/70) |
| Claude Opus 4.8 | 15% (10/68) | 0/10 | 0% (0/70) |

Read the two tables together: **as the driver strengthens, its residual false-beliefs concentrate into the one case no page-reader can beat.** Haiku is fooled 21 ways and TrueReplay catches the 11 that aren't page-lies; Opus is fooled only 10 times — and all 10 are optimistic-UI, where even Opus believed the order was placed 10/10 times while the server said it failed. Every one of the 40 misses is optimistic-UI; on every other trap TrueReplay is perfect across all four models.

Pre-registered gates: **market exists = true** (Haiku's belief false-success is 26%); **instrument works = false** — but all 39 pooled misses are optimistic-UI, the lying page a page-read can't beat; **cry-wolf 0/279 across every rung** (the false-halt engine holds under a frontier driver); **PUBLISH = false**. The takeaway the ladder proves: the auto page-verdict is near-perfect except against a page that lies — money-critical writes need a declared postcondition or a server signal (the oracle), which is what `expect` provides. Full report: [bench/out/report.md](bench/out/report.md); method in [docs/DAY6.md](docs/DAY6.md); product read in [docs/BUSINESS.md](docs/BUSINESS.md).

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
    // Optimistic UI lies to the page (shows ✅ while the server 500s) and no
    // page read can tell. `probe` is the out-of-band catch: TrueReplay GETs a
    // status endpoint itself and matches real server state.
    { kind: "probe", get: "/api/orders/latest", text: /"placed":true/ },
  ],
});
await replay.finalize({ expect: { kind: "url", matches: "/thank-you" } }); // run-level; can only demote
```

Unmet → `did-not-land`. Met lifts only the auto default's uncertain outcomes and never overrides a validation error or an obstruction. Vacuous declarations throw before the write. One shared `waitMs` budget (default 5 s), read-only retries. The `probe` kind is the only one that catches optimistic UI, which Stagehand cannot observe on the wire — it fetches a caller-declared verification URL out of band (never the agent's claim; a broken or unreachable endpoint → `inconclusive`, never a false halt). See [docs/DAY4.md](docs/DAY4.md).

## The rule

TrueReplay never trusts the agent. It reads the page. The agent's claim is recorded on a separate channel and compared only at the end. If those two channels touch during measurement, the false-success number is worthless — so they don't.

## License

MIT
