import { fingerprint, safeRead, sameFingerprint, } from "./session.js";
const EMPTY_FP = { href: "", readyState: "", bodyTextLength: 0, elementCount: 0, title: "" };
export const redactLen = (s) => `<redacted:${s.length}>`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Strip the `[n-m]` node-id prefix and indentation so diffs compare content. */
export function normalizeTree(formattedTree) {
    return formattedTree
        .split("\n")
        .map((l) => l.replace(/^\s*\[\d+-\d+\]\s*/, "").trim())
        .filter(Boolean);
}
/** The reader's normalized tree lines, or null if the snapshot threw
 *  (mid-navigation). The single place `captureState`, `checkDeclarations` and
 *  grounding read the a11y tree — now driver-agnostic via the PageReader. */
export function readTree(page) {
    return page.snapshotTree();
}
/** The page text of one normalized tree line, without its `role:` prefix or
 *  `[selected]`/`[checked]` markers. A role-only structural line (no `: `,
 *  e.g. `status`, `scrollable, html`) has no text and returns "". */
export function treeText(line) {
    const clean = line.replace(/\s*\[[a-z]+\]/g, "").trim();
    const i = clean.indexOf(": ");
    return i === -1 ? "" : clean.slice(i + 2).trim();
}
export function multisetDiff(a, b) {
    const counts = new Map();
    for (const x of b)
        counts.set(x, (counts.get(x) ?? 0) + 1);
    const out = [];
    for (const x of a) {
        const c = counts.get(x) ?? 0;
        if (c > 0)
            counts.set(x, c - 1);
        else
            out.push(x);
    }
    return out;
}
export async function captureState(page) {
    const fp = (await fingerprint(page)) ?? EMPTY_FP;
    const tree = (await readTree(page)) ?? []; // mid-navigation snapshot can throw; empty tree is a safe read
    const meta = (await safeRead(page, () => {
        const forms = {};
        const els = document.querySelectorAll("input, textarea, select");
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const key = el.getAttribute("name") || el.id;
            if (!key)
                continue;
            const tag = el.tagName.toLowerCase();
            const type = (el.getAttribute("type") || "").toLowerCase();
            let value;
            if (tag === "select") {
                const opt = el.options && el.selectedIndex != null ? el.options[el.selectedIndex] : null;
                value = opt ? opt.value || opt.textContent || "" : "";
            }
            else {
                value = el.value || "";
            }
            if (type === "password")
                value = "<redacted:" + value.length + ">";
            let userInvalid = false;
            try {
                userInvalid = el.matches(":user-invalid");
            }
            catch {
                /* :user-invalid unsupported */
            }
            const rec = { value, userInvalid };
            if (type === "checkbox" || type === "radio")
                rec.checked = !!el.checked;
            forms[key] = rec;
        }
        let userInvalidCount = 0;
        try {
            userInvalidCount = document.querySelectorAll(":user-invalid").length;
        }
        catch {
            /* unsupported */
        }
        const ae = document.activeElement;
        let activeField = null;
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) {
            activeField = ae.getAttribute("name") || ae.id || null;
        }
        return { forms, userInvalidCount, activeField };
    })) ?? { forms: {}, userInvalidCount: 0, activeField: null };
    return {
        fp,
        tree,
        forms: meta.forms,
        userInvalidCount: meta.userInvalidCount,
        activeField: meta.activeField,
        pageId: page.id,
    };
}
const ERROR_RX = /required|invalid|error|failed|incorrect|try again|must be|not (valid|allowed)/i;
const CONFIRM_RX = /thank|success|confirm|placed|saved|sent|submitted|complete|done|received|updated|created/i;
const isEmptyValue = (fv) => !fv || fv.value === "" || fv.value === "<redacted:0>";
function urlDelta(a, b) {
    if (a === b)
        return { changed: false, hashOnly: false };
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        const hashOnly = ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
        return { changed: true, hashOnly };
    }
    catch {
        return { changed: true, hashOnly: false };
    }
}
/** The evidence block for a step: tree diff, url delta, forms. Pure. */
export function evidenceOf(before, after, pageSwitched, outcome) {
    const added = multisetDiff(after.tree, before.tree);
    const removed = multisetDiff(before.tree, after.tree);
    return {
        ...outcome,
        auto: outcome,
        urlChanged: before.fp.href !== after.fp.href,
        pageSwitched,
        treeAdded: added.slice(0, 40),
        treeRemoved: removed.slice(0, 40),
        formsBefore: before.forms,
        formsAfter: after.forms,
    };
}
/**
 * The §4 classification rows (docs/DAY3.md, revised by DAY4 R2). Pure: a
 * function of two PageStates plus whether a tab switch happened. First match
 * wins. Bare no-change is `inconclusive`; corroboration to did-not-land
 * happens in sessionVerdict, where the obstruction is known.
 */
export function classify(before, after, pageSwitched) {
    const added = multisetDiff(after.tree, before.tree);
    const removed = multisetDiff(before.tree, after.tree);
    const { changed: urlChanged, hashOnly } = urlDelta(before.fp.href, after.fp.href);
    const formsChanged = JSON.stringify(before.forms) !== JSON.stringify(after.forms);
    const contentChanged = added.length > 0 || removed.length > 0 || formsChanged;
    const out = (verdict, reason, confidence) => ({ verdict, reason, confidence });
    const hasRole = (role) => added.some((l) => new RegExp("^" + role + "\\b").test(l));
    const hasErrorText = added.some((l) => ERROR_RX.test(l));
    const hasConfirmText = added.some((l) => CONFIRM_RX.test(l));
    if (pageSwitched)
        return out("landed", "new-page", "high");
    if (urlChanged && !hashOnly)
        return out("landed", "navigated", "high");
    // A corroborated error (an alert announcing an error) is a real rejection and
    // outranks everything below.
    if (hasRole("alert") && hasErrorText)
        return out("did-not-land", "validation-error", "high");
    // A positive confirmation signal outranks a stray :user-invalid elsewhere on
    // the page: a write that shows "Order placed ✅" landed even if an unrelated
    // optional field also went invalid. Real rejections show no confirmation, so
    // validation-reject (empty required field, no ✅) still falls through to
    // did-not-land below.
    const hasConfirm = hasRole("status") || hasRole("dialog") || hasConfirmText;
    const activeInvalid = after.activeField ? after.forms[after.activeField]?.userInvalid : false;
    if (!hasConfirm && (after.userInvalidCount > before.userInvalidCount || activeInvalid)) {
        return out("did-not-land", "validation-error", "high");
    }
    if (hasErrorText && !hasRole("alert") && !hasRole("status"))
        return out("inconclusive", "error-text", "heuristic");
    if (hasRole("dialog") && hasRole("button"))
        return out("inconclusive", "prompt", "high");
    if (hasConfirm || hasRole("alert")) {
        return out("landed", "confirmation", "heuristic");
    }
    const nonEmptyBefore = Object.keys(before.forms).filter((k) => !isEmptyValue(before.forms[k]));
    const formStillPresent = Object.keys(after.forms).length > 0;
    if (formStillPresent &&
        nonEmptyBefore.length > 0 &&
        nonEmptyBefore.every((k) => k in after.forms && isEmptyValue(after.forms[k]))) {
        return out("landed", "form-cleared", "heuristic");
    }
    if (hashOnly && !contentChanged)
        return out("inconclusive", "hash-only-nav", "heuristic");
    if (contentChanged)
        return out("inconclusive", "changed-unclassified", "heuristic");
    return out("inconclusive", "no-change", "heuristic"); // R2: absence of feedback is not a mechanism
}
/**
 * Day 2 obstruction rule + Day 4 destination gate + R2 corroboration, as a
 * pure function of the verdict-so-far, the session read on the final page,
 * and the reason. A high-confidence obstruction forces did-not-land; a
 * heuristic one demotes landed to inconclusive; bare no-change plus ANY
 * obstruction is the cookie-overlay signature → did-not-land.
 */
export function sessionVerdict(current, session, reason) {
    if (!session.obstruction)
        return current;
    if (session.confidence === "high")
        return "did-not-land";
    if (reason === "no-change")
        return "did-not-land";
    if (current === "landed")
        return "inconclusive";
    return current;
}
/**
 * Compose the page-read verdict with the network sidecar (M2). A same-origin
 * server error / failed request in the write window means the write's own
 * backend rejected it — did-not-land, high — and this overrides an optimistic
 * confirmation (page ✅, server 500), the one trap a page read cannot beat.
 *
 * It only demotes: it never lifts, never argues with a mechanism-backed
 * did-not-land (that verdict keeps its own reason), and does nothing on an
 * empty error set. Same-origin filtering is the caller's (see sidecar): a
 * third-party analytics 500 is not evidence the write failed, so it never
 * reaches here — that is the cry-wolf guard.
 */
export function applyNetwork(current, errors) {
    if (current === "did-not-land" || errors.length === 0)
        return null;
    return { verdict: "did-not-land", reason: "network-error", confidence: "high" };
}
/**
 * One in-page read of a selector's target (css | xpath= | bare xpath): its
 * value (input / select), text, whether it exists, and whether it is a
 * password field. Serialized into the page, so everything is inline (no outer
 * helper calls — see AGENTS.md).
 */
export async function readTarget(page, selector) {
    return safeRead(page, (sel) => {
        const s = sel;
        const looksXPath = s.indexOf("xpath=") === 0 || s.charAt(0) === "/" || s.charAt(0) === "(";
        const clean = s.indexOf("xpath=") === 0 ? s.slice(6) : s;
        let el = null;
        if (looksXPath) {
            try {
                el = document.evaluate(clean, document, null, 9, null).singleNodeValue;
            }
            catch {
                el = null;
            }
        }
        else {
            try {
                el = document.querySelector(s);
            }
            catch {
                el = null;
            }
        }
        if (!el)
            return { found: false, value: "", text: "", isPassword: false };
        const e = el;
        let value = "";
        if (e.tagName === "SELECT") {
            const o = e.options && e.selectedIndex != null ? e.options[e.selectedIndex] : null;
            value = o ? o.value || o.textContent || "" : "";
        }
        else if (typeof e.value === "string") {
            value = e.value;
        }
        return {
            found: true,
            value,
            text: (e.textContent || "").trim(),
            isPassword: (e.getAttribute("type") || "").toLowerCase() === "password",
        };
    }, selector);
}
const SELECT_METHODS = new Set(["selectOption", "selectOptionFromDropdown"]);
const FIELD_METHODS = new Set(["fill", "type", ...SELECT_METHODS]);
// From Stagehand's action handlers (extension METHOD_HANDLER_MAP).
const NON_MUTATING = new Set([
    "hover", "scroll", "scrollTo", "scrollIntoView", "scrollByPixelOffset", "nextChunk", "prevChunk", "mouse.wheel",
]);
/**
 * Read the field the agent says it targeted and compare to what it says it
 * typed. `attempt` picks the selector and the expected value; the verdict
 * comes from a page read. Returns null (fall through to classify) if the read
 * fails for any reason.
 */
export async function fieldPostcondition(page, action) {
    if (!action.method || !FIELD_METHODS.has(action.method))
        return null;
    const expected = action.arguments?.[0] ?? "";
    const res = await readTarget(page, action.selector);
    if (!res || !res.found)
        return null;
    const actual = res.value;
    // Compare on alphanumerics only, so input masking (a phone that renders
    // "(555) 123-4567", a trimmed/reformatted value) is not read as a mismatch.
    // ponytail: alnum-normalized substring; if a field's punctuation is ever
    // semantic (rare), compare raw for that type.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = SELECT_METHODS.has(action.method)
        ? actual === expected
        : expected === ""
            ? actual === ""
            : norm(actual).includes(norm(expected));
    return {
        verdict: match ? "landed" : "did-not-land",
        reason: match ? "field-match" : "field-mismatch",
        confidence: "high",
        field: { selector: action.selector, expected, actual },
        isPassword: res.isPassword,
    };
}
/**
 * Poll the cheap fingerprint every `intervalMs` for up to `budgetMs`, calling
 * `probe(changed)` each tick; return its first non-null result, else probe
 * once more at the deadline. A null fingerprint (navigation in flight) counts
 * as changed (DAY4 R3).
 */
export async function pollUntil(page, budgetMs, probe, intervalMs = 250) {
    const start = Date.now();
    let last = await fingerprint(page);
    while (Date.now() - start < budgetMs) {
        await sleep(intervalMs);
        const fp = await fingerprint(page);
        const changed = !fp || !last || !sameFingerprint(fp, last);
        if (fp)
            last = fp;
        const r = await probe(changed, false);
        if (r !== null)
            return r;
    }
    return probe(true, true);
}
const stricter = (a, b) => {
    const rank = { "did-not-land": 2, inconclusive: 1, landed: 0 };
    return rank[b.verdict] > rank[a.verdict] ? b : a;
};
/**
 * The write-step decision (DAY3 §8 precedence with DAY4 R1/R2). `waitMs` is
 * the extended no-change budget; pass 0 when a declaration will poll instead.
 */
export async function decideWrite(page, before, firstAfter, actions, pageSwitched, settled, waitMs) {
    const methods = (actions ?? []).map((a) => a.method).filter(Boolean);
    let after = firstAfter;
    // §6 non-mutating: this was not a write.
    if (methods.length > 0 && methods.every((m) => NON_MUTATING.has(m))) {
        const o = { verdict: "inconclusive", reason: "non-mutating", confidence: "heuristic" };
        return { kind: "read", post: evidenceOf(before, after, pageSwitched, o), after, isPassword: false };
    }
    // §3 field writes: read each targeted field. R1: only a pure field-write
    // step short-circuits; a mixed step also classifies and takes the stricter.
    let field = null;
    if (!pageSwitched && methods.length > 0 && FIELD_METHODS.has(methods[0])) {
        field = await fieldPostcondition(page, actions[0]);
    }
    // Only the outcome triple goes into evidence: a FieldResult carries the
    // plaintext expected/actual, which must not ride along as `auto`.
    const triple = (o) => ({ verdict: o.verdict, reason: o.reason, confidence: o.confidence });
    const pureFieldStep = field !== null && methods.every((m) => FIELD_METHODS.has(m));
    if (pureFieldStep) {
        const post = evidenceOf(before, after, pageSwitched, triple(field));
        post.field = field.field;
        return { kind: "write", post, after, isPassword: field.isPassword };
    }
    // §4 classification, with the §4.1 extended wait on a first-look no-change.
    let auto = classify(before, after, pageSwitched);
    if (auto.reason === "no-change" && waitMs > 0) {
        const resolved = await pollUntil(page, waitMs, async (changed) => {
            if (!changed)
                return null;
            const state = await captureState(page);
            const c = classify(before, state, false);
            return c.reason === "no-change" ? null : { state, c };
        });
        if (resolved) {
            after = resolved.state;
            auto = resolved.c;
        }
        else {
            after = await captureState(page);
            auto = classify(before, after, false);
        }
        if (auto.reason === "no-change" && !settled)
            auto = { verdict: "inconclusive", reason: "unsettled", confidence: "heuristic" };
    }
    if (field)
        auto = stricter(auto, triple(field)); // mixed fill+click: the field read is evidence, the stricter verdict wins
    const post = evidenceOf(before, after, pageSwitched, auto);
    if (field)
        post.field = field.field;
    return { kind: "write", post, after, isPassword: field?.isPassword ?? false };
}
