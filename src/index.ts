// TrueReplay — wrap a Stagehand (v4) instance by composition and record, per
// step, what the agent claimed vs. what the page shows. The two channels never
// touch here: no verdict function receives agent_claim. See docs/DAY2.md, DAY3.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Stagehand, Action } from "@browserbasehq/stagehand";
import {
  detectSession,
  fingerprint,
  sameFingerprint,
  settle,
  type Fingerprint,
  type SessionEvidence,
} from "./session.js";
import {
  captureState,
  classify,
  fieldPostcondition,
  redactLen,
  type PageState,
  type Postcondition,
} from "./postcondition.js";

export type Verdict = "landed" | "did-not-land" | "inconclusive";
export type StepKind = "write" | "read" | "nav";
export type { SessionEvidence, Fingerprint, Postcondition };

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
    postcondition?: Postcondition;
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
  screenshots?: boolean; // default true; captured on write steps, after the verdict is decided
  screenshotDir?: string; // default ".truereplay/screenshots"
  postconditionWaitMs?: number; // extended no-change poll budget (default 8000)
}

/**
 * §4.2 destination gate + the Day 2 obstruction rule, as a pure function of the
 * verdict-so-far and the session read on the final page. A high-confidence
 * obstruction (captcha/blank/corroborated login) forces did-not-land; a
 * heuristic one (overlay/login) only demotes a landed to inconclusive.
 */
export function sessionVerdict(current: Verdict, session: SessionEvidence): Verdict {
  if (session.obstruction) {
    if (session.confidence === "high") return "did-not-land";
    if (current === "landed") return "inconclusive";
  }
  return current;
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

// Method groups from Stagehand's action handlers (extension METHOD_HANDLER_MAP).
const NON_MUTATING = new Set([
  "hover",
  "scroll",
  "scrollTo",
  "scrollIntoView",
  "scrollByPixelOffset",
  "nextChunk",
  "prevChunk",
  "mouse.wheel",
]);
const FIELD_METHODS = new Set(["fill", "type", "selectOption", "selectOptionFromDropdown"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function actionText(args: unknown[]): string {
  const a = args[0];
  return typeof a === "string" ? a : JSON.stringify(a);
}

function statusOf(claim: unknown): number | null {
  const r = claim as { status?: () => number } | null;
  return r && typeof r.status === "function" ? r.status() : null;
}

export function withReplay(stagehand: Stagehand, opts: ReplayOptions = {}): Wrapped {
  const replay = new ReplayImpl();
  const screenshotDir = opts.screenshotDir ?? ".truereplay/screenshots";
  const waitMs = opts.postconditionWaitMs ?? 8000;

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

  /** Poll for a classifiable change after a first-look no-change (§4.1). */
  async function resolveNoChange(
    page: Page,
    before: PageState,
    firstAfter: PageState,
  ): Promise<{ verdict: Verdict; post: Postcondition; after: PageState }> {
    const start = Date.now();
    let lastFp: Fingerprint | null = firstAfter.fp;
    while (Date.now() - start < waitMs) {
      await sleep(250);
      const fp = await fingerprint(page);
      if (fp && lastFp && !sameFingerprint(fp, lastFp)) {
        lastFp = fp;
        const state = await captureState(page);
        const c = classify(before, state, false);
        if (c.post.reason !== "no-change") return { ...c, after: state };
      }
    }
    const state = await captureState(page);
    return { ...classify(before, state, false), after: state };
  }

  async function run(
    kind: StepKind,
    action: string,
    invoke: (page: Page) => Promise<unknown>,
  ): Promise<unknown> {
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
    // activePage() returns a fresh wrapper each call, so compare the stable
    // per-tab `pageId`, not object identity.
    const pageId = (p: Page) => (p as unknown as { pageId?: string }).pageId;
    const page = await activePage();
    const pageSwitched = pageId(page) !== pageId(beforePage);

    const data = (claim as { data?: { success?: boolean; message?: string; actions?: Action[] } })
      ?.data;

    // --- read / nav: Day 2 behavior, on the final page ---
    if (!isWrite) {
      const { settled, after } = await settle(page);
      const navStatus = kind === "nav" ? statusOf(claim) : undefined;
      const session = await detectSession(page, { navStatus });
      replay.steps.push({
        kind,
        action,
        declaration: "auto",
        verdict: "inconclusive",
        evidence: {
          before: beforeFp,
          after,
          settled,
          session,
          ...(kind === "nav" ? { nav: { status: navStatus ?? null } } : {}),
        },
        attempt: null,
        agent_claim: null,
        timestamp: new Date().toISOString(),
      });
      if (threw) throw threw;
      return claim;
    }

    // --- write path ---
    const actions = data?.actions ?? null;
    const methods = (actions ?? []).map((a) => a.method).filter(Boolean) as string[];
    const { settled } = await settle(page);
    let after = await captureState(page);

    let effectiveKind: StepKind = "write";
    let verdict: Verdict;
    let post: Postcondition;
    let fieldIsPassword = false;

    if (actions && methods.length > 0 && methods.every((m) => NON_MUTATING.has(m))) {
      // §6 non-mutating: this was not a write.
      effectiveKind = "read";
      verdict = "inconclusive";
      ({ post } = classify(beforeState!, after, pageSwitched));
      post.reason = "non-mutating";
      post.confidence = "heuristic";
    } else {
      const fieldResult =
        actions && methods.length > 0 && FIELD_METHODS.has(methods[0]) && !pageSwitched
          ? await fieldPostcondition(page, actions)
          : null;

      if (fieldResult) {
        verdict = fieldResult.verdict;
        ({ post } = classify(beforeState!, after, pageSwitched));
        post.reason = fieldResult.reason;
        post.confidence = fieldResult.confidence;
        post.field = fieldResult.field;
        fieldIsPassword = fieldResult.isPassword;
      } else {
        let c = classify(beforeState!, after, pageSwitched);
        if (c.post.reason === "no-change") {
          const resolved = await resolveNoChange(page, beforeState!, after);
          after = resolved.after;
          c = { verdict: resolved.verdict, post: resolved.post };
          // still nothing after the wait, and the page never settled → unsettled
          if (c.post.reason === "no-change" && !settled) {
            c = { verdict: "inconclusive", post: { ...c.post, reason: "unsettled" } };
          }
        }
        verdict = c.verdict;
        post = c.post;
      }
    }

    if (pageSwitched) post.newPageUrl = await page.url().catch(() => "");

    // §4.2 destination gate + the Day 2 obstruction rule, on the FINAL page.
    const session = await detectSession(page);
    if (effectiveKind === "write") verdict = sessionVerdict(verdict, session);

    // Redact passwords AFTER the verdict is computed (§7).
    let storedAttempt = actions;
    if (storedAttempt && fieldIsPassword) {
      storedAttempt = storedAttempt.map((a, i) =>
        i === 0 && a.arguments?.length
          ? { ...a, arguments: [redactLen(a.arguments[0]), ...a.arguments.slice(1)] }
          : a,
      );
    }
    if (post.field && fieldIsPassword) {
      post.field = {
        selector: post.field.selector,
        expected: redactLen(post.field.expected),
        actual: post.field.actual == null ? null : redactLen(post.field.actual),
      };
    }

    const screenshot = await snap(page); // after the verdict — the picture shows what decided it

    replay.steps.push({
      kind: effectiveKind,
      action,
      declaration: "auto",
      verdict,
      evidence: {
        before: beforeState!.fp,
        after: after.fp,
        settled,
        session,
        postcondition: post,
        ...(screenshot ? { screenshot } : {}),
      },
      attempt: storedAttempt,
      agent_claim: data ? { success: !!data.success, message: data.message ?? "" } : null,
      timestamp: new Date().toISOString(),
    });

    if (threw) throw threw;
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

export interface Wrapped {
  act: Stagehand["act"];
  extract: Stagehand["extract"];
  observe: Stagehand["observe"];
  page: { goto(url: string, opts?: unknown): Promise<unknown>; current(): Promise<Page> };
  replay: Replay;
}
