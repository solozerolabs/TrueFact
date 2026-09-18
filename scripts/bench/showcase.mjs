// The showcase: the optimistic-UI catch, with the network sidecar ON — the one
// thing the pre-registered 520-run ladder (bench/out/report.md) could not show,
// because src/sidecar.ts did not exist when it ran. This is a focused before/
// after, NOT the ladder: one model, a few tasks, n runs each.
//
// Per step we record BOTH channels the wrapper already computes:
//   pageRead = post.auto.verdict  — what the page read alone concluded (fooled)
//   verdict  = post.verdict       — after the network sidecar (caught)
// and the server oracle (ground truth), read out of band. The gap between them
// is the product. Usage:  node --env-file=.env scripts/bench/showcase.mjs
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../../dist/index.js";
import { startFixtures } from "./fixtures.mjs";

const N = Number(process.env.SHOWCASE_N || 10);
const MODEL = process.env.SHOWCASE_MODEL || "anthropic/claude-haiku-4-5";
const OUT = "bench/showcase";
mkdirSync(OUT, { recursive: true });
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY (run with --env-file=.env)");
  process.exit(1);
}

// A free port per run: the sidecar is a second CDP client on the launch port,
// and each run gets a fresh browser. Bind :0, read the port, release it.
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

// The trap (truth: NOT placed) and the hard-clean set (truth: placed) whose
// SHAPE tempts a false halt — the cry-wolf guard. Both from bench fixtures.
const TRAP = { id: "optimistic-ui", instruction: "click the 'Place order' button", q: "Was the order placed successfully?" };
const CLEAN = [
  { id: "masked-phone", instruction: "enter 5551234567 in the phone number field", q: "Was the phone number saved?" },
  { id: "blur-validate", instruction: "click the 'Place order' button", q: "Was the order placed?" },
  { id: "modal-cookie", instruction: "click the 'Place order' button", q: "Was the order placed?" },
];

const fx = await startFixtures();

async function runOne(task, run) {
  await fx.reset();
  const port = await freePort();
  const browser = await localBrowser.launch({ headless: true, port });
  const stagehand = await Stagehand.create({
    browser,
    model: { modelName: MODEL, apiKey: process.env.ANTHROPIC_API_KEY },
    logging: { level: "error" },
  });
  const jsonl = `${OUT}/${task.id}__${run}.jsonl`;
  const { act, extract, page, replay } = withTrueFact(stagehand, { jsonl, screenshots: true, network: { port } });
  let belief = null;
  try {
    await page.goto(fx.url(task.id));
    await act(task.instruction);
    const b = await extract(task.q + " Answer only yes or no.");
    belief = /^\s*yes/i.test(b?.data?.extraction ?? "");
  } catch (e) {
    process.stderr.write(`  ${task.id} #${run} threw: ${String(e).slice(0, 120)}\n`);
  }
  const oracle = await fx.truth(task.id);
  const step = [...replay.steps].reverse().find((s) => s.kind === "write");
  await browser.close();
  return {
    task: task.id,
    run,
    jsonl,
    claim: step?.agent_claim?.success ?? null, // the agent's execution self-report
    belief, // the agent's belief self-report (same model, one question)
    pageRead: step?.evidence?.postcondition?.auto?.verdict ?? null, // BEFORE: page channel alone
    verdict: step?.verdict ?? null, // AFTER: with the network sidecar
    reason: step?.evidence?.postcondition?.reason ?? null,
    oracle: oracle.landed, // ground truth, read out of band
  };
}

console.log(`showcase: ${MODEL} · n=${N} · ${TRAP.id} (trap) + ${CLEAN.map((c) => c.id).join(", ")} (clean)\n`);
const rows = [];
for (const task of [TRAP, ...CLEAN]) {
  for (let run = 1; run <= N; run++) {
    const r = await runOne(task, run);
    rows.push(r);
    process.stdout.write(
      `${r.task.padEnd(15)} #${String(run).padStart(2)}  claim=${r.claim} belief=${r.belief}  page=${String(r.pageRead).padEnd(12)} →net=${String(r.verdict).padEnd(12)} (${r.reason ?? ""})  oracle=${r.oracle}\n`,
    );
  }
}
await fx.close();
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));

// --- score: the before/after the showcase exists to show ---------------------
const trap = rows.filter((r) => r.task === TRAP.id);
const believed = trap.filter((r) => r.belief === true || r.claim === true); // model reported success
const pageFooled = trap.filter((r) => r.pageRead === "landed"); // page read alone said landed
const caught = trap.filter((r) => r.verdict === "did-not-land"); // network flipped it

const clean = rows.filter((r) => r.task !== TRAP.id);
const genuine = clean.filter((r) => r.oracle === true); // a real success happened
const falseHalt = genuine.filter((r) => r.verdict === "did-not-land"); // cry-wolf
const bestTrap = caught.find((r) => r.claim === true) ?? caught[0] ?? trap[0];

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "0/0 (—)");
const md = `# TrueFact showcase — the optimistic-UI catch

Model: **${MODEL}** · n=${N}/task · network sidecar **ON** · ${new Date().toISOString().slice(0, 10)}
Unlike [bench/out/report.md](../out/report.md) (the 520-run ladder, run before the
network sidecar existed), this run has it on. Ground truth is the server oracle,
read out of band; the wrapped agent never sees it.

## The trap: \`optimistic-ui\` — page shows "✅ Order placed", server returned 500

The server records the order as **NOT placed** on every run. What each channel said:

| channel | verdict | correct? |
|---|---|---|
| The agent's own claim | success ${pct(believed.length, trap.length)} of runs | ✗ wrong |
| TrueFact, page read alone | \`landed\` ${pct(pageFooled.length, trap.length)} | ✗ fooled by the ✅ |
| **TrueFact + network** | **\`did-not-land\`** ${pct(caught.length, trap.length)} | ✓ **caught** |

The agent believed it, and the page *looked* right — the network channel is what
tells the truth apart from the banner.

## The guard: does it cry wolf?

The hard-clean set (\`masked-phone\`, \`blur-validate\`, \`modal-cookie\`) are genuine
successes whose shape tempts a false halt. Across ${genuine.length} genuine successes:

- **false halts (cry-wolf): ${pct(falseHalt.length, genuine.length)}** ${falseHalt.length === 0 ? "— none. The catch is not trigger-happiness." : "⚠︎ investigate"}

## See one

\`\`\`bash
truefact view ${bestTrap?.jsonl ?? OUT + "/optimistic-ui__1.jsonl"}
\`\`\`

Opens on the step that didn't land: the page diff with the ✅ banner, the 500 in
the network panel, and — boxed off as the untrusted channel — the agent's
"success". One run is the whole pitch.
`;
writeFileSync(`${OUT}/showcase.md`, md);
console.log(`\n${"=".repeat(60)}`);
console.log(`trap caught (network):   ${pct(caught.length, trap.length)}`);
console.log(`page read alone fooled:  ${pct(pageFooled.length, trap.length)}`);
console.log(`cry-wolf (false halts):  ${pct(falseHalt.length, genuine.length)}`);
console.log(`report:  ${OUT}/showcase.md`);
console.log(`view:    truefact view ${bestTrap?.jsonl ?? ""}`);
