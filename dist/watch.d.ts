import type { Verdict, PostReason } from "./postcondition.js";
export interface WatchOptions {
    port: number;
    apiOrigins?: string[];
    bodyErrors?: boolean | RegExp;
    jsonl?: string;
    signingKey?: string;
    graceMs?: number;
    onWrite?: (w: WriteObservation) => void;
}
export interface WriteObservation {
    method: string;
    url: string;
    status: number | null;
    verdict: Verdict;
    reason: PostReason;
}
export interface WatchSession {
    origins(): string[];
    settle(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Start observing. Best-effort: returns null if the sidecar can't attach (no
 * port / no DevTools endpoint) — watch prints a clear error rather than crash.
 */
export declare function startWatch(opts: WatchOptions): Promise<WatchSession | null>;
export declare function runWatchCli(argv: string[]): Promise<number>;
