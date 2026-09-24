// The wrapped-mode network reader. A second, independent CDP client on the
// Chrome the agent drives sees the response Stagehand v4 cannot: the POST 500
// behind an optimistic ✅. It accumulates one outcome per mutating request (via
// the shared trackWrites), and answers `errorsSince(mark, origins)` for the
// action bracket that just closed. The classification policy lives here; the
// event wiring and the 2xx-then-cancel guard are shared with `watch` in
// netwatch.ts, so the two modes can never drift apart again.
import { cdpConnectBrowser, type CdpConn } from "./cdp.js";
import { trackWrites, isWriteError, originOf, type WriteOutcome } from "./netwatch.js";

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
  /** Why this reader is blind (its socket died, its Network never enabled), or
   *  null while it watches. The bracket reads it after settle(); silence from a
   *  blind reader is never "no errors". */
  lost(): string | null;
  close(): void;
}

/**
 * Attach the network reader to the Chrome listening on `port` (launched with
 * `localBrowser.launch({ port })`). Best-effort: any failure resolves to null,
 * and network verification is simply skipped — an infra hiccup must never crash
 * a run or fabricate a verdict.
 */
export async function attachSidecar(port: number, opts: SidecarOptions = {}): Promise<Sidecar | null> {
  // Browser-level so popups and cross-origin iframes are seen too (see cdp.ts).
  // That connector enables Network per child session on attach (the browser
  // target has no Network domain), so nothing to enable here.
  const conn = await cdpConnectBrowser(port);
  if (!conn) return null;
  return make(conn, opts, true);
}

/**
 * Same reader, but on a CdpConn the CALLER owns and shares with the page reader
 * — used by `serve` in fd mode, where one CDP channel serves both reads and
 * network events. `close()` does NOT close a shared conn; the owner closes it.
 */
export function attachSidecarConn(conn: CdpConn, opts: SidecarOptions = {}): Sidecar {
  // Every connector enables Network itself (per child session on the browser
  // conn; on connect for a page/fd conn) and reports a failed enable through
  // lost() — so nothing to enable here, and nothing to guess about the conn type.
  return make(conn, opts, false);
}

function make(conn: CdpConn, opts: SidecarOptions, ownsConn: boolean): Sidecar {
  const outcomes: WriteOutcome[] = [];
  const tracker = trackWrites(conn, { bodyErrors: opts.bodyErrors, onOutcome: (o) => outcomes.push(o) });

  const key = (o: WriteOutcome) => o.method + " " + o.url;
  const isError = (o: WriteOutcome) => o.bodyError || o.status == null || isWriteError(o.status, o.method);
  const watchedOf = (origins: string[]) => {
    const ok = new Set(origins.filter(Boolean));
    return (u: string) => ok.has(originOf(u));
  };
  // Snapshot at mark(); the before→after contract keeps one bracket open at a
  // time, so a single stored seq is enough (ponytail: serial use assumed).
  let markSeq = 0;
  const self: Sidecar = {
    lost: () => conn.lost(),
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
      // A dead reader will never answer: stop waiting the moment it is lost.
      while (tracker.pendingWrites(markSeq, watched) > 0 && Date.now() - start < budgetMs && !self.lost())
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
      // Order matters: only a success arriving AFTER the error recovers it. An
      // earlier success (an autosave, an idempotent pre-check) must NOT absolve a
      // later 500 — that later failure is the real write not landing.
      // ponytail: O(n^2) later-scan; n = writes in one act bracket, always tiny.
      return since
        .filter((o, i) =>
          isError(o) && !since.slice(i + 1).some((n) => !isError(n) && key(n) === key(o)))
        .map((o) => ({ url: o.url, status: o.status }));
    },
    close: () => {
      if (ownsConn) conn.close();
    },
  };
  return self;
}
