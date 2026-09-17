import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDeclarations, validateDeclarations, type DeclaredResult, type Declaration } from "../src/declaration.js";
import { withReplay } from "../src/index.js";
import type { Outcome } from "../src/postcondition.js";
import { serve, fakeStagehand, withBrowser, type Fixture } from "./helpers.js";

const res = (declaration: Declaration, met: boolean | null, actual: string | null = null): DeclaredResult => ({ declaration, met, actual, elapsedMs: 0 });
const auto = (verdict: Outcome["verdict"], reason: Outcome["reason"], confidence: Outcome["confidence"] = "heuristic"): Outcome => ({ verdict, reason, confidence });
const el: Declaration = { kind: "element", selector: "#receipt" };
const gone: Declaration = { kind: "element", selector: "#pay", absent: true };

describe("validateDeclarations (fail fast on vacuity)", () => {
  it("rejects an empty text/url match and a regex that matches the empty string", () => {
    assert.throws(() => validateDeclarations({ kind: "text", matches: "" }), /vacuous/);
    assert.throws(() => validateDeclarations({ kind: "url", matches: /.*/ }), /vacuous/);
    assert.throws(() => validateDeclarations({ kind: "element", selector: " " }), /vacuous/);
  });
  it("allows field equals '' (a declared clear) and normalizes a single declaration to a list", () => {
    assert.deepEqual(validateDeclarations({ kind: "field", selector: "#e", equals: "" }), [{ kind: "field", selector: "#e", equals: "" }]);
    assert.deepEqual(validateDeclarations(undefined), []);
  });
});

describe("applyDeclarations (pure composition, DAY4 §3)", () => {
  it("unmet -> did-not-land / declared-unmet / high, even over an auto landed", () => {
    assert.deepEqual(applyDeclarations(auto("landed", "confirmation"), [res(el, false)]), auto("did-not-land", "declared-unmet", "high"));
  });
  it("unreadable -> inconclusive / declared-unreadable, never did-not-land", () => {
    assert.deepEqual(applyDeclarations(auto("landed", "navigated", "high"), [res(el, null)]), auto("inconclusive", "declared-unreadable"));
  });
  it("met lifts no-change to landed / declared-met / high", () => {
    assert.deepEqual(applyDeclarations(auto("inconclusive", "no-change"), [res(el, true)]), auto("landed", "declared-met", "high"));
  });
  it("met raises an auto landed to high confidence and keeps its reason", () => {
    assert.deepEqual(applyDeclarations(auto("landed", "confirmation"), [res(el, true)]), auto("landed", "confirmation", "high"));
  });
  it("met does not argue with a mechanism: validation-error stays did-not-land", () => {
    assert.deepEqual(applyDeclarations(auto("did-not-land", "validation-error", "high"), [res(el, true)]), auto("did-not-land", "validation-error", "high"));
  });
  it("negatives never lift: only absent declarations that hold leave the auto verdict alone", () => {
    assert.deepEqual(applyDeclarations(auto("inconclusive", "no-change"), [res(gone, true)]), auto("inconclusive", "no-change"));
  });
  it("a violated negative tightens to did-not-land", () => {
    assert.deepEqual(applyDeclarations(auto("landed", "navigated", "high"), [res(gone, false)]), auto("did-not-land", "declared-unmet", "high"));
  });
  it("no declarations -> auto unchanged", () => {
    assert.deepEqual(applyDeclarations(auto("inconclusive", "no-change"), []), auto("inconclusive", "no-change"));
  });
});

describe("withReplay: declared postconditions end to end", () => {
  const b = withBrowser();
  let fx: Fixture;
  const WAIT = 600;
  const runAct = async (spec: Parameters<typeof fakeStagehand>[2], expect?: Declaration | Declaration[], waitMs = WAIT) => {
    const sh = await b.start();
    const { act, replay } = withReplay(fakeStagehand(sh, await b.page(), spec), { waitMs, screenshots: false });
    await act("do it", expect ? { expect } : undefined);
    return { step: replay.steps.at(-1)!, replay };
  };
  const go = async (path: string) => (await b.page()).goto(fx.base + path);

  before(async () => {
    await b.start();
    fx = await serve({
      "/silent": `<html><body><main><button id="s">Save</button><p id="msg"></p><script>document.getElementById('s').onclick=()=>{fetch('/x').catch(()=>{});}</script></main></body></html>`,
      "/receipt": `<html><body><main><button id="s">Pay</button><script>document.getElementById('s').onclick=()=>document.body.insertAdjacentHTML('beforeend','<div id="receipt" role="status">Order #4821 placed</div>')</script></main></body></html>`,
      // R10: the status text is split across inline markup, so its number lands on a separate a11y line
      "/receipt-inline": `<html><body><main><button id="s">Pay</button><script>document.getElementById('s').onclick=()=>document.body.insertAdjacentHTML('beforeend','<div role="status">Order #<strong>4821</strong> placed</div>')</script></main></body></html>`,
      // renders the receipt with no role and no confirmation-shaped words: auto can only say changed-unclassified
      "/receipt-silent": `<html><body><main><button id="s">Pay</button><script>document.getElementById('s').onclick=()=>document.body.insertAdjacentHTML('beforeend','<div id="receipt">ref 4821</div>')</script></main></body></html>`,
      "/late": `<html><body><main><button id="s">Pay</button><script>document.getElementById('s').onclick=()=>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div id="receipt">Order #77</div>'),700)</script></main></body></html>`,
      "/confirm-only": `<html><body><main><button id="s">Pay</button><script>document.getElementById('s').onclick=()=>document.body.insertAdjacentHTML('beforeend','<p role=status>Saved</p>')</script></main></body></html>`,
      "/nav": `<html><body><main><a id="go" href="/done">go</a><a id="err" href="/error">err</a></main></body></html>`,
      "/done": `<html><head><title>Done</title></head><body><main><h1>done</h1></main></body></html>`,
      "/error": `<html><head><title>Error</title></head><body><main><h1>error</h1></main></body></html>`,
      // the declared element is ALREADY present; the submit is blocked by `required` — met must not beat the mechanism
      "/required": `<html><body><main><div id="receipt">static</div><form onsubmit="event.preventDefault()"><input name="email" required><button id="s" type="submit">Go</button></form></main></body></html>`,
      "/redirect": `<html><body><main><form onsubmit="event.preventDefault();setTimeout(()=>location.href='/login',300)"><button id="s" type="submit">Save</button></form></main></body></html>`,
      "/login": { status: 401, html: `<html><body><main><div id="receipt">wall</div><form><input type="password" autocomplete="current-password"></form></main></body></html>` },
      "/fields": `<html><body><main><input id="e" name="email"><form><input id="p" name="pw" type="password" autocomplete="new-password"></form><button id="s" type="button">x</button></main></body></html>`,
      "/tall": `<html><body><main style="height:3000px"><button id="s">x</button></main></body></html>`,
      "/cart": `<html><body><main><button id="s">Checkout</button></main></body></html>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  it("given a declared element on a write auto can only call changed-unclassified, when it renders, then landed / declared-met with the auto reason kept", async () => {
    await go("/receipt-silent");
    const { step } = await runAct({ selector: "#s" }, el);
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "declared-met");
    assert.equal(step.evidence.postcondition?.confidence, "high");
    assert.equal(step.evidence.postcondition?.auto.reason, "changed-unclassified");
    assert.deepEqual(step.declaration, [el]);
  });

  it("given a declared element met on a write auto already calls confirmation, then landed keeps its reason and rises to high", async () => {
    await go("/receipt");
    const { step } = await runAct({ selector: "#s" }, el);
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "confirmation");
    assert.equal(step.evidence.postcondition?.confidence, "high");
  });

  it("given a declared text with role status, then landed / declared-met via the a11y tree", async () => {
    await go("/receipt");
    const { step } = await runAct({ selector: "#s" }, { kind: "text", matches: /Order #\d+/, role: "status" });
    assert.equal(step.verdict, "landed");
    assert.match(step.evidence.postcondition?.declared?.[0].actual ?? "", /Order #4821/);
  });

  it("given a declared text role status whose value is split across inline markup (R10), then landed / declared-met", async () => {
    await go("/receipt-inline");
    const { step } = await runAct({ selector: "#s" }, { kind: "text", matches: /Order #\d+/, role: "status" });
    assert.equal(step.verdict, "landed");
    assert.match(step.evidence.postcondition?.declared?.[0].actual ?? "", /Order #4821/);
  });

  it("given a declared url /done and a click that navigates there, then landed / navigated at high", async () => {
    await go("/nav");
    const { step } = await runAct({ selector: "#go" }, { kind: "url", matches: "/done" });
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.reason, "navigated");
    assert.equal(step.evidence.postcondition?.confidence, "high");
  });

  it("given a declared url /done but the click navigates to /error, then did-not-land / declared-unmet", async () => {
    await go("/nav");
    const { step } = await runAct({ selector: "#err" }, { kind: "url", matches: "/done" });
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "declared-unmet");
    assert.equal(step.evidence.postcondition?.auto.reason, "navigated");
  });

  it("given a declared element that never appears though a confirmation did, then did-not-land — the declaration beats auto confirmation", async () => {
    await go("/confirm-only");
    const { step } = await runAct({ selector: "#s" }, el);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "declared-unmet");
    assert.equal(step.evidence.postcondition?.auto.reason, "confirmation");
  });

  it("given a silent write with no declaration, then inconclusive / no-change (regression guard: auto default unchanged)", async () => {
    await go("/silent");
    const { step } = await runAct({ selector: "#s" });
    assert.equal(step.declaration, "auto");
    assert.equal(step.evidence.postcondition?.reason, "no-change");
    assert.equal(step.verdict, "inconclusive");
  });

  it("given a declared element that appears at 700 ms, then it is met within the budget, not a premature unmet", async () => {
    await go("/late");
    const { step } = await runAct({ selector: "#s" }, el, 3000);
    assert.equal(step.verdict, "landed");
    assert.ok((step.evidence.postcondition?.declared?.[0].elapsedMs ?? 0) >= 400);
  });

  it("given a declared element that never appears, then declared-unmet at the deadline, not far past it", async () => {
    await go("/silent");
    const t = Date.now();
    const { step } = await runAct({ selector: "#s" }, el, 800);
    assert.equal(step.evidence.postcondition?.reason, "declared-unmet");
    assert.ok(Date.now() - t < 800 + 4000, "bounded by the budget plus settle/capture overhead");
  });

  it("given a declaration that passes while :user-invalid rose, then did-not-land / validation-error stays", async () => {
    await go("/required");
    const { step } = await runAct({ selector: "#s" }, el);
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "validation-error");
  });

  it("given a declaration that is met on a 401 login wall, then the destination gate still yields inconclusive", async () => {
    await go("/redirect");
    const { step } = await runAct({ selector: "#s" }, el, 3000);
    assert.equal(step.evidence.postcondition?.declared?.[0].met, true);
    assert.equal(step.evidence.session.obstruction, "login-wall");
    assert.equal(step.verdict, "inconclusive");
  });

  it("given a field declaration against a password input, then the verdict is right and nothing plain is stored", async () => {
    await go("/fields");
    const { step } = await runAct({ selector: "#p", method: "fill", args: ["hunter2secret"] }, { kind: "field", selector: "#p", equals: "hunter2secret" });
    assert.equal(step.verdict, "landed");
    assert.ok(!JSON.stringify(step).includes("hunter2secret"));
    assert.equal(step.evidence.postcondition?.declared?.[0].actual, "<redacted:13>");
  });

  it("given a declaration with an unresolvable selector, then inconclusive / declared-unreadable, never landed", async () => {
    await go("/receipt");
    const { step } = await runAct({ selector: "#s" }, { kind: "field", selector: "#does-not-exist", equals: "x" });
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "declared-unreadable");
  });

  it("given a declaration on a scroll act, then the step is still a read and the declaration is recorded, not evaluated", async () => {
    await go("/tall");
    const { step } = await runAct({ selector: "#s", method: "scroll" }, el);
    assert.equal(step.kind, "read");
    assert.deepEqual(step.declaration, [el]);
    assert.equal(step.evidence.postcondition?.declared, undefined);
  });

  it("given a vacuous declaration, then withReplay throws before any browser action", async () => {
    await go("/receipt");
    await assert.rejects(runAct({ selector: "#s" }, { kind: "text", matches: "" }), /vacuous/);
  });

  it("given finalize({ url /thank-you }) on a run whose steps landed but ends on /cart, then replay.verdict is did-not-land", async () => {
    await go("/receipt");
    const { replay } = await runAct({ selector: "#s" }, el);
    assert.equal(replay.verdict, "landed");
    await (await b.page()).goto(fx.base + "/cart");
    const final = await replay.finalize({ expect: { kind: "url", matches: "/thank-you" } });
    assert.equal(final.verdict, "did-not-land");
    assert.equal(replay.verdict, "did-not-land");
  });
});
