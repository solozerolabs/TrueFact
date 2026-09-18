export interface CdpConn {
    /** Send a CDP command and await its result (id-correlated). */
    cmd(method: string, params?: unknown): Promise<unknown>;
    /** Subscribe to a CDP event method; multiple handlers per method are fine. */
    on(method: string, handler: (params: Record<string, unknown>) => void): void;
    close(): void;
}
/**
 * Open a CDP client to the page target of the Chrome listening on `port`.
 * Best-effort: any failure resolves to null so a caller can skip network
 * verification rather than crash — an infra hiccup must never fabricate a verdict.
 */
export declare function cdpConnect(port: number): Promise<CdpConn | null>;
