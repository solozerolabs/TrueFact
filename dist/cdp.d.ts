import { Socket } from "node:net";
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
/**
 * A CdpConn whose transport is an inherited duplex socket (fd), NOT a TCP debug
 * port. The peer on the other end (Syndai's Python bridge) pumps each command
 * into Playwright's OWN in-process CDP session and streams events back, so the
 * browser needs no --remote-debugging-port — nothing a same-UID sandbox process
 * could reach. Newline-delimited JSON: we send {i,m,p}; the peer replies {i,r}
 * (or {i,x:error}) and pushes events as {e:method,p}. Best-effort like
 * cdpConnect: a transport error resolves the command to undefined, never throws,
 * so an infra hiccup skips a read rather than fabricating or crashing a verdict.
 */
export declare function cdpConnectFd(fd: number): CdpConn;
/** cdpConnectFd's transport over an already-connected duplex socket (the seam a
 *  test can drive with a plain socket pair; production wraps an inherited fd). */
export declare function cdpConnectSocket(sock: Socket): CdpConn;
