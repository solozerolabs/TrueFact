#!/usr/bin/env node
// truereplay CLI. Today one subcommand:
//
//   truereplay assert <run.jsonl> --with <assertions.mjs>
//
// Re-runs an assertion module against a recorded run, offline. Exits non-zero
// if any write step fails the assertion — so it drops into CI as a gate over
// stored agent runs. See docs/SPEC-V2.md §5.1.
import { reassertFile } from "./assert.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, jsonl] = argv;
  if (cmd !== "assert" || !jsonl) {
    process.stderr.write("usage: truereplay assert <run.jsonl> --with <assertions.mjs>\n");
    return 2;
  }
  const wi = argv.indexOf("--with");
  const mod = wi >= 0 ? argv[wi + 1] : undefined;
  if (!mod) {
    process.stderr.write("truereplay assert: --with <assertions.mjs> is required\n");
    return 2;
  }

  const report = await reassertFile(jsonl, mod);
  for (const it of report.items) {
    if (!it.ok) process.stdout.write(`FAIL  #${it.index}  ${it.action}\n      ${it.message ?? ""}\n`);
  }
  process.stdout.write(`\n${report.total - report.failed}/${report.total} write steps pass  (${report.failed} failed)\n`);
  return report.failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`truereplay: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
