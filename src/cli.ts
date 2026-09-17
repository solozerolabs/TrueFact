#!/usr/bin/env node
// truereplay CLI. Subcommands:
//
//   truereplay assert <run.jsonl> --with <assertions.mjs>
//   truereplay verify <run.jsonl>
//   truereplay view   <run.jsonl>
//
// `assert` re-runs an assertion module against a recorded run, offline, and
// exits 1 if any write step fails — a CI gate over stored runs. `verify`
// recomputes the tamper-evident hash chain and exits 1 at the first break.
// `view` writes a standalone HTML timeline beside the run and opens it.
// See docs/SPEC-V2.md §5.1 / §6 / §8.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { reassertFile } from "./assert.js";
import { verifyChain, type ChainLink } from "./chain.js";
import { viewFile } from "./view.js";

function verifyCmd(jsonl: string): number {
  const steps = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChainLink);
  const r = verifyChain(steps);
  if (r.ok) {
    process.stdout.write(`OK  ${r.length} steps, chain intact\n`);
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
  if (cmd === "verify" && argv[1]) return verifyCmd(argv[1]);
  if (cmd === "view" && argv[1]) return viewCmd(argv[1]);
  if (cmd === "assert") return assertCmd(argv);
  process.stderr.write("usage:\n  truereplay assert <run.jsonl> --with <assertions.mjs>\n  truereplay verify <run.jsonl>\n  truereplay view   <run.jsonl>\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`truereplay: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
