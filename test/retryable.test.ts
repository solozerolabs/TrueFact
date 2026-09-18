// The recovery contract: `retryable === true` means repeating the identical
// action cannot double-apply a server write — NOT that a retry will succeed.
// So it is true in exactly one place: a did-not-land, pure field write whose
// value never took. Every network-error and every inconclusive is false — that
// is the guard against an auto-retry loop double-charging a payment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryableOf, type Step } from "../src/index.js";
import type { PostReason, Verdict } from "../src/postcondition.js";

const step = (verdict: Verdict, reason: PostReason, methods: (string | undefined)[] = ["fill"]): Step =>
  ({
    kind: "write", action: "x", declaration: "auto", verdict,
    evidence: { before: null, after: null, settled: true, session: { obstruction: null, confidence: "heuristic" }, postcondition: { reason } },
    attempt: methods.map((m) => ({ selector: "#f", method: m, arguments: ["v"] })),
    agent_claim: null, cost: null, timestamp: "",
  }) as unknown as Step;

describe("retryableOf: safe only when a pure field write didn't take", () => {
  it("given did-not-land field-mismatch on a pure fill/type/select, then retryable", () => {
    for (const m of ["fill", "type", "selectOption", "selectOptionFromDropdown"])
      assert.equal(retryableOf(step("did-not-land", "field-mismatch", [m])), true, m);
  });

  it("given a mixed fill+click field-mismatch, then NOT retryable (the click may have submitted)", () => {
    assert.equal(retryableOf(step("did-not-land", "field-mismatch", ["fill", "click"])), false);
  });

  it("given field-mismatch with no attempt methods, then not retryable", () => {
    assert.equal(retryableOf(step("did-not-land", "field-mismatch", [])), false);
  });

  it("given a network-error did-not-land, then NOT retryable (the server may have applied it)", () => {
    assert.equal(retryableOf(step("did-not-land", "network-error", ["click"])), false);
  });

  it("given any landed, then NOT retryable (repeating it is the double charge)", () => {
    for (const r of ["confirmation", "navigated", "new-page", "field-match", "form-cleared"] as PostReason[])
      assert.equal(retryableOf(step("landed", r, ["click"])), false, r);
  });

  it("given any inconclusive reason, then NOT retryable (we don't know it didn't land)", () => {
    for (const r of ["no-change", "changed-unclassified", "unsettled", "hash-only-nav", "error-text", "prompt", "non-mutating"] as PostReason[])
      assert.equal(retryableOf(step("inconclusive", r, ["click"])), false, r);
  });

  it("given other did-not-land reasons (validation, declared, obstruction), then NOT retryable — the caller decides", () => {
    for (const r of ["validation-error", "declared-unmet", "declared-unreadable"] as PostReason[])
      assert.equal(retryableOf(step("did-not-land", r, ["click"])), false, r);
  });
});
