import { type CdpConn } from "./cdp.js";
export { originOf, isWriteError, MUTATING, DEFAULT_BODY_ERR, bodyErrorPattern } from "./netwatch.js";
export interface NetError {
    url: string;
    status: number | null;
}
export interface SidecarOptions {
    bodyErrors?: boolean | RegExp;
}
export interface Sidecar {
    /** How many outcomes have been seen so far — the start of an action's window. */
    mark(): number;
    /** Await in-flight body reads so a late 2xx-that-lies has landed before read. */
    settle(): Promise<void>;
    /** Errors on a watched origin since `mark`, after retry-collapse. */
    errorsSince(mark: number, origins: string[]): NetError[];
    close(): void;
}
/**
 * Attach the network reader to the Chrome listening on `port` (launched with
 * `localBrowser.launch({ port })`). Best-effort: any failure resolves to null,
 * and network verification is simply skipped — an infra hiccup must never crash
 * a run or fabricate a verdict.
 */
export declare function attachSidecar(port: number, opts?: SidecarOptions): Promise<Sidecar | null>;
/**
 * Same reader, but on a CdpConn the CALLER owns and shares with the page reader
 * — used by `serve` in fd mode, where one CDP channel serves both reads and
 * network events. `close()` does NOT close a shared conn; the owner closes it.
 */
export declare function attachSidecarConn(conn: CdpConn, opts?: SidecarOptions & {
    ownsConn?: boolean;
}): Promise<Sidecar>;
