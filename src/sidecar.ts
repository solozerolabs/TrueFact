// M2 — the CDP network sidecar. A SECOND, independent CDP client on the same
// Chrome the agent drives, so TrueFact sees the response Stagehand v4 cannot
// (its own channel carries only "console" — see docs/DAY4.md §4). This is the
// out-of-band catch for optimistic UI: page shows ✅ while the POST 500s.
// Verified reachable in scripts/m0-sidecar.mjs. Stdlib only: Node's global
// WebSocket + fetch to the browser's /json target list. No new dependency.
//
// It reads the world, never the agent's claim — so its evidence belongs to the
// verdict channel, like every other page read.

export interface NetError {
  url: string;
  status: number | null; // null = a mutating request failed on the wire (Network.loadingFailed)
}

export interface Sidecar {
  mark(): number; // an opaque cursor into the event stream, taken before a write
  errorsSince(mark: number, origin: string): NetError[]; // same-origin write errors (5xx any / 4xx on POST-like / failed) since the cursor
  close(): void;
}

const originOf = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

// A write is a mutation. A 4xx on a POST/PUT/PATCH/DELETE means the server
// rejected the write (402 declined, 422 invalid, 429 throttled, 401/403 auth) —
// the common "did-not-land behind an optimistic ✅" that a 5xx-only reader
// misses. A 4xx on a GET is noise (a missing image, a probed 404), so those
// never demote. 5xx stays method-agnostic: a server crash fails any write.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isWriteError = (status: number, method: string): boolean =>
  status >= 500 || (status >= 400 && status < 500 && MUTATING.has(method.toUpperCase()));

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

    // requestId → {url, method}, so responseReceived can class the status by
    // method and a later loadingFailed (which carries neither) can resolve both.
    const reqOf = new Map<string, { url: string; method: string }>();
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
        const req = p.request as { url?: string; method?: string } | undefined;
        reqOf.set(p.requestId as string, { url: req?.url ?? "", method: req?.method ?? "GET" });
      } else if (msg.method === "Network.responseReceived") {
        const r = p.response as { url?: string; status?: number } | undefined;
        const method = reqOf.get(p.requestId as string)?.method ?? "GET";
        if (r && typeof r.status === "number" && isWriteError(r.status, method))
          events.push({ url: r.url ?? "", status: r.status });
      } else if (msg.method === "Network.loadingFailed") {
        // A request that never got a response. Only a mutating one signals a
        // failed write; a dropped GET (tracker, aborted image) is noise.
        const req = reqOf.get(p.requestId as string);
        if (req?.url && MUTATING.has(req.method.toUpperCase())) events.push({ url: req.url, status: null });
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
