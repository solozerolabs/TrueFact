#!/usr/bin/env node
// truefact CLI. Subcommands:
//
//   truefact assert <run.jsonl> --with <assertions.mjs>
//   truefact verify <run.jsonl>
//   truefact view   <run.jsonl>
//   truefact fleet  <run.jsonl...>
//   truefact gate   <run.jsonl...> [--max-did-not-land 0.05]
//   truefact demo   — the optimistic-UI catch, keyless, in one command
//   truefact watch  — attach to a running Chrome, verify writes for any framework
//
// `assert` re-runs an assertion module against a recorded run, offline, and
// exits 1 if any write step fails — a CI gate over stored runs. `verify`
// recomputes the tamper-evident hash chain and exits 1 at the first break.
// `view` writes a standalone HTML timeline beside the run and opens it.
// `fleet` prints the true landed rate across many runs; `gate` is its CI form,
// exiting 1 when the did-not-land rate crosses a threshold.
// See docs/SPEC-V2.md §5.1 / §6 / §7 / §8.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { reassertFile } from "./assert.js";
import { verifyChain } from "./chain.js";
import { viewFile } from "./view.js";
import { summarizeRun, rollupRuns } from "./fleet.js";
const loadRun = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pct = (x) => (x * 100).toFixed(1) + "%";
/** Split argv into file paths and a `--flag value` map. */
function parseArgs(argv) {
    const files = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--"))
            flags[argv[i].slice(2)] = argv[++i] ?? "";
        else
            files.push(argv[i]);
    }
    return { files, flags };
}
function fleetOf(files) {
    return rollupRuns(files.map((f) => summarizeRun(loadRun(f), f)));
}
function fleetCmd(files) {
    if (!files.length) {
        process.stderr.write("usage: truefact fleet <run.jsonl...>\n");
        return 2;
    }
    const s = fleetOf(files);
    process.stdout.write(`${s.runs} runs · landed ${pct(s.landedRate)} · did-not-land ${pct(s.didNotLandRate)} · ${s.inconclusive} inconclusive\n`);
    for (const r of s.needReview)
        process.stdout.write(`  review  ${r.verdict.padEnd(13)} ${r.file ?? ""}\n`);
    return 0;
}
function gateCmd(files, flags) {
    if (!files.length) {
        process.stderr.write("usage: truefact gate <run.jsonl...> [--max-did-not-land 0.05]\n");
        return 2;
    }
    const max = flags["max-did-not-land"] !== undefined ? Number(flags["max-did-not-land"]) : 0.05;
    const s = fleetOf(files);
    const over = s.didNotLandRate > max;
    process.stdout.write(`${s.runs} runs · did-not-land ${pct(s.didNotLandRate)} (max ${pct(max)}) · ${over ? "FAIL" : "OK"}\n`);
    return over ? 1 : 0;
}
function verifyCmd(jsonl, pubkeyPath) {
    const steps = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const publicKey = pubkeyPath ? readFileSync(pubkeyPath, "utf8") : undefined;
    const r = verifyChain(steps, { publicKey });
    if (r.ok) {
        process.stdout.write(`OK  ${r.length} steps, chain intact${publicKey ? " and signed" : ""}\n`);
        return 0;
    }
    process.stdout.write(`BROKEN at step #${r.brokenAt} of ${r.length}: ${r.reason}\n`);
    return 1;
}
async function assertCmd(argv) {
    const jsonl = argv[1];
    const wi = argv.indexOf("--with");
    const mod = wi >= 0 ? argv[wi + 1] : undefined;
    if (!jsonl || !mod) {
        process.stderr.write("usage: truefact assert <run.jsonl> --with <assertions.mjs>\n");
        return 2;
    }
    const report = await reassertFile(jsonl, mod);
    for (const it of report.items) {
        if (!it.ok)
            process.stdout.write(`FAIL  #${it.index}  ${it.action}\n      ${it.message ?? ""}\n`);
    }
    process.stdout.write(`\n${report.total - report.failed}/${report.total} write steps pass  (${report.failed} failed)\n`);
    return report.failed > 0 ? 1 : 0;
}
function viewCmd(jsonl) {
    const out = viewFile(jsonl);
    process.stdout.write(`${out}\n`);
    // Best-effort open; the path above is the real deliverable (works headless).
    // TRUEFACT_NO_OPEN skips it — for CI, tests, and headless boxes.
    if (process.env.TRUEFACT_NO_OPEN)
        return 0;
    const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
    try {
        spawn(opener, [out], { stdio: "ignore", detached: true }).unref();
    }
    catch {
        /* no opener (CI / headless) — the printed path is enough */
    }
    return 0;
}
async function main(argv) {
    const cmd = argv[0];
    if (cmd === "verify" && argv[1]) {
        const { files, flags } = parseArgs(argv.slice(1));
        return verifyCmd(files[0], flags["pubkey"]);
    }
    if (cmd === "view" && argv[1])
        return viewCmd(argv[1]);
    if (cmd === "assert")
        return assertCmd(argv);
    if (cmd === "fleet")
        return fleetCmd(parseArgs(argv.slice(1)).files);
    if (cmd === "gate") {
        const { files, flags } = parseArgs(argv.slice(1));
        return gateCmd(files, flags);
    }
    if (cmd === "demo") {
        const { runDemo } = await import("./demo.js");
        return runDemo();
    }
    if (cmd === "watch") {
        const { runWatchCli } = await import("./watch.js");
        return runWatchCli(argv.slice(1));
    }
    if (cmd === "serve") {
        const { runServeCli } = await import("./serve.js");
        return runServeCli(argv.slice(1));
    }
    process.stderr.write("usage:\n" +
        "  truefact assert <run.jsonl> --with <assertions.mjs>\n" +
        "  truefact verify <run.jsonl> [--pubkey <key.pem>]\n" +
        "  truefact view   <run.jsonl>\n" +
        "  truefact fleet  <run.jsonl...>\n" +
        "  truefact gate   <run.jsonl...> [--max-did-not-land 0.05]\n" +
        "  truefact demo\n" +
        "  truefact watch  --port <n> [--api-origins a.com,b.com] [--body-errors] [--jsonl run.jsonl]\n" +
        "  truefact serve  --port <n> [--jsonl run.jsonl] [--api-origins a,b] [--body-errors] [--screenshots]  (stdio JSON lines; see docs/SERVE.md)\n");
    return 2;
}
main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write(`truefact: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
});
