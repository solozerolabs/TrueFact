// The wrapped-mode network reader. A second, independent CDP client on the
// Chrome the agent drives sees the response Stagehand v4 cannot: the POST 500
// behind an optimistic ✅. It accumulates one outcome per mutating request (via
// the shared trackWrites), and answers `errorsSince(mark, origins)` for the
// action bracket that just closed. The classification policy lives here; the
// event wiring and the 2xx-then-cancel guard are shared with `watch` in
// netwatch.ts, so the two modes can never drift apart again.
import { cdpConnect } from "./cdp.js";
import { trackWrites, isWriteError, originOf } from "./netwatch.js";
// Re-exported for the modules that imported these from here before netwatch.
export { originOf, isWriteError, MUTATING, DEFAULT_BODY_ERR, bodyErrorPattern } from "./netwatch.js";
/**
 * Attach the network reader to the Chrome listening on `port` (launched with
 * `localBrowser.launch({ port })`). Best-effort: any failure resolves to null,
 * and network verification is simply skipped — an infra hiccup must never crash
 * a run or fabricate a verdict.
 */
export async function attachSidecar(port, opts = {}) {
    const conn = await cdpConnect(port);
    if (!conn)
        return null;
    return attachSidecarConn(conn, { ...opts, ownsConn: true });
}
/**
 * Same reader, but on a CdpConn the CALLER owns and shares with the page reader
 * — used by `serve` in fd mode, where one CDP channel serves both reads and
 * network events. `close()` does NOT close a shared conn; the owner closes it.
 */
export async function attachSidecarConn(conn, opts = {}) {
    const ownsConn = opts.ownsConn ?? false;
    const outcomes = [];
    const tracker = trackWrites(conn, { bodyErrors: opts.bodyErrors, onOutcome: (o) => outcomes.push(o) });
    await conn.cmd("Network.enable");
    const key = (o) => o.method + " " + o.url;
    const isError = (o) => o.bodyError || o.status == null || isWriteError(o.status, o.method);
    return {
        mark: () => outcomes.length,
        settle: () => tracker.settle(),
        errorsSince: (mark, origins) => {
            const ok = new Set(origins.filter(Boolean));
            if (!ok.size)
                return [];
            const since = outcomes.slice(mark).filter((o) => ok.has(originOf(o.url)));
            // Retry-collapse: a later success to the same (method,url) in this window
            // means the write landed (401 -> token refresh -> retry, transient 5xx ->
            // retry). Drop the earlier error so a recovered write never cries wolf.
            const recovered = new Set(since.filter((o) => !isError(o)).map(key));
            return since
                .filter((o) => isError(o) && !recovered.has(key(o)))
                .map((o) => ({ url: o.url, status: o.status }));
        },
        close: () => {
            if (ownsConn)
                conn.close();
        },
    };
}
