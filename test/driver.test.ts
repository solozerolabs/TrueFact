// M7 Phase 0 — the driver seam. Every existing test already runs through it
// (withReplay wraps a Stagehand via stagehandDriver internally). This proves
// the new boundary: withReplay also accepts a ready Driver directly, which is
// how a Phase 2 non-Stagehand driver plugs in. See docs/M7-PLAN.md.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { withReplay, verifyChain } from "../src/index.js";
import { stagehandDriver } from "../src/driver.js";
import { serve, withBrowser, fakeStagehand, type Fixture } from "./helpers.js";

describe("driver seam: withReplay accepts a Driver, not only a Stagehand", () => {
  const b = withBrowser();
  let fx: Fixture;
  before(async () => {
    await b.start();
    fx = await serve({
      "/f": `<!doctype html><meta charset=utf8><button id=go>Go</button>
        <script>document.getElementById('go').onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);};</script>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  it("drives a write and produces a verdict + valid chain through an explicit Driver", async () => {
    const page = await b.page();
    const sh = fakeStagehand(await b.start(), page, { actions: [{ selector: "#go" }] });
    const driver = stagehandDriver(sh); // the seam: hand withReplay a Driver
    const w = withReplay(driver, { screenshots: false, waitMs: 400 });
    await w.page.goto(`${fx.base}/f`);
    await w.act("click go");
    const step = w.replay.steps.at(-1)!;
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "landed"); // a role=status confirmation appeared
    assert.equal(verifyChain(w.replay.steps).ok, true);
  });
});
