// Shared test infrastructure. Fixtures that navigate, redirect, open tabs, or
// need an HTTP status must be served over http:// — Chrome refuses script
// navigation to data: URLs and a data: tab never reports a URL (docs/DAY3.md §0).
import { createServer, type Server } from "node:http";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { PageState, FormValue } from "../src/postcondition.js";

type Route = string | { status?: number; html: string };

export interface Fixture {
  base: string;
  close(): Promise<void>;
}

/** A tiny stdlib HTTP server for fixtures. `serve({ "/checkout": html })`. */
export async function serve(routes: Record<string, Route>): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const r = routes[req.url ?? ""] ?? { status: 404, html: "not found" };
    const { status = 200, html } = typeof r === "string" ? { html: r } : r;
    res.writeHead(status, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // A browser tab left open on a fixture holds a keep-alive socket, which
        // would make server.close() hang until the browser closes.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Build a PageState for pure classify() unit tests. */
export function state(over: Partial<PageState> = {}): PageState {
  return {
    fp: { href: "http://x/a", readyState: "complete", bodyTextLength: 0, elementCount: 0, title: "" },
    tree: [],
    forms: {},
    userInvalidCount: 0,
    activeField: null,
    pageId: "",
    ...over,
  };
}

export const form = (value: string, over: Partial<FormValue> = {}): FormValue => ({
  value,
  userInvalid: false,
  ...over,
});

export interface ActionSpec {
  selector: string;
  method?: string;
  args?: string[];
  success?: boolean;
  message?: string;
}

/**
 * A duck-typed Stagehand whose `act` performs a REAL locator action on the page
 * and returns an ActResult-shaped result. The only fake is the LLM; the browser,
 * the click/fill, and every page read are real.
 */
export function fakeStagehand(stagehand: Stagehand, page: Page, spec: ActionSpec): Stagehand {
  return {
    browser: stagehand.browser,
    act: async () => {
      const loc = page.locator(spec.selector);
      if (spec.method === "fill") await loc.fill(spec.args?.[0] ?? "");
      else if (spec.method === "type") await loc.type(spec.args?.[0] ?? "");
      else if (spec.method === "selectOption") await loc.selectOption(spec.args?.[0] ?? "");
      else if (!spec.method || spec.method === "click") await loc.click();
      return {
        data: {
          success: spec.success ?? true,
          message: spec.message ?? "",
          actionDescription: spec.selector,
          actions: [{ selector: spec.selector, description: "", method: spec.method ?? "click", arguments: spec.args ?? [] }],
        },
        metadata: {},
      };
    },
    extract: ((...a: unknown[]) => (stagehand.extract as (...x: unknown[]) => unknown)(...a)) as Stagehand["extract"],
    observe: ((...a: unknown[]) => (stagehand.observe as (...x: unknown[]) => unknown)(...a)) as Stagehand["observe"],
  } as unknown as Stagehand;
}
