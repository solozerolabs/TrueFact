// M6 — the fleet number + CI gate, pure rollups over recorded runs. Hermetic:
// build runs as jsonl files and check the numbers and the gate exit code. No
// browser. See docs/SPEC-V2.md §7.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeRun, rollupRuns } from "../src/fleet.js";
import { step } from "./helpers.js";
import type { Step } from "../src/index.js";
import type { Verdict } from "../src/postcondition.js";

const run = (...verdicts: Verdict[]): Step[] => verdicts.map((v) => step({ kind: "write", verdict: v }));

describe("rollupRuns (pure): the true landed rate", () => {
  it("summarizeRun rolls a run's write steps to one verdict", () => {
    assert.equal(summarizeRun(run("landed", "did-not-land")).verdict, "did-not-land");
    assert.equal(summarizeRun(run("landed", "landed")).verdict, "landed");
    // issue #2: a landed write is not erased by a later inconclusive retry.
    assert.equal(summarizeRun(run("landed", "inconclusive")).verdict, "landed");
  });

  it("counts and rates come from verdicts", () => {
    const s = rollupRuns([run("landed"), run("landed"), run("did-not-land"), run("inconclusive")].map((r) => summarizeRun(r)));
    assert.equal(s.runs, 4);
    assert.equal(s.landed, 2);
    assert.equal(s.didNotLand, 1);
    assert.equal(s.inconclusive, 1);
    assert.equal(s.landedRate, 0.5);
    assert.equal(s.didNotLandRate, 0.25);
    assert.equal(s.needReview.length, 2); // the non-landed runs
  });

  it("an empty fleet is all zeros, not NaN", () => {
    const s = rollupRuns([]);
    assert.equal(s.runs, 0);
    assert.equal(s.landedRate, 0);
  });
});

describe("fleet + gate CLI over jsonl files", () => {
  let dir = "";
  let files: string[] = [];
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "truefact-fleet-"));
    const runs: Step[][] = [run("landed"), run("landed"), run("did-not-land")];
    files = runs.map((r, i) => {
      const p = join(dir, `run${i}.jsonl`);
      writeFileSync(p, r.map((s) => JSON.stringify(s)).join("\n") + "\n");
      return p;
    });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fleet prints the landed and did-not-land rates", () => {
    const out = execFileSync("node", ["dist/cli.js", "fleet", ...files], { encoding: "utf8" });
    assert.match(out, /3 runs/);
    assert.match(out, /landed 66\.7%/);
    assert.match(out, /did-not-land 33\.3%/);
  });

  it("gate exits 1 when the did-not-land rate exceeds the max", () => {
    let code = 0;
    let out = "";
    try {
      out = execFileSync("node", ["dist/cli.js", "gate", ...files, "--max-did-not-land", "0.05"], { encoding: "utf8" });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      out = err.stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /FAIL/);
  });

  it("gate exits 0 when the rate is within the max", () => {
    const out = execFileSync("node", ["dist/cli.js", "gate", ...files, "--max-did-not-land", "0.5"], { encoding: "utf8" });
    assert.match(out, /OK/);
  });
});
