// M3 — the assertion engine (offline re-assert). An assertion is a function over
// a BROWSER VIEW: what the world showed after a write, reconstructed from a
// recorded step. It never receives the agent's claim, so the two-channel rule
// (docs/DAY2) holds for callbacks exactly as it does for declared `expect`.
//
// The value: change an assertion, re-run it against a stored run (a `jsonl`
// from withTrueFact) with no browser and no model — see which historical steps
// now pass or fail. A flaky agent run becomes a deterministic, $0 unit test.
// See docs/SPEC-V2.md §4 / §5.1.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Step } from "./index.js";
import type { FormValue, Verdict } from "./postcondition.js";

/** What an assertion sees for one write step. All evidence, never the claim. */
export interface BrowserView {
  action: string;
  url: string; // the page URL after the write
  verdict: Verdict; // TrueFact's own recorded verdict (evidence, for reference)
  treeAdded: string[]; // a11y-tree lines that appeared
  treeRemoved: string[]; // a11y-tree lines that disappeared
  forms: Record<string, FormValue>; // field values after the write (passwords redacted)
  network: { url: string; status: number | null }[]; // same-origin 5xx/failed in the write window
}

export interface AssertResult {
  ok: boolean;
  message?: string;
}
export const pass = (): AssertResult => ({ ok: true });
export const fail = (message: string): AssertResult => ({ ok: false, message });

/** What an assertion sees for one record write (`run.write`). The read-back
 *  values only — never the action's return value. */
export interface RecordView {
  action: string;
  verdict: Verdict;
  before: unknown; // null when unreadable or absent
  after: unknown;
  changed: string[];
}

export type BrowserAssertion = (v: BrowserView) => AssertResult;
export type RecordAssertion = (v: RecordView) => AssertResult;
export interface Assertions {
  browser?: BrowserAssertion;
  record?: RecordAssertion; // http/mcp/cli join when their recorders land (§3)
}

/** Identity helper for types + a default-export a module can carry. */
export const defineAssertions = (a: Assertions): Assertions => a;

/** A module's default export may be an Assertions object or a bare browser fn. */
export function toAssertions(mod: unknown): Assertions {
  const d = (mod as { default?: unknown })?.default ?? mod;
  if (typeof d === "function") return { browser: d as BrowserAssertion };
  if (d && typeof d === "object" && ("browser" in d || "record" in d)) return d as Assertions;
  throw new Error("TrueFact: assertion module must default-export a function or { browser, record } (see defineAssertions)");
}

/** Reconstruct a write step's browser view from its recorded evidence. */
export function viewOf(step: Step): BrowserView | null {
  const p = step.evidence.postcondition;
  if (step.kind !== "write" || !p) return null;
  return {
    action: step.action,
    url: step.evidence.after?.href ?? "",
    verdict: step.verdict,
    treeAdded: p.treeAdded ?? [],
    treeRemoved: p.treeRemoved ?? [],
    forms: p.formsAfter ?? {},
    network: p.network?.errors ?? [],
  };
}

export interface ReassertItem {
  index: number; // position in the run
  action: string;
  ok: boolean;
  message?: string;
}
export interface ReassertReport {
  total: number; // write steps evaluated
  failed: number;
  items: ReassertItem[];
}

/** Evaluate the assertion against every write step. Pure: no fs, no browser. */
export function reassert(steps: Step[], a: Assertions): ReassertReport {
  const items: ReassertItem[] = [];
  steps.forEach((s, i) => {
    const rec = s.kind === "write" ? s.evidence.record : undefined;
    const v = rec ? null : viewOf(s);
    const r = rec
      ? a.record?.({ action: s.action, verdict: s.verdict, before: rec.before, after: rec.after, changed: rec.changed })
      : v && a.browser?.(v);
    if (r) items.push({ index: i, action: s.action, ok: r.ok, message: r.message });
  });
  return { total: items.length, failed: items.filter((x) => !x.ok).length, items };
}

/** Read a `jsonl` run + an assertion module, and reassert. */
export async function reassertFile(jsonlPath: string, modulePath: string): Promise<ReassertReport> {
  const steps = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Step);
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  return reassert(steps, toAssertions(mod));
}
