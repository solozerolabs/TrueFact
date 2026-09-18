import type { ActResult, Action, Stagehand, StagehandClientActOptions } from "@browserbasehq/stagehand";
import { type Fingerprint, type SessionEvidence } from "./session.js";
import { sessionVerdict, type Postcondition, type Verdict } from "./postcondition.js";
import type { CdpConn } from "./cdp.js";
import { type Driver, type PageReader } from "./driver.js";
import { applyDeclarations, validateDeclarations, type Declaration, type DeclaredResult } from "./declaration.js";
import { groundValues, type Grounding, type GroundingReason } from "./grounding.js";
export type { Verdict, Postcondition, SessionEvidence, Fingerprint, Declaration, DeclaredResult, Grounding, GroundingReason };
export { sessionVerdict, applyDeclarations, validateDeclarations, groundValues };
export { defineAssertions, reassert, reassertFile, viewOf, pass, fail, type BrowserView, type BrowserAssertion, type Assertions, type AssertResult, type ReassertReport, type ReassertItem, } from "./assert.js";
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
        grounding?: Grounding;
        nav?: {
            status: number | null;
        };
        screenshot?: string;
    };
    attempt: Action[] | null;
    agent_claim: {
        success: boolean;
        message: string;
    } | null;
    cost: {
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        inferenceTimeMs: number;
    } | null;
    timestamp: string;
    prevHash?: string;
    hash?: string;
    sig?: string;
}
export interface RunDeclaration {
    declared: DeclaredResult[];
    verdict: Verdict;
}
export interface Replay {
    steps: Step[];
    readonly verdict: Verdict;
    claim: {
        done: boolean;
        note?: string;
    } | null;
    setClaim(done: boolean, note?: string): void;
    final: RunDeclaration | null;
    finalize(opts?: {
        expect?: Declaration | Declaration[];
    }): Promise<RunDeclaration>;
}
export interface TrueFactOptions {
    screenshots?: boolean;
    screenshotDir?: string;
    waitMs?: number;
    jsonl?: string;
    signingKey?: string;
    network?: {
        port?: number;
        conn?: CdpConn;
        apiOrigins?: string[];
        bodyErrors?: boolean | RegExp;
    };
    redactFields?: (string | RegExp)[];
}
export type ActOptions = StagehandClientActOptions & {
    expect?: Declaration | Declaration[];
    waitMs?: number;
};
export interface Wrapped {
    act(instruction: string | Action, options?: ActOptions): Promise<ActResult>;
    extract: Stagehand["extract"];
    observe: Stagehand["observe"];
    page: {
        goto(url: string, opts?: unknown): Promise<unknown>;
        current(): Promise<PageReader>;
    };
    replay: Replay;
    close(): Promise<void>;
}
/** Run verdict rolls up over write steps only; a read/nav never decides it. */
export declare function rollup(steps: Step[]): Verdict;
/** A run-level declaration can only demote the step roll-up. */
export declare function combine(steps: Verdict, final: RunDeclaration | null): Verdict;
export declare function withTrueFact(source: Stagehand | Driver, opts?: TrueFactOptions): Wrapped;
