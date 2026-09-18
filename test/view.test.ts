// M4 — the timeline viewer generator. A standalone HTML with the run inlined;
// no server, no build step. Hermetic: assert on the produced HTML string and
// the written file — no browser is launched here. See docs/SPEC-V2.md §6.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHtml, viewFile } from "../src/view.js";
import { step, session } from "./helpers.js";
import type { Step } from "../src/index.js";
import type { Postcondition } from "../src/postcondition.js";

const writeStep = (over: Partial<Postcondition>, verdict: Step["verdict"], action: string): Step => {
  const post: Postcondition = {
    verdict, reason: "confirmation", confidence: "high",
    auto: { verdict, reason: "confirmation", confidence: "high" },
    urlChanged: false, pageSwitched: false, treeAdded: [], treeRemoved: [], formsBefore: {}, formsAfter: {}, ...over,
  };
  return step({
    kind: "write", action, verdict,
    agent_claim: { success: true, message: "did it" },
    evidence: {
      before: null,
      after: { href: "http://shop.x/checkout", readyState: "complete", bodyTextLength: 0, elementCount: 0, title: "" },
      settled: true, session: session(), postcondition: post,
    },
  });
};

const steps: Step[] = [
  writeStep({ treeAdded: ["status: ✅ Order placed — #4242"] }, "landed", "act: place order"),
  writeStep({ treeAdded: [], network: { errors: [{ url: "http://shop.x/charge", status: 500 }] } }, "did-not-land", "act: pay now"),
];

describe("renderHtml: standalone timeline", () => {
  const html = renderHtml(steps);
  it("is a full HTML document", () => assert.match(html, /^<!doctype html>/i));
  it("inlines the steps as data", () => assert.match(html, /window\.__STEPS__=/));
  it("shows each step's action and both verdicts", () => {
    assert.match(html, /place order/);
    assert.match(html, /pay now/);
    assert.match(html, /did-not-land/);
  });
  it("surfaces the network error and the tree diff to the renderer via the data", () => {
    assert.match(html, /charge/);
    assert.match(html, /Order placed/);
  });
  it("neutralizes a </script> inside the data so it can't break out", () => {
    const evil = renderHtml([writeStep({ treeAdded: ["</script><img src=x>"] }, "landed", "act: x")]);
    assert.doesNotMatch(evil, /<\/script><img/); // the literal sequence must not appear unescaped
    assert.match(evil, /\\u003c\/script>/); // it survives as escaped data
  });
});

describe("viewFile + CLI: writes a page beside the run", () => {
  let dir = "";
  let runPath = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "truefact-view-"));
    runPath = join(dir, "run.jsonl");
    writeFileSync(runPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("viewFile writes <run>.html and returns its path", () => {
    const out = viewFile(runPath);
    assert.equal(out, join(dir, "run.html"));
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, "utf8"), /place order/);
  });

  it("the CLI writes the page and prints its path (no browser opened)", () => {
    const out = execFileSync("node", ["dist/cli.js", "view", runPath], { encoding: "utf8", env: { ...process.env, TRUEFACT_NO_OPEN: "1" } });
    assert.match(out.trim(), /run\.html$/);
    assert.ok(existsSync(out.trim()));
  });
});
