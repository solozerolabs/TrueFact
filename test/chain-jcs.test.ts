// RFC 8785 (JCS) conformance for canonical(). A TrueFact chain hashes the
// canonical form of each step, so "third-party verifiable" is only true if our
// canonical bytes match the spec exactly. These are the official reference
// vectors (see test/fixtures/jcs/SOURCE.txt) — number formatting, key ordering,
// minimal string escaping, unicode, and the "weird" key-sort edge cases.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonical } from "../src/chain.js";

const here = dirname(fileURLToPath(import.meta.url));
const vec = (kind: "input" | "output", name: string) => readFileSync(join(here, "fixtures/jcs", kind, `${name}.json`), "utf8");

describe("canonical() is RFC 8785 (JCS) conformant", () => {
  for (const name of ["arrays", "french", "structures", "unicode", "values", "weird"]) {
    it(`matches the official JCS vector: ${name}`, () => {
      assert.equal(canonical(JSON.parse(vec("input", name))), vec("output", name));
    });
  }

  // The number-formatting cases that break naive canonicalizers (JCS defers to
  // the ECMAScript Number-to-String, which JSON.stringify already implements).
  it("numbers follow ECMAScript Number-to-String (JCS §3.2.2.3)", () => {
    assert.equal(canonical(-0), "0"); // negative zero normalizes
    assert.equal(canonical(1e21), "1e+21");
    assert.equal(canonical(1e-7), "1e-7");
    assert.equal(canonical(0.000001), "0.000001");
    assert.equal(canonical(9007199254740992), "9007199254740992"); // 2^53
  });

  // Canonical output must re-canonicalize to itself (idempotent), the property a
  // verifier relies on when it re-hashes a stored step.
  it("is idempotent: canonical(parse(canonical(x))) === canonical(x)", () => {
    const x = { z: [3, 1, 2], a: "€\n", n: 1e-7, b: true };
    const once = canonical(x);
    assert.equal(canonical(JSON.parse(once)), once);
  });
});
