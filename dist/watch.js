// `truefact watch` — observe mode. Attach to an already-running Chrome by its
// --remote-debugging-port and passively verify writes for ANY framework
// (Browser-Use, Puppeteer, Playwright, a human clicking), wrapping nothing.
//
// v1 is the NETWORK-TRUTH floor, and only the floor (docs/WATCH-PLAN.md): per
// mutating request (POST/PUT/PATCH/DELETE) on a WATCHED origin it emits one
// verdict from the already-certified sidecar classification —
//   did-not-land : the server rejected the write (5xx / 4xx-on-write except
//                  401/403 auth / pre-response wire failure / opt-in error-body),
//                  after retry-collapse
//   landed       : the server accepted it (clean 2xx, incl. a 2xx whose body load
//                  was later canceled — a navigated/beacon abort, not a failure)
// The two exclusions (auth 4xx, 2xx-then-cancel) come from the real-site cry-wolf
// experiment (docs/EXPERIMENT-SITES.md run #4): both are pervasive same-origin
// BACKGROUND traffic that would false-fire in passive mode. See isPassiveWriteError
// and the loadingFailed handler below.
// It does NOT reconstruct a DOM bracket or a boundary, so it never renders the
// DOM/validation verdict that needs a causal `before` — that path (and its own
// cry-wolf proof on real sites) is deferred. Passive attribution keeps
// cry-wolf-0 the one way it soundly can: a failed request is tied to its OWN
// origin+method+status (never a guessed DOM cause), scoped to a watched-origin
// allowlist, with retry-collapse so a transient error that then succeeds is
// dropped (a miss, never a false accusation).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cdpConnect } from "./cdp.js";
import { originOf, isWriteError, trackWrites } from "./netwatch.js";
import { hashStep, makeSigner } from "./chain.js";
import { redactText } from "./redact.js";
// Observe mode has no act() bracket to tie a failure to the agent's intent, so
// its passive verdict is deliberately narrower than wrapped mode's: auth
// failures (401/403) are dropped entirely — pervasive as background token/JWT
// probes on logged-out pages (real-site cry-wolf experiment: vercel POST
// /api/jwt 403 cried wolf). A forbidden write is a genuine MISS here: it is
// neither accused (no did-not-land) nor claimed landed. Wrapped mode (with a
// causal bracket) keeps the sharp full-4xx classification.
const PASSIVE_AUTH_SKIP = new Set([401, 403]);
const pathOf = (u) => {
    try {
        const x = new URL(u);
        return x.pathname + x.search;
    }
    catch {
        return u;
    }
};
/**
 * Start observing. Best-effort: returns null if the sidecar can't attach (no
 * port / no DevTools endpoint) — watch prints a clear error rather than crash.
 */
export async function startWatch(opts) {
    const conn = await cdpConnect(opts.port);
    if (!conn)
        return null;
    const grace = opts.graceMs ?? 1200;
    const apiOrigins = (opts.apiOrigins ?? []).filter(Boolean);
    const signingKey = opts.signingKey ?? process.env.TRUEFACT_SIGNING_KEY;
    const sign = signingKey ? makeSigner(signingKey) : null;
    if (opts.jsonl)
        mkdirSync(dirname(opts.jsonl), { recursive: true });
    let prevHash = "";
    // The watched-origin allowlist = the top-level page origin (tracked live) plus
    // any caller-declared API origins. Same guard errorsSince uses in wrapped mode.
    let pageOrigin = "";
    const watched = (url) => {
        const o = originOf(url);
        return o !== "" && (o === pageOrigin || apiOrigins.includes(o));
    };
    // retry-collapse: a pending failure per endpoint, suppressed if a later
    // success to the same (method,url) lands within `grace`.
    const pendingErr = new Map();
    const emit = (o) => {
        if (opts.jsonl) {
            const step = buildStep(o, prevHash, sign);
            prevHash = step.hash;
            appendFileSync(opts.jsonl, JSON.stringify(step) + "\n");
        }
        opts.onWrite?.(o);
    };
    const finalize = (rec, verdict, reason) => {
        const o = { method: rec.method, url: rec.url, status: rec.status ?? null, verdict, reason };
        const key = rec.method + " " + rec.url;
        if (verdict === "landed") {
            // a success recovers any pending failure to the same endpoint (retry).
            const p = pendingErr.get(key);
            if (p) {
                clearTimeout(p.timer);
                pendingErr.delete(key);
            }
            emit(o);
            return;
        }
        // did-not-land: hold for the grace window; a newer attempt supersedes.
        const existing = pendingErr.get(key);
        if (existing)
            clearTimeout(existing.timer);
        pendingErr.set(key, {
            o,
            timer: setTimeout(() => {
                pendingErr.delete(key);
                emit(o);
            }, grace),
        });
    };
    // One shared write tracker (netwatch): it emits a terminal outcome per mutating
    // request with the 2xx-then-cancel guard already applied. Observe policy is
    // applied here: scope to a watched origin, treat 401/403 as a MISS not a false
    // accusation (isPassiveWriteError), and hold a failure for the grace window.
    const tracker = trackWrites(conn, {
        bodyErrors: opts.bodyErrors,
        onOutcome: (o) => {
            if (!watched(o.url))
                return; // tracker already filters to mutating writes
            // 401/403: a MISS in passive mode — not accused, not claimed landed.
            if (o.status != null && PASSIVE_AUTH_SKIP.has(o.status))
                return;
            const rec = { url: o.url, method: o.method, status: o.status ?? undefined };
            const failed = o.bodyError || o.status == null || isWriteError(o.status, o.method);
            finalize(rec, failed ? "did-not-land" : "landed", failed ? "network-error" : "network-ok");
        },
    });
    conn.on("Page.frameNavigated", (p) => {
        const f = p.frame;
        if (f && !f.parentId && f.url)
            pageOrigin = originOf(f.url); // main frame only
    });
    await conn.cmd("Page.enable");
    await conn.cmd("Network.enable");
    // Seed the page origin from the current main frame (watch may attach mid-run).
    try {
        const t = (await conn.cmd("Target.getTargetInfo"));
        if (t?.targetInfo?.url)
            pageOrigin = originOf(t.targetInfo.url);
    }
    catch {
        /* older Chrome without Target.getTargetInfo on the page session — Page.frameNavigated covers it */
    }
    // Deterministic drain: await in-flight body reads first (a body-derived
    // success can recover a pending failure), then fire any failures still held —
    // if one is still pending, no success ever came, so it stands. Used by tests
    // and by close() so a held failure isn't lost on shutdown.
    const settle = async () => {
        await tracker.settle();
        for (const [key, p] of [...pendingErr]) {
            clearTimeout(p.timer);
            pendingErr.delete(key);
            emit(p.o);
        }
    };
    return {
        origins: () => [pageOrigin, ...apiOrigins].filter(Boolean),
        settle,
        close: async () => {
            await settle();
            conn.close();
        },
    };
}
// Build a minimal, chain-valid Step for one observed write. before/after are
// null (watch has no DOM bracket); the network evidence carries the outcome.
function buildStep(o, prevHash, sign) {
    const outcome = { verdict: o.verdict, reason: o.reason, confidence: "high" };
    // A watched write URL can carry a token/PII in its path or query
    // (POST /reset?token=…). Scrub every stored string, like the wrapped path.
    const url = redactText(o.url);
    const step = {
        kind: "write",
        action: redactText(`${o.method} ${pathOf(o.url)}`),
        declaration: "auto",
        verdict: o.verdict,
        evidence: {
            before: null,
            after: null,
            settled: true,
            session: { obstruction: null, confidence: "high", detail: "watch: network-only", checked: [] },
            postcondition: {
                ...outcome,
                auto: outcome,
                urlChanged: false,
                pageSwitched: false,
                treeAdded: [],
                treeRemoved: [],
                formsBefore: {},
                formsAfter: {},
                ...(o.verdict === "did-not-land" ? { network: { errors: [{ url, status: o.status }] } } : {}),
            },
        },
        attempt: null,
        agent_claim: null,
        cost: null,
        timestamp: new Date().toISOString(),
        prevHash,
    };
    step.hash = hashStep(step);
    if (sign)
        step.sig = sign(step.hash);
    return step;
}
// --- CLI glue: `truefact watch --port 9222 [--api-origins a,b] [--body-errors] [--jsonl out]`
// Runs until Ctrl-C, printing one line per observed write, then a summary.
export async function runWatchCli(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++)
        if (argv[i].startsWith("--"))
            flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "" : argv[++i];
    const port = Number(flags.port);
    if (!port) {
        process.stderr.write("usage: truefact watch --port <n> [--api-origins a.com,b.com] [--body-errors] [--jsonl run.jsonl]\n");
        return 2;
    }
    const counts = { landed: 0, "did-not-land": 0 };
    const mark = (v) => (v === "did-not-land" ? "✗ did-not-land" : "✓ landed       ");
    const session = await startWatch({
        port,
        apiOrigins: flags["api-origins"] ? flags["api-origins"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        bodyErrors: "body-errors" in flags,
        jsonl: flags.jsonl || undefined,
        onWrite: (w) => {
            counts[w.verdict]++;
            const s = w.status == null ? "wire-fail" : String(w.status);
            process.stdout.write(`  ${mark(w.verdict)}  ${w.method.padEnd(6)} ${s.padEnd(9)} ${w.url}\n`);
        },
    });
    if (!session) {
        process.stderr.write(`truefact watch: could not attach to Chrome on port ${port}.\n  Launch Chrome with --remote-debugging-port=${port} first.\n`);
        return 2;
    }
    process.stdout.write(`watching writes on ${session.origins().join(", ") || "the active page"}${flags.jsonl ? ` → ${flags.jsonl}` : ""}  (Ctrl-C to stop)\n`);
    await new Promise((res) => process.once("SIGINT", () => res()));
    await session.close();
    process.stdout.write(`\n${counts.landed} landed · ${counts["did-not-land"]} did-not-land\n`);
    return counts["did-not-land"] > 0 ? 1 : 0;
}
