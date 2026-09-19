// The real-site campaign runner. Drives each pre-registered trial (scripts/live/
// sites.mjs) through TrueFact, reads independent ground truth out of band, and
// appends one manifest row per trial×config. Records, never asserts — live sites
// are non-deterministic (score with scripts/live/score.mjs). See the spec §2.3.
//
//   node scripts/live/run.mjs            scripted, keyless, free — the metric
//   node --env-file=.env scripts/live/run.mjs --agent   autonomous funnel run
//
// One trial at a time per browser: the sidecar bracket is serial (one mark open),
// exactly like scripts/bench/run.mjs.
import net from "node:net";
import http from "node:http";
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright-core";
import { localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../../dist/index.js";
import { playwrightDriver } from "../../dist/driver-playwright.js";
import { cdpConnect } from "../../dist/cdp.js";
import { verifyChain } from "../../dist/chain.js";
import { arm } from "./inject.mjs";
import { truthOf } from "./oracle.mjs";
import { TRIALS, shimPage } from "./sites.mjs";

const AGENT = process.argv.includes("--agent");
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const OUT = "live/out";
mkdirSync(OUT, { recursive: true });

// Single-run lock (a run owns Chromes + real third-party traffic) — same rule as bench.
const LOCK = `${OUT}/.run.lock`;
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, "utf8").trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
  if (alive) { console.error(`A live run is active (pid ${pid}). Wait, or rm ${LOCK} if stale.`); process.exit(1); }
}
writeFileSync(LOCK, String(process.pid));
const release = () => { try { if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK); } catch {} };
process.on("exit", release); process.on("SIGINT", () => { release(); process.exit(130); });

// Serve a one-button optimistic shim for `postTo` rows (the write is third-party).
async function serveShim(postTo, body) {
  const port = await freePort();
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(shimPage(postTo, body)); });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const configsFor = (trial) => Object.keys(trial.expect).filter((c) => c === "zero" || c === "bodyErrors" || c === "declared");

async function runTrial(trial, config) {
  const port = await freePort();
  const chrome = await localBrowser.launch({ headless: true, port });
  let shim, injector, injConn, model = "scripted", claimExec = null, claimBelief = null;
  const jsonl = `${OUT}/${trial.id.replace(/\W+/g, "-")}__${config}.jsonl`;
  try {
    const pw = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = pw.contexts()[0].pages()[0] ?? (await pw.contexts()[0].newPage());
    const target = trial.page ?? (shim = await serveShim(trial.postTo, trial.body)).url;

    const net = { port, apiOrigins: trial.write.apiOrigins ?? [], bodyErrors: config === "bodyErrors" };
    const w = withTrueFact(playwrightDriver(page), { network: net, jsonl, screenshots: false, waitMs: 1500 });
    await w.page.goto(target);
    await page.waitForLoadState?.("domcontentloaded").catch(() => {});

    if (trial.inject) {
      injConn = await cdpConnect(port);
      injector = await arm(injConn, { urlPattern: trial.write.urlPattern, mode: trial.inject });
    }

    if (AGENT && trial.instruction) {
      const { Stagehand } = await import("@browserbasehq/stagehand");
      const sh = await Stagehand.create({ browser: chrome, model: { modelName: process.env.MODEL || "anthropic/claude-sonnet-4-5", apiKey: process.env.ANTHROPIC_API_KEY }, logging: { level: "error" } });
      const wa = withTrueFact(sh, { network: net, jsonl, screenshots: false, waitMs: 1500 });
      model = process.env.MODEL || "anthropic/claude-sonnet-4-5";
      await wa.page.goto(target);
      await wa.act(trial.instruction);
      if (trial.completionQuestion) { try { const b = await wa.extract(trial.completionQuestion + " Answer only yes or no."); claimBelief = /^\s*yes/i.test(b?.data?.extraction ?? ""); } catch {} }
      var replay = wa.replay;
    } else {
      for (const s of trial.steps) await w.act(s);
      var replay = w.replay;
    }

    const decisive = [...replay.steps].reverse().find((s) => s.kind === "write");
    claimExec = decisive?.agent_claim?.success ?? null;
    const verdict = decisive?.verdict ?? "inconclusive";
    const reason = decisive?.evidence?.postcondition?.reason;
    const injectorConfirmed = injector ? injector.confirmed() : undefined;
    await injector?.disarm();

    const oracleLanded = await truthOf(trial.oracle, { injectorConfirmed });
    const chainOk = existsSync(jsonl) ? verifyChain(readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))).ok : undefined;

    return { site: trial.id, stratum: trial.stratum, config, induced: trial.inject ?? "none", oracleKind: trial.oracle.kind, injectorConfirmed, oracleLanded, verdict, reason, claimExec, claimBelief, model, evidenceLog: jsonl, chainOk, checkedLive: trial.checkedLive, expect: trial.expect, task: trial.id, run: 0, provider: "local" };
  } finally {
    await injConn?.close?.();
    await shim?.close?.();
    await chrome.close();
  }
}

const manifest = `${OUT}/manifest.jsonl`;
writeFileSync(manifest, "");
console.log(`live run (${AGENT ? "autonomous" : "scripted"}) · ${TRIALS.length} trials`);
for (const trial of TRIALS) {
  if (AGENT && !trial.instruction) continue; // autonomous rows must carry an NL instruction
  for (const config of configsFor(trial)) {
    let row;
    try { row = await runTrial(trial, config); }
    catch (e) { row = { site: trial.id, stratum: trial.stratum, config, error: String(e).slice(0, 160), oracleLanded: "unknown", verdict: "inconclusive", claimExec: null, run: 0 }; process.stderr.write(`  ! ${trial.id}/${config}: ${row.error}\n`); }
    appendFileSync(manifest, JSON.stringify(row) + "\n");
    const flag = row.oracleLanded !== "unknown" && ((row.oracleLanded === false && row.verdict === "landed") ? "  ⟵ FALSE-LANDED" : (row.oracleLanded === true && row.verdict === "did-not-land") ? "  ⟵ CRY-WOLF" : "");
    process.stdout.write(`  ${String(row.stratum).padEnd(3)} ${trial.id.padEnd(34)} ${String(config).padEnd(10)} verdict=${String(row.verdict).padEnd(13)} truth=${row.oracleLanded}${flag}\n`);
  }
}
console.log(`\nmanifest: ${manifest}\nscore:    npm run live:score`);
