// Pure verdict logic (no browser) + one wrapper integration on the nav path
// (real Stagehand, no model — goto works without an LLM).
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { sessionVerdict, rollup, withReplay, type Step } from "../src/index.js";
import type { SessionEvidence } from "../src/session.js";

const session = (over: Partial<SessionEvidence> = {}): SessionEvidence => ({
  obstruction: null,
  confidence: "high",
  detail: "",
  checked: ["blank", "captcha", "login-wall", "overlay"],
  ...over,
});

const step = (over: Partial<Step>): Step => ({
  kind: "write",
  action: "act: x",
  declaration: "auto",
  verdict: "inconclusive",
  evidence: { before: null, after: null, settled: true, session: session() },
  attempt: null,
  agent_claim: null,
  timestamp: "",
  ...over,
});

describe("sessionVerdict (Day 2 obstruction rule / Day 3 destination gate)", () => {
  it("high-confidence obstruction -> did-not-land regardless of the verdict so far", () => {
    assert.equal(sessionVerdict("landed", session({ obstruction: "captcha", confidence: "high" })), "did-not-land");
    assert.equal(sessionVerdict("inconclusive", session({ obstruction: "blank", confidence: "high" })), "did-not-land");
  });
  it("heuristic obstruction only demotes a landed to inconclusive", () => {
    assert.equal(sessionVerdict("landed", session({ obstruction: "overlay", confidence: "heuristic" })), "inconclusive");
    assert.equal(sessionVerdict("did-not-land", session({ obstruction: "login-wall", confidence: "heuristic" })), "did-not-land");
  });
  it("no obstruction -> verdict unchanged", () => {
    assert.equal(sessionVerdict("landed", session()), "landed");
  });
});

describe("rollup (write steps only)", () => {
  it("a did-not-land write makes the run did-not-land", () => {
    assert.equal(rollup([step({ verdict: "did-not-land" }), step({ verdict: "inconclusive" })]), "did-not-land");
  });
  it("an inconclusive read does not poison writes that landed", () => {
    const steps = [
      step({ kind: "write", verdict: "landed" }),
      step({ kind: "read", verdict: "inconclusive" }),
    ];
    assert.equal(rollup(steps), "landed");
  });
  it("no write steps -> inconclusive", () => {
    assert.equal(rollup([step({ kind: "nav", verdict: "inconclusive" })]), "inconclusive");
  });
});

describe("withReplay: nav path (no model)", () => {
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  let stagehand: Stagehand;

  before(async () => {
    browser = await localBrowser.launch({ headless: true });
    stagehand = await Stagehand.create({ browser, logging: { level: "error" } });
  });
  after(async () => {
    await browser.close();
  });

  it("records a nav step with before/after fingerprints and a session read", async () => {
    const { page, replay } = withReplay(stagehand, { screenshots: false });
    await page.goto("data:text/html," + encodeURIComponent("<html><head><title>Nav</title></head><body><main><h1>hi</h1></main></body></html>"));
    assert.equal(replay.steps.length, 1);
    const s = replay.steps[0];
    assert.equal(s.kind, "nav");
    assert.equal(s.agent_claim, null); // nav steps carry no agent claim
    assert.ok(s.evidence.after);
    assert.equal(s.evidence.after!.title, "Nav");
    assert.equal(s.evidence.session.obstruction, null);
    assert.equal(replay.verdict, "inconclusive"); // no write steps yet
  });

  it("run-level claim is a separate channel set by the caller", () => {
    const { replay } = withReplay(stagehand, { screenshots: false });
    assert.equal(replay.claim, null);
    replay.setClaim(true, "scripted flow finished");
    assert.deepEqual(replay.claim, { done: true, note: "scripted flow finished" });
  });
});
