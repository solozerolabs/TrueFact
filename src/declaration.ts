// Day 4 — declared postconditions. Data, never callbacks: a callback could read
// the agent's claim, and no verdict may. Each check is a direct page read,
// polled read-only until met or the budget ends. See docs/DAY4.md §2–§3.
import type { Page } from "@browserbasehq/stagehand";
import { safeRead } from "./session.js";
import {
  normalizeTree,
  pollUntil,
  readTarget,
  redactLen,
  type Outcome,
  type PostReason,
} from "./postcondition.js";

export type Declaration =
  | { kind: "url"; matches: string | RegExp } // string = substring of the URL without its hash; never equality
  | { kind: "element"; selector: string; absent?: boolean } // css | xpath= | text= (Stagehand's parser)
  | { kind: "text"; matches: string | RegExp; role?: string; absent?: boolean } // innerText, or a11y-tree lines under `role`
  | { kind: "field"; selector: string; equals: string | RegExp };

export interface DeclaredResult {
  declaration: Declaration; // `equals` redacted when the target is a password field
  met: boolean | null; // null = could not read the page
  actual: string | null; // last observed value, redacted for password targets
  elapsedMs: number;
}

const isVacuous = (m: string | RegExp): boolean => (typeof m === "string" ? m === "" : m.test(""));

/** Fail fast on declarations that would pass on anything. */
export function validateDeclarations(input: Declaration | Declaration[] | undefined): Declaration[] {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  for (const d of list) {
    const bad = (why: string) => new Error(`TrueReplay: vacuous declaration ${JSON.stringify(d, (_, v) => (v instanceof RegExp ? String(v) : v))} — ${why}`);
    switch (d.kind) {
      case "url":
        if (isVacuous(d.matches)) throw bad("url.matches would match any URL");
        break;
      case "text":
        if (isVacuous(d.matches)) throw bad("text.matches would match any page");
        break;
      case "element":
        if (!d.selector.trim()) throw bad("element.selector is empty");
        break;
      case "field":
        if (!d.selector.trim()) throw bad("field.selector is empty");
        break; // equals "" is allowed: it declares a cleared field
    }
  }
  return list;
}

const matches = (m: string | RegExp, s: string) => (typeof m === "string" ? s.includes(m) : m.test(s));

async function checkOne(
  page: Page,
  d: Declaration,
  tree: () => Promise<string[] | null>,
): Promise<{ met: boolean | null; actual: string | null; isPassword: boolean }> {
  switch (d.kind) {
    case "url": {
      let href: string;
      try {
        href = await page.url();
      } catch {
        return { met: null, actual: null, isPassword: false };
      }
      const noHash = href.split("#")[0];
      return { met: matches(d.matches, noHash), actual: noHash, isPassword: false };
    }
    case "element": {
      try {
        const count = await page.locator(d.selector).count(); // the one Locator read that never throws on zero
        return { met: d.absent ? count === 0 : count > 0, actual: String(count), isPassword: false };
      } catch {
        return { met: null, actual: null, isPassword: false };
      }
    }
    case "text": {
      if (d.role) {
        const lines = await tree();
        if (!lines) return { met: null, actual: null, isPassword: false };
        const roleRx = new RegExp("^" + d.role + "\\b");
        let hit: string | null = null;
        for (let i = 0; i < lines.length && !hit; i++) {
          if (!roleRx.test(lines[i])) continue;
          for (let j = i; j < Math.min(lines.length, i + 6); j++) {
            if (matches(d.matches, lines[j])) {
              hit = lines[j];
              break;
            }
          }
        }
        return { met: d.absent ? hit === null : hit !== null, actual: hit, isPassword: false };
      }
      const text = await safeRead(page, () => (document.body ? document.body.innerText : ""));
      if (text === null) return { met: null, actual: null, isPassword: false };
      const found = matches(d.matches, text);
      const actual = typeof d.matches === "string" ? (found ? d.matches : null) : (text.match(d.matches)?.[0] ?? null);
      return { met: d.absent ? !found : found, actual, isPassword: false };
    }
    case "field": {
      const r = await readTarget(page, d.selector);
      if (!r || !r.found) return { met: null, actual: null, isPassword: false };
      const met = typeof d.equals === "string" ? r.value === d.equals : d.equals.test(r.value);
      return { met, actual: r.value, isPassword: r.isPassword };
    }
  }
}

/**
 * Evaluate every declaration each tick until all are met or the budget ends.
 * Read-only: the write is never re-issued. Password targets are redacted in
 * the returned results (the verdict was computed on the real value).
 */
export async function checkDeclarations(page: Page, decls: Declaration[], budgetMs: number): Promise<DeclaredResult[]> {
  const start = Date.now();
  const evaluate = async (): Promise<DeclaredResult[]> => {
    let cached: string[] | null | undefined;
    const tree = async () => {
      if (cached !== undefined) return cached;
      try {
        cached = normalizeTree((await page.snapshot()).formattedTree);
      } catch {
        cached = null;
      }
      return cached;
    };
    const out: DeclaredResult[] = [];
    for (const d of decls) {
      const r = await checkOne(page, d, tree);
      const declaration: Declaration =
        r.isPassword && d.kind === "field" && typeof d.equals === "string" ? { ...d, equals: redactLen(d.equals) } : d;
      out.push({
        declaration,
        met: r.met,
        actual: r.isPassword && r.actual !== null ? redactLen(r.actual) : r.actual,
        elapsedMs: Date.now() - start,
      });
    }
    return out;
  };
  const first = await evaluate();
  if (first.every((r) => r.met === true)) return first;
  const polled = await pollUntil(page, budgetMs, async (_changed, final) => {
    const rs = await evaluate();
    return rs.every((r) => r.met === true) || final ? rs : null;
  });
  return polled ?? first;
}

const LIFTABLE = new Set<PostReason>(["no-change", "changed-unclassified", "hash-only-nav", "unsettled", "error-text"]);

/**
 * Compose the auto outcome with declared results (docs/DAY4.md §3). Unmet →
 * did-not-land. Met lifts only the auto default's uncertain outcomes and
 * never argues with a mechanism-backed did-not-land. Negatives never lift.
 */
export function applyDeclarations(auto: Outcome, results: DeclaredResult[]): Outcome {
  if (results.length === 0) return auto;
  if (results.some((r) => r.met === null)) return { verdict: "inconclusive", reason: "declared-unreadable", confidence: "heuristic" };
  if (results.some((r) => r.met === false)) return { verdict: "did-not-land", reason: "declared-unmet", confidence: "high" };
  const positives = results.filter((r) => !("absent" in r.declaration && r.declaration.absent));
  if (positives.length === 0) return auto;
  if (auto.verdict === "landed") return { ...auto, confidence: "high" };
  if (LIFTABLE.has(auto.reason)) return { verdict: "landed", reason: "declared-met", confidence: "high" };
  return auto;
}
