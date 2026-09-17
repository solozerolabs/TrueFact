// The three Day-5.5 additions: step cost from result metadata, JSONL
// persistence, and secret redaction of free-text fields.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withReplay, type Step } from "../src/index.js";
import { redactText } from "../src/redact.js";
import { fakeStagehand, withBrowser, serve, type Fixture } from "./helpers.js";

describe("redactText", () => {
  it("scrubs an API key and an email, leaves plain text alone", () => {
    const out = redactText("key sk-ant-abcdefghij0123456789XY mail a@b.com click login");
    assert.equal(out, "key [REDACTED:anthropic_key] mail [REDACTED:email] click login");
  });
});

describe("withReplay: cost + jsonl", () => {
  const b = withBrowser();
  let fx: Fixture;
  const jsonl = join(tmpdir(), `truereplay-${process.pid}.jsonl`);
  before(async () => {
    await b.start();
    fx = await serve({ "/f": `<html><body><main><button id="go">go</button></main></body></html>` });
  });
  after(async () => {
    await b.stop();
    await fx.close();
    rmSync(jsonl, { force: true });
  });

  it("reads usage into step.cost, redacts the agent message, and appends one JSONL line", async () => {
    const sh = fakeStagehand(await b.start(), await b.page(), {
      actions: [{ selector: "#go" }],
      message: "sent to leak@corp.com", // must not survive into the record
      usage: { inputTokens: 10, outputTokens: 4, inferenceTimeMs: 120 },
    });
    const { act, page, replay } = withReplay(sh, { screenshots: false, jsonl });
    await page.goto(fx.base + "/f");
    await act("click go");

    const write = replay.steps.find((s) => s.kind === "write")!;
    assert.equal(write.cost?.inputTokens, 10);
    assert.equal(write.cost?.totalTokens, 14); // summed when the result omits totalTokens
    assert.equal(write.cost?.inferenceTimeMs, 120);
    assert.equal(write.agent_claim?.message, "sent to [REDACTED:email]");

    // JSONL holds every step, and the persisted write matches memory exactly.
    const lines = readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Step);
    assert.equal(lines.length, replay.steps.length);
    const persisted = lines.find((s) => s.kind === "write")!;
    assert.deepEqual(persisted, write);
  });
});
