import type { Verdict, Confidence } from "./postcondition.js";
export type GroundingReason = "grounded" | "ungrounded" | "non-grounding" | "nothing-to-ground";
export interface GroundedValue {
    value: string;
    match: "exact" | "normalized" | "absent";
}
export interface Grounding {
    verdict: Verdict;
    reason: GroundingReason;
    confidence: Confidence;
    values: GroundedValue[];
    skipped: number;
    visual?: true;
}
/** Pure: match each groundable leaf of `data` against the a11y tree. `tree` is
 *  the normalized (node-id/indent-stripped) formattedTree lines. */
export declare function groundValues(data: unknown, tree: string[]): Grounding;
