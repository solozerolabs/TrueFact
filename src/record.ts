// Record read-back — the verdict for a write that has no page. An API/tool-call
// agent ("update deal 123", "kubectl rollout restart", an MCP write) returns
// "ok"; that return is the agent's claim. The evidence is the caller's own
// independent read of the thing written (GET the deal, SELECT the row), taken
// before and after. Same rules as the page reader:
//   - `read` is a reader, called with no arguments: it never sees the claim.
//   - `expect` is data, never a callback (DAY4): a partial object matched by
//     subset, a RegExp for strings, or `null` for "gone".
//   - Heuristic ⇒ inconclusive: a changed record with no `expect` is not
//     `landed` (someone else may have written it); an unchanged one is not
//     `did-not-land` (the write may be idempotent). Only a declared, readable,
//     unmet `expect` after the budget is `did-not-land`.
//   - A read that fails says inconclusive, never landed.
import { isDeepStrictEqual } from "node:util";
import { sleep, type Outcome } from "./postcondition.js";

/** A declared postcondition over the read-back value. Subset match:
 *  objects match when every listed key matches, arrays match element-wise at
 *  equal length, RegExps test strings/numbers, `null` means the record is gone
 *  (`read` returned null/undefined). Values compare as JSON (a Date reads back
 *  as its ISO string; a Date in `expect` is compared the same way). */
export type Expect = null | string | number | boolean | RegExp | Date | Expect[] | { [key: string]: Expect | undefined };

export type ReadFn = () => unknown;

export interface RecordEvidence {
  reason: Outcome["reason"];
  confidence: Outcome["confidence"];
  // ponytail: whole read-back values are stored; add a size cap or a
  // path allowlist when someone reads back a list of thousands of rows.
  before: unknown; // JSON-normalized; null when unreadable or absent
  after: unknown;
  beforeError?: string;
  afterError?: string;
  changed: string[]; // leaf paths that differ before → after (capped)
  met: boolean | null; // expect result on the final read; null = no expect or unreadable
  elapsedMs: number; // action end → verdict
}

const MAX_PATHS = 50;

/** JSON round-trip: the stored form IS the compared form. undefined → null. */
export function normalize(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v) ?? "null");
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RegExp) && !(v instanceof Date);

/** Fail fast on an expect that would pass on anything. */
export function validateExpect(e: Expect | undefined, path = "expect"): void {
  if (e === undefined) return;
  if (e instanceof RegExp) {
    e.lastIndex = 0;
    if (e.test("")) throw new Error(`TrueFact: vacuous ${path} ${e} — it matches an empty string`);
  } else if (Array.isArray(e)) e.forEach((x, i) => validateExpect(x, `${path}[${i}]`));
  else if (isPlain(e)) {
    const keys = Object.keys(e);
    if (!keys.length) throw new Error(`TrueFact: vacuous ${path} {} — it matches any object; list the fields that prove the write`);
    for (const k of keys) validateExpect(e[k], `${path}.${k}`);
  }
}

/** Does the read-back value satisfy `expect`? Pure. */
export function matchExpect(actual: unknown, e: Expect | undefined): boolean {
  if (e === undefined) return actual === undefined;
  if (e === null) return actual === null || actual === undefined;
  if (e instanceof RegExp) {
    if (typeof actual !== "string" && typeof actual !== "number") return false;
    e.lastIndex = 0;
    return e.test(String(actual));
  }
  if (e instanceof Date) return actual === e.toISOString();
  if (Array.isArray(e)) return Array.isArray(actual) && actual.length === e.length && e.every((x, i) => matchExpect(actual[i], x));
  if (isPlain(e)) return isPlain(actual) && Object.keys(e).every((k) => matchExpect(actual[k], e[k]));
  return actual === e;
}

/** Leaf paths that differ between two JSON values (`deal.stage`, `items[2]`). */
export function changedPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= MAX_PATHS || isDeepStrictEqual(a, b)) return out;
  if (isPlain(a) && isPlain(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) changedPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) changedPaths(a[i], b[i], `${path}[${i}]`, out);
  } else out.push(path || "(root)");
  return out;
}

/** Store an expect in the replay: RegExps/Dates survive JSON as strings. */
export function serializeExpect(e: Expect | undefined): unknown {
  return e === undefined ? undefined : JSON.parse(JSON.stringify(e, (_, v) => (v instanceof RegExp ? String(v) : v)));
}

type Read = { ok: true; value: unknown } | { ok: false; error: string };

export async function safeReadBack(read: ReadFn): Promise<Read> {
  try {
    return { ok: true, value: normalize(await read()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The verdict over one before/after pair. Pure; `readBack` polls it. */
export function decideRecord(before: Read, after: Read, e: Expect | undefined): Outcome & { met: boolean | null } {
  if (e !== undefined) {
    if (!after.ok) return { verdict: "inconclusive", reason: "declared-unreadable", confidence: "heuristic", met: null };
    const met = matchExpect(after.value, e);
    return met
      ? { verdict: "landed", reason: "declared-met", confidence: "high", met }
      : { verdict: "did-not-land", reason: "declared-unmet", confidence: "high", met };
  }
  if (!before.ok || !after.ok) return { verdict: "inconclusive", reason: "read-failed", confidence: "heuristic", met: null };
  return isDeepStrictEqual(before.value, after.value)
    ? { verdict: "inconclusive", reason: "no-change", confidence: "heuristic", met: null }
    : { verdict: "inconclusive", reason: "changed-unclassified", confidence: "heuristic", met: null };
}

/** Poll `read` after the action until the outcome is decided or `budgetMs`
 *  ends: with `expect`, until it is met (an eventually-consistent store gets
 *  the budget to catch up); without, until the value changes. The last read
 *  decides — an unmet expect is did-not-land only once the budget is spent. */
export async function readBack(
  read: ReadFn,
  before: Read,
  e: Expect | undefined,
  budgetMs: number,
  intervalMs = 250,
): Promise<{ evidence: RecordEvidence; verdict: Outcome["verdict"]; settled: boolean }> {
  const start = Date.now();
  let after = await safeReadBack(read);
  let decided = decideRecord(before, after, e);
  const done = () => (e !== undefined ? decided.met === true : decided.reason === "changed-unclassified");
  while (!done() && Date.now() - start < budgetMs) {
    await sleep(intervalMs);
    after = await safeReadBack(read);
    decided = decideRecord(before, after, e);
  }
  const b = before.ok ? before.value : null;
  const a = after.ok ? after.value : null;
  return {
    verdict: decided.verdict,
    settled: done(),
    evidence: {
      reason: decided.reason,
      confidence: decided.confidence,
      before: b,
      after: a,
      ...(before.ok ? {} : { beforeError: before.error }),
      ...(after.ok ? {} : { afterError: after.error }),
      changed: before.ok && after.ok ? changedPaths(b, a) : [],
      met: decided.met,
      elapsedMs: Date.now() - start,
    },
  };
}
