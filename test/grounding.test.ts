// Day 5 — grounding is pure: a function of the extracted data and the a11y tree
// lines. No browser here. The integration path (a real extract through withTrueFact)
// lives in replay.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groundValues } from "../src/grounding.js";

// normalized tree lines (node-id prefix + indentation already stripped)
const receipt = [
  "heading: Order #4242",
  "StaticText: Total:",
  "strong",
  "StaticText: $1,249.00",
  "StaticText: ada@example.com",
];

describe("groundValues", () => {
  it("all returned values on the page -> landed / grounded / high", () => {
    const g = groundValues({ order: "Order #4242", total: "$1,249.00", id: 4242 }, receipt);
    assert.equal(g.verdict, "landed");
    assert.equal(g.reason, "grounded");
    assert.equal(g.confidence, "high");
    assert.ok(g.values.every((v) => v.match === "exact"));
  });

  it("matches a value that spans inline markup via the joined blob", () => {
    // "Total:" and "$1,249.00" are separate StaticText lines; the blob rejoins them.
    const g = groundValues({ line: "Total: $1,249.00" }, receipt);
    assert.equal(g.verdict, "landed");
    assert.equal(g.values[0].match, "exact");
  });

  it("numbers match on whole digit tokens: 49 does not ground against $1,249.00, 1249 and 1249.00 do", () => {
    assert.equal(groundValues({ n: "49" }, receipt).reason, "ungrounded");
    assert.equal(groundValues({ n: "1249" }, receipt).verdict, "landed");
    assert.equal(groundValues({ n: "1249.00" }, receipt).verdict, "landed");
  });

  it("grounds a bare number once and not by a date's digits", () => {
    const tree = ["cell: 3", "StaticText: Date 2026-09-16 and 09/16/2026"];
    assert.equal(groundValues({ qty: 3 }, tree).verdict, "landed");
    assert.equal(groundValues({ qty: 3 }, tree).values[0].match, "exact");
  });

  it("case- and whitespace-normalized match is grounded at heuristic confidence", () => {
    const g = groundValues({ name: "ADA   LOVELACE" }, ["StaticText: Ada Lovelace"]);
    assert.equal(g.verdict, "landed");
    assert.equal(g.confidence, "heuristic");
    assert.equal(g.values[0].match, "normalized");
  });

  it("a value the tree lacks is inconclusive / ungrounded, never did-not-land, and is attached", () => {
    const g = groundValues({ msg: "goodbye moon" }, ["StaticText: hello world"]);
    assert.equal(g.verdict, "inconclusive");
    assert.equal(g.reason, "ungrounded");
    assert.deepEqual(g.values, [{ value: "goodbye moon", match: "absent" }]);
  });

  it("only booleans, short strings and a long summary -> nothing-to-ground, all skipped", () => {
    const g = groundValues({ ok: true, code: "ok", note: "x".repeat(300) }, receipt);
    assert.equal(g.reason, "nothing-to-ground");
    assert.equal(g.verdict, "inconclusive");
    assert.equal(g.values.length, 0);
    assert.equal(g.skipped, 3);
  });

  it("the no-schema { extraction: <paragraph> } shape is nothing-to-ground, not ungrounded", () => {
    const g = groundValues({ extraction: "The order was placed and a confirmation email will arrive shortly.".repeat(3) }, receipt);
    assert.equal(g.reason, "nothing-to-ground");
    assert.equal(g.skipped, 1);
  });

  it("walks nested arrays and objects", () => {
    const g = groundValues({ items: [{ name: "Order #4242" }, { name: "missing item" }] }, receipt);
    assert.equal(g.values.length, 2);
    assert.equal(g.reason, "ungrounded"); // one present, one absent
  });

  it("caps at 50 judged leaves; the rest count as skipped", () => {
    const data = Array.from({ length: 60 }, (_, i) => `value-number-${i}`);
    const g = groundValues(data, receipt);
    assert.equal(g.values.length, 50);
    assert.equal(g.skipped, 10);
  });
});
