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
export async function cdpConnect(port: number): Promise<CdpConn | null> {
  try {
    const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) return null;

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("cdp ws connect failed"));
    });

    let id = 0;
    const pending = new Map<number, (result: unknown) => void>();
    const handlers = new Map<string, ((params: Record<string, unknown>) => void)[]>();

    ws.onmessage = (m: MessageEvent) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result);
        pending.delete(msg.id);
        return;
      }
      if (msg.method) {
        const hs = handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params ?? {});
      }
    };

    return {
      cmd: (method, params) =>
        new Promise((resolve) => {
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
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
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
export function cdpConnectFd(fd: number): CdpConn {
  return cdpConnectSocket(new Socket({ fd }));
}

/** cdpConnectFd's transport over an already-connected duplex socket (the seam a
 *  test can drive with a plain socket pair; production wraps an inherited fd). */
export function cdpConnectSocket(sock: Socket): CdpConn {
  let buf = "";
  let id = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const handlers = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  sock.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
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
  sock.on("error", () => {
    /* peer gone — pending commands stay unresolved; fail-open covers the caller */
  });

  return {
    cmd: (method, params) =>
      new Promise((resolve) => {
        const cid = ++id;
        pending.set(cid, resolve);
        try {
          sock.write(JSON.stringify({ i: cid, m: method, p: params ?? {} }) + "\n");
        } catch {
          pending.delete(cid);
          resolve(undefined);
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
