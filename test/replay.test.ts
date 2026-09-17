// Pure roll-up logic (no browser) + the wrapper's nav path on a real Stagehand with no model.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rollup, combine, withReplay } from "../src/index.js";
import { step, fakeStagehand, withBrowser, serve, type Fixture } from "./helpers.js";

describe("rollup (write steps only)", () => {
  it("a did-not-land write makes the run did-not-land", () => {
    assert.equal(rollup([step({ verdict: "did-not-land" }), step({ verdict: "inconclusive" })]), "did-not-land");
  });
  it("an inconclusive read does not poison writes that landed", () => {
    assert.equal(rollup([step({ verdict: "landed" }), step({ kind: "read", verdict: "inconclusive" })]), "landed");
  });
  it("no write steps -> inconclusive", () => {
    assert.equal(rollup([step({ kind: "nav" })]), "inconclusive");
  });
});

describe("combine (run-level declaration only demotes)", () => {
  it("a failed run declaration demotes landed to did-not-land", () => {
    assert.equal(combine("landed", { declared: [], verdict: "did-not-land" }), "did-not-land");
  });
  it("an unreadable run declaration demotes landed to inconclusive", () => {
    assert.equal(combine("landed", { declared: [], verdict: "inconclusive" }), "inconclusive");
  });
  it("a met run declaration never lifts a step did-not-land", () => {
    assert.equal(combine("did-not-land", { declared: [], verdict: "landed" }), "did-not-land");
  });
});

describe("withReplay: nav path (no model)", () => {
  const b = withBrowser();
  let fx: Fixture;
  before(async () => {
    await b.start();
    fx = await serve({ "/nav": `<html><head><title>Nav</title></head><body><main><h1>hi</h1></main></body></html>` });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  it("records a nav step with before/after fingerprints and a session read", async () => {
    const { page, replay } = withReplay(await b.start(), { screenshots: false });
    await page.goto(fx.base + "/nav");
    const s = replay.steps[0];
    assert.equal(s.kind, "nav");
    assert.equal(s.agent_claim, null);
    assert.equal(s.evidence.after?.title, "Nav");
    assert.equal(s.evidence.nav?.status, 200);
    assert.equal(s.evidence.session.obstruction, null);
    assert.equal(replay.verdict, "inconclusive"); // no write steps
  });

  it("run-level claim is a separate channel set by the caller", async () => {
    const { replay } = withReplay(await b.start(), { screenshots: false });
    replay.setClaim(true, "scripted flow finished");
    assert.deepEqual(replay.claim, { done: true, note: "scripted flow finished" });
  });
});

describe("withReplay: grounding on extract (Day 5)", () => {
  const b = withBrowser();
  let fx: Fixture;
  before(async () => {
    await b.start();
    fx = await serve({
      "/receipt": `<html><head><title>Receipt</title></head><body><main><h1>Order #4242</h1><p>Total: <strong>$1,249.00</strong></p><span>Deluxe Widget</span><span>ada@example.com</span></main></body></html>`,
      "/plain": `<html><body><main><p>nothing useful here</p></main></body></html>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  // fakeStagehand.extract returns `data` verbatim; the browser/page read is real.
  const extractOn = async (path: string, data: unknown, opts?: unknown) => {
    const sh = fakeStagehand(await b.start(), await b.page(), { actions: [], extract: data });
    const { extract, replay } = withReplay(sh, { screenshots: false });
    await (await b.page()).goto(fx.base + path);
    await (extract as (i: string, o?: unknown) => Promise<unknown>)("get it", opts);
    return replay.steps.at(-1)!;
  };

  it("given an extract whose values are all on the page, then landed / grounded with the values listed", async () => {
    const s = await extractOn("/receipt", { order: "Order #4242", total: "$1,249.00", item: "Deluxe Widget" });
    assert.equal(s.kind, "read");
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.grounding?.reason, "grounded");
    assert.equal(s.evidence.grounding?.values.length, 3);
  });

  it("given an extract returning a value the tree lacks, then inconclusive / ungrounded and reads never move the roll-up", async () => {
    const s = await extractOn("/receipt", { total: "$1,249.00", promo: "SAVE-NOWHERE" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.grounding?.reason, "ungrounded");
    assert.ok(s.evidence.grounding?.values.some((v) => v.match === "absent"));
  });

  it("given a no-schema summary extraction, then nothing-to-ground, not a false ungrounded", async () => {
    const s = await extractOn("/receipt", { extraction: "The order total is high and the item is a deluxe widget shipped to Ada.".repeat(2) });
    assert.equal(s.evidence.grounding?.reason, "nothing-to-ground");
  });

  it("given screenshot: true, then grounding records visual so Day 6 can separate visual misses", async () => {
    const s = await extractOn("/receipt", { item: "Deluxe Widget" }, { screenshot: true });
    assert.equal(s.evidence.grounding?.visual, true);
    assert.equal(s.verdict, "landed");
  });

  it("given an observe step, then it does not ground (non-grounding), stays a read at inconclusive", async () => {
    const sh = fakeStagehand(await b.start(), await b.page(), { actions: [] });
    const { observe, replay } = withReplay(sh, { screenshots: false });
    await (await b.page()).goto(fx.base + "/plain");
    await observe("find things");
    const s = replay.steps.at(-1)!;
    assert.equal(s.kind, "read");
    assert.equal(s.evidence.grounding?.reason, "non-grounding");
    assert.equal(s.verdict, "inconclusive");
  });

  it("given an extracted email, then the stored value is redacted but the value still grounded (match preserved)", async () => {
    const s = await extractOn("/receipt", { contact: "ada@example.com" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.grounding?.values[0].match, "exact");
    assert.equal(s.evidence.grounding?.values[0].value, "[REDACTED:email]");
    assert.ok(!JSON.stringify(s).includes("ada@example.com"));
  });
});
