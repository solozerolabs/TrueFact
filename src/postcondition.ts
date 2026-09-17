// Day 3 — auto-inferred postcondition. Capture page state (a11y tree + form
// values + validity), classify the change after a write, and read the targeted
// field directly for fill/type/select. Pure where it can be: `classify` is a
// function of two PageStates, unit-testable with no browser. See docs/DAY3.md.
import type { Page } from "@browserbasehq/stagehand";
import { fingerprint, safeRead, type Fingerprint } from "./session.js";
import type { Verdict } from "./index.js";

export type PostReason =
  | "field-match"
  | "field-mismatch"
  | "new-page"
  | "navigated"
  | "validation-error"
  | "error-text"
  | "prompt"
  | "confirmation"
  | "form-cleared"
  | "hash-only-nav"
  | "changed-unclassified"
  | "no-change"
  | "non-mutating"
  | "unsettled";

export type Confidence = "high" | "heuristic";

export interface FormValue {
  value: string; // passwords already stored as "<redacted:N>"
  checked?: boolean;
  userInvalid: boolean;
}

export interface PageState {
  fp: Fingerprint;
  tree: string[]; // normalized formattedTree lines
  forms: Record<string, FormValue>;
  userInvalidCount: number;
  activeField: string | null;
  pageId: string;
}

export interface Postcondition {
  reason: PostReason;
  confidence: Confidence;
  urlChanged: boolean;
  pageSwitched: boolean;
  newPageUrl?: string;
  treeAdded: string[];
  treeRemoved: string[];
  formsBefore: Record<string, FormValue>;
  formsAfter: Record<string, FormValue>;
  field?: { selector: string; expected: string; actual: string | null };
}

const EMPTY_FP: Fingerprint = {
  href: "",
  readyState: "",
  bodyTextLength: 0,
  elementCount: 0,
  title: "",
};

export const redactLen = (s: string): string => `<redacted:${s.length}>`;

/** Strip the `[n-m]` node-id prefix and indentation so diffs compare content. */
export function normalizeTree(formattedTree: string): string[] {
  return formattedTree
    .split("\n")
    .map((l) => l.replace(/^\s*\[\d+-\d+\]\s*/, "").trim())
    .filter(Boolean);
}

function multisetDiff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

export async function captureState(page: Page): Promise<PageState> {
  const fp = (await fingerprint(page)) ?? EMPTY_FP;
  let tree: string[] = [];
  try {
    tree = normalizeTree((await page.snapshot()).formattedTree);
  } catch {
    /* mid-navigation snapshot can throw; empty tree is a safe read */
  }
  const meta =
    (await safeRead(page, () => {
      const forms: Record<string, { value: string; checked?: boolean; userInvalid: boolean }> = {};
      const els = document.querySelectorAll("input, textarea, select");
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as unknown as {
          getAttribute(n: string): string | null;
          id: string;
          tagName: string;
          value: string;
          checked?: boolean;
          options?: { value: string; textContent: string | null }[];
          selectedIndex?: number;
          matches(s: string): boolean;
        };
        const key = el.getAttribute("name") || el.id;
        if (!key) continue;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        let value: string;
        if (tag === "select") {
          const opt = el.options && el.selectedIndex != null ? el.options[el.selectedIndex] : null;
          value = opt ? opt.value || opt.textContent || "" : "";
        } else {
          value = el.value || "";
        }
        if (type === "password") value = "<redacted:" + value.length + ">";
        let userInvalid = false;
        try {
          userInvalid = el.matches(":user-invalid");
        } catch {
          /* :user-invalid unsupported */
        }
        const rec: { value: string; checked?: boolean; userInvalid: boolean } = { value, userInvalid };
        if (type === "checkbox" || type === "radio") rec.checked = !!el.checked;
        forms[key] = rec;
      }
      let userInvalidCount = 0;
      try {
        userInvalidCount = document.querySelectorAll(":user-invalid").length;
      } catch {
        /* unsupported */
      }
      const ae = document.activeElement;
      let activeField: string | null = null;
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
    pageId: String((page as unknown as { pageId?: string }).pageId ?? ""),
  };
}

const ERROR_RX = /required|invalid|error|failed|incorrect|try again|must be|not (valid|allowed)/i;
const CONFIRM_RX =
  /thank|success|confirm|placed|saved|sent|submitted|complete|done|received|updated|created/i;

const isEmptyValue = (fv: FormValue | undefined): boolean =>
  !fv || fv.value === "" || fv.value === "<redacted:0>";

function urlDelta(a: string, b: string): { changed: boolean; hashOnly: boolean } {
  if (a === b) return { changed: false, hashOnly: false };
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const hashOnly =
      ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
    return { changed: true, hashOnly };
  } catch {
    return { changed: true, hashOnly: false };
  }
}

/**
 * The §4 classification rows. Pure: a function of two PageStates plus whether a
 * tab switch happened. Returns the verdict, the reason, and the evidence block
 * (minus `field`/`newPageUrl`, which the wrapper adds). First match wins.
 */
export function classify(
  before: PageState,
  after: PageState,
  pageSwitched: boolean,
): { verdict: Verdict; post: Postcondition } {
  const added = multisetDiff(after.tree, before.tree);
  const removed = multisetDiff(before.tree, after.tree);
  const { changed: urlChanged, hashOnly } = urlDelta(before.fp.href, after.fp.href);
  const formsChanged = JSON.stringify(before.forms) !== JSON.stringify(after.forms);
  const contentChanged = added.length > 0 || removed.length > 0 || formsChanged;

  const base = (reason: PostReason, confidence: Confidence): Postcondition => ({
    reason,
    confidence,
    urlChanged,
    pageSwitched,
    treeAdded: added.slice(0, 40),
    treeRemoved: removed.slice(0, 40),
    formsBefore: before.forms,
    formsAfter: after.forms,
  });
  const out = (verdict: Verdict, reason: PostReason, confidence: Confidence) => ({
    verdict,
    post: base(reason, confidence),
  });

  const hasRole = (role: string) => added.some((l) => new RegExp("^" + role + "\\b").test(l));
  const hasErrorText = added.some((l) => ERROR_RX.test(l));
  const hasConfirmText = added.some((l) => CONFIRM_RX.test(l));

  // 1-2: navigation is the strongest landed signal.
  if (pageSwitched) return out("landed", "new-page", "high");
  if (urlChanged && !hashOnly) return out("landed", "navigated", "high");

  // 3: native constraint validation blocked the submit (invisible to the tree).
  const activeInvalid = after.activeField ? after.forms[after.activeField]?.userInvalid : false;
  if (after.userInvalidCount > before.userInvalidCount || activeInvalid) {
    return out("did-not-land", "validation-error", "high");
  }
  // 4: an alert with error text.
  if (hasRole("alert") && hasErrorText) return out("did-not-land", "validation-error", "high");
  // 5: error text without a role.
  if (hasErrorText && !hasRole("alert") && !hasRole("status")) {
    return out("inconclusive", "error-text", "heuristic");
  }
  // 6: a prompt (dialog + buttons) is a question, not a confirmation.
  if (hasRole("dialog") && hasRole("button")) return out("inconclusive", "prompt", "high");
  // 7: confirmation-shaped.
  if (hasRole("status") || hasRole("alert") || hasRole("dialog") || hasConfirmText) {
    return out("landed", "confirmation", "heuristic");
  }
  // 8: the form cleared.
  const nonEmptyBefore = Object.keys(before.forms).filter((k) => !isEmptyValue(before.forms[k]));
  const formStillPresent = Object.keys(after.forms).length > 0;
  if (
    formStillPresent &&
    nonEmptyBefore.length > 0 &&
    nonEmptyBefore.every((k) => k in after.forms && isEmptyValue(after.forms[k]))
  ) {
    return out("landed", "form-cleared", "heuristic");
  }
  // 9: a bare hash change that landed nothing.
  if (hashOnly && !contentChanged) return out("inconclusive", "hash-only-nav", "heuristic");
  // 10: something changed, none of the above.
  if (contentChanged) return out("inconclusive", "changed-unclassified", "heuristic");
  // 11: nothing changed at all.
  return out("did-not-land", "no-change", "high");
}

interface Action {
  selector: string;
  method?: string;
  arguments?: string[];
}

export interface FieldResult {
  verdict: Verdict;
  reason: "field-match" | "field-mismatch";
  confidence: "high";
  field: { selector: string; expected: string; actual: string | null };
  isPassword: boolean;
}

const SELECT_METHODS = new Set(["selectOption", "selectOptionFromDropdown"]);

/**
 * Read the field the agent says it targeted and compare to what it says it
 * typed. `attempt` picks the selector and the expected value; the verdict comes
 * from a page read, never from agent_claim. Returns null (fall through to §4) if
 * the read fails for any reason.
 */
export async function fieldPostcondition(page: Page, actions: Action[]): Promise<FieldResult | null> {
  const a = actions[0];
  if (!a?.method) return null;
  const selector = a.selector;
  const expected = a.arguments?.[0] ?? "";
  const res = await safeRead(
    page,
    (sel) => {
      const s = sel as string;
      const clean = s.indexOf("xpath=") === 0 ? s.slice(6) : s;
      let el: unknown = null;
      try {
        const r = document.evaluate(clean, document, null, 9, null);
        el = r.singleNodeValue;
      } catch {
        el = null;
      }
      if (!el) {
        try {
          el = document.querySelector(s);
        } catch {
          el = null;
        }
      }
      if (!el) return null;
      const e = el as {
        tagName: string;
        value?: string;
        options?: { value: string; textContent: string | null }[];
        selectedIndex?: number;
        getAttribute(n: string): string | null;
      };
      let value: string;
      if (e.tagName === "SELECT") {
        const o = e.options && e.selectedIndex != null ? e.options[e.selectedIndex] : null;
        value = o ? o.value || o.textContent || "" : "";
      } else {
        value = e.value ?? "";
      }
      const isPassword = (e.getAttribute("type") || "").toLowerCase() === "password";
      return { value, isPassword };
    },
    selector,
  );
  if (!res) return null;

  const actual = res.value;
  const match = SELECT_METHODS.has(a.method)
    ? actual === expected
    : expected === ""
      ? actual === ""
      : actual.includes(expected);

  return {
    verdict: match ? "landed" : "did-not-land",
    reason: match ? "field-match" : "field-mismatch",
    confidence: "high",
    field: { selector, expected, actual },
    isPassword: res.isPassword,
  };
}
