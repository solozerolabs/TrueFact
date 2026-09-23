// Record read-back — the verdict for a write with no page (API, tool-call, MCP
// agents). Pure tests for the matcher and the decision, then real `openRun`
// runs against an in-memory "system of record": no browser, no model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, decideRecord, matchExpect, validateExpect } from "../src/record.js";
import { openRun, withTrueFact, type Driver } from "../src/index.js";
import { verifyChain } from "../src/chain.js";

const ok = (value: unknown) => ({ ok: true as const, value });
const err = { ok: false as const, error: "503" };

describe("record: matchExpect", () => {
  it("given a partial object, when the record has extra fields, then it matches by subset", () => {
    assert.equal(matchExpect({ id: 1, stage: "Closed Won", owner: "a" }, { stage: "Closed Won" }), true);
  });
  it("given a nested expect, when a nested field differs, then it does not match", () => {
    assert.equal(matchExpect({ deal: { stage: "Open" } }, { deal: { stage: "Closed Won" } }), false);
  });
  it("given a RegExp, when the value is a string or number, then it tests the string form", () => {
    assert.equal(matchExpect({ amount: 500 }, { amount: /^500$/ }), true);
    assert.equal(matchExpect({ amount: 5000 }, { amount: /^500$/ }), false);
  });
  it("given expect null, when read returned null or undefined, then the record is gone", () => {
    assert.equal(matchExpect(null, null), true);
    assert.equal(matchExpect({ id: 1 }, null), false);
  });
  it("given an array, when lengths differ, then it does not match", () => {
    assert.equal(matchExpect({ tags: ["a", "b"] }, { tags: ["a"] }), false);
    assert.equal(matchExpect({ tags: [] }, { tags: [] }), true);
  });
  it("given a Date, when the value is its ISO string, then it matches (values compare as JSON)", () => {
    const d = new Date("2026-09-22T00:00:00Z");
    assert.equal(matchExpect({ at: d.toISOString() }, { at: d }), true);
  });
  it("given a global RegExp, when matched twice, then lastIndex does not flip the result", () => {
    const re = /won/g;
    assert.equal(matchExpect("won", re), true);
    assert.equal(matchExpect("won", re), true);
  });
});

describe("record: validateExpect", () => {
  it("given {}, when validated, then it throws as vacuous", () => {
    assert.throws(() => validateExpect({}), /vacuous expect \{\}/);
  });
  it("given a RegExp that matches empty, when validated, then it throws with its path", () => {
    assert.throws(() => validateExpect({ deal: { stage: /.*/ } }), /expect\.deal\.stage/);
  });
  it("given an empty array or null, when validated, then it is allowed (list emptied, record gone)", () => {
    validateExpect({ items: [] });
    validateExpect(null);
  });
});

describe("record: decideRecord", () => {
  it("given expect met, then landed/declared-met/high", () => {
    assert.deepEqual(decideRecord(ok(null), ok({ s: 1 }), { s: 1 }), { verdict: "landed", reason: "declared-met", confidence: "high", met: true });
  });
  it("given expect unmet on a readable record, then did-not-land/declared-unmet", () => {
    assert.equal(decideRecord(ok({ s: 0 }), ok({ s: 0 }), { s: 1 }).verdict, "did-not-land");
  });
  it("given expect and an unreadable after, then inconclusive, never landed", () => {
    assert.deepEqual(decideRecord(ok({ s: 0 }), err, { s: 1 }), { verdict: "inconclusive", reason: "declared-unreadable", confidence: "heuristic", met: null });
  });
  it("given no expect and a changed record, then inconclusive (someone else may have written it)", () => {
    assert.equal(decideRecord(ok({ s: 0 }), ok({ s: 1 }), undefined).reason, "changed-unclassified");
    assert.equal(decideRecord(ok({ s: 0 }), ok({ s: 1 }), undefined).verdict, "inconclusive");
  });
  it("given no expect and an unchanged record, then inconclusive/no-change, never did-not-land", () => {
    assert.deepEqual(decideRecord(ok({ s: 0 }), ok({ s: 0 }), undefined).verdict, "inconclusive");
  });
  it("given no expect and a failed read, then inconclusive/read-failed", () => {
    assert.equal(decideRecord(err, ok({ s: 0 }), undefined).reason, "read-failed");
  });
});

describe("record: changedPaths", () => {
  it("given nested objects and arrays, then it names each differing leaf", () => {
    assert.deepEqual(changedPaths({ a: { b: 1, c: 2 }, t: [1, 2] }, { a: { b: 1, c: 3 }, t: [1, 2, 3] }), ["a.c", "t[2]"]);
  });
  it("given a whole value replaced, then it names the root", () => {
    assert.deepEqual(changedPaths(null, { id: 1 }), ["(root)"]);
  });
});

/** A tiny system of record the "agent" writes to. */
const store = () => {
  const deals = new Map<number, { id: number; stage: string; email?: string }>([[123, { id: 123, stage: "Open" }]]);
  return {
    get: (id: number) => (deals.has(id) ? { ...deals.get(id)! } : null),
    set: (id: number, stage: string) => void deals.set(id, { ...deals.get(id)!, stage }),
    del: (id: number) => void deals.delete(id),
    raw: deals,
  };
};

describe("record: openRun", () => {
  it("given a tool that really writes, when expect is met, then landed and the value comes back", async () => {
    const db = store();
    const run = openRun({ waitMs: 0 });
    const { value, truefact } = await run.write("move deal 123 to Closed Won", () => (db.set(123, "Closed Won"), "Deal updated"), {
      read: () => db.get(123),
      expect: { stage: "Closed Won" },
    });
    assert.equal(value, "Deal updated");
    assert.equal(truefact.verdict, "landed");
    assert.equal(truefact.reason, "declared-met");
    assert.deepEqual(truefact.step.evidence.record?.changed, ["stage"]);
    assert.equal(run.replay.verdict, "landed");
  });

  it("given a tool that says ok but writes nothing, when expect is declared, then did-not-land — the false success", async () => {
    const db = store();
    const run = openRun({ waitMs: 50 });
    const { truefact } = await run.write("move deal 123 to Closed Won", () => ({ ok: true }), {
      read: () => db.get(123),
      expect: { stage: "Closed Won" },
    });
    assert.equal(truefact.verdict, "did-not-land");
    assert.match(truefact.why, /doesn't match expect — nothing changed/);
    assert.deepEqual(truefact.step.agent_claim, { success: true, message: '{"ok":true}' });
    assert.throws(() => run.replay.assertLanded(), /did not land/);
  });

  it("given an eventually-consistent store, when the write shows up within the budget, then landed", async () => {
    const db = store();
    const run = openRun({ waitMs: 2000 });
    const { truefact } = await run.write("move deal", () => void setTimeout(() => db.set(123, "Closed Won"), 300), {
      read: () => db.get(123),
      expect: { stage: "Closed Won" },
    });
    assert.equal(truefact.verdict, "landed");
    assert.equal(truefact.step.evidence.settled, true);
  });

  it("given a delete, when expect is null and the record is gone, then landed", async () => {
    const db = store();
    const { truefact } = await openRun({ waitMs: 0 }).write("delete deal 123", () => db.del(123), { read: () => db.get(123), expect: null });
    assert.equal(truefact.verdict, "landed");
  });

  it("given no expect, when the record changed, then inconclusive with a hint to declare expect", async () => {
    const db = store();
    const { truefact } = await openRun({ waitMs: 0 }).write("move deal", () => db.set(123, "Closed Won"), { read: () => db.get(123) });
    assert.equal(truefact.verdict, "inconclusive");
    assert.match(truefact.why, /changed-unclassified.*declare `expect`/);
  });

  it("given a read that throws, when expect is declared, then inconclusive/declared-unreadable, never landed", async () => {
    const db = store();
    const { truefact } = await openRun({ waitMs: 0 }).write("move deal", () => db.set(123, "Closed Won"), {
      read: () => {
        throw new Error("CRM 503");
      },
      expect: { stage: "Closed Won" },
    });
    assert.equal(truefact.verdict, "inconclusive");
    assert.match(truefact.why, /read-back failed: CRM 503/);
  });

  it("given an action that throws after committing, then the step says landed and the error carries it", async () => {
    const db = store();
    const run = openRun({ waitMs: 0 });
    await assert.rejects(
      run.write("move deal", () => {
        db.set(123, "Closed Won");
        throw new Error("timeout");
      }, { read: () => db.get(123), expect: { stage: "Closed Won" } }),
      (e: Error & { truefact?: { verdict: string } }) => e.message === "timeout" && e.truefact?.verdict === "landed",
    );
    assert.deepEqual(run.replay.steps[0].agent_claim, { success: false, message: "timeout" });
  });

  it("given a vacuous expect, when write is called, then it throws before running the action", async () => {
    let ran = false;
    await assert.rejects(openRun().write("x", () => (ran = true), { read: () => 1, expect: {} }), /vacuous/);
    assert.equal(ran, false);
  });
});

describe("record: the stored run", () => {
  it("given a jsonl run with secrets in the record, then values are redacted, fields masked, and the chain verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-record-"));
    try {
      const db = store();
      db.raw.set(123, { id: 123, stage: "Open", email: "sam@example.com" });
      const jsonl = join(dir, "run.jsonl");
      const run = openRun({ jsonl, waitMs: 0, redactFields: ["stage"] });
      await run.write("move deal", () => db.set(123, "Closed Won"), { read: () => db.get(123), expect: { stage: /Won/ } });
      await run.write("move deal again", () => undefined, { read: () => db.get(123) });
      const steps = readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(steps.length, 2);
      assert.equal(steps[0].evidence.record.after.email, "[REDACTED:email]");
      assert.equal(steps[0].evidence.record.after.stage, "<redacted:10>");
      assert.deepEqual(steps[0].declaration, { expect: { stage: "<redacted:5>" } });
      assert.equal(verifyChain(steps).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("given a browser-wrapped run, when write is called, then the record step joins the same replay with no page read", async () => {
    const touched = () => {
      throw new Error("page touched");
    };
    const noPage = { act: touched, extract: touched, observe: touched, goto: touched, activePage: touched, readerFor: touched } as unknown as Driver;
    const db = store();
    const tf = withTrueFact(noPage, { waitMs: 0 });
    const { truefact } = await tf.write("move deal", () => db.set(123, "Closed Won"), { read: () => db.get(123), expect: { stage: "Closed Won" } });
    assert.equal(truefact.verdict, "landed");
    assert.equal(tf.replay.steps.length, 1);
    assert.equal(tf.replay.verdict, "landed");
  });
});

describe("record: offline re-assert", () => {
  it("given a stored record run, when a record assertion runs, then it sees read-back values and never the claim", async () => {
    const { reassert } = await import("../src/index.js");
    const db = store();
    const run = openRun({ waitMs: 0 });
    await run.write("move deal", () => (db.set(123, "Closed Won"), "SECRET-CLAIM"), { read: () => db.get(123), expect: { stage: "Closed Won" } });
    const seen: unknown[] = [];
    const report = reassert(run.replay.steps, {
      record: (v) => {
        seen.push(v);
        return (v.after as { stage: string }).stage === "Closed Won" ? { ok: true } : { ok: false, message: "stage" };
      },
    });
    assert.deepEqual(report, { total: 1, failed: 0, items: [{ index: 0, action: "move deal", ok: true, message: undefined }] });
    assert.doesNotMatch(JSON.stringify(seen), /SECRET-CLAIM/);
  });
});
