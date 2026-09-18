import { axToLines } from "./driver-playwright.js";
async function evalIn(conn, expression) {
    const r = (await conn.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
    if (r?.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "cdp evaluate threw");
    return r?.result?.value;
}
// The one selector grammar `count()` sees (declaration.ts): css | xpath=… | text=…
// ponytail: `text=` is a case-insensitive substring over innermost elements —
// Playwright's full text-selector engine is not worth porting for a count.
const COUNT_JS = `(function(sel){
  if (sel.startsWith('xpath=')) { const r=document.evaluate(sel.slice(6),document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null); return r.snapshotLength; }
  if (sel.startsWith('text=')) { const t=sel.slice(5).replace(/^["']|["']$/g,'').toLowerCase(); let n=0;
    for (const el of document.querySelectorAll('body *')) { if (el.children.length===0 && (el.textContent||'').toLowerCase().includes(t)) n++; } return n; }
  return document.querySelectorAll(sel).length; })`;
/** Adapt a raw CDP page connection to the PageReader surface. */
export function cdpReader(conn, id = "cdp") {
    let axEnabled = null;
    return {
        id,
        async snapshotTree() {
            try {
                await (axEnabled ??= conn.cmd("Accessibility.enable"));
                const res = (await conn.cmd("Accessibility.getFullAXTree"));
                return axToLines(res.nodes);
            }
            catch {
                return null; // mid-navigation — an empty read is safe
            }
        },
        evaluate: (fn, arg) => evalIn(conn, `(${fn.toString()})(${JSON.stringify(arg ?? null)})`),
        url: () => evalIn(conn, "location.href"),
        count: (selector) => evalIn(conn, `${COUNT_JS}(${JSON.stringify(selector)})`),
        screenshot: async () => {
            const r = (await conn.cmd("Page.captureScreenshot", { format: "png" }));
            return new Uint8Array(Buffer.from(r.data, "base64"));
        },
        waitForLoadState: async (_state, timeoutMs) => {
            const start = Date.now();
            for (;;) {
                const rs = await evalIn(conn, "document.readyState").catch(() => "");
                if (rs === "interactive" || rs === "complete")
                    return;
                if (Date.now() - start > timeoutMs)
                    throw new Error("waitForLoadState: timeout");
                await new Promise((r) => setTimeout(r, 50));
            }
        },
    };
}
/**
 * Adapt a raw CDP connection to the Driver surface. `act`/`goto` delegate to
 * `perform` — the caller owns the browser and does the clicking; the driver
 * reports the action so field verification works, and carries no claim
 * (agent_claim degrades to null, like the Playwright driver). Single page.
 */
export function cdpDriver(conn, perform) {
    const reader = cdpReader(conn);
    const unsupported = (verb) => () => {
        throw new Error(`TrueFact: the CDP driver has no ${verb}() — use the reader for reads`);
    };
    return {
        act: async (instruction) => {
            const a = (typeof instruction === "string" ? { method: "click", selector: instruction } : instruction);
            await perform("act", a);
            return { data: { actions: [a] } };
        },
        extract: unsupported("extract"),
        observe: unsupported("observe"),
        goto: (url) => perform("goto", url),
        activePage: () => Promise.resolve(reader),
        readerFor: () => reader,
    };
}
