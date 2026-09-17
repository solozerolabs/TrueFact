// Shared test infrastructure. Fixtures that navigate, redirect, open tabs, or
// need an HTTP status must be served over http:// — Chrome refuses script
// navigation to data: URLs and a data: tab never reports a URL. A locator
// action also costs ~1 s on a data: page vs ~9 ms over HTTP, so everything
// integration-level goes through serve().
import { createServer, type Server } from "node:http";
import { Stagehand, localBrowser, type Page } from "@browserbasehq/stagehand";
import type { PageState, FormValue } from "../src/postcondition.js";
import type { SessionEvidence } from "../src/session.js";
import type { Step } from "../src/index.js";

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
        server.closeAllConnections?.(); // a tab left on a fixture holds a keep-alive socket
        server.close(() => resolve());
      }),
  };
}

/** One headless Chrome + model-less Stagehand per test file, lazily. */
export function withBrowser() {
  let browser: Awaited<ReturnType<typeof localBrowser.launch>> | null = null;
  let stagehand: Stagehand | null = null;
  return {
    async start(): Promise<Stagehand> {
      if (!stagehand) {
        browser = await localBrowser.launch({ headless: true });
        stagehand = await Stagehand.create({ browser, logging: { level: "error" } });
      }
      return stagehand;
    },
    async page(): Promise<Page> {
      const sh = await this.start();
      return (await sh.browser.context.activePage())!; // fresh wrapper each call; always the live tab
    },
    async stop(): Promise<void> {
      await browser?.close(); // close the browser BEFORE any fixture server
      browser = null;
      stagehand = null;
    },
  };
}

/** Build a PageState for pure unit tests. `state({ href })` is the common case. */
export function state(over: Partial<PageState> & { href?: string } = {}): PageState {
  const { href, ...rest } = over;
  return {
    fp: { href: href ?? "http://x/a", readyState: "complete", bodyTextLength: 0, elementCount: 0, title: "" },
    tree: [],
    forms: {},
    userInvalidCount: 0,
    activeField: null,
    pageId: "",
    ...rest,
  };
}

export const form = (value: string, over: Partial<FormValue> = {}): FormValue => ({ value, userInvalid: false, ...over });

export const session = (over: Partial<SessionEvidence> = {}): SessionEvidence => ({
  obstruction: null,
  confidence: "high",
  detail: "",
  checked: ["blank", "captcha", "login-wall", "overlay"],
  ...over,
});

export const step = (over: Partial<Step> = {}): Step => ({
  kind: "write",
  action: "act: x",
  declaration: "auto",
  verdict: "inconclusive",
  evidence: { before: null, after: null, settled: true, session: session() },
  attempt: null,
  agent_claim: null,
  cost: null,
  timestamp: "",
  ...over,
});

export interface ActionSpec {
  selector: string; // where the fake actually performs the action
  reportSelector?: string; // what it REPORTS in actions[] (simulates a stale xpath after a re-render)
  method?: string;
  args?: string[];
}

export interface FakeSpec {
  actions: ActionSpec[]; // performed in order, all reported
  success?: boolean;
  message?: string;
  usage?: Record<string, number>; // Stagehand result metadata.usage, for cost tests
  extract?: unknown; // if present, fake extract returns { data: extract } (grounding tests)
}

/**
 * A duck-typed Stagehand whose `act` performs REAL locator actions on the page
 * and returns an ActResult-shaped result. The only fake is the LLM; the browser,
 * the clicks/fills, and every page read are real.
 */
export function fakeStagehand(stagehand: Stagehand, page: Page, spec: ActionSpec | FakeSpec): Stagehand {
  const fs: FakeSpec = "actions" in spec ? spec : { actions: [spec] };
  return {
    browser: stagehand.browser,
    act: async () => {
      for (const a of fs.actions) {
        const loc = page.locator(a.selector);
        if (a.method === "fill") await loc.fill(a.args?.[0] ?? "");
        else if (a.method === "type") await loc.type(a.args?.[0] ?? "");
        else if (a.method === "selectOption") await loc.selectOption(a.args?.[0] ?? "");
        else if (!a.method || a.method === "click") await loc.click();
      }
      return {
        data: {
          success: fs.success ?? true,
          message: fs.message ?? "",
          actionDescription: fs.actions.map((a) => a.selector).join(","),
          actions: fs.actions.map((a) => ({ selector: a.reportSelector ?? a.selector, description: "", method: a.method ?? "click", arguments: a.args ?? [] })),
        },
        metadata: fs.usage ? { usage: fs.usage } : {},
      };
    },
    // Only the LLM is faked: extract returns the configured data, the browser is real.
    extract: (async () => ({ data: fs.extract, metadata: fs.usage ? { usage: fs.usage } : {} })) as unknown as Stagehand["extract"],
    observe: (async () => []) as unknown as Stagehand["observe"],
  } as unknown as Stagehand;
}
