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
import { cdpConnect } from "./cdp.js";
import { cdpDriver } from "./driver-cdp.js";
import { withTrueFact } from "./index.js";
/** Attach to Chrome on `port`; null when there is no DevTools endpoint. */
export async function startServe(opts) {
    const conn = await cdpConnect(opts.port);
    if (!conn)
        return null;
    // One in-flight bracket at a time: `before` parks the pipeline inside
    // perform() until `after` arrives. A second `before` while parked is an error.
    let parked = null;
    let running = null;
    const { port, apiOrigins, bodyErrors, ...replayOpts } = opts;
    const w = withTrueFact(cdpDriver(conn, () => new Promise((resolve, reject) => {
        // before-state is captured by the time perform() runs (run() orders it so)
        parked.beforeDone();
        parked = { ...parked, resolve, reject };
    })), { screenshots: false, ...replayOpts, network: { port, apiOrigins, bodyErrors } });
    const close = async () => {
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
                if (parked)
                    return { id: req.id, ok: false, error: "a bracket is already open; send after first" };
                const beforeDone = new Promise((res) => {
                    parked = { resolve: () => { }, reject: () => { }, beforeDone: res };
                });
                const expect = req.expect;
                running =
                    req.kind === "nav"
                        ? w.page.goto(req.url ?? "")
                        : w.act((req.action ?? { method: "click" }), expect ? { expect } : undefined);
                running.catch(() => { }); // surfaced through `after`; never unhandled
                await beforeDone;
                return { id: req.id, ok: true };
            }
            // after
            if (!parked || !running)
                return { id: req.id, ok: false, error: "no open bracket" };
            const p = parked;
            const r = running;
            parked = null;
            running = null;
            if (req.threw)
                p.reject(new Error(req.threw));
            else
                p.resolve(null);
            try {
                await r;
            }
            catch {
                /* the caller's own throw, re-raised by run(); the step is still recorded */
            }
            return { id: req.id, ok: true, step: w.replay.steps.at(-1) };
        },
    };
}
// --- CLI glue: `truefact serve --port 9222 [--jsonl run.jsonl] [--api-origins a,b] [--body-errors] [--screenshots]`
export async function runServeCli(argv, io = process) {
    const flags = {};
    for (let i = 0; i < argv.length; i++)
        if (argv[i].startsWith("--"))
            flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "" : argv[++i];
    const port = Number(flags.port);
    if (!port) {
        process.stderr.write("usage: truefact serve --port <n> [--jsonl run.jsonl] [--api-origins a.com,b.com] [--body-errors] [--screenshots]\n");
        return 2;
    }
    const session = await startServe({
        port,
        jsonl: flags.jsonl || undefined,
        apiOrigins: flags["api-origins"] ? flags["api-origins"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        bodyErrors: "body-errors" in flags,
        screenshots: "screenshots" in flags,
    });
    if (!session) {
        process.stderr.write(`truefact serve: could not attach to Chrome on port ${port}.\n  Launch it with --remote-debugging-port=${port} first.\n`);
        return 2;
    }
    io.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\n");
    let buf = "";
    let closed = false;
    for await (const chunk of io.stdin) {
        buf += String(chunk);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line)
                continue;
            let req;
            try {
                req = JSON.parse(line);
            }
            catch {
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
        if (closed)
            break;
    }
    if (!closed)
        await session.close();
    return 0;
}
