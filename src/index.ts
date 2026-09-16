// TrueReplay — wrap a Stagehand (v4) instance by composition and record, per
// step, what the agent claimed vs. what the page shows. The two channels never
// touch here: no verdict function receives agent_claim. See docs/DAY2.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Stagehand, Action } from "@browserbasehq/stagehand";
import {
  detectSession,
  fingerprint,
  settle,
  type Fingerprint,
  type SessionEvidence,
} from "./session.js";

export type Verdict = "landed" | "did-not-land" | "inconclusive";
export type StepKind = "write" | "read" | "nav";
export type { SessionEvidence, Fingerprint };

export interface Step {
  kind: StepKind;
  action: string;
  declaration: "auto"; // Day 4 adds declared postconditions
  verdict: Verdict;
  evidence: {
    before: Fingerprint | null;
    after: Fingerprint | null;
    settled: boolean;
    session: SessionEvidence;
    nav?: { status: number | null };
    screenshot?: string;
  };
  attempt: Action[] | null; // where to look, never evidence of outcome
  agent_claim: { success: boolean; message: string } | null;
  timestamp: string;
}

export interface Replay {
  steps: Step[];
  readonly verdict: Verdict; // roll-up over write steps only
  claim: { done: boolean; note?: string } | null;
  setClaim(done: boolean, note?: string): void;
}

export interface ReplayOptions {
  screenshots?: boolean; // default true; screenshots are captured on write steps
  screenshotDir?: string; // default ".truereplay/screenshots"
}

/** Verdict for a write step from page-truth only (Day 2). */
export function writeVerdict(session: SessionEvidence): Verdict {
  if (session.obstruction && session.confidence === "high") return "did-not-land";
  return "inconclusive"; // heuristic obstruction, clear, or unreadable — Day 3 decides
}

/** Run verdict rolls up over write steps only; a read/nav never decides it. */
export function rollup(steps: Step[]): Verdict {
  const writes = steps.filter((s) => s.kind === "write");
  if (writes.some((s) => s.verdict === "did-not-land")) return "did-not-land";
  if (writes.some((s) => s.verdict === "inconclusive")) return "inconclusive";
  return writes.length ? "landed" : "inconclusive";
}

class ReplayImpl implements Replay {
  steps: Step[] = [];
  claim: { done: boolean; note?: string } | null = null;
  get verdict(): Verdict {
    return rollup(this.steps);
  }
  setClaim(done: boolean, note?: string): void {
    this.claim = { done, note };
  }
}

function actionText(args: unknown[]): string {
  const a = args[0];
  return typeof a === "string" ? a : JSON.stringify(a);
}

function statusOf(claim: unknown): number | null {
  const r = claim as { status?: () => number } | null;
  return r && typeof r.status === "function" ? r.status() : null;
}

async function attemptPoint(
  page: Page,
  claim: unknown,
): Promise<{ x: number; y: number } | undefined> {
  const actions = (claim as { data?: { actions?: Action[] } })?.data?.actions;
  const selector = actions?.[0]?.selector;
  if (!selector) return undefined;
  try {
    const c = await page.locator(selector).centroid();
    if (c && typeof c.x === "number" && typeof c.y === "number") return { x: c.x, y: c.y };
  } catch {
    /* stale/invalid selector — fall back to viewport center in the detector */
  }
  return undefined;
}

export interface Wrapped {
  act: Stagehand["act"];
  extract: Stagehand["extract"];
  observe: Stagehand["observe"];
  page: { goto(url: string, opts?: unknown): Promise<unknown>; current(): Promise<Page> };
  replay: Replay;
}

export function withReplay(stagehand: Stagehand, opts: ReplayOptions = {}): Wrapped {
  const replay = new ReplayImpl();
  const screenshotDir = opts.screenshotDir ?? ".truereplay/screenshots";

  const activePage = async (): Promise<Page> => {
    const ctx = stagehand.browser.context;
    const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
    if (!page) throw new Error("TrueReplay: no active page on the Stagehand browser context");
    return page;
  };

  async function snap(page: Page): Promise<string | undefined> {
    if (opts.screenshots === false) return undefined;
    try {
      const bytes = await page.screenshot();
      mkdirSync(screenshotDir, { recursive: true });
      // ponytail: index-named PNGs; swap for content-hash names if runs collide.
      const path = join(screenshotDir, `step-${replay.steps.length}.png`);
      writeFileSync(path, bytes);
      return path;
    } catch {
      return undefined;
    }
  }

  async function run(
    kind: StepKind,
    action: string,
    invoke: (page: Page) => Promise<unknown>,
  ): Promise<unknown> {
    const page = await activePage();
    const before = await fingerprint(page);
    let claim: unknown = null;
    let threw: unknown = null;
    try {
      claim = await invoke(page);
    } catch (e) {
      threw = e;
    }
    const { settled, after } = await settle(page);
    const navStatus = kind === "nav" ? statusOf(claim) : undefined;
    const point = kind === "write" ? await attemptPoint(page, claim) : undefined;
    const session = await detectSession(page, { navStatus, point });
    const screenshot = kind === "write" ? await snap(page) : undefined;

    const verdict: Verdict =
      kind === "write" ? writeVerdict(session) : "inconclusive"; // reads/navs carry evidence only

    const data = (claim as { data?: { success?: boolean; message?: string; actions?: Action[] } })
      ?.data;
    replay.steps.push({
      kind,
      action,
      declaration: "auto",
      verdict,
      evidence: {
        before,
        after,
        settled,
        session,
        ...(kind === "nav" ? { nav: { status: navStatus ?? null } } : {}),
        ...(screenshot ? { screenshot } : {}),
      },
      attempt: kind === "write" ? data?.actions ?? null : null,
      agent_claim:
        kind === "write" && data
          ? { success: !!data.success, message: data.message ?? "" }
          : null,
      timestamp: new Date().toISOString(),
    });

    if (threw) throw threw; // step is recorded, but the caller still sees the failure
    return claim;
  }

  return {
    act: ((...args: unknown[]) =>
      run("write", `act: ${actionText(args)}`, () =>
        (stagehand.act as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as Stagehand["act"],
    extract: ((...args: unknown[]) =>
      run("read", `extract: ${actionText(args)}`, () =>
        (stagehand.extract as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as Stagehand["extract"],
    observe: ((...args: unknown[]) =>
      run("read", `observe: ${actionText(args)}`, () =>
        (stagehand.observe as (...a: unknown[]) => Promise<unknown>)(...args),
      )) as Stagehand["observe"],
    page: {
      goto: (url: string, gotoOpts?: unknown) =>
        run("nav", `goto ${url}`, (p) =>
          (p.goto as (u: string, o?: unknown) => Promise<unknown>)(url, gotoOpts),
        ),
      current: activePage,
    },
    replay,
  };
}
