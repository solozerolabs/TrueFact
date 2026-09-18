// M1 — the tamper-evident hash chain. Each recorded step commits to the prior
// one; altering, reordering, or dropping a step breaks verification at that
// point. Pure tests for the primitives, plus a real-writer round-trip: a tiny
// withReplay run emits a jsonl whose chain verifies, and a one-byte edit breaks
// it. See docs/SPEC-V2.md §8.
// (The real writer's chain is proven live in test/sidecar-network.test.ts,
// which asserts verifyChain(replay.steps).ok on an actual run — no browser is
// launched here, to keep the suite's concurrent-browser load down.)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashStep, verifyChain, makeSigner } from "../src/chain.js";

// Chain plain records the way record() does, so verifyChain should accept them.
type Rec = Record<string, unknown> & { prevHash?: string; hash?: string };
const chain = (recs: Rec[]): Rec[] => {
  let prev = "";
  for (const r of recs) {
    r.prevHash = prev;
    r.hash = hashStep(r);
    prev = r.hash;
  }
  return recs;
};

describe("canonical: deterministic JSON", () => {
  it("is insensitive to key insertion order", () =>
    assert.equal(canonical({ b: 1, a: [3, { y: 1, x: 2 }] }), canonical({ a: [3, { x: 2, y: 1 }], b: 1 })));
  it("drops undefined keys", () => assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}'));
});

describe("hashStep: covers content, not the hash/sig fields", () => {
  it("ignores hash and sig", () => {
    const base = { verdict: "landed", n: 1 };
    assert.equal(hashStep(base), hashStep({ ...base, hash: "deadbeef", sig: "zzz" }));
  });
  it("changes when any covered field changes", () =>
    assert.notEqual(hashStep({ verdict: "landed" }), hashStep({ verdict: "did-not-land" })));
});

describe("verifyChain: detects tamper, reorder, drop", () => {
  const build = () => chain([{ verdict: "landed", i: 0 }, { verdict: "did-not-land", i: 1 }, { verdict: "inconclusive", i: 2 }]);

  it("accepts an intact chain", () => assert.equal(verifyChain(build()).ok, true));

  it("catches an altered field (hash mismatch)", () => {
    const s = build();
    s[1].verdict = "landed"; // flip a verdict without re-hashing
    const r = verifyChain(s);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 1);
    assert.match(r.reason!, /altered/);
  });

  it("catches a reorder (prevHash mismatch)", () => {
    const s = build();
    [s[1], s[2]] = [s[2], s[1]];
    const r = verifyChain(s);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 1);
    assert.match(r.reason!, /link/);
  });

  it("catches a dropped step", () => {
    const s = build();
    s.splice(1, 1);
    assert.equal(verifyChain(s).ok, false);
  });
});

describe("signing (M9): ed25519 over the hash", () => {
  const kp = generateKeyPairSync("ed25519");
  const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signed = (): Rec[] => {
    const s = chain([{ kind: "write", verdict: "landed", i: 0 }, { kind: "write", verdict: "did-not-land", i: 1 }]);
    const sign = makeSigner(priv);
    for (const r of s) r.sig = sign(r.hash as string); // sig is set AFTER hash; hashStep excludes it
    return s;
  };

  it("a signed chain verifies with the public key", () => assert.equal(verifyChain(signed(), { publicKey: pub }).ok, true));

  it("without a public key, signatures are ignored and the hash chain still holds", () =>
    assert.equal(verifyChain(signed()).ok, true));

  it("a missing signature breaks when a key is required", () => {
    const s = signed();
    delete s[1].sig;
    const r = verifyChain(s, { publicKey: pub });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /missing signature/);
  });

  it("a wrong public key fails the signature", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const r = verifyChain(signed(), { publicKey: other });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /bad signature/);
  });

  it("CLI verify --pubkey reports 'intact and signed'", () => {
    const dir = mkdtempSync(join(tmpdir(), "truereplay-sig-"));
    try {
      const run = join(dir, "run.jsonl");
      const key = join(dir, "pub.pem");
      writeFileSync(run, signed().map((r) => JSON.stringify(r)).join("\n") + "\n");
      writeFileSync(key, pub);
      const out = execFileSync("node", ["dist/cli.js", "verify", run, "--pubkey", key], { encoding: "utf8" });
      assert.match(out, /intact and signed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("truereplay verify CLI: over a jsonl on disk", () => {
  let dir = "";
  let runPath = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "truereplay-chain-"));
    runPath = join(dir, "run.jsonl");
    const recs = chain([{ kind: "write", verdict: "landed", i: 0 }, { kind: "write", verdict: "did-not-land", i: 1 }]);
    writeFileSync(runPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("exits 0 and reports the chain intact on an untouched run", () => {
    const out = execFileSync("node", ["dist/cli.js", "verify", runPath], { encoding: "utf8" });
    assert.match(out, /chain intact/);
  });

  it("exits 1 and names the broken step after a one-field edit", () => {
    const lines = readFileSync(runPath, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.verdict = "did-not-land"; // tamper, keep the old hash
    lines[0] = JSON.stringify(first);
    const tampered = join(dir, "tampered.jsonl");
    writeFileSync(tampered, lines.join("\n") + "\n");
    let code = 0;
    let out = "";
    try {
      out = execFileSync("node", ["dist/cli.js", "verify", tampered], { encoding: "utf8" });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      out = err.stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /BROKEN at step #0/);
  });
});
