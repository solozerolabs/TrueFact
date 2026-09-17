// M2 — the CDP network sidecar. A SECOND, independent CDP client on the same
// Chrome the agent drives, so TrueReplay sees the response Stagehand v4 cannot
// (its own channel carries only "console" — see docs/DAY4.md §4). This is the
// out-of-band catch for optimistic UI: page shows ✅ while the POST 500s.
// Verified reachable in scripts/m0-sidecar.mjs. Stdlib only: Node's global
// WebSocket + fetch to the browser's /json target list. No new dependency.
//
// It reads the world, never the agent's claim — so its evidence belongs to the
// verdict channel, like every other page read.

export interface NetError {
  url: string;
  status: number | null; // null = the request failed on the wire (Network.loadingFailed)
}

export interface Sidecar {
  mark(): number; // an opaque cursor into the event stream, taken before a write
  errorsSince(mark: number, origin: string): NetError[]; // same-origin 5xx / failed since the cursor
  close(): void;
}

const originOf = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

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
export async function attachSidecar(port: number): Promise<Sidecar | null> {
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
      ws.onerror = () => rej(new Error("sidecar ws connect failed"));
    });

    // requestId → url, so a later loadingFailed (which carries no url) resolves.
    const urlOf = new Map<string, string>();
    const events: NetError[] = [];
    ws.onmessage = (m: MessageEvent) => {
      let msg: { method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      const p = msg.params ?? {};
      if (msg.method === "Network.requestWillBeSent") {
        urlOf.set(p.requestId as string, ((p.request as { url?: string })?.url) ?? "");
      } else if (msg.method === "Network.responseReceived") {
        const r = p.response as { url?: string; status?: number } | undefined;
        if (r && typeof r.status === "number" && r.status >= 500) events.push({ url: r.url ?? "", status: r.status });
      } else if (msg.method === "Network.loadingFailed") {
        const url = urlOf.get(p.requestId as string) ?? "";
        if (url) events.push({ url, status: null });
      }
    };

    let id = 0;
    ws.send(JSON.stringify({ id: ++id, method: "Network.enable" }));

    return {
      mark: () => events.length,
      errorsSince: (mark, origin) => (origin ? events.slice(mark).filter((e) => originOf(e.url) === origin) : []),
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
