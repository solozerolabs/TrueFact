// TrueFact — wrap a Stagehand (v4) instance by composition and record, per
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
  FIELD_METHODS,
  readTree,
  redactLen,
  sessionVerdict,
  type FormValue,
  type Postcondition,
  type Verdict,
} from "./postcondition.js";
import { attachSidecar, attachSidecarConn, type Sidecar } from "./sidecar.js";
import type { CdpConn } from "./cdp.js";
import { hashStep, makeSigner } from "./chain.js";
import { stagehandDriver, type Driver, type PageReader } from "./driver.js";
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
export { verifyChain, hashStep, canonical, makeSigner, verifyHashSig, type ChainResult } from "./chain.js";
export { renderHtml, viewFile } from "./view.js";
export { launch, type LaunchOptions, type Launched } from "./launch.js";
export { stagehandDriver, stagehandReader, type Driver, type PageReader } from "./driver.js";
export { playwrightDriver, playwrightReader, axToLines } from "./driver-playwright.js";
export { cdpDriver, cdpReader, type CdpAction, type Perform } from "./driver-cdp.js";
export { startServe, type ServeOptions, type ServeRequest, type ServeReply, type ServeSession } from "./serve.js";
export { summarizeRun, rollupRuns, type RunSummary, type FleetSummary } from "./fleet.js";
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
  /** Throw with the reason unless the whole run landed. Handy in a test/gate. */
  assertLanded(): void;
}

/** The verdict, attached to what `act()` returns, so an agent loop reads it off
 *  the result instead of digging into replay.steps. `why` is a one-line reason.
 *  `retryable` says whether repeating the identical action is safe (see retryableOf). */
export interface VerdictView {
  verdict: Verdict;
  reason: string;
  confidence: string;
  why: string;
  retryable: boolean;
  step: Step;
}

/**
 * Is it safe to repeat this exact action? `true` means retrying it cannot
 * double-apply a server write — NOT that a retry will succeed. So it is true in
 * one case only: a `did-not-land` field write (`fill`/`type`/`select`) whose
 * value never took, where the step is *purely* those field methods (the value
 * never left the input, no click was submitted). Everything else is `false`:
 *   - `landed` — retrying it IS the double charge.
 *   - every `inconclusive` — we don't know it didn't land; never auto-retry.
 *   - `network-error` (incl. a null-status wire failure) — the request left the
 *     browser and the server may have applied it.
 *   - a mixed fill+click `field-mismatch` — the click may have submitted.
 *   - `validation-error`, `declared-unmet`, an obstruction — the caller decides.
 */
export function retryableOf(step: Step): boolean {
  const post = step.evidence.postcondition;
  if (step.verdict !== "did-not-land" || post?.reason !== "field-mismatch") return false;
  const methods = (step.attempt ?? []).map((a) => a.method).filter(Boolean) as string[];
  return methods.length > 0 && methods.every((m) => FIELD_METHODS.has(m));
}

/** A one-line, human/agent-readable reason for a write step's verdict. */
export function whyOf(step: Step): string {
  const p = step.evidence.postcondition;
  const net = p?.network?.errors?.[0];
  if (net) return `a request behind this write ${net.status == null ? "failed with no response" : "returned " + net.status} (${step.verdict})`;
  if (p?.network?.pending) return `a request behind this write hadn't answered when we checked (${step.verdict})`;
  if (step.evidence.session.obstruction) return `blocked by ${step.evidence.session.obstruction} (${step.verdict})`;
  return `${step.verdict}${p ? " (" + p.reason + ")" : ""}`;
}

const verdictView = (step: Step): VerdictView => ({
  verdict: step.verdict,
  reason: step.evidence.postcondition?.reason ?? "no-evidence",
  confidence: step.evidence.postcondition?.confidence ?? "heuristic",
  why: whyOf(step),
  retryable: retryableOf(step),
  step,
});

export interface TrueFactOptions {
  screenshots?: boolean; // default true; captured on write steps, after the verdict is decided
  screenshotDir?: string; // default ".truefact/screenshots"
  waitMs?: number; // one budget for the auto no-change poll and declared checks (default 5000)
  jsonl?: string; // if set, append one redacted step per line as the run proceeds
  // ed25519 private key (PEM). When set — here or via TRUEFACT_SIGNING_KEY —
  // each step is signed over its hash, and `truefact verify --pubkey` can
  // check the signature. Off by default; the hash chain alone still detects
  // tamper. See docs/SPEC-V2.md §8.
  signingKey?: string;
  // Opt-in network verification (M2). Attaches a second CDP client to the Chrome
  // launched with `localBrowser.launch({ port })` and demotes an optimistic write
  // (page ✅) to did-not-land when its own backend returned a same-origin 5xx.
  // Off by default: the certified 0-false-halt page-read verdict is unchanged.
  // apiOrigins: extra origins whose failed writes also demote (default: page
  // origin only). Name your write host(s) for a split-origin app (app.x.com ->
  // api.x.com, *.supabase.co, api.stripe.com); an explicit allowlist keeps the
  // cry-wolf guard intact — a third-party analytics 500 still never fires.
  network?: {
    port?: number; // TCP debug-port mode (watch, stagehand). Mutually exclusive with conn.
    conn?: CdpConn; // shared fd-transport conn (serve fd mode): no port, no second client.
    apiOrigins?: string[];
    // Opt-in: also demote on a 2xx whose body says the write failed (GraphQL
    // `{"errors":[…]}`, `{"success":false}`). true = default pattern; a RegExp
    // overrides it. Costs one CDP body read per mutating 2xx. See sidecar.ts.
    bodyErrors?: boolean | RegExp;
  };
  // Length-mask the stored values of these form fields (matched by name/id):
  // strings match exactly, RegExps test the key. For PII that is not
  // secret-shaped (a name, an address) and so slips past the always-on
  // secret scrubber. `["ssn", /card/]`. Off by default.
  redactFields?: (string | RegExp)[];
}

export type ActOptions = StagehandClientActOptions & {
  expect?: Declaration | Declaration[]; // AND; stripped before delegating (Stagehand rejects unknown keys)
  waitMs?: number;
};

export interface Wrapped {
  act(instruction: string | Action, options?: ActOptions): Promise<ActResult & { truefact: VerdictView }>;
  extract: Stagehand["extract"];
  observe: Stagehand["observe"];
  page: { goto(url: string, opts?: unknown): Promise<unknown>; current(): Promise<PageReader> };
  replay: Replay;
  close(): Promise<void>; // release the network sidecar (no-op when network is off)
}

/**
 * Run verdict rolls up over write steps only; a read/nav never decides it.
 * The last *decisive* write (landed | did-not-land) wins: an inconclusive
 * retry can't erase an earlier landed (issue #2 — a success drawer obstructs
 * the re-issued action), but a later did-not-land still actively undoes it.
 */
export function rollup(steps: Step[]): Verdict {
  const decisive = steps.filter((s) => s.kind === "write" && s.verdict !== "inconclusive");
  return decisive.length ? decisive[decisive.length - 1].verdict : "inconclusive";
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
  assertLanded(): void {
    if (this.verdict === "landed") return;
    const bad = this.steps.filter((s) => s.kind === "write" && s.verdict !== "landed").at(-1);
    throw new Error(`TrueFact: run did not land (${this.verdict})${bad ? " — " + whyOf(bad) : ""}`);
  }
}

const actionText = (a: unknown): string => (typeof a === "string" ? a : JSON.stringify(a));
// A selector that targets a password field, for masking a typed secret in a
// multi-field step where the field read (which covers only actions[0]) can't.
const looksPassword = (sel = ""): boolean => /password|passwd|(?:^|[^a-z])pwd(?:[^a-z]|$)/i.test(sel);
const statusOf = (r: unknown): number | null =>
  r && typeof (r as { status?: () => number }).status === "function" ? (r as { status: () => number }).status() : null;

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
async function groundExtract(active: PageReader, extractOpts: StagehandClientExtractOptions | undefined, claim: unknown, driver: Driver): Promise<Grounding> {
  const target = extractOpts?.page ? driver.readerFor(extractOpts.page) : active;
  const tree = await readTree(target);
  if (!tree) return nonGrounding();
  const g = groundValues((claim as { data?: unknown })?.data, tree);
  if (extractOpts?.screenshot) g.visual = true;
  const masks = new Set<number>();
  for (const l of tree) { const m = l.match(/•+/g); if (m) for (const s of m) masks.add(s.length); }
  if (masks.size) for (const v of g.values) if (v.match === "absent" && masks.has(v.value.length)) v.value = redactLen(v.value);
  return g;
}

/**
 * Redact secrets from a step before it is persisted, in place of trusting
 * callers. Two nets: `redactText` scrubs secret-shaped runs (keys, tokens,
 * emails) from *every* stored string — free text AND the evidence a page read
 * leaves behind (form values, the targeted field, tree lines, URLs, titles),
 * which the old version left in plaintext. `redactFields` additionally
 * length-masks the values of named form fields (`"ssn"`, `/card/`), for PII
 * that is not secret-shaped. We store no cookies, headers or response bodies,
 * so there is nothing else to scrub. See docs/M7-PLAN.md Phase 1.5.
 */
function redactStep(step: Step, redactFields?: (string | RegExp)[]): Step {
  step.action = redactText(step.action);
  if (step.agent_claim) step.agent_claim = { ...step.agent_claim, message: redactText(step.agent_claim.message) };
  if (step.attempt)
    step.attempt = step.attempt.map((a) => {
      const desc = (a as { description?: string }).description;
      return {
        ...a,
        ...(a.arguments?.length ? { arguments: a.arguments.map(redactText) } : {}),
        ...(desc ? { description: redactText(desc) } : {}),
      };
    });
  if (step.evidence.grounding)
    step.evidence.grounding.values = step.evidence.grounding.values.map((v) => ({ ...v, value: redactText(v.value) }));

  const declared = (key: string): boolean =>
    !!redactFields?.some((r) => (typeof r === "string" ? r === key : r.test(key)));

  // Fingerprints: href (query strings) and title can carry a token or PII.
  for (const fp of [step.evidence.before, step.evidence.after]) {
    if (fp) {
      fp.href = redactText(fp.href);
      fp.title = redactText(fp.title);
    }
  }

  const post = step.evidence.postcondition;
  if (post) {
    const scrubForms = (forms: Record<string, FormValue>): void => {
      for (const k of Object.keys(forms)) {
        // password values arrive already length-masked (postcondition.ts).
        forms[k].value = declared(k) ? redactLen(forms[k].value) : redactText(forms[k].value);
      }
    };
    scrubForms(post.formsBefore);
    scrubForms(post.formsAfter);
    if (post.field)
      post.field = {
        ...post.field,
        expected: redactText(post.field.expected),
        actual: post.field.actual == null ? null : redactText(post.field.actual),
      };
    post.treeAdded = post.treeAdded.map(redactText);
    post.treeRemoved = post.treeRemoved.map(redactText);
    if (post.network) post.network.errors = post.network.errors.map((e) => ({ ...e, url: redactText(e.url) }));
    // A redirect URL and a declaration's observed value are stored strings too.
    if (post.newPageUrl) post.newPageUrl = redactText(post.newPageUrl);
    if (post.declared) post.declared = post.declared.map((r) => (r.actual == null ? r : { ...r, actual: redactText(r.actual) }));
  }
  return step;
}

export function withTrueFact(source: Stagehand | Driver, opts: TrueFactOptions = {}): Wrapped {
  // Accept a Stagehand (wrap it) or a ready Driver (Phase 2 drivers pass one).
  const driver: Driver =
    "activePage" in source && "readerFor" in source ? (source as Driver) : stagehandDriver(source as Stagehand);
  const screenshotDir = opts.screenshotDir ?? ".truefact/screenshots";
  const defaultWait = opts.waitMs ?? 5000;
  // Truncate at the start of the run: a run owns its file and appends one line
  // per step, so a fresh chain always begins at prevHash "". Re-running the same
  // path used to concatenate runs into a chain that verify() reports as broken.
  if (opts.jsonl) {
    mkdirSync(dirname(opts.jsonl), { recursive: true });
    writeFileSync(opts.jsonl, "");
  }

  // Redact, chain, sign, push in memory, and (if configured) append one JSONL
  // line — so the stored record survives a crashed run and always matches
  // what's in memory. The hash is computed AFTER redaction, so a stored line
  // re-hashes to its own `hash` (verify reads exactly what was written).
  const signingKey = opts.signingKey ?? process.env.TRUEFACT_SIGNING_KEY;
  const sign = signingKey ? makeSigner(signingKey) : null;
  let prevHash = "";
  const record = (step: Step): void => {
    const clean = redactStep(step, opts.redactFields);
    clean.prevHash = prevHash;
    clean.hash = hashStep(clean);
    if (sign) clean.sig = sign(clean.hash);
    prevHash = clean.hash;
    replay.steps.push(clean);
    if (opts.jsonl) appendFileSync(opts.jsonl, JSON.stringify(clean) + "\n");
  };

  const activePage = (): Promise<PageReader> => driver.activePage();

  // Attach the network sidecar once, lazily. Network.enable is persistent, so
  // enabling it here (before the first write's click) covers every later write.
  let sidecarPromise: Promise<Sidecar | null> | null = null;
  const sidecar = (): Promise<Sidecar | null> =>
    (sidecarPromise ??= opts.network
      ? opts.network.conn
        ? attachSidecarConn(opts.network.conn, { bodyErrors: opts.network.bodyErrors, ownsConn: false })
        : opts.network.port
          ? attachSidecar(opts.network.port, { bodyErrors: opts.network.bodyErrors })
          : Promise.resolve(null)
      : Promise.resolve(null));

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

  async function snap(page: PageReader): Promise<string | undefined> {
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
    invoke: () => Promise<unknown>,
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
      claim = await invoke();
    } catch (e) {
      threw = e;
    }

    // Re-resolve the active page: a click can open/switch to a new tab (§5).
    // activePage() returns a fresh reader each call; compare the stable id.
    const page = await activePage();
    const pageSwitched = page.id !== beforePage.id;
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
            ? await groundExtract(page, declared.extractOpts, claim, driver)
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

    // M2: a server error in this write's window overrides an optimistic
    // page-read verdict. errorsSince() filters to the page origin plus any
    // caller-declared apiOrigins, so a third-party analytics 500 never fires
    // this (the cry-wolf guard); a split-origin write host opts in explicitly.
    if (sc) {
      const origins = [new URL(beforeState!.fp.href || "http://x").origin, ...(opts.network?.apiOrigins ?? [])];
      // Wait for THIS write's own in-flight requests to answer before judging,
      // but only when the page read says landed — that's the sole verdict the
      // network can overturn (an optimistic ✅ whose POST 500s late). settle()
      // also drains 2xx body reads so a late 200-that-lies is seen.
      const pending = await sc.settle(verdict === "landed" ? waitMs : 0, origins);
      const errors = sc.errorsSince(netMark, origins);
      const net = applyNetwork(verdict, errors);
      if (net) {
        post.verdict = net.verdict;
        post.reason = net.reason;
        post.confidence = net.confidence;
        verdict = net.verdict;
      } else if (verdict === "landed" && post.confidence === "heuristic" && pending > 0) {
        // A watched write left the browser but never answered within the budget.
        // An optimistic banner (`confirmation`/`form-cleared`, heuristic) can lie
        // while its POST is still in flight — so we cannot call this landed. We
        // also cannot call it did-not-land (it may yet succeed): inconclusive.
        // High-confidence landings (navigation, a client-side field-match) and
        // caller declarations are not optimistic in this way and are left alone.
        post.verdict = "inconclusive";
        post.reason = "unsettled";
        post.confidence = "heuristic";
        verdict = "inconclusive";
        post.network = { errors: [], pending };
      }
      // The network only ever DEMOTES. It deliberately does not lift an uncertain
      // verdict on a clean 2xx: a same-origin 2xx (a first-party analytics beacon)
      // proves that request succeeded, never that THIS action's write did —
      // lifting on it reintroduces false-landed. Shrink inconclusive the sound
      // way: declare a postcondition (probe/text). See docs/FINDINGS.
      if (errors.length) post.network = { errors };
    }

    // Length-mask the typed value of EVERY action that targeted a password
    // field, not just actions[0] (fill-username-then-password lands the secret in
    // attempt[1]). A plain password isn't secret-shaped, so redactText misses it;
    // detect actions[0] from the field read and the rest from the selector (the
    // field itself may be gone after a submit+navigate).
    let attempt = actions;
    if (attempt) {
      attempt = attempt.map((a, i) => {
        const isPw = a.arguments?.length && ((i === 0 && decision.isPassword) || looksPassword(a.selector));
        return isPw ? { ...a, arguments: [redactLen(a.arguments![0]), ...a.arguments!.slice(1)] } : a;
      });
      if (decision.isPassword && post.field)
        post.field = { ...post.field, expected: redactLen(post.field.expected), actual: post.field.actual == null ? null : redactLen(post.field.actual) };
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
      // Only a driver that self-reports (Stagehand's ActResult carries `success`)
      // gets a sealed claim. A Playwright write has actions but no claim, so it
      // degrades to null — we never fabricate one to keep the narrative.
      agent_claim: data && "success" in data ? { success: !!data.success, message: data.message ?? "" } : null,
      cost,
      timestamp: new Date().toISOString(),
    });
    if (threw) throw threw;
    return claim;
  }

  return {
    act: async (instruction, options) => {
      const { expect, waitMs, ...rest } = options ?? {};
      const res = (await run("write", `act: ${actionText(instruction)}`, () => driver.act(instruction, rest), { expect, waitMs, model: modelName(rest) })) as ActResult;
      // Attach the independent verdict to the result, so an agent loop reads it
      // off `res.truefact` instead of reaching into replay.steps.
      const step = replay.steps.at(-1)!;
      return Object.assign(res ?? ({} as ActResult), { truefact: verdictView(step) });
    },
    extract: ((...args: unknown[]) => {
      const extractOpts = extractOptionsOf(args);
      return run("read", `extract: ${actionText(args[0])}`, () => driver.extract(...args), { model: modelName(extractOpts), ground: true, extractOpts });
    }) as Stagehand["extract"],
    observe: ((...args: unknown[]) =>
      run("read", `observe: ${actionText(args[0])}`, () => driver.observe(...args), { model: modelName(args[1]) })) as Stagehand["observe"],
    page: {
      goto: (url: string, gotoOpts?: unknown) =>
        run("nav", `goto ${url}`, () => driver.goto(url, gotoOpts)),
      current: activePage,
    },
    replay,
    close: async () => {
      (await sidecar())?.close();
    },
  };
}
