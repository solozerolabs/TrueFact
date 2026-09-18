// A minimal raw-CDP client over a WebSocket, shared by the network sidecar
// (wrapped mode) and `truefact watch` (observe mode). Both attach to a Chrome
// they did not launch, by its --remote-debugging-port. Stdlib only: Node's
// global WebSocket + fetch to the browser's /json target list. No dependency,
// no Playwright — a second CDP client that reads the world out-of-band.
//
// Scope: a single page target with a flat subscription (enough for same-origin
// and cross-origin-API-subdomain writes — see docs/WATCH-PLAN.md §2). Popups and
// cross-origin iframes need Target.setAutoAttach{flatten} + sessionId routing;
// deferred to v2.
/**
 * Open a CDP client to the page target of the Chrome listening on `port`.
 * Best-effort: any failure resolves to null so a caller can skip network
 * verification rather than crash — an infra hiccup must never fabricate a verdict.
 */
export async function cdpConnect(port) {
    try {
        const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()));
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (!page?.webSocketDebuggerUrl)
            return null;
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.onopen = () => res();
            ws.onerror = () => rej(new Error("cdp ws connect failed"));
        });
        let id = 0;
        const pending = new Map();
        const handlers = new Map();
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
            if (msg.method) {
                const hs = handlers.get(msg.method);
                if (hs)
                    for (const h of hs)
                        h(msg.params ?? {});
            }
        };
        return {
            cmd: (method, params) => new Promise((resolve) => {
                const cid = ++id;
                pending.set(cid, resolve);
                ws.send(JSON.stringify({ id: cid, method, params }));
            }),
            on: (method, handler) => {
                const hs = handlers.get(method) ?? [];
                hs.push(handler);
                handlers.set(method, hs);
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
