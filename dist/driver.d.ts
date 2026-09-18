import type { ActResult, Action, Page, Stagehand } from "@browserbasehq/stagehand";
/** Everything the verdict channel reads off one page/tab. Pure reads. */
export interface PageReader {
    /** Normalized a11y lines (`role: text [markers]`), or null if the snapshot
     *  threw mid-navigation. The driver owns normalization. */
    snapshotTree(): Promise<string[] | null>;
    /** In-page eval; throws on failure (safeRead wraps it to null). */
    evaluate<T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T>;
    url(): Promise<string>;
    count(selector: string): Promise<number>;
    screenshot(): Promise<Uint8Array>;
    waitForLoadState(state: "domcontentloaded", timeoutMs: number): Promise<void>;
    /** Stable per-tab identity, for tab-switch detection. */
    readonly id: string;
}
/** The agent (drive) channel + tab resolution. */
export interface Driver {
    act(instruction: string | Action, opts?: unknown): Promise<ActResult>;
    extract(...args: unknown[]): Promise<unknown>;
    observe(...args: unknown[]): Promise<unknown>;
    goto(url: string, opts?: unknown): Promise<unknown>;
    activePage(): Promise<PageReader>;
    /** Wrap a specific page handle (e.g. an extract's options.page) as a reader. */
    readerFor(handle: unknown): PageReader;
}
/** Adapt one Stagehand Page to the PageReader surface. */
export declare function stagehandReader(page: Page): PageReader;
/** Adapt a Stagehand instance to the Driver surface. */
export declare function stagehandDriver(stagehand: Stagehand): Driver;
