// Score a live campaign manifest. Stratified, never pooled: false-`landed` and
// cry-wolf are reported per stratum×config as k/N with a Wilson interval, and
// each is checked against the pre-registered expectation. Trials whose truth is
// "unknown" (unconfirmed injection, disagreeing read-back, unreachable site) are
// dropped here, before the pure scorer — never coerced. See the spec §4.
//   npm run live:score  [path/to/manifest.jsonl]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { score } from "../../dist/bench.js";

const path = process.argv[2] || "live/out/manifest.jsonl";
mkdirSync("live/out", { recursive: true });
const all = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const scored = all.filter((r) => r.oracleLanded === true || r.oracleLanded === false);
const dropped = all.length - scored.length;
const pct = (r) => `${(r.p * 100).toFixed(1)}% [${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}] (${r.x}/${r.n})`;
const bound = (r) => (r.x === 0 ? `≤${(r.hi * 100).toFixed(1)}% (rule-of-three, 0/${r.n})` : pct(r));

// verdict expectation checker: "did-not-land" | "landed" | "not:did-not-land" | "not:landed"
const meets = (verdict, expect) => (expect?.startsWith("not:") ? verdict !== expect.slice(4) : verdict === expect);

const groups = {};
for (const r of scored) (groups[`${r.stratum} · ${r.config}`] ??= []).push(r);

let md = `# TrueFact — real-site false-\`landed\` campaign\n\n`;
md += `Trials: ${all.length} (scored ${scored.length}, dropped-unknown ${dropped}). Never pooled; see the pre-registered strata.\n\n`;

const findings = [];
for (const [key, rows] of Object.entries(groups)) {
  const rep = score(rows).overall;
  const pairs = new Set(rows.map((r) => r.site)).size;
  md += `## ${key}  (n=${rows.length}, ${pairs} site×flow)\n`;
  md += `- **false-landed** ${bound(rep.falseLanded)}\n`;
  md += `- cry-wolf ${bound(rep.falseAccusation)} · under-confidence ${pct(rep.underConfidence)}\n\n`;
}

// Pre-registration check: compare each row's verdict to its trial's expect[config].
// The manifest carries `expect` only if the runner copied it; fall back to reading
// sites.mjs is avoided (KISS) — the runner stamps the expectation per row.
for (const r of scored) {
  if (!r.expect) continue;
  const want = r.expect[r.config];
  if (want && !meets(r.verdict, want)) findings.push(`${r.stratum} ${r.site} [${r.config}]: expected ${want}, got ${r.verdict} (truth=${r.oracleLanded})`);
}

// The headline: pooled false-landed ACROSS the shapes whose expectation is a clean
// catch (S1/S2/S6/S7) — never across the known ceilings (S3-zero, S4-zero).
const headline = scored.filter((r) => r.expect && r.expect[r.config] && r.expect[r.config] !== "landed");
const hRep = score(headline).overall;
md = `# TrueFact — real-site false-\`landed\` campaign\n\n` +
  `**Headline (S1/S2/S6/S7, shapes we claim to catch): false-landed ${bound(hRep.falseLanded)} · cry-wolf ${bound(hRep.falseAccusation)}.**\n` +
  `Known ceilings (S3 default / S4) are reported in their own strata and excluded from the headline.\n\n` +
  md.slice(md.indexOf("Trials:"));

if (findings.length) md += `## ⚠ FINDINGS (contradicted pre-registration)\n` + findings.map((f) => `- ${f}`).join("\n") + "\n";
else md += `_All scored trials matched their pre-registered expectation._\n`;

writeFileSync("live/out/report.md", md);
writeFileSync("live/out/report.json", JSON.stringify({ headline: hRep, groups: Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, score(rows).overall])), dropped, findings }, null, 2));
console.log(md);
