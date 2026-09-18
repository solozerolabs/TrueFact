// `truefact serve` — the verdict bracket as a sidecar process. A caller that
// owns the browser (Syndai's Python patchright bridge is the first) launches
// Chrome with --remote-debugging-port, spawns `truefact serve --port N`, and
// speaks one JSON object per line over stdio:
//
//   → {"id":1,"op":"before","kind":"write","action":{"selector":"#go","method":"click"},"expect":[…]?}
//   ← {"id":1,"ok":true}                       // before-state captured; NOW perform the action
//   → {"id":1,"op":"after","threw":"msg"?}      // action done (or threw)
//   ← {"id":1,"ok":true,"step":{…}}            // the verdict Step, chained + redacted
//   → {"op":"close"}  ← {"ok":true}
//
// Everything between the two messages is the unchanged withTrueFact pipeline
// (captureState → decideWrite → detectSession → network sidecar → chain), so a
// serve verdict is the same verdict the wrapped Stagehand path certifies. The
// agent's claim is never on this channel: `kind` is what the caller INTENDED
// (write/nav), and the verdict is what the page and the network showed.
import { cdpConnect, cdpConnectFd } from "./cdp.js";
import { cdpDriver, type CdpAction } from "./driver-cdp.js";
import { withTrueFact, type Step, type TrueFactOptions, type Wrapped } from "./index.js";
import type { Declaration } from "./declaration.js";

export interface ServeOptions extends Omit<TrueFactOptions, "network"> {
  port?: number; // TCP debug-port mode. Mutually exclusive with cdpFd.
  cdpFd?: number; // inherited duplex-socket fd; CDP is proxied by the caller into
  // Playwright's in-process session — no --remote-debugging-port, so nothing a
  // same-UID sandbox process can reach. Preferred; see docs/SERVE.md.
  apiOrigins?: string[];
  bodyErrors?: boolean | RegExp;
}

export type ServeRequest =
  | { id: number; op: "before"; kind: "write" | "nav"; action?: CdpAction; url?: string; expect?: Declaration | Declaration[] }
  | { id: number; op: "after"; threw?: string }
  | { op: "close" };

export type ServeReply = { id?: number; ok: true; step?: Step } | { id?: number; ok: false; error: string };

export interface ServeSession {
  /** Handle one request; resolves with the reply to write back. */
  handle(req: ServeRequest): Promise<ServeReply>;
  close(): Promise<void>;
}

/** Attach to Chrome on `port`; null when there is no DevTools endpoint. */
export async function startServe(opts: ServeOptions): Promise<ServeSession | null> {
  const conn = opts.cdpFd !== undefined ? cdpConnectFd(opts.cdpFd) : await cdpConnect(opts.port ?? 0);
  if (!conn) return null;

  // One in-flight bracket at a time: `before` parks the pipeline inside
  // perform() until `after` arrives. A second `before` while parked is an error.
  let parked: { resolve: (v: unknown) => void; reject: (e: Error) => void; beforeDone: () => void } | null = null;
  let running: Promise<unknown> | null = null;

  const { port, cdpFd, apiOrigins, bodyErrors, ...replayOpts } = opts;
  void port;
  void cdpFd;
  const w: Wrapped = withTrueFact(
    cdpDriver(conn, () =>
      new Promise((resolve, reject) => {
        // before-state is captured by the time perform() runs (run() orders it so)
        parked!.beforeDone();
        parked = { ...parked!, resolve, reject };
      }),
    ),
    // ONE conn for reads AND network events — no second CDP client, no port.
    { screenshots: false, ...replayOpts, network: { conn, apiOrigins, bodyErrors } },
  );

  const close = async (): Promise<void> => {
    await w.close();
    conn.close();
  };

  return {
    close,
    async handle(req) {
      if (req.op === "close") {
        await close();
        return { ok: true };
      }
      if (req.op === "before") {
        if (parked) return { id: req.id, ok: false, error: "a bracket is already open; send after first" };
        const beforeDone = new Promise<void>((res) => {
          parked = { resolve: () => {}, reject: () => {}, beforeDone: res };
        });
        const expect = req.expect;
        running =
          req.kind === "nav"
            ? w.page.goto(req.url ?? "")
            : w.act((req.action ?? { method: "click" }) as never, expect ? { expect } : undefined);
        running.catch(() => {}); // surfaced through `after`; never unhandled
        await beforeDone;
        return { id: req.id, ok: true };
      }
      // after
      if (!parked || !running) return { id: req.id, ok: false, error: "no open bracket" };
      const p = parked;
      const r = running;
      parked = null;
      running = null;
      if (req.threw) p.reject(new Error(req.threw));
      else p.resolve(null);
      try {
        await r;
      } catch {
        /* the caller's own throw, re-raised by run(); the step is still recorded */
      }
      return { id: req.id, ok: true, step: w.replay.steps.at(-1) };
    },
  };
}

// --- CLI glue: `truefact serve --port 9222 [--jsonl run.jsonl] [--api-origins a,b] [--body-errors] [--screenshots]`
export async function runServeCli(argv: string[], io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process): Promise<number> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "" : argv[++i];
  const port = flags.port ? Number(flags.port) : undefined;
  const cdpFd = "cdp-fd" in flags ? Number(flags["cdp-fd"]) : undefined;
  if (!port && cdpFd === undefined) {
    process.stderr.write("usage: truefact serve (--cdp-fd <n> | --port <n>) [--jsonl run.jsonl] [--api-origins a.com,b.com] [--body-errors] [--screenshots]\n");
    return 2;
  }
  const session = await startServe({
    port,
    cdpFd,
    jsonl: flags.jsonl || undefined,
    apiOrigins: flags["api-origins"] ? flags["api-origins"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    bodyErrors: "body-errors" in flags,
    screenshots: "screenshots" in flags,
  });
  if (!session) {
    process.stderr.write(
      cdpFd !== undefined
        ? `truefact serve: could not open CDP over fd ${cdpFd}.\n`
        : `truefact serve: could not attach to Chrome on port ${port}.\n  Launch it with --remote-debugging-port=${port} first.\n`,
    );
    return 2;
  }
  io.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\n");
  let buf = "";
  let closed = false;
  for await (const chunk of io.stdin) {
    buf += String(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: ServeRequest;
      try {
        req = JSON.parse(line) as ServeRequest;
      } catch {
        io.stdout.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
        continue;
      }
      const reply = await session.handle(req);
      io.stdout.write(JSON.stringify(reply) + "\n");
      if (req.op === "close") {
        closed = true;
        break;
      }
    }
    if (closed) break;
  }
  if (!closed) await session.close();
  return 0;
}
