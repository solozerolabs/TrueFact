import type { PageReader, Driver } from "./driver.js";
interface PwLocator {
    count(): Promise<number>;
    click(opts?: unknown): Promise<void>;
    fill(value: string, opts?: unknown): Promise<void>;
    pressSequentially(value: string, opts?: unknown): Promise<void>;
    selectOption(value: string, opts?: unknown): Promise<unknown>;
}
interface PwCDPSession {
    send(method: string, params?: unknown): Promise<unknown>;
}
interface PwPage {
    locator(selector: string): PwLocator;
    evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
    url(): string;
    goto(url: string, opts?: unknown): Promise<{
        status(): number;
    } | null>;
    screenshot(opts?: unknown): Promise<Uint8Array>;
    waitForLoadState(state: string, opts?: unknown): Promise<void>;
    context(): {
        newCDPSession(page: PwPage): Promise<PwCDPSession>;
    };
}
interface AxNode {
    nodeId: string;
    parentId?: string;
    ignored?: boolean;
    role?: {
        value?: string;
    };
    name?: {
        value?: string;
    };
    childIds?: string[];
    properties?: {
        name: string;
        value?: {
            value?: unknown;
        };
    }[];
}
/**
 * Flatten `Accessibility.getFullAXTree` nodes into the same normalized lines
 * `readTree` yields for Stagehand: `role`, or `role: name`, with `[checked]` /
 * `[selected]` appended from AX properties. The classifier needs before/after
 * self-consistency from one reader, not byte-parity with Stagehand, so this
 * reproduces the role signals (`status`/`alert`/`dialog`/`button`/…) and the
 * StaticText that carries confirmation/error text — which is all it reads.
 */
export declare function axToLines(nodes: AxNode[]): string[];
/** Adapt one Playwright Page to the PageReader surface. Its tree comes from
 *  CDP; every other read is Playwright-native. Memoized per page. */
export declare function playwrightReader(page: PwPage): PageReader;
/**
 * Adapt a Playwright Page to the Driver surface. `act` takes an action object
 * (a selector + method) — Playwright has no natural-language executor, so we
 * drive the locator directly and report `actions` for field verification, with
 * no claim. `extract`/`observe` have no Playwright equivalent and throw a clear
 * error; use `tr.page` for reads. Single-page for now (ponytail: multi-tab
 * needs `context.on('page')`, the same gap sidecar.ts flags).
 */
export declare function playwrightDriver(page: PwPage): Driver;
export {};
