// M7 Phase 0 — the driver seam. Every existing test already runs through it
// (withTrueFact wraps a Stagehand via stagehandDriver internally). This proves
// the new boundary: withTrueFact also accepts a ready Driver directly, which is
// how a Phase 2 non-Stagehand driver plugs in. See docs/M7-PLAN.md.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Stagehand } from "@browserbasehq/stagehand";
import { withTrueFact, verifyChain, type Step } from "../src/index.js";
import { stagehandDriver } from "../src/driver.js";
import { serve, withBrowser, fakeStagehand, type Fixture } from "./helpers.js";

// OBSERVER-PLAN §3/§4 evidence fields, read off a step. Typed here (not in
// src/) so this file runs before the fields exist — the point of a red test.
type Observed = Step["evidence"] & {
  observer?: { network: "watched" | "blind" | "off"; lost?: string };
  context?: { before: { target: string; origin: string }; after: { target: string; origin: string } };
};
const observed = (s: Step): Observed => s.evidence as Observed;

/** A Stagehand fake whose `act` runs an arbitrary async body (close a tab,
 *  re-focus another) and reports one click, exactly like fakeStagehand. */
function actingStagehand(sh: Stagehand, body: () => Promise<void>): Stagehand {
  return {
    browser: sh.browser,
    act: async () => {
      await body();
      return {
        data: { success: true, message: "", actionDescription: "#go", actions: [{ selector: "#go", description: "", method: "click", arguments: [] }] },
        metadata: {},
      };
    },
    extract: async () => ({ data: undefined, metadata: {} }),
    observe: async () => [],
  } as unknown as Stagehand;
}

describe("driver seam: withTrueFact accepts a Driver, not only a Stagehand", () => {
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
    const driver = stagehandDriver(sh); // the seam: hand withTrueFact a Driver
    const w = withTrueFact(driver, { screenshots: false, waitMs: 400 });
    await w.page.goto(`${fx.base}/f`);
    await w.act("click go");
    const step = w.replay.steps.at(-1)!;
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "landed"); // a role=status confirmation appeared
    assert.equal(verifyChain(w.replay.steps).ok, true);
  });
});

// ---------------------------------------------------------------------------
// OBSERVER-PLAN §3 (A8) + §4 (B1, B2): observation context and observer
// liveness through the Stagehand driver. Own browser: A8 closes the last tab.
// The tab-closing cases run LAST in this block — order is load-bearing.
// ---------------------------------------------------------------------------
describe("stagehand driver: observation context and observer liveness", () => {
  const b = withBrowser();
  let fx: Fixture;
  before(async () => {
    await b.start();
    fx = await serve({
      "/f": `<!doctype html><meta charset=utf8><button id=go>Go</button>
        <script>document.getElementById('go').onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);};</script>`,
      "/nav": `<!doctype html><meta charset=utf8><main><a id="ext" href="/tab2" target="_blank">open</a></main>`,
      "/tab2": `<!doctype html><meta charset=utf8><main><h1>tab2</h1></main>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });
  const origin = () => new URL(fx.base).origin;
  const lastWrite = (steps: Step[]) => steps.filter((s) => s.kind === "write").at(-1)!;
  /** Back to exactly one focused tab (the cases below depend on the tab count). */
  const oneTab = async (sh: Stagehand) => {
    const bc = sh.browser.context;
    const pages = await bc.pages();
    for (const p of pages.slice(1)) await p.close().catch(() => {});
    await bc.setActivePage(pages[0]);
  };

  it("given a normal same-tab click, when the step is recorded, then context.before and context.after name the same target and the fixture origin", async () => {
    const page = await b.page();
    const sh = fakeStagehand(await b.start(), page, { actions: [{ selector: "#go" }] });
    const w = withTrueFact(sh, { screenshots: false, waitMs: 400 });
    await w.page.goto(`${fx.base}/f`);
    await w.act("click go");
    const ctx = observed(lastWrite(w.replay.steps)).context;
    assert.ok(ctx, "evidence.context is recorded on a write step");
    assert.ok(ctx.before.target.length > 0, "before.target is a real target id");
    assert.equal(ctx.after.target, ctx.before.target);
    assert.equal(ctx.before.origin, origin());
    assert.equal(ctx.after.origin, origin());
  });

  it("B1: given a click that opens a new tab, when the step is recorded, then landed / new-page and context.after.target is a new, different target", async () => {
    const sh0 = await b.start();
    const page = await b.page();
    const sh = fakeStagehand(sh0, page, { actions: [{ selector: "#ext" }] });
    const w = withTrueFact(sh, { screenshots: false, waitMs: 400 });
    await w.page.goto(`${fx.base}/nav`);
    try {
      await w.act("open in a new tab");
      const step = lastWrite(w.replay.steps);
      assert.equal(step.verdict, "landed");
      assert.equal(step.evidence.postcondition?.reason, "new-page");
      const ctx = observed(step).context;
      assert.ok(ctx, "evidence.context is recorded on a write step");
      assert.ok(ctx.after.target.length > 0, "after.target is a real target id");
      assert.notEqual(ctx.after.target, ctx.before.target);
    } finally {
      await oneTab(sh0); // even when red: the cases below need a single tab
    }
  });

  it("B2: given an older tab exists and the active tab closes during the action (focus falls back to the older tab), then inconclusive / context-changed with context.after.target === the older tab", async () => {
    const sh0 = await b.start();
    const bc = sh0.browser.context;
    const older = await bc.newPage();
    await older.goto(`${fx.base}/tab2`); // a real page, so a blank-tab obstruction can't mask the verdict
    const active = await bc.newPage();
    await bc.setActivePage(active);
    await active.goto(`${fx.base}/f`);
    const beforeSet = (await bc.pages()).map((p) => p.pageId);
    assert.ok(beforeSet.includes(older.pageId), "the older tab is in the before-set");
    // A framework that re-focuses an existing tab after the active one dies:
    // nothing this action did opened `older`, so it is not a new page.
    const sh = actingStagehand(sh0, async () => {
      await active.close();
      await bc.setActivePage(older);
    });
    const w = withTrueFact(sh, { screenshots: false, waitMs: 400 });
    try {
      await w.act("click go");
      const step = lastWrite(w.replay.steps);
      assert.equal(step.verdict, "inconclusive");
      assert.equal(step.evidence.postcondition?.reason, "context-changed");
      const ctx = observed(step).context;
      assert.ok(ctx, "evidence.context is recorded on a write step");
      assert.equal(ctx.after.target, older.pageId);
      assert.notEqual(ctx.after.target, ctx.before.target);
    } finally {
      await oneTab(sh0);
    }
  });

  it("A8: given the only Stagehand tab closes during the action, when act is awaited, then it rejects AND one write step is recorded as inconclusive / observer-lost (after: null, lost: no-active-page)", async () => {
    const sh0 = await b.start();
    await oneTab(sh0);
    const page = await b.page();
    await page.goto(`${fx.base}/f`);
    assert.equal((await sh0.browser.context.pages()).length, 1, "precondition: exactly one tab");
    const sh = actingStagehand(sh0, async () => {
      await page.close();
    });
    const w = withTrueFact(sh, { screenshots: false, waitMs: 400 });
    await assert.rejects(w.act("click go"), "act rethrows when the tab is gone after the action");
    const writes = w.replay.steps.filter((s) => s.kind === "write");
    assert.equal(writes.length, 1, "a write that ran always gets a step, even with nothing to read afterwards");
    const step = writes[0];
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "observer-lost");
    assert.equal(step.evidence.after, null);
    assert.equal(observed(step).observer?.lost, "no-active-page");
    assert.equal(verifyChain(w.replay.steps).ok, true);
  });
});
