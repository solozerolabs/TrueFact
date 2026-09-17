// Re-score a benchmark manifest with the pure scorer. No browser, no key.
// Usage:  npm run bench:score  [path/to/oracle.jsonl]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { score } from "../../dist/bench.js";

const path = process.argv[2] || "bench/out/oracle.jsonl";
const outDir = "bench/out";
mkdirSync(outDir, { recursive: true });
const runs = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rep = score(runs);

const pct = (r) => `${(r.p * 100).toFixed(1)}% [${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}] (${r.x}/${r.n})`;
let md = `# TrueReplay benchmark\n\nRuns: ${runs.length}\n\n`;
for (const [m, g] of Object.entries(rep.byModel)) {
  md += `## ${m}  (n=${g.n}, $${g.usd.toFixed(3)})\n`;
  md += `- **exec**:   false-success ${pct(g.exec.falseSuccess)} → TrueReplay residual MISS ${pct(g.exec.miss)}\n`;
  md += `- **belief**: false-success ${pct(g.belief.falseSuccess)} → TrueReplay residual MISS ${pct(g.belief.miss)}\n`;
  md += `- cry-wolf ${pct(g.falseAccusation)} · under-confidence ${pct(g.underConfidence)}\n\n`;
}
md += `## Gates (pre-registered)\n`;
md += `- market exists: **${rep.gates.marketExists.pass}** — ${rep.gates.marketExists.detail}\n`;
md += `- instrument works: **${rep.gates.instrumentWorks.pass}** — ${rep.gates.instrumentWorks.detail}\n`;
md += `- **PUBLISH: ${rep.gates.publish}**\n`;

writeFileSync("bench/out/report.md", md);
writeFileSync("bench/out/report.json", JSON.stringify(rep, null, 2));
console.log(md);
