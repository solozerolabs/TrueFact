#!/usr/bin/env node
// truereplay CLI. Subcommands:
//
//   truereplay assert <run.jsonl> --with <assertions.mjs>
//   truereplay verify <run.jsonl>
//   truereplay view   <run.jsonl>
//   truereplay fleet  <run.jsonl...>
//   truereplay gate   <run.jsonl...> [--max-did-not-land 0.05]
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
import { verifyChain, type ChainLink } from "./chain.js";
import { viewFile } from "./view.js";
import { summarizeRun, rollupRuns } from "./fleet.js";
import type { Step } from "./index.js";

const loadRun = (p: string): Step[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Step);
const pct = (x: number) => (x * 100).toFixed(1) + "%";

/** Split argv into file paths and a `--flag value` map. */
function parseArgs(argv: string[]): { files: string[]; flags: Record<string, string> } {
  const files: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i] ?? "";
    else files.push(argv[i]);
  }
  return { files, flags };
}

function fleetOf(files: string[]) {
  return rollupRuns(files.map((f) => summarizeRun(loadRun(f), f)));
}

function fleetCmd(files: string[]): number {
  if (!files.length) {
    process.stderr.write("usage: truereplay fleet <run.jsonl...>\n");
    return 2;
  }
  const s = fleetOf(files);
  process.stdout.write(`${s.runs} runs · landed ${pct(s.landedRate)} · did-not-land ${pct(s.didNotLandRate)} · ${s.inconclusive} inconclusive\n`);
  for (const r of s.needReview) process.stdout.write(`  review  ${r.verdict.padEnd(13)} ${r.file ?? ""}\n`);
  return 0;
}

function gateCmd(files: string[], flags: Record<string, string>): number {
  if (!files.length) {
    process.stderr.write("usage: truereplay gate <run.jsonl...> [--max-did-not-land 0.05]\n");
    return 2;
  }
  const max = flags["max-did-not-land"] !== undefined ? Number(flags["max-did-not-land"]) : 0.05;
  const s = fleetOf(files);
  const over = s.didNotLandRate > max;
  process.stdout.write(`${s.runs} runs · did-not-land ${pct(s.didNotLandRate)} (max ${pct(max)}) · ${over ? "FAIL" : "OK"}\n`);
  return over ? 1 : 0;
}

function verifyCmd(jsonl: string, pubkeyPath?: string): number {
  const steps = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChainLink);
  const publicKey = pubkeyPath ? readFileSync(pubkeyPath, "utf8") : undefined;
  const r = verifyChain(steps, { publicKey });
  if (r.ok) {
    process.stdout.write(`OK  ${r.length} steps, chain intact${publicKey ? " and signed" : ""}\n`);
    return 0;
  }
  process.stdout.write(`BROKEN at step #${r.brokenAt} of ${r.length}: ${r.reason}\n`);
  return 1;
}

async function assertCmd(argv: string[]): Promise<number> {
  const jsonl = argv[1];
  const wi = argv.indexOf("--with");
  const mod = wi >= 0 ? argv[wi + 1] : undefined;
  if (!jsonl || !mod) {
    process.stderr.write("usage: truereplay assert <run.jsonl> --with <assertions.mjs>\n");
    return 2;
  }
  const report = await reassertFile(jsonl, mod);
  for (const it of report.items) {
    if (!it.ok) process.stdout.write(`FAIL  #${it.index}  ${it.action}\n      ${it.message ?? ""}\n`);
  }
  process.stdout.write(`\n${report.total - report.failed}/${report.total} write steps pass  (${report.failed} failed)\n`);
  return report.failed > 0 ? 1 : 0;
}

function viewCmd(jsonl: string): number {
  const out = viewFile(jsonl);
  process.stdout.write(`${out}\n`);
  // Best-effort open; the path above is the real deliverable (works headless).
  // TRUEREPLAY_NO_OPEN skips it — for CI, tests, and headless boxes.
  if (process.env.TRUEREPLAY_NO_OPEN) return 0;
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(opener, [out], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener (CI / headless) — the printed path is enough */
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "verify" && argv[1]) { const { files, flags } = parseArgs(argv.slice(1)); return verifyCmd(files[0], flags["pubkey"]); }
  if (cmd === "view" && argv[1]) return viewCmd(argv[1]);
  if (cmd === "assert") return assertCmd(argv);
  if (cmd === "fleet") return fleetCmd(parseArgs(argv.slice(1)).files);
  if (cmd === "gate") { const { files, flags } = parseArgs(argv.slice(1)); return gateCmd(files, flags); }
  process.stderr.write(
    "usage:\n" +
    "  truereplay assert <run.jsonl> --with <assertions.mjs>\n" +
    "  truereplay verify <run.jsonl> [--pubkey <key.pem>]\n" +
    "  truereplay view   <run.jsonl>\n" +
    "  truereplay fleet  <run.jsonl...>\n" +
    "  truereplay gate   <run.jsonl...> [--max-did-not-land 0.05]\n",
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`truereplay: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
