// M2 — the CDP network sidecar. A SECOND, independent CDP client on the same
// Chrome the agent drives, so TrueFact sees the response Stagehand v4 cannot
// (its own channel carries only "console" — see docs/DAY4.md §4). This is the
// out-of-band catch for optimistic UI: page shows ✅ while the POST 500s.
// Verified reachable in scripts/m0-sidecar.mjs. Stdlib only: Node's global
// WebSocket + fetch to the browser's /json target list. No new dependency.
//
// It reads the world, never the agent's claim — so its evidence belongs to the
// verdict channel, like every other page read.
const originOf = (u) => {
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
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isWriteError = (status, method) => status >= 500 || (status >= 400 && status < 500 && MUTATING.has(method.toUpperCase()));
// The 200-that-lies. A non-empty GraphQL `errors` array, or an explicit
// `success:false`. `errors:[]` (empty = success) deliberately does not match.
const DEFAULT_BODY_ERR = /("errors"\s*:\s*\[\s*\{)|("success"\s*:\s*false)/;
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
    try {
        const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()));
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (!page?.webSocketDebuggerUrl)
            return null;
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.onopen = () => res();
            ws.onerror = () => rej(new Error("sidecar ws connect failed"));
        });
        const bodyRe = opts.bodyErrors ? (opts.bodyErrors instanceof RegExp ? opts.bodyErrors : DEFAULT_BODY_ERR) : null;
        // requestId → {url, method}, so responseReceived can class the status by
        // method and a later loadingFailed (which carries neither) can resolve both.
        const reqOf = new Map();
        // mutating requests that returned a clean 2xx — candidates for a body read.
        const bodyCandidates = new Map();
        const events = [];
        // CDP command/response correlation, so getResponseBody can be awaited.
        let id = 0;
        const pending = new Map();
        const cmd = (method, params) => new Promise((resolve) => {
            const cid = ++id;
            pending.set(cid, resolve);
            ws.send(JSON.stringify({ id: cid, method, params }));
        });
        // Body reads in flight, so settle() can wait for them before errorsSince().
        const inflight = new Set();
        const readBody = (requestId, cand) => {
            const pr = (async () => {
                try {
                    const r = (await cmd("Network.getResponseBody", { requestId }));
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
        ws.onmessage = (m) => {
            let msg;
            try {
                msg = JSON.parse(String(m.data));
            }
            catch {
                return;
            }
            if (typeof msg.id === "number" && pending.has(msg.id)) {
                pending.get(msg.id)(msg.result);
                pending.delete(msg.id);
                return;
            }
            const p = msg.params ?? {};
            if (msg.method === "Network.requestWillBeSent") {
                const req = p.request;
                reqOf.set(p.requestId, { url: req?.url ?? "", method: req?.method ?? "GET" });
            }
            else if (msg.method === "Network.responseReceived") {
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
            }
            else if (msg.method === "Network.loadingFinished") {
                const cand = bodyCandidates.get(p.requestId);
                if (cand) {
                    bodyCandidates.delete(p.requestId);
                    readBody(p.requestId, cand); // body ready only after loadingFinished
                }
            }
            else if (msg.method === "Network.loadingFailed") {
                // A request that never got a response. Only a mutating one signals a
                // failed write; a dropped GET (tracker, aborted image) is noise.
                const req = reqOf.get(p.requestId);
                if (req?.url && MUTATING.has(req.method.toUpperCase()))
                    events.push({ url: req.url, status: null });
            }
        };
        ws.send(JSON.stringify({ id: ++id, method: "Network.enable" }));
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
                try {
                    ws.close();
                }
                catch {
                    /* already gone */
                }
            },
        };
    }
    catch {
        return null; // best-effort: no port, no DevTools endpoint, no network verification
    }
}
