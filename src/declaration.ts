// Day 4 — declared postconditions. Data, never callbacks: a callback could read
// the agent's claim, and no verdict may. Each check is a direct page read,
// polled read-only until met or the budget ends. See docs/DAY4.md §2–§3.
import type { PageReader } from "./driver.js";
import { safeRead } from "./session.js";
import {
  pollUntil,
  readTarget,
  redactLen,
  treeText,
  type Outcome,
  type PostReason,
} from "./postcondition.js";

export type Declaration =
  | { kind: "url"; matches: string | RegExp } // string = substring of the URL without its hash; never equality
  | { kind: "element"; selector: string; absent?: boolean } // css | xpath= | text= (Stagehand's parser)
  | { kind: "text"; matches: string | RegExp; role?: string; absent?: boolean } // innerText, or a11y-tree lines under `role`
  | { kind: "field"; selector: string; equals: string | RegExp }
  // Out-of-band reconciliation: TrueFact GETs `get` itself (relative resolves
  // against the page URL) and matches real server state — the only signal that
  // catches optimistic UI, which Stagehand v4 cannot observe on the wire. Data,
  // not a callback: no verdict path ever sees the agent's claim. See DAY4 §4.
  | { kind: "probe"; get: string; status?: "ok" | number; text?: string | RegExp; absent?: boolean };

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
    const bad = (why: string) => new Error(`TrueFact: vacuous declaration ${JSON.stringify(d, (_, v) => (v instanceof RegExp ? String(v) : v))} — ${why}`);
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
      case "probe":
        if (!d.get.trim()) throw bad("probe.get is empty");
        if (d.status === undefined && d.text === undefined) throw bad("probe needs a status or text to match — a bare get asserts nothing");
        if (d.text !== undefined && isVacuous(d.text)) throw bad("probe.text would match any body");
        break;
    }
  }
  return list;
}

const matches = (m: string | RegExp, s: string) => (typeof m === "string" ? s.includes(m) : m.test(s));

async function checkOne(
  page: PageReader,
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
        const count = await page.count(d.selector); // the one Locator read that never throws on zero
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
        // R10: a role's text lives in child StaticText lines, and inline markup
        // (Order #<strong>4821</strong>) splits it across several — so match over
        // the joined subtree, not line by line. Try a spaced join and a tight
        // join (the DOM had no separator between inline nodes).
        for (let i = 0; i < lines.length && hit === null; i++) {
          if (!roleRx.test(lines[i])) continue;
          const parts: string[] = [];
          for (let j = i; j < Math.min(lines.length, i + 6); j++) parts.push(treeText(lines[j]));
          const spaced = parts.filter(Boolean).join(" ");
          const tight = parts.join("");
          if (matches(d.matches, spaced)) hit = spaced;
          else if (matches(d.matches, tight)) hit = tight;
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
    case "probe": {
      // Resolve relative against the page's own origin, then GET it ourselves.
      let url: string;
      try {
        url = new URL(d.get, await page.url()).toString();
      } catch {
        return { met: null, actual: null, isPassword: false };
      }
      let res: { status: number; ok: boolean; text(): Promise<string> };
      try {
        // ponytail: fixed 2s per-fetch timeout so a hung endpoint can't stall the
        // verdict poll; widen if a legitimate reconciliation call is slower.
        res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
      } catch {
        return { met: null, actual: null, isPassword: false }; // unreachable / timeout → inconclusive
      }
      const status = res.status;
      // A broken verify endpoint (5xx) is not evidence the write failed — unless
      // the caller explicitly declared that 5xx. Never turn probe ill-health into
      // a false did-not-land.
      const expectedThis5xx = typeof d.status === "number" && d.status === status;
      if (status >= 500 && !expectedThis5xx) return { met: null, actual: `HTTP ${status}`, isPassword: false };
      let ok = true;
      if (d.status !== undefined) ok = d.status === "ok" ? res.ok : status === d.status;
      if (ok && d.text !== undefined) {
        let body: string;
        try {
          body = await res.text();
        } catch {
          return { met: null, actual: `HTTP ${status}`, isPassword: false };
        }
        ok = matches(d.text, body);
      }
      // Store only the status line — never the fetched body — so a probe cannot
      // leak server content into the replay record.
      return { met: d.absent ? !ok : ok, actual: `HTTP ${status}`, isPassword: false };
    }
  }
}

/**
 * Evaluate every declaration each tick until all are met or the budget ends.
 * Read-only: the write is never re-issued. Password targets are redacted in
 * the returned results (the verdict was computed on the real value).
 */
export async function checkDeclarations(page: PageReader, decls: Declaration[], budgetMs: number): Promise<DeclaredResult[]> {
  const start = Date.now();
  const evaluate = async (): Promise<DeclaredResult[]> => {
    let cached: string[] | null | undefined;
    const tree = async () => {
      if (cached !== undefined) return cached;
      cached = await page.snapshotTree();
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
