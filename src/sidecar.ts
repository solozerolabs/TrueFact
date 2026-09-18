// The wrapped-mode network reader. A second, independent CDP client on the
// Chrome the agent drives sees the response Stagehand v4 cannot: the POST 500
// behind an optimistic ✅. It accumulates one outcome per mutating request (via
// the shared trackWrites), and answers `errorsSince(mark, origins)` for the
// action bracket that just closed. The classification policy lives here; the
// event wiring and the 2xx-then-cancel guard are shared with `watch` in
// netwatch.ts, so the two modes can never drift apart again.
import { cdpConnect, type CdpConn } from "./cdp.js";
import { trackWrites, isWriteError, originOf, type WriteOutcome } from "./netwatch.js";

// Re-exported for the modules that imported these from here before netwatch.
export { originOf, isWriteError, MUTATING, DEFAULT_BODY_ERR, bodyErrorPattern } from "./netwatch.js";

export interface NetError {
  url: string;
  status: number | null; // null = a wire failure with no response (a failed write)
}

export interface SidecarOptions {
  bodyErrors?: boolean | RegExp;
}

export interface Sidecar {
  /** How many outcomes have been seen so far — the start of an action's window.
   *  Also snapshots the request sequence so `settle` scopes in-flight writes to
   *  this action. */
  mark(): number;
  /** Wait up to `budgetMs` for this action's own in-flight watched writes to
   *  answer, drain any 2xx body reads, and return how many writes are still
   *  unresolved — the ones we cannot call landed. */
  settle(budgetMs: number, origins: string[]): Promise<number>;
  /** Errors on a watched origin since `mark`, after retry-collapse. */
  errorsSince(mark: number, origins: string[]): NetError[];
  close(): void;
}

/**
 * Attach the network reader to the Chrome listening on `port` (launched with
 * `localBrowser.launch({ port })`). Best-effort: any failure resolves to null,
 * and network verification is simply skipped — an infra hiccup must never crash
 * a run or fabricate a verdict.
 */
export async function attachSidecar(port: number, opts: SidecarOptions = {}): Promise<Sidecar | null> {
  const conn = await cdpConnect(port);
  if (!conn) return null;
  return attachSidecarConn(conn, { ...opts, ownsConn: true });
}

/**
 * Same reader, but on a CdpConn the CALLER owns and shares with the page reader
 * — used by `serve` in fd mode, where one CDP channel serves both reads and
 * network events. `close()` does NOT close a shared conn; the owner closes it.
 */
export async function attachSidecarConn(conn: CdpConn, opts: SidecarOptions & { ownsConn?: boolean } = {}): Promise<Sidecar> {
  const ownsConn = opts.ownsConn ?? false;
  const outcomes: WriteOutcome[] = [];
  const tracker = trackWrites(conn, { bodyErrors: opts.bodyErrors, onOutcome: (o) => outcomes.push(o) });
  await conn.cmd("Network.enable");

  const key = (o: WriteOutcome) => o.method + " " + o.url;
  const isError = (o: WriteOutcome) => o.bodyError || o.status == null || isWriteError(o.status, o.method);
  const watchedOf = (origins: string[]) => {
    const ok = new Set(origins.filter(Boolean));
    return (u: string) => ok.has(originOf(u));
  };
  // Snapshot at mark(); the before→after contract keeps one bracket open at a
  // time, so a single stored seq is enough (ponytail: serial use assumed).
  let markSeq = 0;

  return {
    mark: () => {
      markSeq = tracker.seq();
      return outcomes.length;
    },
    settle: async (budgetMs, origins) => {
      const watched = watchedOf(origins);
      const start = Date.now();
      // Wait for this action's own writes to answer, so an optimistic ✅ whose
      // POST 500s a second later is caught rather than called landed. Only
      // watched-origin mutations hold us, and only until they resolve — a fast
      // site pays nothing; a slow reject pays exactly what correctness costs.
      while (tracker.pendingWrites(markSeq, watched) > 0 && Date.now() - start < budgetMs)
        await new Promise((r) => setTimeout(r, 50));
      await tracker.settle(); // drain any 2xx body reads too
      return tracker.pendingWrites(markSeq, watched);
    },
    errorsSince: (mark, origins) => {
      const ok = new Set(origins.filter(Boolean));
      if (!ok.size) return [];
      const since = outcomes.slice(mark).filter((o) => ok.has(originOf(o.url)));
      // Retry-collapse: a later success to the same (method,url) in this window
      // means the write landed (401 -> token refresh -> retry, transient 5xx ->
      // retry). Drop the earlier error so a recovered write never cries wolf.
      const recovered = new Set(since.filter((o) => !isError(o)).map(key));
      return since
        .filter((o) => isError(o) && !recovered.has(key(o)))
        .map((o) => ({ url: o.url, status: o.status }));
    },
    close: () => {
      if (ownsConn) conn.close();
    },
  };
}
