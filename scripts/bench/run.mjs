// Day 6 runner. For each task × ladder rung × run: reset the fixture, drive one
// decisive write with a REAL model wrapped by TrueFact, ask the SAME model to
// self-assess (the belief claim), read the server oracle out of band, and append
// a manifest row. Needs a key for the cloud rungs (git-ignored .env, via
// --env-file); the local oMLX rung needs none. Nothing here authors a claim.
// See docs/DAY6.md §4.  Usage:  node --env-file=.env scripts/bench/run.mjs
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { withReplay } from "../../dist/index.js";
import { startFixtures, TASKS } from "./fixtures.mjs";
import { omlxModel, omlxModelId } from "../omlx-model.mjs";

const N = Number(process.env.BENCH_N || 5);
const OUT = "bench/out";
mkdirSync(OUT, { recursive: true });

// $/1M tokens [input, output]. Editable — prices AND model ids move; set each
// id to whatever your provider/Stagehand currently accepts. Local is free.
const PRICES = {
  "anthropic/claude-opus-4-8": [15, 75],
  "anthropic/claude-sonnet-4-5": [3, 15],
  "anthropic/claude-haiku-4-5": [1, 5],
  "openai/gpt-5.4": [10, 30],
  local: [0, 0],
};
const costUsd = (cost, model) => {
  const [pin, pout] = PRICES[model] ?? PRICES.local;
  return cost ? (cost.inputTokens / 1e6) * pin + (cost.outputTokens / 1e6) * pout : 0;
};

// The ladder: skip a rung whose key is absent. Local (oMLX) needs none.
async function ladder() {
  const rungs = [];
  // Weak -> strong ladder: the false-success curve should fall as the rung climbs.
  if (process.env.ANTHROPIC_API_KEY) {
    for (const id of ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-8"]) {
      rungs.push({ model: id, make: () => ({ modelName: id, apiKey: process.env.ANTHROPIC_API_KEY }) });
    }
  }
  if (process.env.OPENAI_API_KEY) rungs.push({ model: "openai/gpt-5.4", make: () => ({ modelName: "openai/gpt-5.4", apiKey: process.env.OPENAI_API_KEY }) });
  try { const id = await omlxModelId(); rungs.push({ model: "local", make: () => omlxModel(id) }); } catch { /* oMLX not running */ }
  return rungs;
}

const fx = await startFixtures();
const rungs = await ladder();
if (!rungs.length) { console.error("No models. Set ANTHROPIC_API_KEY / OPENAI_API_KEY, or start oMLX."); process.exit(1); }
console.log(`ladder: ${rungs.map((r) => r.model).join(", ")}  ·  ${N} runs/task/rung  ·  ${TASKS.length} tasks`);

const manifest = `${OUT}/oracle.jsonl`;
writeFileSync(manifest, "");

for (const task of TASKS) {
  for (const rung of rungs) {
    for (let run = 1; run <= N; run++) {
      await fx.reset();
      const browser = await localBrowser.launch({ headless: true });
      const stagehand = await Stagehand.create({ browser, model: rung.make(), logging: { level: "error" } });
      const jsonl = `${OUT}/${task.id}__${rung.model.replace(/\//g, "-")}__${run}.jsonl`;
      const { act, extract, page, replay } = withReplay(stagehand, { jsonl, screenshots: true });
      let claimBelief = null;
      try {
        await page.goto(fx.url(task.id));
        await act(task.instruction);
        // The graded party grades itself, from the page it is on. One fixed question, registered pre-run.
        const b = await extract(task.completionQuestion + " Answer only yes or no.");
        claimBelief = /^\s*yes/i.test(b?.data?.extraction ?? "");
      } catch (e) {
        process.stderr.write(`  ${task.id} ${rung.model} #${run} threw: ${String(e).slice(0, 120)}\n`);
      }
      const oracle = await fx.truth(task.id); // out of band — never through the wrapped page
      const decisive = [...replay.steps].reverse().find((s) => s.kind === "write");
      appendFileSync(manifest, JSON.stringify({
        task: task.id, model: rung.model, run, provider: "local",
        claimExec: decisive?.agent_claim?.success ?? false,
        claimBelief,
        verdict: decisive?.verdict ?? "inconclusive",
        reason: decisive?.evidence?.postcondition?.reason,
        oracleLanded: oracle.landed,
        costUsd: costUsd(decisive?.cost, rung.model),
      }) + "\n");
      await browser.close();
      process.stdout.write(`${task.id.padEnd(18)} ${rung.model.padEnd(28)} #${run} claim=${decisive?.agent_claim?.success} belief=${claimBelief} verdict=${decisive?.verdict} oracle=${oracle.landed}\n`);
    }
  }
}
await fx.close();
console.log(`\nmanifest: ${manifest}\nscore:    npm run bench:score`);
