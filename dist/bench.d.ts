import type { Verdict } from "./postcondition.js";
export interface RunRecord {
    task: string;
    model: string;
    run: number;
    provider: "local" | "browserbase";
    claimExec: boolean;
    claimBelief: boolean | null;
    verdict: Verdict;
    reason?: string;
    oracleLanded: boolean;
    costUsd?: number;
}
export interface Rate {
    x: number;
    n: number;
    p: number;
    lo: number;
    hi: number;
}
export interface Slice {
    falseSuccess: Rate;
    miss: Rate;
    caught: Rate;
    matrix: {
        claim: boolean;
        oracle: boolean;
        n: number;
    }[];
}
export type Gate = {
    pass: boolean;
    detail: string;
} | {
    pass: null;
    detail: "insufficient-n";
};
export interface ModelReport {
    exec: Slice;
    belief: Slice;
    falseAccusation: Rate;
    underConfidence: Rate;
    usd: number;
    n: number;
}
export interface BenchReport {
    byModel: Record<string, ModelReport>;
    overall: Omit<ModelReport, "usd" | "n"> & {
        usd: number;
        n: number;
    };
    gates: {
        marketExists: Gate;
        instrumentWorks: Gate;
        publish: boolean;
    };
}
export interface Thresholds {
    marketMinRate: number;
    marketMinEvents: number;
    marketMinN: number;
    missMaxRate: number;
    missZeroN: number;
    missRateN: number;
    cryWolfMaxRate: number;
    cryWolfZeroN: number;
    cryWolfRateN: number;
}
export declare const DEFAULT_THRESHOLDS: Thresholds;
/** Wilson score interval for a binomial proportion. Chosen over the normal
 *  approximation because the rates sit near 0 and n is small; n===0 is p 0 on
 *  [0,1] with no divide-by-zero. */
export declare function wilson(x: number, n: number, z?: number): Rate;
export declare function score(runs: RunRecord[], opts?: {
    z?: number;
    thresholds?: Partial<Thresholds>;
}): BenchReport;
