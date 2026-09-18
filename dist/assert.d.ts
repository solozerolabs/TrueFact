import type { Step } from "./index.js";
import type { FormValue, Verdict } from "./postcondition.js";
/** What an assertion sees for one write step. All evidence, never the claim. */
export interface BrowserView {
    action: string;
    url: string;
    verdict: Verdict;
    treeAdded: string[];
    treeRemoved: string[];
    forms: Record<string, FormValue>;
    network: {
        url: string;
        status: number | null;
    }[];
}
export interface AssertResult {
    ok: boolean;
    message?: string;
}
export declare const pass: () => AssertResult;
export declare const fail: (message: string) => AssertResult;
export type BrowserAssertion = (v: BrowserView) => AssertResult;
export interface Assertions {
    browser?: BrowserAssertion;
}
/** Identity helper for types + a default-export a module can carry. */
export declare const defineAssertions: (a: Assertions) => Assertions;
/** A module's default export may be an Assertions object or a bare browser fn. */
export declare function toAssertions(mod: unknown): Assertions;
/** Reconstruct a write step's browser view from its recorded evidence. */
export declare function viewOf(step: Step): BrowserView | null;
export interface ReassertItem {
    index: number;
    action: string;
    ok: boolean;
    message?: string;
}
export interface ReassertReport {
    total: number;
    failed: number;
    items: ReassertItem[];
}
/** Evaluate the assertion against every write step. Pure: no fs, no browser. */
export declare function reassert(steps: Step[], a: Assertions): ReassertReport;
/** Read a `jsonl` run + an assertion module, and reassert. */
export declare function reassertFile(jsonlPath: string, modulePath: string): Promise<ReassertReport>;
