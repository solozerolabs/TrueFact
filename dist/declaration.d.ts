import type { PageReader } from "./driver.js";
import { type Outcome } from "./postcondition.js";
export type Declaration = {
    kind: "url";
    matches: string | RegExp;
} | {
    kind: "element";
    selector: string;
    absent?: boolean;
} | {
    kind: "text";
    matches: string | RegExp;
    role?: string;
    absent?: boolean;
} | {
    kind: "field";
    selector: string;
    equals: string | RegExp;
} | {
    kind: "probe";
    get: string;
    status?: "ok" | number;
    text?: string | RegExp;
    absent?: boolean;
};
export interface DeclaredResult {
    declaration: Declaration;
    met: boolean | null;
    actual: string | null;
    elapsedMs: number;
}
/** Fail fast on declarations that would pass on anything. */
export declare function validateDeclarations(input: Declaration | Declaration[] | undefined): Declaration[];
/**
 * Evaluate every declaration each tick until all are met or the budget ends.
 * Read-only: the write is never re-issued. Password targets are redacted in
 * the returned results (the verdict was computed on the real value).
 */
export declare function checkDeclarations(page: PageReader, decls: Declaration[], budgetMs: number): Promise<DeclaredResult[]>;
/**
 * Compose the auto outcome with declared results (docs/DAY4.md §3). Unmet →
 * did-not-land. Met lifts only the auto default's uncertain outcomes and
 * never argues with a mechanism-backed did-not-land. Negatives never lift.
 */
export declare function applyDeclarations(auto: Outcome, results: DeclaredResult[]): Outcome;
