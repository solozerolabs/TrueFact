// Day 6 — the fixtures themselves, on a real browser with no LLM. The harness
// can be wrong before any model runs, so the oracle gets the same treatment as
// the wrapper: fakeStagehand performs the decisive action and we read /truth.
import { before, after, describe, it } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { localBrowser } from "@browserbasehq/stagehand";
import { withTrueFact } from "../src/index.js";
import { playwrightDriver } from "../src/driver-playwright.js";
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
    const { act, replay } = withTrueFact(sh, { screenshots: false, waitMs: 900 });
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

  it("overlay-checkout: the scrim takes the click — oracle stays false and TrueFact says did-not-land/overlay (Probe Run 2 regression)", async () => {
    const { step, truth } = await runTask("overlay-checkout", click);
    assert.equal(truth.landed, false);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.session.obstruction, "overlay");
  });

  it("optimistic-ui: the PAGE-READ floor alone misses the lying banner — landed (the network sidecar is the fix, see the recall-lever block below)", async () => {
    const { step, truth } = await runTask("optimistic-ui", click);
    assert.equal(truth.landed, false); // the write genuinely did not happen
    // Page-read ONLY (no network): a page that lies to its user lies to the
    // confirmation heuristic. This pins that floor's ceiling. The network sidecar
    // catches it out of band — see "network sidecar catches optimistic-ui" below,
    // and the bench runner now attaches it by default (scripts/bench/run.mjs).
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
  });

  it("slow-confirm: the POST is real even though the banner is late — oracle true", async () => {
    assert.equal((await runTask("slow-confirm", click)).truth.landed, true);
  });

  it("clean-settings: an in-place save reaches the oracle", async () => {
    assert.equal((await runTask("clean-settings", [{ selector: "#save" }])).truth.landed, true);
  });

  it("clean-form: a single submit that navigates still records the write", async () => {
    assert.equal((await runTask("clean-form", [{ selector: "#signup" }])).truth.landed, true);
  });

  for (const task of ["expired-session", "captcha-gate", "validation-reject", "silent-noop"]) {
    it(`${task}: the decisive click never reaches the oracle`, async () => {
      assert.equal((await runTask(task, click)).truth.landed, false);
    });
  }

  // Hard clean set: writes that LAND but whose shape once provoked a false halt.
  // The three false-halts are fixed; these pin the corrected verdicts so a
  // regression flips the test. cry-wolf on this set must stay 0.

  it("masked-phone: a masked fill reads back reformatted, but lands — field-match after alnum normalization", async () => {
    const { step, truth } = await runTask("masked-phone", [{ selector: "#phone", method: "fill", args: ["5551234567"] }]);
    assert.equal(truth.landed, true);
    assert.equal(step.verdict, "landed"); // "(555) 123-4567" normalizes to the typed digits
    assert.equal(step.evidence.postcondition?.reason, "field-match");
  });

  it("blur-validate: a stray invalid coupon beside a real confirmation does not outrank it — landed", async () => {
    const { step, truth } = await runTask("blur-validate", click);
    assert.equal(truth.landed, true);
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
  });

  it("modal-cookie: a corner aria-modal cookie card intercepts nothing, so it is no obstruction — not a halt", async () => {
    const { step, truth } = await runTask("modal-cookie", click);
    assert.equal(truth.landed, true);
    assert.equal(step.evidence.session.obstruction, null); // geometry check clears the non-covering modal
    assert.notEqual(step.verdict, "did-not-land"); // no longer a false halt (inconclusive: real write, no feedback)
  });
});

// The recall lever: with the network sidecar ON (as the bench runner now attaches
// it), the flagship optimistic-ui 500 is caught out of band. This is the fixture
// the page-read floor MISSES above (verdict "landed", the measured ceiling), so
// it pins the exact improvement the network wedge buys — at zero cry-wolf on a
// genuine landing. Driven by a real Playwright over CDP so the sidecar is a pure
// out-of-band second client, exactly like production.
describe("bench fixtures: network sidecar catches optimistic-ui (recall lever)", () => {
  let fx: Awaited<ReturnType<typeof startFixtures>>;
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>, page: import("playwright-core").Page, port = 0;
  before(async () => {
    fx = await startFixtures();
    const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    port = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r()));
    browser = await localBrowser.launch({ headless: true, port });
    const { chromium } = await import("playwright-core");
    const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = cdp.contexts()[0].pages()[0] ?? (await cdp.contexts()[0].newPage());
  });
  after(async () => { await browser?.close(); await fx?.close(); });

  const drive = async (task: string, action: { selector: string; method?: string; arguments?: string[] }, waitMs = 900) => {
    await fx.reset();
    const w = withTrueFact(playwrightDriver(page), { network: { port }, screenshots: false, waitMs });
    await w.page.goto(fx.url(task));
    await w.act(action);
    const stp = [...w.replay.steps].reverse().find((s) => s.kind === "write")!;
    const truth = await fx.truth(task);
    await w.close();
    return { step: stp, truth };
  };

  it("optimistic-ui: the 500 behind the lying banner → did-not-land (network-error)", async () => {
    const { step, truth } = await drive("optimistic-ui", { selector: "#place", method: "click" });
    assert.equal(truth.landed, false);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
  });

  it("clean-checkout: a genuine 200 landing is not falsely halted by the sidecar (cry-wolf guard)", async () => {
    const { step, truth } = await drive("clean-checkout", { selector: "#place", method: "click" });
    assert.equal(truth.landed, true);
    assert.notEqual(step.verdict, "did-not-land");
  });

  it("slow-reject: the 500 arrives AFTER the banner — the in-flight wait (§1) still catches it → did-not-land", async () => {
    const { step, truth } = await drive("slow-reject", { selector: "#place", method: "click" }, 2500);
    assert.equal(truth.landed, false);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
  });
});
