export interface NetError {
    url: string;
    status: number | null;
}
export interface Sidecar {
    mark(): number;
    errorsSince(mark: number, origin: string): NetError[];
    close(): void;
}
/**
 * Attach a network-observing sidecar to the Chrome listening on `port`
 * (the browser must have been launched with `localBrowser.launch({ port })`).
 * Best-effort: any failure resolves to null, and network verification is simply
 * skipped — an infra hiccup must never crash a run or fabricate a verdict.
 *
 * ponytail: single page target, flat Network subscription. A write that opens a
 * NEW tab won't be network-observed until we follow Target.attachedToTarget
 * (SPEC-V2 §12 multi-target). The page-read verdict still covers that step.
 */
export declare function attachSidecar(port: number): Promise<Sidecar | null>;
