// M6 — the fleet number and the CI gate. Both are pure rollups over recorded
// runs (the jsonl a run leaves behind); no new runtime API, no dashboard. The
// number is the TRUE landed rate — from verdicts, never from what the agents
// claimed. See docs/SPEC-V2.md §7.
import { rollup } from "./index.js";
import type { Step } from "./index.js";
import type { Verdict } from "./postcondition.js";

export interface RunSummary {
  file?: string;
  verdict: Verdict; // the run's write-step roll-up
  writes: number;
}

export interface FleetSummary {
  runs: number;
  landed: number;
  didNotLand: number;
  inconclusive: number;
  landedRate: number; // landed / runs
  didNotLandRate: number; // did-not-land / runs
  needReview: RunSummary[]; // every run whose verdict is not "landed"
}

/** One run's write steps → one verdict + a write count. */
export function summarizeRun(steps: Step[], file?: string): RunSummary {
  return { file, verdict: rollup(steps), writes: steps.filter((s) => s.kind === "write").length };
}

/** Aggregate run verdicts into the fleet number. Pure. */
export function rollupRuns(runs: RunSummary[]): FleetSummary {
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
