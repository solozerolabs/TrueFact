// M3 — offline re-assert. Change an assertion, re-run it against a recorded
// run with no browser and no model, and see which write steps now fail. Fully
// hermetic: these build step records by hand (or a jsonl on disk) — the whole
// point of offline re-assert is that it needs neither browser nor LLM.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reassert, reassertFile, toAssertions, viewOf, defineAssertions } from "../src/assert.js";
import { step, session } from "./helpers.js";
import type { Step } from "../src/index.js";
import type { Postcondition } from "../src/postcondition.js";

// A write step with a postcondition carrying the fields viewOf reads.
const writeStep = (over: Partial<Postcondition>, verdict: Step["verdict"] = "landed", action = "act: place order"): Step => {
  const post: Postcondition = {
    verdict, reason: "confirmation", confidence: "heuristic",
    auto: { verdict, reason: "confirmation", confidence: "heuristic" },
    urlChanged: false, pageSwitched: false,
    treeAdded: [], treeRemoved: [], formsBefore: {}, formsAfter: {}, ...over,
  };
  return step({
    kind: "write", action, verdict,
    evidence: {
      before: null,
      after: { href: "http://shop.x/checkout", readyState: "complete", bodyTextLength: 0, elementCount: 0, title: "" },
      settled: true, session: session(), postcondition: post,
    },
  });
};

describe("reassert (pure): assertion re-run over recorded write steps", () => {
  const steps: Step[] = [
    writeStep({ treeAdded: ["status: ✅ Order placed — #4242"] }, "landed", "act: place order"),
    writeStep({ treeAdded: [], network: { errors: [{ url: "http://shop.x/charge", status: 500 }] } }, "did-not-land", "act: pay now"),
  ];

  it("an assertion that demands an order-confirmation line flags the step that lacks it", () => {
    const report = reassert(steps, {
      browser: (v) => (v.treeAdded.some((l) => /#\d+/.test(l)) ? { ok: true } : { ok: false, message: "no order confirmation line" }),
    });
    assert.equal(report.total, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.items[1].ok, false);
    assert.match(report.items[1].message!, /no order confirmation/);
  });

  it("a network-aware assertion catches the charge 5xx even reading only stored evidence", () => {
    const report = reassert(steps, {
      browser: (v) => (v.network.some((n) => (n.status ?? 500) >= 500) ? { ok: false, message: "charge failed" } : { ok: true }),
    });
    assert.equal(report.failed, 1);
    assert.equal(report.items[0].ok, true);
    assert.equal(report.items[1].ok, false);
  });

  it("read/nav steps carry no postcondition and are skipped", () => {
    const withRead = [...steps, step({ kind: "read", action: "extract: total" })];
    assert.equal(reassert(withRead, { browser: () => ({ ok: true }) }).total, 2);
  });

  it("viewOf maps evidence → view; non-write → null", () => {
    const v = viewOf(steps[0])!;
    assert.equal(v.url, "http://shop.x/checkout");
    assert.equal(v.verdict, "landed");
    assert.equal(viewOf(step({ kind: "nav", action: "goto x" })), null);
  });
});

describe("toAssertions: module default-export normalization", () => {
  it("accepts a bare function", () => assert.equal(typeof toAssertions(() => ({ ok: true })).browser, "function"));
  it("accepts { browser }", () => assert.equal(typeof toAssertions({ browser: () => ({ ok: true }) }).browser, "function"));
  it("accepts a { default } wrapper", () => assert.equal(typeof toAssertions({ default: defineAssertions({ browser: () => ({ ok: true }) }) }).browser, "function"));
  it("rejects nonsense", () => assert.throws(() => toAssertions({ nope: 1 }), /must default-export/));
});

describe("reassertFile + CLI: offline over a jsonl on disk", () => {
  let dir = "";
  let runPath = "";
  let modPath = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "truereplay-assert-"));
    runPath = join(dir, "run.jsonl");
    modPath = join(dir, "assertions.mjs");
    const lines = [
      writeStep({ treeAdded: ["status: ✅ Order placed — #4242"] }, "landed", "act: place order"),
      writeStep({ treeAdded: [], network: { errors: [{ url: "http://shop.x/charge", status: 500 }] } }, "did-not-land", "act: pay now"),
    ].map((s) => JSON.stringify(s));
    writeFileSync(runPath, lines.join("\n") + "\n");
    // A plain assertion module — returns literals, imports nothing.
    writeFileSync(modPath, "export default (v) => v.treeAdded.some(l => /#\\d+/.test(l)) ? { ok: true } : { ok: false, message: 'no confirmation' };\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reassertFile loads the run + module and evaluates", async () => {
    const report = await reassertFile(runPath, modPath);
    assert.equal(report.total, 2);
    assert.equal(report.failed, 1);
  });

  it("the CLI exits 1 when a step fails and names it", () => {
    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", ["dist/cli.js", "assert", runPath, "--with", modPath], { encoding: "utf8" });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      out = err.stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /FAIL.*pay now/s);
    assert.match(out, /1\/2 write steps pass/);
  });
});
