// A minimal raw-CDP client over a WebSocket, shared by the network sidecar
// (wrapped mode) and `truefact watch` (observe mode). Both attach to a Chrome
// they did not launch, by its --remote-debugging-port. Stdlib only: Node's
// global WebSocket + fetch to the browser's /json target list. No dependency,
// no Playwright — a second CDP client that reads the world out-of-band.
//
// Two connectors: `cdpConnect` binds a single page target (the page reader and
// `watch` — a page target carries the Runtime/Accessibility/Page domains they
// need). `cdpConnectBrowser` binds the browser target with
// Target.setAutoAttach{flatten}, so the sidecar also sees popups (OAuth / 3DS)
// and cross-origin iframes (Stripe) via sessionId-tagged events — the writes a
// single-page reader is blind to. The fd transport below stays single-page.
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

// A command that never gets a reply (the browser crashed, the tab closed, the
// peer went away) resolves to undefined after this, so a verdict read fails
// open (skipped) instead of hanging the whole run forever.
const CMD_TIMEOUT_MS = 10000;

export interface CdpConn {
  /** Send a CDP command and await its result (id-correlated). `sessionId` routes
   *  it to an auto-attached child target (popup / OOPIF); omit for root/page. */
  cmd(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  /** Subscribe to a CDP event method; multiple handlers per method are fine. The
   *  handler also gets the `sessionId` the event came from (undefined = root/page). */
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void;
  close(): void;
}

/**
 * Open a CDP client to the page target of the Chrome listening on `port`.
 * Best-effort: any failure resolves to null so a caller can skip network
 * verification rather than crash — an infra hiccup must never fabricate a verdict.
 */
export async function cdpConnect(port: number): Promise<CdpConn | null> {
  try {
    const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) return null;
    return await openWs(page.webSocketDebuggerUrl);
  } catch {
    return null; // best-effort: no port, no DevTools endpoint, no network verification
  }
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

/**
 * A CDP client on the BROWSER target (not a single page), so it sees the network
 * of popups (OAuth / 3DS windows) and cross-origin iframes (a Stripe checkout) —
 * the writes a single-page reader is blind to. `Target.setAutoAttach{flatten}`
 * routes every child's events over this one socket, tagged with a `sessionId`;
 * `trackWrites` keys on the global requestId, so those child writes verify for
 * free. Best-effort like cdpConnect: any failure resolves to null.
 *
 * Used ONLY by the network sidecar. The page reader and `watch` stay on
 * cdpConnect (a page target has the Runtime/Accessibility/Page domains a browser
 * target lacks). Two probed facts shape this (scripts/probe-multitarget.mjs):
 *   - `Network.enable` is per-session — enabling it on root does nothing for a
 *     child, so each page/iframe session is enabled on attach.
 *   - every attached target MUST be resumed (`runIfWaitingForDebugger`) or a
 *     clicked popup never loads — the observer would break the user's flow.
 */
export async function cdpConnectBrowser(port: number): Promise<CdpConn | null> {
  try {
    const { webSocketDebuggerUrl } = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    if (!webSocketDebuggerUrl) return null;
    const conn = await openWs(webSocketDebuggerUrl);

    let ready: () => void = () => {};
    const firstPageEnabled = new Promise<void>((r) => (ready = r));
    conn.on("Target.attachedToTarget", (p) => {
      const sid = p.sessionId as string;
      const type = (p.targetInfo as { type?: string } | undefined)?.type;
      // Order matters (commands run FIFO per session): enable Network and arm
      // nested auto-attach BEFORE resuming, so a parked child can't load and fire
      // its first request before we're listening.
      if (type === "page" || type === "iframe") {
        void conn.cmd("Network.enable", {}, sid).then(() => type === "page" && ready());
        void conn.cmd("Target.setAutoAttach", AUTO_ATTACH, sid); // nested OOPIFs / grandchild popups
      }
      // Resume EVERY target (all types), or an auto-attached popup stays parked.
      void conn.cmd("Runtime.runIfWaitingForDebugger", {}, sid);
    });
    await conn.cmd("Target.setAutoAttach", AUTO_ATTACH);
    // Don't return until the current page's Network is enabled (else the first
    // write races the enable), bounded so a pathological browser can't hang.
    await Promise.race([firstPageEnabled, new Promise((r) => setTimeout(r, 2000))]);
    return conn;
  } catch {
    return null;
  }
}

/** Open a raw-CDP client over a WebSocket URL (a browser or page target). Shared
 *  by cdpConnect and cdpConnectBrowser; the only difference is the endpoint and
 *  whether the caller sets up auto-attach. */
async function openWs(url: string): Promise<CdpConn> {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("cdp ws connect failed"));
  });

  let id = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const handlers = new Map<string, ((params: Record<string, unknown>, sessionId?: string) => void)[]>();

  ws.onmessage = (m: MessageEvent) => {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(String(m.data));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result); // an {id,error} reply has no result → undefined
      pending.delete(msg.id);
      return;
    }
    if (msg.method) {
      const hs = handlers.get(msg.method);
      if (hs) for (const h of hs) h(msg.params ?? {}, msg.sessionId);
    }
  };
  // On close/error, settle every in-flight command to undefined — nothing must
  // wait forever on a dead socket. Each resolver clears its own timeout.
  const drain = () => {
    for (const fn of pending.values()) fn(undefined);
    pending.clear();
  };
  ws.onclose = drain;

  return {
    cmd: (method, params, sessionId) =>
      new Promise((resolve) => {
        const cid = ++id;
        if (ws.readyState !== 1 /* OPEN */) return resolve(undefined);
        const timer = setTimeout(() => { if (pending.delete(cid)) resolve(undefined); }, CMD_TIMEOUT_MS);
        pending.set(cid, (result) => { clearTimeout(timer); resolve(result); });
        try {
          ws.send(JSON.stringify({ id: cid, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch {
          if (pending.delete(cid)) { clearTimeout(timer); resolve(undefined); }
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
      } catch {
        /* already gone */
      }
    },
  };
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
export function cdpConnectFd(fd: number): CdpConn {
  return cdpConnectSocket(new Socket({ fd }));
}

/** cdpConnectFd's transport over an already-connected duplex socket (the seam a
 *  test can drive with a plain socket pair; production wraps an inherited fd). */
export function cdpConnectSocket(sock: Socket): CdpConn {
  let buf = "";
  let id = 0;
  const decoder = new StringDecoder("utf8"); // holds a split multibyte char across chunks
  const pending = new Map<number, (result: unknown) => void>();
  const handlers = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  sock.on("data", (d: Buffer) => {
    buf += decoder.write(d);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { i?: number; r?: unknown; x?: unknown; e?: string; p?: Record<string, unknown> };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.i === "number" && pending.has(msg.i)) {
        // an {x} error resolves to undefined (best-effort, never rejects)
        pending.get(msg.i)!(msg.x !== undefined ? undefined : msg.r);
        pending.delete(msg.i);
      } else if (typeof msg.e === "string") {
        const hs = handlers.get(msg.e);
        if (hs) for (const h of hs) h(msg.p ?? {});
      }
    }
  });
  // Peer gone (crash / socket closed): settle every in-flight command to
  // undefined so a read fails open instead of hanging forever.
  const drain = () => {
    for (const fn of pending.values()) fn(undefined);
    pending.clear();
  };
  sock.on("error", drain);
  sock.on("close", drain);

  return {
    cmd: (method, params) =>
      new Promise((resolve) => {
        const cid = ++id;
        if (sock.destroyed) return resolve(undefined);
        const timer = setTimeout(() => { if (pending.delete(cid)) resolve(undefined); }, CMD_TIMEOUT_MS);
        pending.set(cid, (result) => { clearTimeout(timer); resolve(result); });
        try {
          sock.write(JSON.stringify({ i: cid, m: method, p: params ?? {} }) + "\n");
        } catch {
          if (pending.delete(cid)) { clearTimeout(timer); resolve(undefined); }
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
      } catch {
        /* already gone */
      }
    },
  };
}
