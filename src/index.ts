// TrueReplay — wrap a Stagehand (v4) instance by composition and record, per
// step, what the agent claimed vs. what the page shows. The two channels never
// touch here: no verdict function receives agent_claim. See docs/DAY2–4.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  ActResult,
  Action,
  Page,
  Stagehand,
  StagehandClientActOptions,
  StagehandClientExtractOptions,
} from "@browserbasehq/stagehand";
import { detectSession, fingerprint, settle, type Fingerprint, type SessionEvidence } from "./session.js";
import {
  applyNetwork,
  captureState,
  decideWrite,
  readTree,
  redactLen,
  sessionVerdict,
  type Postcondition,
  type Verdict,
} from "./postcondition.js";
import { attachSidecar, type Sidecar } from "./sidecar.js";
import { hashStep } from "./chain.js";
import {
  applyDeclarations,
  checkDeclarations,
  validateDeclarations,
  type Declaration,
  type DeclaredResult,
} from "./declaration.js";
import { groundValues, type Grounding, type GroundingReason } from "./grounding.js";
import { redactText } from "./redact.js";

export type { Verdict, Postcondition, SessionEvidence, Fingerprint, Declaration, DeclaredResult, Grounding, GroundingReason };
export { sessionVerdict, applyDeclarations, validateDeclarations, groundValues };
export {
  defineAssertions,
  reassert,
  reassertFile,
  viewOf,
  pass,
  fail,
  type BrowserView,
  type BrowserAssertion,
  type Assertions,
  type AssertResult,
  type ReassertReport,
  type ReassertItem,
} from "./assert.js";
export { verifyChain, hashStep, canonical, type ChainResult } from "./chain.js";
export { renderHtml, viewFile } from "./view.js";
export { launch, type LaunchOptions, type Launched } from "./launch.js";
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
    grounding?: Grounding; // extract steps: did each returned value appear on the page
    nav?: { status: number | null };
    screenshot?: string;
  };
  attempt: Action[] | null; // where to look, never evidence of outcome
  agent_claim: { success: boolean; message: string } | null;
  // Token/latency for this step, read off Stagehand's result metadata. `model`
  // is the per-call override the caller requested (null = the instance default,
  // which Stagehand does not echo back). Day 6 sums these into $/run.
  cost: { model: string | null; inputTokens: number; outputTokens: number; totalTokens: number; inferenceTimeMs: number } | null;
  timestamp: string;
  // M1 tamper-evident chain, set at record time. `prevHash` links to the prior
  // step ("" for the first); `hash` covers the whole step (incl. the sealed
  // agent_claim) minus hash/sig. `sig` is added by M9 when a signing key is set.
  prevHash?: string;
  hash?: string;
  sig?: string;
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
  jsonl?: string; // if set, append one redacted step per line as the run proceeds
  // Opt-in network verification (M2). Attaches a second CDP client to the Chrome
  // launched with `localBrowser.launch({ port })` and demotes an optimistic write
  // (page ✅) to did-not-land when its own backend returned a same-origin 5xx.
  // Off by default: the certified 0-false-halt page-read verdict is unchanged.
  network?: { port: number };
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
  close(): Promise<void>; // release the network sidecar (no-op when network is off)
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

const costOf = (claim: unknown, model: string | null): Step["cost"] => {
  const u = (claim as { metadata?: { usage?: Record<string, number> } })?.metadata?.usage;
  if (!u) return model ? { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, inferenceTimeMs: 0 } : null;
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens: u.totalTokens ?? inputTokens + outputTokens,
    inferenceTimeMs: u.inferenceTimeMs ?? 0,
  };
};

const modelName = (o: unknown): string | null =>
  (o as { model?: { modelName?: string } })?.model?.modelName ?? null;

/** The extract options among the call args (not the zod schema, which has a
 *  `parse`/`_def`). Works whether options sit at arg 1 (no schema) or arg 2. */
function extractOptionsOf(args: unknown[]): StagehandClientExtractOptions | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i] as { parse?: unknown; _def?: unknown } | null;
    if (a && typeof a === "object" && typeof a.parse !== "function" && !("_def" in a)) return a as StagehandClientExtractOptions;
  }
  return undefined;
}

const nonGrounding = (): Grounding => ({ verdict: "inconclusive", reason: "non-grounding", confidence: "heuristic", values: [], skipped: 0 });

/** Ground an extract's returned data against the a11y tree of the page it read
 *  (`options.page` may target a non-active tab). Redact any absent leaf that is
 *  the length of a masked password run — the only case a returned value could
 *  be a secret the tree did not already mask. */
async function groundExtract(active: Page, extractOpts: StagehandClientExtractOptions | undefined, claim: unknown): Promise<Grounding> {
  const target = ((extractOpts?.page as Page | undefined) ?? active);
  const tree = await readTree(target);
  if (!tree) return nonGrounding();
  const g = groundValues((claim as { data?: unknown })?.data, tree);
  if (extractOpts?.screenshot) g.visual = true;
  const masks = new Set<number>();
  for (const l of tree) { const m = l.match(/•+/g); if (m) for (const s of m) masks.add(s.length); }
  if (masks.size) for (const v of g.values) if (v.match === "absent" && masks.has(v.value.length)) v.value = redactLen(v.value);
  return g;
}

/** Redact secrets from a step's free-text fields, in place of trusting callers. */
function redactStep(step: Step): Step {
  step.action = redactText(step.action);
  if (step.agent_claim) step.agent_claim = { ...step.agent_claim, message: redactText(step.agent_claim.message) };
  if (step.attempt)
    step.attempt = step.attempt.map((a) =>
      a.arguments?.length ? { ...a, arguments: a.arguments.map(redactText) } : a,
    );
  if (step.evidence.grounding)
    step.evidence.grounding.values = step.evidence.grounding.values.map((v) => ({ ...v, value: redactText(v.value) }));
  return step;
}

export function withReplay(stagehand: Stagehand, opts: ReplayOptions = {}): Wrapped {
  const screenshotDir = opts.screenshotDir ?? ".truereplay/screenshots";
  const defaultWait = opts.waitMs ?? 5000;
  if (opts.jsonl) mkdirSync(dirname(opts.jsonl), { recursive: true });

  // Redact, chain, push in memory, and (if configured) append one JSONL line —
  // so the stored record survives a crashed run and always matches what's in
  // memory. The hash is computed AFTER redaction, so a stored line re-hashes to
  // its own `hash` (verify reads exactly what was written).
  let prevHash = "";
  const record = (step: Step): void => {
    const clean = redactStep(step);
    clean.prevHash = prevHash;
    clean.hash = hashStep(clean);
    prevHash = clean.hash;
    replay.steps.push(clean);
    if (opts.jsonl) appendFileSync(opts.jsonl, JSON.stringify(clean) + "\n");
  };

  const activePage = async (): Promise<Page> => {
    const ctx = stagehand.browser.context;
    const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
    if (!page) throw new Error("TrueReplay: no active page on the Stagehand browser context");
    return page;
  };

  // Attach the network sidecar once, lazily. Network.enable is persistent, so
  // enabling it here (before the first write's click) covers every later write.
  let sidecarPromise: Promise<Sidecar | null> | null = null;
  const sidecar = (): Promise<Sidecar | null> =>
    (sidecarPromise ??= opts.network ? attachSidecar(opts.network.port) : Promise.resolve(null));

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
    declared: { expect?: Declaration | Declaration[]; waitMs?: number; model?: string | null; ground?: boolean; extractOpts?: StagehandClientExtractOptions } = {},
  ): Promise<unknown> {
    const decls = validateDeclarations(declared.expect); // fail fast, before the write
    const waitMs = declared.waitMs ?? defaultWait;
    const beforePage = await activePage();
    const isWrite = kind === "write";
    const beforeState = isWrite ? await captureState(beforePage) : null;
    const beforeFp = beforeState ? beforeState.fp : await fingerprint(beforePage);

    // Mark the network stream just before the write so errorsSince() sees only
    // this step's requests. Only writes are network-verified.
    const sc = isWrite ? await sidecar() : null;
    const netMark = sc ? sc.mark() : 0;

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
    const cost = costOf(claim, declared.model ?? null);

    if (!isWrite) {
      const navStatus = kind === "nav" ? statusOf(claim) : undefined;
      const session = await detectSession(page, { navStatus });
      // Grounding is the read-side check: does each value an extract returned
      // actually appear on the page? observe/goto and a thrown extract → non-grounding.
      const grounding =
        kind === "read"
          ? declared.ground && !threw
            ? await groundExtract(page, declared.extractOpts, claim)
            : nonGrounding()
          : undefined;
      record({
        kind, action, declaration: "auto", verdict: grounding ? grounding.verdict : "inconclusive",
        evidence: { before: beforeFp, after: await fingerprint(page), settled, session, ...(grounding ? { grounding } : {}), ...(kind === "nav" ? { nav: { status: navStatus ?? null } } : {}) },
        attempt: null, agent_claim: null, cost, timestamp: new Date().toISOString(),
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
    let verdict = decision.kind === "write" ? sessionVerdict(post.verdict, session, post.reason) : post.verdict;

    // M2: a same-origin server error in this write's window overrides an
    // optimistic page-read verdict. errorsSince() filters to the page origin, so
    // a third-party analytics 500 never fires this (the cry-wolf guard).
    if (sc) {
      const errors = sc.errorsSince(netMark, new URL(beforeState!.fp.href || "http://x").origin);
      const net = applyNetwork(verdict, errors);
      if (net) {
        post.verdict = net.verdict;
        post.reason = net.reason;
        post.confidence = net.confidence;
        verdict = net.verdict;
      }
      if (errors.length) post.network = { errors };
    }

    let attempt = actions;
    if (attempt && decision.isPassword) {
      attempt = attempt.map((a, i) =>
        i === 0 && a.arguments?.length ? { ...a, arguments: [redactLen(a.arguments[0]), ...a.arguments.slice(1)] } : a,
      );
      if (post.field) post.field = { ...post.field, expected: redactLen(post.field.expected), actual: post.field.actual == null ? null : redactLen(post.field.actual) };
    }

    const screenshot = await snap(page); // after the verdict — the picture shows what decided it
    record({
      kind: decision.kind,
      action,
      // store the evaluated (password-redacted) declarations, never the caller's plaintext copy
      declaration: decls.length ? (post.declared ? post.declared.map((r) => r.declaration) : decls) : "auto",
      verdict,
      evidence: { before: beforeState!.fp, after: decision.after.fp, settled, session, postcondition: post, ...(screenshot ? { screenshot } : {}) },
      attempt,
      agent_claim: data ? { success: !!data.success, message: data.message ?? "" } : null,
      cost,
      timestamp: new Date().toISOString(),
    });
    if (threw) throw threw;
    return claim;
  }

  return {
    act: (instruction, options) => {
      const { expect, waitMs, ...rest } = options ?? {};
      return run("write", `act: ${actionText(instruction)}`, () => stagehand.act(instruction as string, rest), { expect, waitMs, model: modelName(rest) }) as Promise<ActResult>;
    },
    extract: ((...args: unknown[]) => {
      const extractOpts = extractOptionsOf(args);
      return run("read", `extract: ${actionText(args[0])}`, () => (stagehand.extract as (...a: unknown[]) => Promise<unknown>)(...args), { model: modelName(extractOpts), ground: true, extractOpts });
    }) as Stagehand["extract"],
    observe: ((...args: unknown[]) =>
      run("read", `observe: ${actionText(args[0])}`, () => (stagehand.observe as (...a: unknown[]) => Promise<unknown>)(...args), { model: modelName(args[1]) })) as Stagehand["observe"],
    page: {
      goto: (url: string, gotoOpts?: unknown) =>
        run("nav", `goto ${url}`, (p) => (p.goto as (u: string, o?: unknown) => Promise<unknown>)(url, gotoOpts)),
      current: activePage,
    },
    replay,
    close: async () => {
      (await sidecar())?.close();
    },
  };
}
