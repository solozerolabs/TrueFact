// TrueFact — wrap a Stagehand (v4) instance by composition and record, per
// step, what the agent claimed vs. what the page shows. The two channels never
// touch here: no verdict function receives agent_claim. See docs/DAY2–4.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { detectSession, fingerprint, settle } from "./session.js";
import { applyNetwork, captureState, decideWrite, readTree, redactLen, sessionVerdict, } from "./postcondition.js";
import { attachSidecar, attachSidecarConn } from "./sidecar.js";
import { hashStep, makeSigner } from "./chain.js";
import { stagehandDriver } from "./driver.js";
import { applyDeclarations, checkDeclarations, validateDeclarations, } from "./declaration.js";
import { groundValues } from "./grounding.js";
import { redactText } from "./redact.js";
export { sessionVerdict, applyDeclarations, validateDeclarations, groundValues };
export { defineAssertions, reassert, reassertFile, viewOf, pass, fail, } from "./assert.js";
export { verifyChain, hashStep, canonical, makeSigner, verifyHashSig } from "./chain.js";
export { renderHtml, viewFile } from "./view.js";
export { launch } from "./launch.js";
export { stagehandDriver, stagehandReader } from "./driver.js";
export { playwrightDriver, playwrightReader, axToLines } from "./driver-playwright.js";
export { cdpDriver, cdpReader } from "./driver-cdp.js";
export { startServe } from "./serve.js";
export { summarizeRun, rollupRuns } from "./fleet.js";
/** Run verdict rolls up over write steps only; a read/nav never decides it. */
export function rollup(steps) {
    const writes = steps.filter((s) => s.kind === "write");
    if (writes.some((s) => s.verdict === "did-not-land"))
        return "did-not-land";
    if (writes.some((s) => s.verdict === "inconclusive"))
        return "inconclusive";
    return writes.length ? "landed" : "inconclusive";
}
/** A run-level declaration can only demote the step roll-up. */
export function combine(steps, final) {
    if (!final)
        return steps;
    if (final.verdict === "did-not-land")
        return "did-not-land";
    if (final.verdict === "inconclusive" && steps === "landed")
        return "inconclusive";
    return steps;
}
class ReplayImpl {
    finalizer;
    steps = [];
    claim = null;
    final = null;
    constructor(finalizer) {
        this.finalizer = finalizer;
    }
    get verdict() {
        return combine(rollup(this.steps), this.final);
    }
    setClaim(done, note) {
        this.claim = { done, note };
    }
    async finalize(opts = {}) {
        this.final = await this.finalizer(validateDeclarations(opts.expect));
        return this.final;
    }
}
const actionText = (a) => (typeof a === "string" ? a : JSON.stringify(a));
// A selector that targets a password field, for masking a typed secret in a
// multi-field step where the field read (which covers only actions[0]) can't.
const looksPassword = (sel = "") => /password|passwd|(?:^|[^a-z])pwd(?:[^a-z]|$)/i.test(sel);
const statusOf = (r) => r && typeof r.status === "function" ? r.status() : null;
const costOf = (claim, model) => {
    const u = claim?.metadata?.usage;
    if (!u)
        return model ? { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, inferenceTimeMs: 0 } : null;
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
const modelName = (o) => o?.model?.modelName ?? null;
/** The extract options among the call args (not the zod schema, which has a
 *  `parse`/`_def`). Works whether options sit at arg 1 (no schema) or arg 2. */
function extractOptionsOf(args) {
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a && typeof a === "object" && typeof a.parse !== "function" && !("_def" in a))
            return a;
    }
    return undefined;
}
const nonGrounding = () => ({ verdict: "inconclusive", reason: "non-grounding", confidence: "heuristic", values: [], skipped: 0 });
/** Ground an extract's returned data against the a11y tree of the page it read
 *  (`options.page` may target a non-active tab). Redact any absent leaf that is
 *  the length of a masked password run — the only case a returned value could
 *  be a secret the tree did not already mask. */
async function groundExtract(active, extractOpts, claim, driver) {
    const target = extractOpts?.page ? driver.readerFor(extractOpts.page) : active;
    const tree = await readTree(target);
    if (!tree)
        return nonGrounding();
    const g = groundValues(claim?.data, tree);
    if (extractOpts?.screenshot)
        g.visual = true;
    const masks = new Set();
    for (const l of tree) {
        const m = l.match(/•+/g);
        if (m)
            for (const s of m)
                masks.add(s.length);
    }
    if (masks.size)
        for (const v of g.values)
            if (v.match === "absent" && masks.has(v.value.length))
                v.value = redactLen(v.value);
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
function redactStep(step, redactFields) {
    step.action = redactText(step.action);
    if (step.agent_claim)
        step.agent_claim = { ...step.agent_claim, message: redactText(step.agent_claim.message) };
    if (step.attempt)
        step.attempt = step.attempt.map((a) => {
            const desc = a.description;
            return {
                ...a,
                ...(a.arguments?.length ? { arguments: a.arguments.map(redactText) } : {}),
                ...(desc ? { description: redactText(desc) } : {}),
            };
        });
    if (step.evidence.grounding)
        step.evidence.grounding.values = step.evidence.grounding.values.map((v) => ({ ...v, value: redactText(v.value) }));
    const declared = (key) => !!redactFields?.some((r) => (typeof r === "string" ? r === key : r.test(key)));
    // Fingerprints: href (query strings) and title can carry a token or PII.
    for (const fp of [step.evidence.before, step.evidence.after]) {
        if (fp) {
            fp.href = redactText(fp.href);
            fp.title = redactText(fp.title);
        }
    }
    const post = step.evidence.postcondition;
    if (post) {
        const scrubForms = (forms) => {
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
        if (post.network)
            post.network.errors = post.network.errors.map((e) => ({ ...e, url: redactText(e.url) }));
        // A redirect URL and a declaration's observed value are stored strings too.
        if (post.newPageUrl)
            post.newPageUrl = redactText(post.newPageUrl);
        if (post.declared)
            post.declared = post.declared.map((r) => (r.actual == null ? r : { ...r, actual: redactText(r.actual) }));
    }
    return step;
}
export function withTrueFact(source, opts = {}) {
    // Accept a Stagehand (wrap it) or a ready Driver (Phase 2 drivers pass one).
    const driver = "activePage" in source && "readerFor" in source ? source : stagehandDriver(source);
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
    const record = (step) => {
        const clean = redactStep(step, opts.redactFields);
        clean.prevHash = prevHash;
        clean.hash = hashStep(clean);
        if (sign)
            clean.sig = sign(clean.hash);
        prevHash = clean.hash;
        replay.steps.push(clean);
        if (opts.jsonl)
            appendFileSync(opts.jsonl, JSON.stringify(clean) + "\n");
    };
    const activePage = () => driver.activePage();
    // Attach the network sidecar once, lazily. Network.enable is persistent, so
    // enabling it here (before the first write's click) covers every later write.
    let sidecarPromise = null;
    const sidecar = () => (sidecarPromise ??= opts.network
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
        const verdict = declared.some((r) => r.met === null)
            ? "inconclusive"
            : declared.some((r) => r.met === false)
                ? "did-not-land"
                : "landed";
        return { declared, verdict };
    });
    async function snap(page) {
        if (opts.screenshots === false)
            return undefined;
        try {
            const bytes = await page.screenshot();
            mkdirSync(screenshotDir, { recursive: true });
            // ponytail: index-named PNGs; swap for content-hash names if runs collide.
            const path = join(screenshotDir, `step-${replay.steps.length}.png`);
            writeFileSync(path, bytes);
            return path;
        }
        catch {
            return undefined;
        }
    }
    async function run(kind, action, invoke, declared = {}) {
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
        let claim = null;
        let threw = null;
        try {
            claim = await invoke();
        }
        catch (e) {
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
            const grounding = kind === "read"
                ? declared.ground && !threw
                    ? await groundExtract(page, declared.extractOpts, claim, driver)
                    : nonGrounding()
                : undefined;
            record({
                kind, action, declaration: "auto", verdict: grounding ? grounding.verdict : "inconclusive",
                evidence: { before: beforeFp, after: await fingerprint(page), settled, session, ...(grounding ? { grounding } : {}), ...(kind === "nav" ? { nav: { status: navStatus ?? null } } : {}) },
                attempt: null, agent_claim: null, cost, timestamp: new Date().toISOString(),
            });
            if (threw)
                throw threw;
            return claim;
        }
        // --- write path: decide, declare, gate, redact, record ---
        const data = claim?.data;
        const actions = data?.actions ?? null;
        const first = await captureState(page);
        let decision = await decideWrite(page, beforeState, first, actions, pageSwitched, settled, decls.length ? 0 : waitMs);
        let post = decision.post;
        if (decls.length && decision.kind === "write") {
            const results = await checkDeclarations(page, decls, waitMs);
            // refresh the auto evidence once after the poll, then compose
            decision = await decideWrite(page, beforeState, await captureState(page), actions, pageSwitched, settled, 0);
            post = { ...decision.post, ...applyDeclarations(decision.post.auto, results), declared: results };
        }
        if (pageSwitched)
            post.newPageUrl = await page.url().catch(() => "");
        const session = await detectSession(page);
        let verdict = decision.kind === "write" ? sessionVerdict(post.verdict, session, post.reason) : post.verdict;
        // M2: a server error in this write's window overrides an optimistic
        // page-read verdict. errorsSince() filters to the page origin plus any
        // caller-declared apiOrigins, so a third-party analytics 500 never fires
        // this (the cry-wolf guard); a split-origin write host opts in explicitly.
        if (sc) {
            const pageOrigin = new URL(beforeState.fp.href || "http://x").origin;
            await sc.settle(); // let any in-flight 2xx body reads land before we read
            const errors = sc.errorsSince(netMark, [pageOrigin, ...(opts.network?.apiOrigins ?? [])]);
            const net = applyNetwork(verdict, errors);
            if (net) {
                post.verdict = net.verdict;
                post.reason = net.reason;
                post.confidence = net.confidence;
                verdict = net.verdict;
            }
            if (errors.length)
                post.network = { errors };
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
                return isPw ? { ...a, arguments: [redactLen(a.arguments[0]), ...a.arguments.slice(1)] } : a;
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
            evidence: { before: beforeState.fp, after: decision.after.fp, settled, session, postcondition: post, ...(screenshot ? { screenshot } : {}) },
            attempt,
            // Only a driver that self-reports (Stagehand's ActResult carries `success`)
            // gets a sealed claim. A Playwright write has actions but no claim, so it
            // degrades to null — we never fabricate one to keep the narrative.
            agent_claim: data && "success" in data ? { success: !!data.success, message: data.message ?? "" } : null,
            cost,
            timestamp: new Date().toISOString(),
        });
        if (threw)
            throw threw;
        return claim;
    }
    return {
        act: (instruction, options) => {
            const { expect, waitMs, ...rest } = options ?? {};
            return run("write", `act: ${actionText(instruction)}`, () => driver.act(instruction, rest), { expect, waitMs, model: modelName(rest) });
        },
        extract: ((...args) => {
            const extractOpts = extractOptionsOf(args);
            return run("read", `extract: ${actionText(args[0])}`, () => driver.extract(...args), { model: modelName(extractOpts), ground: true, extractOpts });
        }),
        observe: ((...args) => run("read", `observe: ${actionText(args[0])}`, () => driver.observe(...args), { model: modelName(args[1]) })),
        page: {
            goto: (url, gotoOpts) => run("nav", `goto ${url}`, () => driver.goto(url, gotoOpts)),
            current: activePage,
        },
        replay,
        close: async () => {
            (await sidecar())?.close();
        },
    };
}
