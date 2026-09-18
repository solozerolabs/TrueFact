import type { PageReader } from "./driver.js";
import { type Confidence, type Fingerprint, type SessionEvidence } from "./session.js";
import type { DeclaredResult } from "./declaration.js";
export type Verdict = "landed" | "did-not-land" | "inconclusive";
export type { Confidence };
export type PostReason = "field-match" | "field-mismatch" | "new-page" | "navigated" | "validation-error" | "error-text" | "prompt" | "confirmation" | "form-cleared" | "hash-only-nav" | "changed-unclassified" | "no-change" | "non-mutating" | "unsettled" | "declared-met" | "declared-unmet" | "declared-unreadable" | "network-error" | "network-ok";
export interface FormValue {
    value: string;
    checked?: boolean;
    userInvalid: boolean;
}
export interface PageState {
    fp: Fingerprint;
    tree: string[];
    forms: Record<string, FormValue>;
    userInvalidCount: number;
    activeField: string | null;
    pageId: string;
}
export interface Outcome {
    verdict: Verdict;
    reason: PostReason;
    confidence: Confidence;
}
export interface Postcondition extends Outcome {
    auto: Outcome;
    urlChanged: boolean;
    pageSwitched: boolean;
    newPageUrl?: string;
    treeAdded: string[];
    treeRemoved: string[];
    formsBefore: Record<string, FormValue>;
    formsAfter: Record<string, FormValue>;
    field?: {
        selector: string;
        expected: string;
        actual: string | null;
    };
    declared?: DeclaredResult[];
    network?: {
        errors: {
            url: string;
            status: number | null;
        }[];
    };
}
export declare const redactLen: (s: string) => string;
export declare const sleep: (ms: number) => Promise<unknown>;
/** Strip the `[n-m]` node-id prefix and indentation so diffs compare content. */
export declare function normalizeTree(formattedTree: string): string[];
/** The reader's normalized tree lines, or null if the snapshot threw
 *  (mid-navigation). The single place `captureState`, `checkDeclarations` and
 *  grounding read the a11y tree — now driver-agnostic via the PageReader. */
export declare function readTree(page: PageReader): Promise<string[] | null>;
/** The page text of one normalized tree line, without its `role:` prefix or
 *  `[selected]`/`[checked]` markers. A role-only structural line (no `: `,
 *  e.g. `status`, `scrollable, html`) has no text and returns "". */
export declare function treeText(line: string): string;
export declare function multisetDiff(a: string[], b: string[]): string[];
export declare function captureState(page: PageReader): Promise<PageState>;
/** The evidence block for a step: tree diff, url delta, forms. Pure. */
export declare function evidenceOf(before: PageState, after: PageState, pageSwitched: boolean, outcome: Outcome): Postcondition;
/**
 * The §4 classification rows (docs/DAY3.md, revised by DAY4 R2). Pure: a
 * function of two PageStates plus whether a tab switch happened. First match
 * wins. Bare no-change is `inconclusive`; corroboration to did-not-land
 * happens in sessionVerdict, where the obstruction is known.
 */
export declare function classify(before: PageState, after: PageState, pageSwitched: boolean): Outcome;
/**
 * Day 2 obstruction rule + Day 4 destination gate + R2 corroboration, as a
 * pure function of the verdict-so-far, the session read on the final page,
 * and the reason. A high-confidence obstruction forces did-not-land; a
 * heuristic one demotes landed to inconclusive; bare no-change plus ANY
 * obstruction is the cookie-overlay signature → did-not-land.
 */
export declare function sessionVerdict(current: Verdict, session: SessionEvidence, reason?: PostReason): Verdict;
/**
 * Compose the page-read verdict with the network sidecar (M2). A same-origin
 * server error / failed request in the write window means the write's own
 * backend rejected it — did-not-land, high — and this overrides an optimistic
 * confirmation (page ✅, server 500), the one trap a page read cannot beat.
 *
 * It only demotes: it never lifts, never argues with a mechanism-backed
 * did-not-land (that verdict keeps its own reason), and does nothing on an
 * empty error set. Same-origin filtering is the caller's (see sidecar): a
 * third-party analytics 500 is not evidence the write failed, so it never
 * reaches here — that is the cry-wolf guard.
 */
export declare function applyNetwork(current: Verdict, errors: {
    url: string;
    status: number | null;
}[]): Outcome | null;
/**
 * One in-page read of a selector's target (css | xpath= | bare xpath): its
 * value (input / select), text, whether it exists, and whether it is a
 * password field. Serialized into the page, so everything is inline (no outer
 * helper calls — see AGENTS.md).
 */
export declare function readTarget(page: PageReader, selector: string): Promise<{
    found: boolean;
    value: string;
    text: string;
    isPassword: boolean;
} | null>;
export interface Action {
    selector: string;
    method?: string;
    arguments?: string[];
}
export interface FieldResult extends Outcome {
    reason: "field-match" | "field-mismatch";
    field: {
        selector: string;
        expected: string;
        actual: string | null;
    };
    isPassword: boolean;
}
/**
 * Read the field the agent says it targeted and compare to what it says it
 * typed. `attempt` picks the selector and the expected value; the verdict
 * comes from a page read. Returns null (fall through to classify) if the read
 * fails for any reason.
 */
export declare function fieldPostcondition(page: PageReader, action: Action): Promise<FieldResult | null>;
/**
 * Poll the cheap fingerprint every `intervalMs` for up to `budgetMs`, calling
 * `probe(changed)` each tick; return its first non-null result, else probe
 * once more at the deadline. A null fingerprint (navigation in flight) counts
 * as changed (DAY4 R3).
 */
export declare function pollUntil<T>(page: PageReader, budgetMs: number, probe: (changed: boolean, final: boolean) => Promise<T | null>, intervalMs?: number): Promise<T | null>;
export interface WriteDecision {
    kind: "write" | "read";
    post: Postcondition;
    after: PageState;
    isPassword: boolean;
}
/**
 * The write-step decision (DAY3 §8 precedence with DAY4 R1/R2). `waitMs` is
 * the extended no-change budget; pass 0 when a declaration will poll instead.
 */
export declare function decideWrite(page: PageReader, before: PageState, firstAfter: PageState, actions: Action[] | null, pageSwitched: boolean, settled: boolean, waitMs: number): Promise<WriteDecision>;
