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
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
// A command that never gets a reply (the browser crashed, the tab closed, the
// peer went away) resolves to undefined after this, so a verdict read fails
// open (skipped) instead of hanging the whole run forever.
const CMD_TIMEOUT_MS = 10000;
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
                pending.get(msg.id)(msg.result); // an {id,error} reply has no result → undefined
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
        // On close/error, settle every in-flight command to undefined — nothing must
        // wait forever on a dead socket. Each resolver clears its own timeout.
        const drain = () => {
            for (const fn of pending.values())
                fn(undefined);
            pending.clear();
        };
        ws.onclose = drain;
        return {
            cmd: (method, params) => new Promise((resolve) => {
                const cid = ++id;
                if (ws.readyState !== 1 /* OPEN */)
                    return resolve(undefined);
                const timer = setTimeout(() => { if (pending.delete(cid))
                    resolve(undefined); }, CMD_TIMEOUT_MS);
                pending.set(cid, (result) => { clearTimeout(timer); resolve(result); });
                try {
                    ws.send(JSON.stringify({ id: cid, method, params }));
                }
                catch {
                    if (pending.delete(cid)) {
                        clearTimeout(timer);
                        resolve(undefined);
                    }
                }
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
export function cdpConnectFd(fd) {
    return cdpConnectSocket(new Socket({ fd }));
}
/** cdpConnectFd's transport over an already-connected duplex socket (the seam a
 *  test can drive with a plain socket pair; production wraps an inherited fd). */
export function cdpConnectSocket(sock) {
    let buf = "";
    let id = 0;
    const decoder = new StringDecoder("utf8"); // holds a split multibyte char across chunks
    const pending = new Map();
    const handlers = new Map();
    sock.on("data", (d) => {
        buf += decoder.write(d);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof msg.i === "number" && pending.has(msg.i)) {
                // an {x} error resolves to undefined (best-effort, never rejects)
                pending.get(msg.i)(msg.x !== undefined ? undefined : msg.r);
                pending.delete(msg.i);
            }
            else if (typeof msg.e === "string") {
                const hs = handlers.get(msg.e);
                if (hs)
                    for (const h of hs)
                        h(msg.p ?? {});
            }
        }
    });
    // Peer gone (crash / socket closed): settle every in-flight command to
    // undefined so a read fails open instead of hanging forever.
    const drain = () => {
        for (const fn of pending.values())
            fn(undefined);
        pending.clear();
    };
    sock.on("error", drain);
    sock.on("close", drain);
    return {
        cmd: (method, params) => new Promise((resolve) => {
            const cid = ++id;
            if (sock.destroyed)
                return resolve(undefined);
            const timer = setTimeout(() => { if (pending.delete(cid))
                resolve(undefined); }, CMD_TIMEOUT_MS);
            pending.set(cid, (result) => { clearTimeout(timer); resolve(result); });
            try {
                sock.write(JSON.stringify({ i: cid, m: method, p: params ?? {} }) + "\n");
            }
            catch {
                if (pending.delete(cid)) {
                    clearTimeout(timer);
                    resolve(undefined);
                }
            }
        }),
        on: (method, handler) => {
            const hs = handlers.get(method) ?? [];
            hs.push(handler);
            handlers.set(method, hs);
        },
        close: () => {
            try {
                sock.destroy();
            }
            catch {
                /* already gone */
            }
        },
    };
}
