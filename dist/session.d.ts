import type { PageReader } from "./driver.js";
export type Obstruction = "blank" | "captcha" | "login-wall" | "overlay";
export type Confidence = "high" | "heuristic";
export interface SessionEvidence {
    obstruction: Obstruction | null;
    confidence: Confidence;
    detail: string;
    checked: Obstruction[];
}
export interface Fingerprint {
    href: string;
    readyState: string;
    bodyTextLength: number;
    elementCount: number;
    title: string;
}
export interface DetectContext {
    navStatus?: number | null;
    point?: {
        x: number;
        y: number;
    };
}
/** reader.evaluate that returns null instead of throwing (mid-navigation, detached). */
export declare function safeRead<T>(page: PageReader, fn: (arg: unknown) => T, arg?: unknown): Promise<T | null>;
export declare function fingerprint(page: PageReader): Promise<Fingerprint | null>;
export declare function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean;
/**
 * Settle by fingerprinting until two consecutive reads match. Replaces
 * waitForLoadState, which resolves immediately on an already-loaded document
 * and so cannot see a navigation that has not committed yet (docs/DAY2.md §3).
 */
export declare function settle(page: PageReader, budgetMs?: number): Promise<{
    settled: boolean;
    after: Fingerprint | null;
}>;
export declare function detectSession(page: PageReader, ctx?: DetectContext): Promise<SessionEvidence>;
