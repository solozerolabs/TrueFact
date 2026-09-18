import type { CdpConn } from "./cdp.js";
export declare const originOf: (u: string) => string;
export declare const MUTATING: Set<string>;
export declare const isWriteError: (status: number, method: string) => boolean;
export declare const DEFAULT_BODY_ERR: RegExp;
export declare const bodyErrorPattern: (opt: boolean | RegExp | undefined) => RegExp | null;
/** One terminal outcome for a mutating request. `status` is the response status
 *  (kept even if the body load was later canceled), or null for a pre-response
 *  wire failure. `bodyError` is a 2xx whose body says it failed. The consumer
 *  decides whether this is a did-not-land. */
export interface WriteOutcome {
    url: string;
    method: string;
    status: number | null;
    bodyError: boolean;
}
export interface WriteTracker {
    /** Await in-flight body reads (so a body-derived outcome has landed). */
    settle(): Promise<void>;
}
/**
 * Subscribe to `conn` and call `onOutcome` once per terminal mutating request.
 * Best-effort and side-effect-free beyond the subscription: it never throws and
 * never fabricates an outcome (an evicted body just yields no bodyError).
 *
 * The caller owns `Network.enable` (it may need `Page.enable` too) and the
 * connection's lifetime — this only wires handlers.
 */
export declare function trackWrites(conn: CdpConn, opts: {
    bodyErrors?: boolean | RegExp;
    onOutcome: (o: WriteOutcome) => void;
}): WriteTracker;
