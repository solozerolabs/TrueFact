// M2 — the CDP network sidecar. A SECOND, independent CDP client on the same
// Chrome the agent drives, so TrueFact sees the response Stagehand v4 cannot
// (its own channel carries only "console" — see docs/DAY4.md §4). This is the
// out-of-band catch for optimistic UI: page shows ✅ while the POST 500s.
// Verified reachable in scripts/m0-sidecar.mjs. Stdlib only (see src/cdp.ts).
//
// It reads the world, never the agent's claim — so its evidence belongs to the
// verdict channel, like every other page read. The raw CDP plumbing lives in
// src/cdp.ts, shared with `truefact watch` (observe mode).
import { cdpConnect } from "./cdp.js";
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
// the common "did-not-land behind an optimistic ✅" that a 5xx-only reader
// misses. A 4xx on a GET is noise (a missing image, a probed 404), so those
// never demote. 5xx stays method-agnostic: a server crash fails any write.
export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isWriteError = (status, method) => status >= 500 || (status >= 400 && status < 500 && MUTATING.has(method.toUpperCase()));
// The 200-that-lies. A non-empty GraphQL `errors` array, or an explicit
// `success:false`. `errors:[]` (empty = success) deliberately does not match.
export const DEFAULT_BODY_ERR = /("errors"\s*:\s*\[\s*\{)|("success"\s*:\s*false)/;
// Resolve the bodyErrors option to a RegExp or null. Shared with watch.
export const bodyErrorPattern = (opt) => opt ? (opt instanceof RegExp ? opt : DEFAULT_BODY_ERR) : null;
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
export async function attachSidecar(port, opts = {}) {
    const conn = await cdpConnect(port);
    if (!conn)
        return null;
    return attachSidecarConn(conn, { ...opts, ownsConn: true }); // owns the conn it just opened
}
/**
 * Same network sidecar, but on a CdpConn the CALLER owns and shares with the
 * page reader — used by `serve` in fd mode, where one CDP channel (proxied into
 * Playwright's in-process session) serves both reads and network events, so
 * there is no second connection and no debug port. `close()` does NOT close a
 * shared conn; the owner (serve) closes it once.
 */
export async function attachSidecarConn(conn, opts = {}) {
    const ownsConn = opts.ownsConn ?? false;
    const bodyRe = bodyErrorPattern(opts.bodyErrors);
    // requestId → {url, method}, so responseReceived can class the status by
    // method and a later loadingFailed (which carries neither) can resolve both.
    const reqOf = new Map();
    // mutating requests that returned a clean 2xx — candidates for a body read.
    const bodyCandidates = new Map();
    const events = [];
    // Body reads in flight, so settle() can wait for them before errorsSince().
    const inflight = new Set();
    const readBody = (requestId, cand) => {
        const pr = (async () => {
            try {
                const r = (await conn.cmd("Network.getResponseBody", { requestId }));
                if (!r?.body)
                    return;
                const text = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
                if (bodyRe.test(text))
                    events.push({ url: cand.url, status: cand.status });
            }
            catch {
                /* body evicted or gone — skip, never fabricate */
            }
        })();
        inflight.add(pr);
        void pr.finally(() => inflight.delete(pr));
    };
    conn.on("Network.requestWillBeSent", (p) => {
        const req = p.request;
        reqOf.set(p.requestId, { url: req?.url ?? "", method: req?.method ?? "GET" });
    });
    conn.on("Network.responseReceived", (p) => {
        const r = p.response;
        const method = reqOf.get(p.requestId)?.method ?? "GET";
        if (r && typeof r.status === "number") {
            if (isWriteError(r.status, method)) {
                events.push({ url: r.url ?? "", status: r.status });
            }
            else if (bodyRe && r.status >= 200 && r.status < 300 && MUTATING.has(method.toUpperCase())) {
                // clean status on a write — the body may still say it failed.
                bodyCandidates.set(p.requestId, { url: r.url ?? "", status: r.status });
            }
        }
    });
    conn.on("Network.loadingFinished", (p) => {
        const cand = bodyCandidates.get(p.requestId);
        if (cand) {
            bodyCandidates.delete(p.requestId);
            readBody(p.requestId, cand); // body ready only after loadingFinished
        }
    });
    conn.on("Network.loadingFailed", (p) => {
        // A request that never got a response. Only a mutating one signals a failed
        // write; a dropped GET (tracker, aborted image) is noise.
        const req = reqOf.get(p.requestId);
        if (req?.url && MUTATING.has(req.method.toUpperCase()))
            events.push({ url: req.url, status: null });
    });
    await conn.cmd("Network.enable");
    return {
        mark: () => events.length,
        settle: async () => {
            await Promise.allSettled([...inflight]);
        },
        errorsSince: (mark, origins) => {
            const ok = new Set(origins.filter(Boolean));
            return ok.size ? events.slice(mark).filter((e) => ok.has(originOf(e.url))) : [];
        },
        close: () => {
            if (ownsConn)
                conn.close();
        },
    };
}
