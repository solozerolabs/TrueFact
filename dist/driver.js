import { normalizeTree } from "./postcondition.js";
/** Adapt one Stagehand Page to the PageReader surface. */
export function stagehandReader(page) {
    return {
        id: String(page.pageId ?? ""),
        async snapshotTree() {
            try {
                return normalizeTree((await page.snapshot()).formattedTree);
            }
            catch {
                return null; // snapshot throws mid-navigation; empty read is safe
            }
        },
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        url: () => page.url(),
        count: (selector) => page.locator(selector).count(),
        screenshot: () => page.screenshot(),
        waitForLoadState: (state, timeoutMs) => page.waitForLoadState(state, timeoutMs),
    };
}
/** Adapt a Stagehand instance to the Driver surface. */
export function stagehandDriver(stagehand) {
    const active = async () => {
        const ctx = stagehand.browser.context;
        const page = (await ctx.activePage()) ?? (await ctx.pages())[0];
        if (!page)
            throw new Error("TrueFact: no active page on the Stagehand browser context");
        return page;
    };
    return {
        act: (instruction, opts) => stagehand.act(instruction, opts),
        extract: (...args) => stagehand.extract(...args),
        observe: (...args) => stagehand.observe(...args),
        goto: async (url, opts) => {
            const p = await active();
            return p.goto(url, opts);
        },
        activePage: async () => stagehandReader(await active()),
        readerFor: (handle) => stagehandReader(handle),
    };
}
