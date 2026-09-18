// M7 Phase 2 — the Playwright driver. Two proofs: the pure AX→line normalizer
// (the classifier signals survive the CDP tree), and a real headless-Chromium
// run showing withReplay produces a verdict + valid chain through a non-
// Stagehand driver, with the claim honestly absent. See docs/M7-PLAN.md.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { withReplay, verifyChain, axToLines } from "../src/index.js";
import { playwrightDriver } from "../src/driver-playwright.js";
import { serve, withPlaywrightBrowser, type Fixture } from "./helpers.js";

describe("axToLines: CDP AX tree -> classifier line grammar", () => {
  it("emits role/name lines with [checked], drops structural noise and ignored nodes", () => {
    const nodes = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["3", "4", "5", "7"] },
      { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Go" } },
      { nodeId: "4", parentId: "2", role: { value: "checkbox" }, name: { value: "agree" }, properties: [{ name: "checked", value: { value: "true" } }] },
      { nodeId: "5", parentId: "2", role: { value: "status" }, childIds: ["6"] },
      { nodeId: "6", parentId: "5", role: { value: "StaticText" }, name: { value: "Saved — #9" } },
      { nodeId: "7", parentId: "2", ignored: true, role: { value: "button" }, name: { value: "hidden" } },
    ];
    // RootWebArea + generic dropped (children spliced in); ignored node skipped;
    // status kept as a role-only line; StaticText carries the confirmation text.
    assert.deepEqual(axToLines(nodes), ["button: Go", "checkbox: agree [checked]", "status", "StaticText: Saved — #9"]);
  });
});

describe("playwright driver: withReplay drives a real write through the seam", () => {
  const b = withPlaywrightBrowser();
  let fx: Fixture;
  before(async () => {
    fx = await serve({
      "/f": `<!doctype html><meta charset=utf8><button id=go>Go</button>
        <script>document.getElementById('go').onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);};</script>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  it("produces a landed verdict + valid chain, and the claim is honestly null", async () => {
    const page = await b.page();
    const w = withReplay(playwrightDriver(page), { screenshots: false, waitMs: 400 });
    await w.page.goto(`${fx.base}/f`);
    await w.act({ selector: "#go", method: "click" }); // an action object, not NL

    const step = w.replay.steps.at(-1)!;
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "landed"); // role=status confirmation, read via CDP AX tree
    assert.equal(step.agent_claim, null); // Playwright self-reports nothing — honest degrade
    assert.equal(verifyChain(w.replay.steps).ok, true);
  });
});
