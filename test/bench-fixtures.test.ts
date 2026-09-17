// Day 6 — the fixtures themselves, on a real browser with no LLM. The harness
// can be wrong before any model runs, so the oracle gets the same treatment as
// the wrapper: fakeStagehand performs the decisive action and we read /truth.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { withReplay } from "../src/index.js";
import { fakeStagehand, withBrowser } from "./helpers.js";
// @ts-expect-error — .mjs fixture, no types
import { startFixtures } from "../scripts/bench/fixtures.mjs";

describe("bench fixtures: the oracle is honest", () => {
  const b = withBrowser();
  let fx: Awaited<ReturnType<typeof startFixtures>>;
  before(async () => {
    await b.start();
    fx = await startFixtures();
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  // Run one decisive action through the wrapper, then read the out-of-band oracle.
  const runTask = async (task: string, actions: { selector: string; method?: string; args?: string[] }[]) => {
    await fx.reset();
    const sh = fakeStagehand(await b.start(), await b.page(), { actions });
    const { act, replay } = withReplay(sh, { screenshots: false, waitMs: 900 });
    await (await b.page()).goto(fx.url(task));
    await act(`do: ${task}`);
    return { step: replay.steps.at(-1)!, truth: await fx.truth(task) };
  };
  const click = [{ selector: "#place" }];

  it("clean-checkout: a real click lands, and reset clears the oracle", async () => {
    const { truth } = await runTask("clean-checkout", click);
    assert.equal(truth.landed, true);
    await fx.reset();
    assert.equal((await fx.truth("clean-checkout")).landed, false);
  });

  it("overlay-checkout: the scrim takes the click — oracle stays false and TrueReplay says did-not-land/overlay (Probe Run 2 regression)", async () => {
    const { step, truth } = await runTask("overlay-checkout", click);
    assert.equal(truth.landed, false);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.session.obstruction, "overlay");
  });

  it("optimistic-ui: the banner lies, the POST fails — oracle false, and TrueReplay currently MISSES it (the measured ceiling)", async () => {
    const { step, truth } = await runTask("optimistic-ui", click);
    assert.equal(truth.landed, false); // the write genuinely did not happen
    // This is the product's known ceiling (DAY6 §6): a page that lies to its user
    // lies to the confirmation heuristic. Pinned so an improvement flips this test.
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
  });

  it("slow-confirm: the POST is real even though the banner is late — oracle true", async () => {
    assert.equal((await runTask("slow-confirm", click)).truth.landed, true);
  });

  it("clean-settings: an in-place save reaches the oracle", async () => {
    assert.equal((await runTask("clean-settings", [{ selector: "#save" }])).truth.landed, true);
  });

  it("clean-form: a fill + submit that navigates still records the write", async () => {
    const { truth } = await runTask("clean-form", [{ selector: "#email", method: "fill", args: ["a@b.co"] }, { selector: "#signup" }]);
    assert.equal(truth.landed, true);
  });

  for (const task of ["expired-session", "captcha-gate", "validation-reject", "silent-noop"]) {
    it(`${task}: the decisive click never reaches the oracle`, async () => {
      assert.equal((await runTask(task, click)).truth.landed, false);
    });
  }
});
