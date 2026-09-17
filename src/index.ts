// TrueReplay — wrap a Stagehand (v4) instance by composition and record, per
// step, what the agent claimed vs. what the page shows. The two channels never
// touch here: no verdict function receives agent_claim. See docs/DAY2–4.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActResult,
  Action,
  Page,
  Stagehand,
  StagehandClientActOptions,
} from "@browserbasehq/stagehand";
import { detectSession, fingerprint, settle, type Fingerprint, type SessionEvidence } from "./session.js";
import {
  captureState,
  decideWrite,
  redactLen,
  sessionVerdict,
  type Postcondition,
  type Verdict,
} from "./postcondition.js";
import {
  applyDeclarations,
  checkDeclarations,
  validateDeclarations,
  type Declaration,
  type DeclaredResult,
} from "./declaration.js";

export type { Verdict, Postcondition, SessionEvidence, Fingerprint, Declaration, DeclaredResult };
export { sessionVerdict, applyDeclarations, validateDeclarations };
export type StepKind = "write" | "read" | "nav";

export interface Step {
  kind: StepKind;
  action: string;
  declaration: "auto" | Declaration[];
  verdict: Verdict;
  evidence: {
    before: Fingerprint | null;
    after: Fingerprint | null;
    settled: boolean;
    session: SessionEvidence;
    postcondition?: Postcondition;
    nav?: { status: number | null };
    screenshot?: string;
  };
  attempt: Action[] | null; // where to look, never evidence of outcome
  agent_claim: { success: boolean; message: string } | null;
  timestamp: string;
}

export interface RunDeclaration {
  declared: DeclaredResult[];
  verdict: Verdict; // "landed" means "no demotion"; it never lifts a step verdict
}

export interface Replay {
  steps: Step[];
  readonly verdict: Verdict; // roll-up over write steps, AND the run-level declaration
  claim: { done: boolean; note?: string } | null;
  setClaim(done: boolean, note?: string): void;
  final: RunDeclaration | null;
  finalize(opts?: { expect?: Declaration | Declaration[] }): Promise<RunDeclaration>;
}

export interface ReplayOptions {
  screenshots?: boolean; // default true; captured on write steps, after the verdict is decided
  screenshotDir?: string; // default ".truereplay/screenshots"
  waitMs?: number; // one budget for the auto no-change poll and declared checks (default 5000)
}

export type ActOptions = StagehandClientActOptions & {
  expect?: Declaration | Declaration[]; // AND; stripped before delegating (Stagehand rejects unknown keys)
  waitMs?: number;
};

export interface Wrapped {
  act(instruction: string | Action, options?: ActOptions): Promise<ActResult>;
  extract: Stagehand["extract"];
  observe: Stagehand["observe"];
  page: { goto(url: string, opts?: unknown): Promise<unknown>; current(): Promise<Page> };
  replay: Replay;
}

/** Run verdict rolls up over write steps only; a read/nav never decides it. */
export function rollup(steps: Step[]): Verdict {
  const writes = steps.filter((s) => s.kind === "write");
  if (writes.some((s) => s.verdict === "did-not-land")) return "did-not-land";
  if (writes.some((s) => s.verdict === "inconclusive")) return "inconclusive";
  return writes.length ? "landed" : "inconclusive";
}

/** A run-level declaration can only demote the step roll-up. */
export function combine(steps: Verdict, final: RunDeclaration | null): Verdict {
  if (!final) return steps;
  if (final.verdict === "did-not-land") return "did-not-land";
  if (final.verdict === "inconclusive" && steps === "landed") return "inconclusive";
  return steps;
}

class ReplayImpl implements Replay {
  steps: Step[] = [];
  claim: { done: boolean; note?: string } | null = null;
  final: RunDeclaration | null = null;
  constructor(private readonly finalizer: (decls: Declaration[]) => Promise<RunDeclaration>) {}
  get verdict(): Verdict {
    return combine(rollup(this.steps), this.final);
  }
  setClaim(done: boolean, note?: string): void {
    this.claim = { done, note };
  }
  async finalize(opts: { expect?: Declaration | Declaration[] } = {}): Promise<RunDeclaration> {
    this.final = await this.finalizer(validateDeclarations(opts.expect));
    return this.final;
  }
}

const actionText = (a: unknown): string => (typeof a === "string" ? a : JSON.stringify(a));
const statusOf = (r: unknown): number | null =>
  r && typeof (r as { status?: () => number }).status === "function" ? (r as { status: () => number }).status() : null;
const pageId = (p: Page) => (p as unknown as { pageId?: string }).pageId;

export function withReplay(stagehand: Stagehand, opts: ReplayOptions = {}): Wrapped {
  const screenshotDir = opts.screenshotDir ?? ".truereplay/screenshots";
  const defaultWait = opts.waitMs ?? 5000;

  const activePage = async (): Promise<Page> => {
    const ctx = stagehand.browser.context;
    const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
    if (!page) throw new Error("TrueReplay: no active page on the Stagehand browser context");
    return page;
  };

  const replay = new ReplayImpl(async (decls) => {
    const page = await activePage();
    await settle(page);
    const declared = decls.length ? await checkDeclarations(page, decls, defaultWait) : [];
    const verdict: Verdict = declared.some((r) => r.met === null)
      ? "inconclusive"
      : declared.some((r) => r.met === false)
        ? "did-not-land"
        : "landed";
    return { declared, verdict };
  });

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
    declared: { expect?: Declaration | Declaration[]; waitMs?: number } = {},
  ): Promise<unknown> {
    const decls = validateDeclarations(declared.expect); // fail fast, before the write
    const waitMs = declared.waitMs ?? defaultWait;
    const beforePage = await activePage();
    const isWrite = kind === "write";
    const beforeState = isWrite ? await captureState(beforePage) : null;
    const beforeFp = beforeState ? beforeState.fp : await fingerprint(beforePage);

    let claim: unknown = null;
    let threw: unknown = null;
    try {
      claim = await invoke(beforePage);
    } catch (e) {
      threw = e;
    }

    // Re-resolve the active page: a click can open/switch to a new tab (§5).
    // activePage() returns a fresh wrapper each call; compare the stable pageId.
    const page = await activePage();
    const pageSwitched = pageId(page) !== pageId(beforePage);
    const { settled } = await settle(page);

    if (!isWrite) {
      const navStatus = kind === "nav" ? statusOf(claim) : undefined;
      const session = await detectSession(page, { navStatus });
      replay.steps.push({
        kind, action, declaration: "auto", verdict: "inconclusive",
        evidence: { before: beforeFp, after: await fingerprint(page), settled, session, ...(kind === "nav" ? { nav: { status: navStatus ?? null } } : {}) },
        attempt: null, agent_claim: null, timestamp: new Date().toISOString(),
      });
      if (threw) throw threw;
      return claim;
    }

    // --- write path: decide, declare, gate, redact, record ---
    const data = (claim as { data?: { success?: boolean; message?: string; actions?: Action[] } })?.data;
    const actions = data?.actions ?? null;
    const first = await captureState(page);
    let decision = await decideWrite(page, beforeState!, first, actions, pageSwitched, settled, decls.length ? 0 : waitMs);
    let post = decision.post;

    if (decls.length && decision.kind === "write") {
      const results = await checkDeclarations(page, decls, waitMs);
      // refresh the auto evidence once after the poll, then compose
      decision = await decideWrite(page, beforeState!, await captureState(page), actions, pageSwitched, settled, 0);
      post = { ...decision.post, ...applyDeclarations(decision.post.auto, results), declared: results };
    }
    if (pageSwitched) post.newPageUrl = await page.url().catch(() => "");

    const session = await detectSession(page);
    const verdict = decision.kind === "write" ? sessionVerdict(post.verdict, session, post.reason) : post.verdict;

    let attempt = actions;
    if (attempt && decision.isPassword) {
      attempt = attempt.map((a, i) =>
        i === 0 && a.arguments?.length ? { ...a, arguments: [redactLen(a.arguments[0]), ...a.arguments.slice(1)] } : a,
      );
      if (post.field) post.field = { ...post.field, expected: redactLen(post.field.expected), actual: post.field.actual == null ? null : redactLen(post.field.actual) };
    }

    const screenshot = await snap(page); // after the verdict — the picture shows what decided it
    replay.steps.push({
      kind: decision.kind,
      action,
      // store the evaluated (password-redacted) declarations, never the caller's plaintext copy
      declaration: decls.length ? (post.declared ? post.declared.map((r) => r.declaration) : decls) : "auto",
      verdict,
      evidence: { before: beforeState!.fp, after: decision.after.fp, settled, session, postcondition: post, ...(screenshot ? { screenshot } : {}) },
      attempt,
      agent_claim: data ? { success: !!data.success, message: data.message ?? "" } : null,
      timestamp: new Date().toISOString(),
    });
    if (threw) throw threw;
    return claim;
  }

  return {
    act: (instruction, options) => {
      const { expect, waitMs, ...rest } = options ?? {};
      return run("write", `act: ${actionText(instruction)}`, () => stagehand.act(instruction as string, rest), { expect, waitMs }) as Promise<ActResult>;
    },
    extract: ((...args: unknown[]) =>
      run("read", `extract: ${actionText(args[0])}`, () => (stagehand.extract as (...a: unknown[]) => Promise<unknown>)(...args))) as Stagehand["extract"],
    observe: ((...args: unknown[]) =>
      run("read", `observe: ${actionText(args[0])}`, () => (stagehand.observe as (...a: unknown[]) => Promise<unknown>)(...args))) as Stagehand["observe"],
    page: {
      goto: (url: string, gotoOpts?: unknown) =>
        run("nav", `goto ${url}`, (p) => (p.goto as (u: string, o?: unknown) => Promise<unknown>)(url, gotoOpts)),
      current: activePage,
    },
    replay,
  };
}
