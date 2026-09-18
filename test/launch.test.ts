// launch() — the one-call entry point. Proves the plumbing without an LLM:
// it picks a free port, brings up Chrome, wraps with the sidecar, records a
// navigation into a verifiable chain, and close() tears the browser down.
// (The network CATCH itself is proven in sidecar-network.test.ts; launch just
// supplies the port that path already uses.)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { launch, verifyChain } from "../src/index.js";
import { serve, type Fixture } from "./helpers.js";

describe("launch: zero-config browser + network verification", () => {
  let fx: Fixture;
  before(async () => {
    fx = await serve({ "/p": `<!doctype html><meta charset=utf8><title>P</title><h1>hello</h1>` });
  });
  after(async () => {
    await fx.close();
  });

  it("launches, records a signed navigation into a valid chain, and closes cleanly", async () => {
    const kp = generateKeyPairSync("ed25519");
    const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const tr = await launch({ headless: true, screenshots: false, signingKey: priv });
    try {
      await tr.page.goto(`${fx.base}/p`);
      assert.ok(tr.replay.steps.length >= 1);
      assert.equal(tr.replay.steps[0].kind, "nav");
      assert.ok(tr.replay.steps[0].sig, "the real writer signed the step");
      assert.equal(verifyChain(tr.replay.steps, { publicKey: pub }).ok, true); // M9: signature checks out end to end
      assert.ok(tr.browser); // the handle it owns
    } finally {
      await tr.close(); // closes sidecar + browser; must not throw
    }
  });

  it("two launches pick different ports (no fixed-port collision)", async () => {
    const a = await launch({ headless: true, screenshots: false });
    const b = await launch({ headless: true, screenshots: false });
    try {
      await a.page.goto(`${fx.base}/p`);
      await b.page.goto(`${fx.base}/p`);
      assert.equal(verifyChain(a.replay.steps).ok, true);
      assert.equal(verifyChain(b.replay.steps).ok, true);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
