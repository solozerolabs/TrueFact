// M7 Phase 3 — the third driver, and the one that needs no browser library at
// all. It reads a page over raw CDP (src/cdp.ts) by --remote-debugging-port, so
// ANY automation that owns the browser — a Python Playwright/patchright bridge,
// Puppeteer, a human — gets the full DOM+network verdict bracket `watch` cannot
// give (watch has no causal `before`). The caller performs the action itself;
// this driver only reads before and after. See docs/SERVE.md.
//
// Same PageReader/Driver seam as Stagehand and Playwright, so the classifier is
// untouched. Every read is a Runtime.evaluate / Accessibility / Page command.
import type { PageReader, Driver } from "./driver.js";
import type { CdpConn } from "./cdp.js";
import { axToLines } from "./driver-playwright.js";

/** An action the CALLER performs between before/after; the fields drive field
 *  verification exactly like the Playwright driver's action object. */
export interface CdpAction {
  selector?: string;
  method?: string; // click | fill | type | selectOption | goto | scroll …
  arguments?: string[];
}

/** How the driver performs (or awaits) an action. In `serve` this resolves when
 *  the external client says it is done. */
export type Perform = (kind: "act" | "goto", action: CdpAction | string) => Promise<unknown>;

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evalIn<T>(conn: CdpConn, expression: string): Promise<T> {
  const r = (await conn.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as EvalResult;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "cdp evaluate threw");
  return r?.result?.value as T;
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
export function cdpReader(conn: CdpConn, id = "cdp"): PageReader {
  let axEnabled: Promise<unknown> | null = null;
  return {
    id,
    async snapshotTree() {
      try {
        await (axEnabled ??= conn.cmd("Accessibility.enable"));
        const res = (await conn.cmd("Accessibility.getFullAXTree")) as { nodes: Parameters<typeof axToLines>[0] };
        return axToLines(res.nodes);
      } catch {
        return null; // mid-navigation — an empty read is safe
      }
    },
    evaluate: <T>(fn: (arg: unknown) => T, arg?: unknown) =>
      evalIn<T>(conn, `(${fn.toString()})(${JSON.stringify(arg ?? null)})`),
    url: () => evalIn<string>(conn, "location.href"),
    count: (selector) => evalIn<number>(conn, `${COUNT_JS}(${JSON.stringify(selector)})`),
    screenshot: async () => {
      const r = (await conn.cmd("Page.captureScreenshot", { format: "png" })) as { data: string };
      return new Uint8Array(Buffer.from(r.data, "base64"));
    },
    waitForLoadState: async (_state, timeoutMs) => {
      const start = Date.now();
      for (;;) {
        const rs = await evalIn<string>(conn, "document.readyState").catch(() => "");
        if (rs === "interactive" || rs === "complete") return;
        if (Date.now() - start > timeoutMs) throw new Error("waitForLoadState: timeout");
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
export function cdpDriver(conn: CdpConn, perform: Perform): Driver {
  const reader = cdpReader(conn);
  const unsupported = (verb: string) => (): never => {
    throw new Error(`TrueFact: the CDP driver has no ${verb}() — use the reader for reads`);
  };
  return {
    act: async (instruction) => {
      const a = (typeof instruction === "string" ? { method: "click", selector: instruction } : instruction) as CdpAction;
      await perform("act", a);
      return { data: { actions: [a] } } as never;
    },
    extract: unsupported("extract"),
    observe: unsupported("observe"),
    goto: (url) => perform("goto", url),
    activePage: () => Promise.resolve(reader),
    readerFor: () => reader,
  };
}
