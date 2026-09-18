// The driver seam (M7 Phase 0). The verdict channel reads through a `PageReader`
// and drives through a `Driver`, so a second browser driver plugs in without
// touching the classifier. Today the only implementation is Stagehand; Phase 1
// swaps the reader's a11y source to CDP (shared across drivers) and Phase 2 adds
// Playwright. See docs/M7-PLAN.md.
//
// PageReader is the READ (verdict) surface — never sees the agent's claim.
// Driver is the DRIVE (agent) surface + tab resolution.
import type { ActResult, Action, Page, Stagehand } from "@browserbasehq/stagehand";
import { normalizeTree } from "./postcondition.js";

/** Everything the verdict channel reads off one page/tab. Pure reads. */
export interface PageReader {
  /** Normalized a11y lines (`role: text [markers]`), or null if the snapshot
   *  threw mid-navigation. The driver owns normalization. */
  snapshotTree(): Promise<string[] | null>;
  /** In-page eval; throws on failure (safeRead wraps it to null). */
  evaluate<T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T>;
  url(): Promise<string>;
  count(selector: string): Promise<number>; // css | xpath= | text=
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
export function stagehandReader(page: Page): PageReader {
  return {
    id: String((page as unknown as { pageId?: string }).pageId ?? ""),
    async snapshotTree() {
      try {
        return normalizeTree((await page.snapshot()).formattedTree);
      } catch {
        return null; // snapshot throws mid-navigation; empty read is safe
      }
    },
    evaluate: <T>(fn: (arg: unknown) => T, arg?: unknown) => page.evaluate(fn as never, arg as never) as Promise<T>,
    url: () => page.url(),
    count: (selector) => page.locator(selector).count(),
    screenshot: () => page.screenshot() as Promise<Uint8Array>,
    waitForLoadState: (state, timeoutMs) => (page.waitForLoadState as (s: string, t: number) => Promise<void>)(state, timeoutMs),
  };
}

/** Adapt a Stagehand instance to the Driver surface. */
export function stagehandDriver(stagehand: Stagehand): Driver {
  const active = async (): Promise<Page> => {
    const ctx = stagehand.browser.context;
    const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
    if (!page) throw new Error("TrueFact: no active page on the Stagehand browser context");
    return page;
  };
  return {
    act: (instruction, opts) => stagehand.act(instruction as string, opts as never),
    extract: (...args) => (stagehand.extract as (...a: unknown[]) => Promise<unknown>)(...args),
    observe: (...args) => (stagehand.observe as (...a: unknown[]) => Promise<unknown>)(...args),
    goto: async (url, opts) => {
      const p = await active();
      return (p.goto as (u: string, o?: unknown) => Promise<unknown>)(url, opts);
    },
    activePage: async () => stagehandReader(await active()),
    readerFor: (handle) => stagehandReader(handle as Page),
  };
}
