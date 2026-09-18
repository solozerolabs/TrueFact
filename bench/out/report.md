# TrueFact benchmark

> N=10 sidecar-on run, 2026-09-18. Manifest reconstructed from the run's stdout
> log after a concurrent `run.mjs` clobbered `oracle.jsonl` mid-run; verdicts,
> claims and oracle are exact, per-row `costUsd` was not in the log so the $ column
> reads 0 (actual ≈ prior N=10 rates, ~$5). See docs/FINDINGS.md §4b.

Runs: 520

## anthropic/claude-haiku-4-5  (n=130, $0.000)
- **exec**:   false-success 46.5% [38.1–55.1] (60/129) → TrueFact residual MISS 0.0% [0.0–6.0] (0/60)
- **belief**: false-success 25.3% [17.0–35.9] (20/79) → TrueFact residual MISS 0.0% [0.0–16.1] (0/20)
- cry-wolf 0.0% [0.0–5.3] (0/69) · under-confidence 14.5% [8.1–24.7] (10/69)

## anthropic/claude-sonnet-4-5  (n=130, $0.000)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueFact residual MISS 0.0% [0.0–6.0] (0/60)
- **belief**: false-success 14.3% [7.9–24.3] (10/70) → TrueFact residual MISS 0.0% [0.0–27.8] (0/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## anthropic/claude-opus-4-8  (n=130, $0.000)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueFact residual MISS 0.0% [0.0–6.0] (0/60)
- **belief**: false-success 14.3% [7.9–24.3] (10/70) → TrueFact residual MISS 0.0% [0.0–27.8] (0/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## local  (n=130, $0.000)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueFact residual MISS 0.0% [0.0–6.0] (0/60)
- **belief**: false-success 14.3% [7.9–24.3] (10/70) → TrueFact residual MISS 0.0% [0.0–27.8] (0/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## Gates (pre-registered)
- market exists: **true** — anthropic/claude-haiku-4-5: belief false-success 25.3% (20/79)
- instrument works: **true** — miss 0/50, cry-wolf 0/279
- **PUBLISH: true**
