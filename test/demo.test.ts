// The keyless `truefact demo` path. It launches its own Chrome (no model) and
// serves its own optimistic-UI fixture, so this is hermetic — it only needs the
// Stagehand peer already present for every other browser test. Guards the demo's
// contract: it catches the trap (did-not-land via the network sidecar) and
// leaves a chain-valid record. See src/demo.ts.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { runDemo } from "../src/demo.js";
import { verifyChain, type Step } from "../src/index.js";

describe("truefact demo (keyless, no model)", () => {
  after(() => rmSync("demo-run.jsonl", { force: true }));

  it("catches the optimistic-UI trap: exits 0, records a did-not-land write, chain verifies", async () => {
    const code = await runDemo();
    assert.equal(code, 0); // 0 iff verdict === did-not-land
    assert.ok(existsSync("demo-run.jsonl"));

    const steps = readFileSync("demo-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as Step);
    const write = steps.find((s) => s.kind === "write")!;
    assert.equal(write.verdict, "did-not-land"); // the network sidecar caught the POST 500
    assert.equal(write.evidence.postcondition?.reason, "network-error");
    assert.equal(verifyChain(steps).ok, true);
  });
});
