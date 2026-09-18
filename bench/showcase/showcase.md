# TrueReplay showcase — the optimistic-UI catch

Model: **anthropic/claude-haiku-4-5** · n=10/task · network sidecar **ON** · 2026-09-18
Unlike [bench/out/report.md](../out/report.md) (the 520-run ladder, run before the
network sidecar existed), this run has it on. Ground truth is the server oracle,
read out of band; the wrapped agent never sees it.

## The trap: `optimistic-ui` — page shows "✅ Order placed", server returned 500

The server records the order as **NOT placed** on every run. What each channel said:

| channel | verdict | correct? |
|---|---|---|
| The agent's own claim | success 10/10 (100%) of runs | ✗ wrong |
| TrueReplay, page read alone | `landed` 10/10 (100%) | ✗ fooled by the ✅ |
| **TrueReplay + network** | **`did-not-land`** 10/10 (100%) | ✓ **caught** |

The agent believed it, and the page *looked* right — the network channel is what
tells the truth apart from the banner.

## The guard: does it cry wolf?

The hard-clean set (`masked-phone`, `blur-validate`, `modal-cookie`) are genuine
successes whose shape tempts a false halt. Across 30 genuine successes:

- **false halts (cry-wolf): 0/30 (0%)** — none. The catch is not trigger-happiness.

## See one

```bash
truereplay view bench/showcase/optimistic-ui__1.jsonl
```

Opens on the step that didn't land: the page diff with the ✅ banner, the 500 in
the network panel, and — boxed off as the untrusted channel — the agent's
"success". One run is the whole pitch.
