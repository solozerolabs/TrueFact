import type { Step } from "./index.js";
import type { Verdict } from "./postcondition.js";
export interface RunSummary {
    file?: string;
    verdict: Verdict;
    writes: number;
}
export interface FleetSummary {
    runs: number;
    landed: number;
    didNotLand: number;
    inconclusive: number;
    landedRate: number;
    didNotLandRate: number;
    needReview: RunSummary[];
}
/** One run's write steps → one verdict + a write count. */
export declare function summarizeRun(steps: Step[], file?: string): RunSummary;
/** Aggregate run verdicts into the fleet number. Pure. */
export declare function rollupRuns(runs: RunSummary[]): FleetSummary;
