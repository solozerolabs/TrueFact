import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, normalizeTree, multisetDiff, sessionVerdict, captureState, decideWrite } from "../src/postcondition.js";
import { withTrueFact } from "../src/index.js";
import type { PageReader } from "../src/driver.js";
import { serve, state, form, session, fakeStagehand, withBrowser, type Fixture } from "./helpers.js";

// ---------------------------------------------------------------------------
// Unit: observer liveness (OBSERVER-PLAN §3, test A11). Pure — the "reader" is a
// dead one whose every read throws, the shape of a closed tab or a dead socket.
// ---------------------------------------------------------------------------
describe("observer liveness: an unreadable page is a missing observer, not a clean one (A11)", () => {
  // Built inline on purpose: this is exactly what a detached page looks like to us.
  const dead: PageReader = {
    id: "x",
    snapshotTree: async () => null,
    evaluate: async () => {
      throw new Error("detached");
    },
    url: async () => {
      throw new Error("detached");
    },
    count: async () => 0,
    screenshot: async () => new Uint8Array(),
    waitForLoadState: async () => {},
  };
  const click = [{ selector: "#x", description: "", method: "click", arguments: [] }] as never;

  it("A11a: given an unreadable `before`, when decideWrite runs, then inconclusive / observer-lost without polling", async () => {
    const t = Date.now();
    const d = await decideWrite(dead, state({ readable: false }), state(), click, "same", true, 5000);
    assert.equal(d.post.verdict, "inconclusive");
    assert.equal(d.post.reason, "observer-lost");
    assert.ok(Date.now() - t < 200, `returned before the waitMs poll (took ${Date.now() - t} ms)`);
  });

  it("A11b: given an unreadable `firstAfter`, when decideWrite runs, then inconclusive / observer-lost without polling", async () => {
    const t = Date.now();
    const d = await decideWrite(dead, state(), state({ readable: false }), click, "same", true, 5000);
    assert.equal(d.post.verdict, "inconclusive");
    assert.equal(d.post.reason, "observer-lost");
    assert.ok(Date.now() - t < 200, `returned before the waitMs poll (took ${Date.now() - t} ms)`);
  });

  it("A11c: given a reader whose evaluate throws, when captureState runs, then the PageState is readable === false", async () => {
    const s = (await captureState(dead)) as unknown as { readable?: boolean };
    assert.equal(s.readable, false);
  });
});

// ---------------------------------------------------------------------------
// Unit: classify() is pure — no browser. One `it` per §4 row + ordering.
// Confidence is asserted on every row: it is the load-bearing field.
// ---------------------------------------------------------------------------
describe("classify (pure §4 rows, DAY4 R2)", () => {
  const base = state();
  const expect = (c: ReturnType<typeof classify>, verdict: string, reason: string, confidence: string) => {
    assert.equal(c.verdict, verdict);
    assert.equal(c.reason, reason);
    assert.equal(c.confidence, confidence);
  };

  it("row 1: a new tab (not in the before-set) -> landed / new-page / high", () => expect(classify(base, base, "new"), "landed", "new-page", "high"));
  it("row 1b (B rule): focus moved to a tab that existed before the action -> inconclusive / context-changed, never new-page", () => {
    const c = classify(base, base, "existing");
    assert.equal(c.verdict, "inconclusive");
    assert.equal(c.reason, "context-changed");
  });
  it("row 2: a path change -> landed / navigated / high", () =>
    expect(classify(base, state({ href: "http://x/b" }), "same"), "landed", "navigated", "high"));
  it("row 3: :user-invalid rose -> did-not-land / validation-error / high (empty tree diff)", () =>
    expect(classify(base, state({ userInvalidCount: 1 }), "same"), "did-not-land", "validation-error", "high"));
  it("row 4: alert + error text -> did-not-land / validation-error / high", () =>
    expect(classify(base, state({ tree: ["alert", "StaticText: Email is required"] }), "same"), "did-not-land", "validation-error", "high"));
  it("row 5: error text with no role -> inconclusive / error-text / heuristic", () =>
    expect(classify(base, state({ tree: ["StaticText: Something failed"] }), "same"), "inconclusive", "error-text", "heuristic"));
  it("row 6: dialog + buttons -> inconclusive / prompt / high (beats confirmation)", () =>
    expect(classify(base, state({ tree: ["dialog", "StaticText: Confirm your order?", "button: Confirm", "button: Cancel"] }), "same"), "inconclusive", "prompt", "high"));
  it("row 7: status role -> landed / confirmation / heuristic", () =>
    expect(classify(base, state({ tree: ["status", "StaticText: Order placed"] }), "same"), "landed", "confirmation", "heuristic"));
  it("row 8: form cleared -> landed / form-cleared / heuristic", () =>
    expect(classify(state({ forms: { email: form("a@b.co") } }), state({ forms: { email: form("") } }), "same"), "landed", "form-cleared", "heuristic"));
  it("row 9: hash-only change, nothing else -> inconclusive / hash-only-nav / heuristic", () =>
    expect(classify(base, state({ href: "http://x/a#done" }), "same"), "inconclusive", "hash-only-nav", "heuristic"));
  it("row 10: unclassified change -> inconclusive / changed-unclassified / heuristic", () =>
    expect(classify(base, state({ tree: ["menu", "menuitem: Copy"] }), "same"), "inconclusive", "changed-unclassified", "heuristic"));
  it("row 11 (R2): nothing changed -> inconclusive / no-change / heuristic — absence is not a mechanism", () =>
    expect(classify(base, base, "same"), "inconclusive", "no-change", "heuristic"));
  // --- false-landed guards (2026-09 soundness review) --------------------------
  it("bare alert with no confirm/error text -> inconclusive, never landed", () =>
    expect(classify(base, state({ tree: ["alert", "StaticText: Notice"] }), "same"), "inconclusive", "changed-unclassified", "heuristic"));
  it("alert announcing a failure ('Card declined') -> did-not-land, not landed", () =>
    expect(classify(base, state({ tree: ["alert", "StaticText: Card declined"] }), "same"), "did-not-land", "validation-error", "high"));
  it("a status role whose text says it failed ('Payment unsuccessful') -> not landed", () =>
    assert.notEqual(classify(base, state({ tree: ["status", "StaticText: Payment unsuccessful"] }), "same").verdict, "landed"));
  it("confirm word negated on the line ('Order could not be placed') -> not landed", () =>
    assert.notEqual(classify(base, state({ tree: ["StaticText: Order could not be placed"] }), "same").verdict, "landed"));
  it("navigation to an error URL (?error=declined) -> inconclusive, not landed/navigated/high", () =>
    expect(classify(base, state({ href: "http://x/checkout?error=declined" }), "same"), "inconclusive", "navigated", "heuristic"));
  it("ordering: navigation beats a stale validation flag", () =>
    assert.equal(classify(base, state({ href: "http://x/b", userInvalidCount: 1 }), "same").reason, "navigated"));
  it("ordering: an alert-error beats confirmation text on the same page", () =>
    assert.equal(classify(base, state({ tree: ["alert", "StaticText: invalid — order not placed"] }), "same").reason, "validation-error"));
});

describe("sessionVerdict (obstruction rule + destination gate + R2 corroboration)", () => {
  it("high-confidence obstruction -> did-not-land regardless of the verdict so far", () => {
    assert.equal(sessionVerdict("landed", session({ obstruction: "captcha", confidence: "high" })), "did-not-land");
  });
  it("heuristic obstruction only demotes a landed to inconclusive", () => {
    assert.equal(sessionVerdict("landed", session({ obstruction: "overlay", confidence: "heuristic" })), "inconclusive");
    assert.equal(sessionVerdict("did-not-land", session({ obstruction: "login-wall", confidence: "heuristic" })), "did-not-land");
  });
  it("R2: bare no-change + any obstruction is the cookie-overlay signature -> did-not-land", () => {
    assert.equal(sessionVerdict("inconclusive", session({ obstruction: "overlay", confidence: "heuristic" }), "no-change"), "did-not-land");
  });
  it("no obstruction -> verdict unchanged, even on no-change", () => {
    assert.equal(sessionVerdict("inconclusive", session(), "no-change"), "inconclusive");
  });
});

describe("tree normalization + diff", () => {
  it("strips node ids and indentation so the same page twice diffs to nothing", () => {
    const a = normalizeTree("[0-2] RootWebArea: X\n  [0-8] main\n    [0-9] button: Go");
    const b = normalizeTree("[1-4] RootWebArea: X\n  [1-7] main\n    [1-3] button: Go");
    assert.deepEqual(multisetDiff(b, a), []);
    assert.deepEqual(a, ["RootWebArea: X", "main", "button: Go"]);
  });
  it("one added status line diffs to exactly that line, without a prefix", () => {
    const a = normalizeTree("[0-2] main");
    const b = normalizeTree("[3-7] main\n  [3-9] status\n    [3-10] StaticText: Saved");
    assert.deepEqual(multisetDiff(b, a), ["status", "StaticText: Saved"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: real browser, real clicks, fake LLM, HTTP fixtures.
// ---------------------------------------------------------------------------
describe("withTrueFact: postcondition end to end", () => {
  const b = withBrowser();
  let fx: Fixture;
  const WAIT = 600;
  const runAct = async (spec: Parameters<typeof fakeStagehand>[2], waitMs = WAIT) => {
    const sh = await b.start();
    const { act, replay } = withTrueFact(fakeStagehand(sh, await b.page(), spec), { waitMs, screenshots: false });
    await act("do it");
    return replay.steps.at(-1)!;
  };
  const go = async (path: string) => (await b.page()).goto(fx.base + path);

  before(async () => {
    await b.start();
    fx = await serve({
      "/checkout": `<html><head><title>Checkout</title></head><body><main><form id="f" onsubmit="event.preventDefault();document.body.insertAdjacentHTML('beforeend','<p role=status>Order placed</p>')">
        <input name="email" required><button id="s" type="submit">Place order</button></form></main></body></html>`,
      "/done": `<html><head><title>Done</title></head><body><main><h1>done</h1></main></body></html>`,
      "/tab2": `<html><head><title>Tab2</title></head><body><main><h1>tab2</h1></main></body></html>`,
      "/login": { status: 401, html: `<html><head><title>Sign in</title></head><body><main><form><input type="password" autocomplete="current-password"></form></main></body></html>` },
      "/redirect": `<html><body><main><form onsubmit="event.preventDefault();setTimeout(()=>location.href='/login',400)"><button id="s" type="submit">Save</button></form></main></body></html>`,
      "/nav": `<html><body><main><a id="go" href="/done">go</a> <a id="ext" href="/tab2" target="_blank">open</a> <a id="dead" href="#x">dead</a></main></body></html>`,
      "/overlay": `<html><body><main><button id="s">Buy</button></main><div id="cookie" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5)"></div></body></html>`,
      "/dead": `<html><body><main><button id="s">Buy</button></main></body></html>`,
      "/fields": `<html><body><main><input id="e" name="email"><input id="r" name="rw" oninput="this.value=''">
        <input id="ac" name="ac" oninput="this.value='joanna'">
        <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select><button id="s" type="button">noop</button></main></body></html>`,
      // a new-password form is the Day 2 FP-guard case: a password field that is NOT a login wall
      "/pw": `<html><body><main><form><input id="p" name="pw" type="password" autocomplete="new-password"></form></main></body></html>`,
      "/login2": `<html><body><main><form onsubmit="event.preventDefault()"><input id="user" name="user"><input id="password" name="password" type="password"><button id="s" type="submit">Sign in</button></form></main></body></html>`,
      // a same-origin iframe (srcdoc) whose confirmation the click reveals INSIDE the frame
      "/iframe": `<html><body><main><button id="s" onclick="frames[0].document.body.insertAdjacentHTML('beforeend','<p role=status>Order placed</p>')">Go</button><iframe srcdoc="<body></body>"></iframe></main></body></html>`,
      "/mixed": `<html><body><main><form id="f" onsubmit="event.preventDefault()"><input name="email" required><input id="note" name="note"><button id="s" type="submit">Save</button></form></main></body></html>`,
      // value set by script, not the attribute, so form.reset() actually clears it
      "/reset": `<html><body><main><form id="f" onsubmit="event.preventDefault();this.reset()"><input name="email"><button id="s" type="submit">Go</button></form><script>document.querySelector('[name=email]').value='a@b.co'</script></main></body></html>`,
      "/details": `<html><body><main><details><summary id="s">More</summary><p>hidden text appears</p></details></main></body></html>`,
      "/errtext": `<html><body><main><button id="s" onclick="document.body.insertAdjacentHTML('beforeend','<p>Something failed, try again</p>')">Go</button></main></body></html>`,
      "/prompt": `<html><body><main><button id="s">Delete</button><dialog id="d">Confirm delete? <button>Confirm</button><button>Cancel</button></dialog><script>document.getElementById('s').onclick=()=>document.getElementById('d').showModal()</script></main></body></html>`,
      "/slow": `<html><body><main><button id="s">Save</button><script>document.getElementById('s').onclick=()=>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p role=status>Saved</p>'),700)</script></main></body></html>`,
      "/tall": `<html><body><main style="height:3000px"><button id="s">x</button></main></body></html>`,
      "/ticker": `<html><body><main><span id="t"></span><a id="go" href="/done">go</a><script>setInterval(()=>document.getElementById('t').appendChild(document.createElement('i')),60)</script></main></body></html>`,
    });
  });
  after(async () => {
    await b.stop();
    await fx.close();
  });

  it("required field blocks submit -> did-not-land / validation-error, without polling", async () => {
    await go("/checkout");
    const t = Date.now();
    const s = await runAct({ selector: "#s", method: "click" }, 30000);
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "validation-error");
    assert.ok(Date.now() - t < 10000, "resolved without the extended poll");
  });

  it("submit that reveals a confirmation -> landed / confirmation, with the added lines as evidence", async () => {
    const p = await b.page();
    await p.goto(fx.base + "/checkout");
    await p.locator("[name=email]").fill("a@b.co");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "confirmation");
    assert.ok(s.evidence.postcondition?.treeAdded.some((l) => /Order placed/.test(l)));
  });

  it("agent claims success:false but the page confirms -> landed (ignores agent_claim)", async () => {
    const p = await b.page();
    await p.goto(fx.base + "/checkout");
    await p.locator("[name=email]").fill("a@b.co");
    const s = await runAct({ actions: [{ selector: "#s", method: "click" }], success: false, message: "could not click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.agent_claim?.success, false);
  });

  it("a real navigation -> landed / navigated", async () => {
    await go("/nav");
    const s = await runAct({ selector: "#go", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "navigated");
  });

  it("a href='#x' anchor that lands nothing -> inconclusive / hash-only-nav", async () => {
    await go("/nav");
    const s = await runAct({ selector: "#dead", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "hash-only-nav");
  });

  it("R3: submit that redirects into a 401 login wall resolves well inside the budget -> inconclusive, navigated + login-wall", async () => {
    await go("/redirect");
    const t = Date.now();
    const s = await runAct({ selector: "#s", method: "click" }, 8000);
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "navigated");
    assert.equal(s.evidence.session.obstruction, "login-wall");
    assert.ok(Date.now() - t < 6000, "the null-fingerprint poll resolved before the deadline");
  });

  it("a new tab -> landed / new-page with newPageUrl; the extra tab is closed afterwards", async () => {
    await go("/nav");
    const s = await runAct({ selector: "#ext", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "new-page");
    assert.match(s.evidence.postcondition?.newPageUrl ?? "", /\/tab2$/);
    const sh = await b.start();
    const pages = await sh.browser.context.pages();
    assert.equal(pages.length, 2);
    await pages[1].close();
  });

  it("R2: cookie overlay swallows the click -> did-not-land / no-change, corroborated by the overlay", async () => {
    await go("/overlay");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "no-change");
    assert.equal(s.evidence.session.obstruction, "overlay");
  });

  it("R2: a dead click with no obstruction -> inconclusive / no-change (absence is not a mechanism)", async () => {
    await go("/dead");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "no-change");
  });

  it("field fill that holds -> landed / field-match", async () => {
    await go("/fields");
    const s = await runAct({ selector: "#e", method: "fill", args: ["Ada Lovelace"] });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "field-match");
    assert.equal(s.evidence.postcondition?.field?.actual, "Ada Lovelace");
  });

  it("field fill the page rewrites to empty -> did-not-land / field-mismatch", async () => {
    await go("/fields");
    const s = await runAct({ selector: "#r", method: "fill", args: ["a@b.co"] });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "field-mismatch");
  });

  it("non-ASCII fill the page rewrites to empty -> did-not-land, not a false '' == '' match", async () => {
    await go("/fields");
    const s = await runAct({ selector: "#r", method: "fill", args: ["東京"] });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "field-mismatch");
  });

  it("fill 'ann' into a field the page rewrites to 'joanna' -> did-not-land (equality, not substring)", async () => {
    await go("/fields");
    const s = await runAct({ selector: "#ac", method: "fill", args: ["ann"] });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "field-mismatch");
  });

  it("empty-string fill clears the field -> field-match only when actually empty", async () => {
    const p = await b.page();
    await p.goto(fx.base + "/fields");
    await p.locator("#e").fill("x");
    const s = await runAct({ selector: "#e", method: "fill", args: [""] });
    assert.equal(s.evidence.postcondition?.reason, "field-match");
    assert.equal(s.evidence.postcondition?.field?.actual, "");
  });

  it("selectOption 'pro' -> landed / field-match", async () => {
    await go("/fields");
    const s = await runAct({ selector: "#plan", method: "selectOption", args: ["pro"] });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "field-match");
  });

  it("stale reported selector on a field write falls through to classification, no throw", async () => {
    await go("/fields");
    // the fake fills #e for real but reports a selector that no longer resolves
    const s = await runAct({ selector: "#e", reportSelector: "#nope", method: "fill", args: ["x"] });
    assert.notEqual(s.evidence.postcondition?.reason, "field-match");
    assert.equal(s.evidence.postcondition?.reason, "changed-unclassified"); // the typed value shows up in the tree/forms diff
  });

  it("password fill is redacted in attempt, field, and auto evidence — never stored plain", async () => {
    await go("/pw");
    const s = await runAct({ selector: "#p", method: "fill", args: ["hunter2secret"] });
    assert.equal(s.verdict, "landed");
    assert.ok(!JSON.stringify(s).includes("hunter2secret"));
    assert.equal(s.attempt?.[0].arguments?.[0], "<redacted:13>");
    assert.equal(s.evidence.postcondition?.field?.expected, "<redacted:13>");
  });

  it("password in a LATER action of a multi-fill step is masked too, never just actions[0]", async () => {
    await go("/login2");
    const s = await runAct({ actions: [
      { selector: "#user", method: "fill", args: ["ada"] },
      { selector: "#password", method: "fill", args: ["s3cr3t-pw-9"] },
    ] });
    assert.ok(!JSON.stringify(s).includes("s3cr3t-pw-9"), "the password typed in attempt[1] must not be stored plain");
    assert.equal(s.attempt?.[1].arguments?.[0], "<redacted:11>");
  });

  it("R1: fill then click submit with a required field empty -> did-not-land / validation-error, not field-match", async () => {
    await go("/mixed");
    const s = await runAct({ actions: [{ selector: "#note", method: "fill", args: ["hi"] }, { selector: "#s", method: "click" }] });
    assert.equal(s.verdict, "did-not-land");
    assert.equal(s.evidence.postcondition?.reason, "validation-error");
    assert.equal(s.evidence.postcondition?.field?.actual, "hi"); // the field read is kept as evidence
  });

  it("submit that resets the form -> landed / form-cleared / heuristic", async () => {
    await go("/reset");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "form-cleared");
    assert.equal(s.evidence.postcondition?.confidence, "heuristic");
  });

  it("a click that only opens <details> -> inconclusive / changed-unclassified", async () => {
    await go("/details");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "changed-unclassified");
  });

  it("error text without a role -> inconclusive / error-text", async () => {
    await go("/errtext");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "error-text");
  });

  it("a scroll act is reclassified to a read, out of the write roll-up", async () => {
    await go("/tall");
    const s = await runAct({ selector: "#s", method: "scroll" });
    assert.equal(s.kind, "read");
    assert.equal(s.evidence.postcondition?.reason, "non-mutating");
  });

  it("a prompt dialog -> inconclusive / prompt, not confirmation", async () => {
    await go("/prompt");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.evidence.postcondition?.reason, "prompt");
  });

  it("slow confirmation past the settle window -> landed via the extended poll", async () => {
    await go("/slow");
    const s = await runAct({ selector: "#s", method: "click" }, 4000);
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "confirmation");
  });

  it("act() returns the verdict on the result (res.truefact) so an agent loop reads it there", async () => {
    const p = await b.page();
    await p.goto(fx.base + "/checkout");
    await p.locator("[name=email]").fill("a@b.co");
    const sh = await b.start();
    const { act } = withTrueFact(fakeStagehand(sh, await b.page(), { selector: "#s", method: "click" }), { waitMs: WAIT, screenshots: false });
    const res = await act("place the order");
    assert.equal(res.truefact.verdict, "landed");
    assert.ok(typeof res.truefact.why === "string" && res.truefact.why.length > 0, "why is a non-empty reason string");
    assert.equal(res.truefact.retryable, false, "a landed action is never retryable (repeating it is the double charge)");
  });

  it("replay.assertLanded() throws with the reason on a did-not-land run", async () => {
    await go("/checkout"); // required email empty -> validation-error / did-not-land
    const sh = await b.start();
    const tr = withTrueFact(fakeStagehand(sh, await b.page(), { selector: "#s", method: "click" }), { waitMs: WAIT, screenshots: false });
    await tr.act("submit");
    assert.throws(() => tr.replay.assertLanded(), /did not land/);
  });

  it("a confirmation rendered inside a same-origin iframe is seen (includeIframes) -> landed", async () => {
    await go("/iframe");
    const s = await runAct({ selector: "#s", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "confirmation");
  });

  it("D17: a page that mutates forever but navigates on click -> landed / navigated (unsettled must not mask it)", async () => {
    await go("/ticker");
    const s = await runAct({ selector: "#go", method: "click" });
    assert.equal(s.verdict, "landed");
    assert.equal(s.evidence.postcondition?.reason, "navigated");
  });
});
