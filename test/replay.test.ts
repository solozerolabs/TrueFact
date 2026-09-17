// Pure roll-up logic (no browser) + the wrapper's nav path on a real Stagehand with no model.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rollup, combine, withReplay } from "../src/index.js";
import { step, withBrowser, serve, type Fixture } from "./helpers.js";

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
