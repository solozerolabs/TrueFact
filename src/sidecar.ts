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

export interface SidecarOptions {
  // Opt-in: also demote when a mutating request returns a 2xx whose BODY says it
  // failed — GraphQL `{"errors":[{…}]}`, Stripe-style `{"success":false}`. Off
  // by default (a body read is a CDP round-trip per response). `true` uses the
  // default pattern; pass a RegExp to override. The body is tested and dropped,
  // never stored (redaction discipline).
  bodyErrors?: boolean | RegExp;
}

export interface Sidecar {
  mark(): number; // an opaque cursor into the event stream, taken before a write
  settle(): Promise<void>; // await in-flight body reads so errorsSince sees them
  errorsSince(mark: number, origins: string[]): NetError[]; // write errors (5xx any / 4xx on POST-like / failed / 2xx-error-body) since the cursor, from any allowed origin
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
export async function attachSidecar(port: number, opts: SidecarOptions = {}): Promise<Sidecar | null> {
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

    const bodyRe = opts.bodyErrors ? (opts.bodyErrors instanceof RegExp ? opts.bodyErrors : DEFAULT_BODY_ERR) : null;

    // requestId → {url, method}, so responseReceived can class the status by
    // method and a later loadingFailed (which carries neither) can resolve both.
    const reqOf = new Map<string, { url: string; method: string }>();
    // mutating requests that returned a clean 2xx — candidates for a body read.
    const bodyCandidates = new Map<string, { url: string; status: number }>();
    const events: NetError[] = [];

    // CDP command/response correlation, so getResponseBody can be awaited.
    let id = 0;
    const pending = new Map<number, (result: unknown) => void>();
    const cmd = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        const cid = ++id;
        pending.set(cid, resolve);
        ws.send(JSON.stringify({ id: cid, method, params }));
      });

    // Body reads in flight, so settle() can wait for them before errorsSince().
    const inflight = new Set<Promise<void>>();
    const readBody = (requestId: string, cand: { url: string; status: number }): void => {
      const pr = (async () => {
        try {
          const r = (await cmd("Network.getResponseBody", { requestId })) as { body?: string; base64Encoded?: boolean } | undefined;
          if (!r?.body) return;
          const text = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
          if (bodyRe!.test(text)) events.push({ url: cand.url, status: cand.status });
        } catch {
          /* body evicted or gone — skip, never fabricate */
        }
      })();
      inflight.add(pr);
      void pr.finally(() => inflight.delete(pr));
    };

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
      const p = msg.params ?? {};
      if (msg.method === "Network.requestWillBeSent") {
        const req = p.request as { url?: string; method?: string } | undefined;
        reqOf.set(p.requestId as string, { url: req?.url ?? "", method: req?.method ?? "GET" });
      } else if (msg.method === "Network.responseReceived") {
        const r = p.response as { url?: string; status?: number } | undefined;
        const method = reqOf.get(p.requestId as string)?.method ?? "GET";
        if (r && typeof r.status === "number") {
          if (isWriteError(r.status, method)) {
            events.push({ url: r.url ?? "", status: r.status });
          } else if (bodyRe && r.status >= 200 && r.status < 300 && MUTATING.has(method.toUpperCase())) {
            // clean status on a write — the body may still say it failed.
            bodyCandidates.set(p.requestId as string, { url: r.url ?? "", status: r.status });
          }
        }
      } else if (msg.method === "Network.loadingFinished") {
        const cand = bodyCandidates.get(p.requestId as string);
        if (cand) {
          bodyCandidates.delete(p.requestId as string);
          readBody(p.requestId as string, cand); // body ready only after loadingFinished
        }
      } else if (msg.method === "Network.loadingFailed") {
        // A request that never got a response. Only a mutating one signals a
        // failed write; a dropped GET (tracker, aborted image) is noise.
        const req = reqOf.get(p.requestId as string);
        if (req?.url && MUTATING.has(req.method.toUpperCase())) events.push({ url: req.url, status: null });
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
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
    return null; // best-effort: no port, no DevTools endpoint, no network verification
  }
}
