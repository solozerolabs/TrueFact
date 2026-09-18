export const originOf = (u) => {
    try {
        return new URL(u).origin;
    }
    catch {
        return "";
    }
};
// A write is a mutation. A 4xx on a POST/PUT/PATCH/DELETE means the server
// rejected the write (402 declined, 422 invalid, 429 throttled, 401/403 auth) —
// the common "did-not-land behind an optimistic ✅" a 5xx-only reader misses.
// A 4xx on a GET is noise (a missing image, a probed 404), so those never
// demote. 5xx stays method-agnostic: a server crash fails any write.
export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isWriteError = (status, method) => status >= 500 || (status >= 400 && status < 500 && MUTATING.has(method.toUpperCase()));
// The 200-that-lies. A non-empty GraphQL `errors` array, or an explicit
// `success:false`. `errors:[]` (empty = success) deliberately does not match.
export const DEFAULT_BODY_ERR = /("errors"\s*:\s*\[\s*\{)|("success"\s*:\s*false)/;
// Resolve the bodyErrors option to a RegExp or null.
export const bodyErrorPattern = (opt) => opt ? (opt instanceof RegExp ? opt : DEFAULT_BODY_ERR) : null;
/**
 * Subscribe to `conn` and call `onOutcome` once per terminal mutating request.
 * Best-effort and side-effect-free beyond the subscription: it never throws and
 * never fabricates an outcome (an evicted body just yields no bodyError).
 *
 * The caller owns `Network.enable` (it may need `Page.enable` too) and the
 * connection's lifetime — this only wires handlers.
 */
export function trackWrites(conn, opts) {
    const bodyRe = bodyErrorPattern(opts.bodyErrors);
    // requestId → what we know so far. Deleted the moment its outcome is emitted,
    // so the map never grows without bound over a long-lived watch.
    const reqOf = new Map();
    const inflight = new Set();
    const is2xx = (s) => s >= 200 && s < 300;
    const emit = (id, o) => {
        reqOf.delete(id);
        opts.onOutcome(o);
    };
    const readBodyThen = (id, rec) => {
        reqOf.delete(id); // terminal — a later loadingFailed must not double-emit
        const pr = (async () => {
            let bodyError = false;
            try {
                const r = (await conn.cmd("Network.getResponseBody", { requestId: id }));
                if (r?.body) {
                    const text = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
                    bodyError = bodyRe.test(text);
                }
            }
            catch {
                /* body evicted / owned by another client — never fabricate */
            }
            opts.onOutcome({ url: rec.url, method: rec.method, status: rec.status, bodyError });
        })();
        inflight.add(pr);
        void pr.finally(() => inflight.delete(pr));
    };
    conn.on("Network.requestWillBeSent", (p) => {
        const req = p.request;
        reqOf.set(p.requestId, { url: req?.url ?? "", method: req?.method ?? "GET" });
    });
    conn.on("Network.responseReceived", (p) => {
        const id = p.requestId;
        const rec = reqOf.get(id);
        const r = p.response;
        if (!rec || !r || typeof r.status !== "number")
            return;
        rec.status = r.status;
        // A non-2xx response on a write is terminal (it won't recover on THIS
        // request — a retry is a new request, handled by the consumer's collapse).
        // Emit it now, at the same point the old sidecar did, so a late
        // loadingFinished can't leave a 500 behind an instant optimistic ✅.
        if (MUTATING.has(rec.method.toUpperCase()) && !is2xx(r.status))
            emit(id, { url: rec.url, method: rec.method, status: r.status, bodyError: false });
    });
    conn.on("Network.loadingFinished", (p) => {
        const id = p.requestId;
        const rec = reqOf.get(id); // gone already if it was a non-2xx write (emitted above)
        if (!rec || !MUTATING.has(rec.method.toUpperCase())) {
            reqOf.delete(id);
            return;
        }
        const status = rec.status ?? 0; // a 2xx write (non-2xx already emitted)
        if (bodyRe && is2xx(status))
            return readBodyThen(id, { url: rec.url, method: rec.method, status });
        emit(id, { url: rec.url, method: rec.method, status: rec.status ?? null, bodyError: false });
    });
    conn.on("Network.loadingFailed", (p) => {
        const id = p.requestId;
        const rec = reqOf.get(id); // gone if already emitted (non-2xx write, or finished)
        if (!rec || !MUTATING.has(rec.method.toUpperCase())) {
            reqOf.delete(id);
            return;
        }
        // A loadingFailed AFTER a 2xx response is a canceled/aborted body load
        // (navigation, sendBeacon), not a failure — the server already accepted the
        // write. Real-site cry-wolf: theverge POST /metrics (204) and linkedin POST
        // /li/track (200) fired here when navigation canceled the in-flight beacon.
        // Only a wire failure with NO prior 2xx is a failed write.
        const status = rec.status ?? 0;
        emit(id, { url: rec.url, method: rec.method, status: is2xx(status) ? status : null, bodyError: false });
    });
    return {
        settle: async () => {
            await Promise.allSettled([...inflight]);
        },
    };
}
