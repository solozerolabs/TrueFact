# TrueReplay benchmark

Runs: 520

## anthropic/claude-haiku-4-5  (n=130, $0.209)
- **exec**:   false-success 46.5% [38.1–55.1] (60/129) → TrueReplay residual MISS 16.7% [9.3–28.0] (10/60)
- **belief**: false-success 26.3% [17.9–36.8] (21/80) → TrueReplay residual MISS 47.6% [28.3–67.6] (10/21)
- cry-wolf 0.0% [0.0–5.3] (0/69) · under-confidence 14.5% [8.1–24.7] (10/69)

## anthropic/claude-sonnet-4-5  (n=130, $0.621)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueReplay residual MISS 16.7% [9.3–28.0] (10/60)
- **belief**: false-success 14.3% [7.9–24.3] (10/70) → TrueReplay residual MISS 90.0% [59.6–98.2] (9/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## anthropic/claude-opus-4-8  (n=130, $4.082)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueReplay residual MISS 16.7% [9.3–28.0] (10/60)
- **belief**: false-success 14.7% [8.2–25.0] (10/68) → TrueReplay residual MISS 100.0% [72.2–100.0] (10/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## local  (n=130, $0.000)
- **exec**:   false-success 46.2% [37.8–54.7] (60/130) → TrueReplay residual MISS 16.7% [9.3–28.0] (10/60)
- **belief**: false-success 14.3% [7.9–24.3] (10/70) → TrueReplay residual MISS 100.0% [72.2–100.0] (10/10)
- cry-wolf 0.0% [0.0–5.2] (0/70) · under-confidence 14.3% [7.9–24.3] (10/70)

## Gates (pre-registered)
- market exists: **true** — anthropic/claude-haiku-4-5: belief false-success 26.3% (21/80)
- instrument works: **false** — miss 39/51, cry-wolf 0/279
- **PUBLISH: false**
