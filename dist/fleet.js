// M6 — the fleet number and the CI gate. Both are pure rollups over recorded
// runs (the jsonl a run leaves behind); no new runtime API, no dashboard. The
// number is the TRUE landed rate — from verdicts, never from what the agents
// claimed. See docs/SPEC-V2.md §7.
import { rollup } from "./index.js";
/** One run's write steps → one verdict + a write count. */
export function summarizeRun(steps, file) {
    return { file, verdict: rollup(steps), writes: steps.filter((s) => s.kind === "write").length };
}
/** Aggregate run verdicts into the fleet number. Pure. */
export function rollupRuns(runs) {
    const n = runs.length;
    const landed = runs.filter((r) => r.verdict === "landed").length;
    const didNotLand = runs.filter((r) => r.verdict === "did-not-land").length;
    const inconclusive = runs.filter((r) => r.verdict === "inconclusive").length;
    return {
        runs: n,
        landed,
        didNotLand,
        inconclusive,
        landedRate: n ? landed / n : 0,
        didNotLandRate: n ? didNotLand / n : 0,
        needReview: runs.filter((r) => r.verdict !== "landed"),
    };
}
