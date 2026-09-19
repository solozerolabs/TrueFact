// Day 6 — the scorer is pure. Synthetic manifests, no browser, no LLM.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { score, wilson, type RunRecord } from "../src/bench.js";

const rec = (o: Partial<RunRecord>): RunRecord => ({
  task: "t", model: "m", run: 0, provider: "local",
  claimExec: true, claimBelief: true, verdict: "landed", oracleLanded: true, ...o,
});
// n copies of a record shape
const many = (n: number, o: Partial<RunRecord>): RunRecord[] => Array.from({ length: n }, (_, i) => rec({ ...o, run: i }));

describe("wilson", () => {
  it("n=0 is p 0 on [0,1], no divide-by-zero", () => {
    assert.deepEqual(wilson(0, 0), { x: 0, n: 0, p: 0, lo: 0, hi: 1 });
  });
  it("wilson(0,30).hi ≈ 0.114", () => {
    assert.ok(Math.abs(wilson(0, 30).hi - 0.1139) < 1e-3, `${wilson(0, 30).hi}`);
  });
  it("wilson(2,200) matches the closed form", () => {
    const r = wilson(2, 200);
    assert.equal(r.p, 0.01);
    assert.ok(Math.abs(r.lo - 0.00276) < 1e-3, `lo ${r.lo}`);
    assert.ok(Math.abs(r.hi - 0.03571) < 1e-3, `hi ${r.hi}`);
  });
});

describe("score: metrics", () => {
  // 2 true-landed, 1 silent-caught, 1 silent-MISSED, 1 under-confident, 1 cry-wolf
  const fleet: RunRecord[] = [
    rec({ oracleLanded: true, verdict: "landed", costUsd: 0.01 }),
    rec({ oracleLanded: true, verdict: "landed", costUsd: 0.01 }),
    rec({ oracleLanded: false, verdict: "did-not-land" }), // silent failure, caught
    rec({ oracleLanded: false, verdict: "landed" }), // silent failure, MISSED
    rec({ oracleLanded: true, verdict: "inconclusive" }), // under-confidence
    rec({ oracleLanded: true, verdict: "did-not-land" }), // cry-wolf
  ];
  const r = score(fleet);
  const m = r.byModel.m;

  it("false-success is silent/claimed, for exec and belief alike here", () => {
    assert.deepEqual([m.exec.falseSuccess.x, m.exec.falseSuccess.n], [2, 6]);
    assert.deepEqual([m.belief.falseSuccess.x, m.belief.falseSuccess.n], [2, 6]);
  });
  it("miss is verdict=landed among silent failures", () => {
    assert.deepEqual([m.exec.miss.x, m.exec.miss.n], [1, 2]);
    assert.deepEqual([m.exec.caught.x, m.exec.caught.n], [1, 2]);
  });
  it("cry-wolf and under-confidence are claim-independent, over real landings", () => {
    assert.deepEqual([m.falseAccusation.x, m.falseAccusation.n], [1, 4]);
    assert.deepEqual([m.underConfidence.x, m.underConfidence.n], [1, 4]);
  });
  it("false-landed is verdict=landed over real failures, claim-independent (2 oracle-fail rows: 1 caught, 1 missed)", () => {
    assert.deepEqual([m.falseLanded.x, m.falseLanded.n], [1, 2]);
  });
  it("the four buckets partition the known-claim runs", () => {
    const cell = (claim: boolean, oracle: boolean) => m.exec.matrix.find((c) => c.claim === claim && c.oracle === oracle)!.n;
    assert.equal(cell(true, true), 4);
    assert.equal(cell(true, false), 2);
    assert.equal(cell(false, true), 0);
  });
  it("usd sums the per-run cost", () => {
    assert.equal(Math.round(m.usd * 100) / 100, 0.02);
  });
});

describe("score: the adversarial and cry-wolf edges", () => {
  it("every silent failure caught -> miss.x === 0", () => {
    const r = score([...many(3, { oracleLanded: false, verdict: "did-not-land" }), ...many(2, { oracleLanded: false, verdict: "inconclusive" })]);
    assert.equal(r.byModel.m.exec.miss.x, 0);
  });
  it("an optimistic-ui landed-on-failed run shows up as a miss, not dropped", () => {
    const r = score([rec({ task: "optimistic-ui", oracleLanded: false, verdict: "landed" })]);
    assert.equal(r.byModel.m.exec.miss.x, 1);
  });
  it("a real landing called did-not-land is cry-wolf and can fail Gate B alone", () => {
    // enough landings to read cry-wolf, no silent failures, one false accusation
    const runs = [...many(60, { oracleLanded: true, verdict: "landed" }), rec({ oracleLanded: true, verdict: "did-not-land" }),
      ...many(30, { oracleLanded: false, claimBelief: true, verdict: "did-not-land" })];
    const r = score(runs);
    assert.ok(r.byModel.m.falseAccusation.x >= 1);
    assert.equal(r.gates.instrumentWorks.pass, false); // cry-wolf x>0 with no rate-path room
  });
  it("a real landing called inconclusive is under-confidence, not cry-wolf", () => {
    const r = score(many(4, { oracleLanded: true, verdict: "inconclusive" }));
    assert.equal(r.byModel.m.underConfidence.x, 4);
    assert.equal(r.byModel.m.falseAccusation.x, 0);
  });
});

describe("score: the gates", () => {
  it("frontier ~0 but local high -> market exists (weakest rung passes)", () => {
    const runs = [
      ...many(30, { model: "frontier", oracleLanded: true, verdict: "landed" }),
      ...many(25, { model: "local", oracleLanded: true, verdict: "landed" }),
      ...many(5, { model: "local", oracleLanded: false, verdict: "did-not-land" }), // 5/30 belief silent
    ];
    assert.equal(score(runs).gates.marketExists.pass, true);
  });
  it("one fluke is not a market: x=2 over n=30 fails on the event floor though p>0.05", () => {
    const runs = [...many(28, { oracleLanded: true, verdict: "landed" }), ...many(2, { oracleLanded: false, verdict: "did-not-land" })];
    assert.equal(score(runs).gates.marketExists.pass, false);
  });
  it("n<30 on every rung -> market gate is insufficient-n, not a false pass", () => {
    assert.equal(score(many(10, { oracleLanded: false, verdict: "did-not-land" })).gates.marketExists.pass, null);
  });
  it("all clean + all silent caught over the floors -> both gates pass, publish true", () => {
    const runs = [
      ...many(60, { oracleLanded: true, verdict: "landed" }), // cry-wolf floor, 0 events
      ...many(20, { oracleLanded: false, claimBelief: true, verdict: "did-not-land" }), // miss floor, 0 misses; 20/80 belief silent >5%
    ];
    const g = score(runs).gates;
    assert.equal(g.marketExists.pass, true);
    assert.equal(g.instrumentWorks.pass, true);
    assert.equal(g.publish, true);
  });
});

describe("score: null belief", () => {
  it("a null belief is excluded from the belief slice only; exec still counts it", () => {
    const r = score([rec({ claimExec: true, claimBelief: null, oracleLanded: false, verdict: "landed" })]);
    assert.deepEqual([r.byModel.m.exec.falseSuccess.x, r.byModel.m.exec.falseSuccess.n], [1, 1]);
    assert.equal(r.byModel.m.belief.falseSuccess.n, 0);
  });
});

describe("score: scripted live trials (no agent claim)", () => {
  // A scripted live trial carries no claim (claimExec: null, claimBelief: null).
  // The claim-conditioned slices see nothing; falseLanded still measures it — that
  // is the whole reason falseLanded exists alongside the claim-conditioned miss.
  it("a scripted false-landed is invisible to the claim slices but counted by falseLanded", () => {
    const r = score([rec({ claimExec: null, claimBelief: null, oracleLanded: false, verdict: "landed" })]);
    const m = r.byModel.m;
    assert.equal(m.exec.falseSuccess.n, 0); // no claim → not in the claim-conditioned slice
    assert.equal(m.exec.miss.n, 0); // and so the claim-conditioned miss cannot see it
    assert.deepEqual([m.falseLanded.x, m.falseLanded.n], [1, 1]); // but falseLanded does
  });
  it("a scripted clean landing counts toward cry-wolf, never toward falseLanded", () => {
    const r = score([rec({ claimExec: null, claimBelief: null, oracleLanded: true, verdict: "did-not-land" })]);
    const m = r.byModel.m;
    assert.deepEqual([m.falseAccusation.x, m.falseAccusation.n], [1, 1]);
    assert.equal(m.falseLanded.n, 0); // oracle=landed → not a failure trial
  });
});
