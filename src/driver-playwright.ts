// M7 Phase 2 — the second driver. Plays a Playwright Page into the same
// PageReader/Driver seam Stagehand uses, so the verdict engine is unchanged.
// Two honest differences from Stagehand (see docs/M7-PLAN.md Axis 1 + Axis 3):
//   1. Read source: Stagehand exposes no raw CDP, so its reader uses the native
//      formattedTree; Playwright DOES expose CDP (newCDPSession), so its reader
//      builds the a11y tree from Accessibility.getFullAXTree — normalized here
//      to the same `role: text [markers]` line grammar the classifier keys on.
//   2. No claim to disbelieve: a Playwright `act` performs the caller's own
//      action (a selector + method) and reports `actions` for field
//      verification, but carries no self-report — agent_claim degrades to null.
//
// Duck-typed on purpose: this file imports no Playwright package, so the library
// never forces the dependency on Stagehand users. The caller passes their own
// Playwright Page; only the surface we use is typed below.
import type { PageReader, Driver } from "./driver.js";

// --- the slice of Playwright's Page we touch --------------------------------
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
  goto(url: string, opts?: unknown): Promise<{ status(): number } | null>;
  screenshot(opts?: unknown): Promise<Uint8Array>;
  waitForLoadState(state: string, opts?: unknown): Promise<void>;
  context(): { newCDPSession(page: PwPage): Promise<PwCDPSession> };
}

// --- the a11y-tree normalizer (the one piece the dropped Phase 1 would have
//     shared). Pure: CDP AX nodes in, classifier line-grammar out. -----------
interface AxNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  properties?: { name: string; value?: { value?: unknown } }[];
}

// Structural noise the classifier does not key on. Dropped nodes still have
// their children spliced in place, so a `button` inside a `generic` survives.
const DROP = new Set(["none", "generic", "InlineTextBox", "RootWebArea"]);

/**
 * Flatten `Accessibility.getFullAXTree` nodes into the same normalized lines
 * `readTree` yields for Stagehand: `role`, or `role: name`, with `[checked]` /
 * `[selected]` appended from AX properties. The classifier needs before/after
 * self-consistency from one reader, not byte-parity with Stagehand, so this
 * reproduces the role signals (`status`/`alert`/`dialog`/`button`/…) and the
 * StaticText that carries confirmation/error text — which is all it reads.
 */
export function axToLines(nodes: AxNode[]): string[] {
  const byId = new Map<string, AxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const seen = new Set<string>(); // guard a malformed tree with a child cycle
  const out: string[] = [];
  const prop = (n: AxNode, k: string): unknown =>
    n.properties?.find((p) => p.name === k)?.value?.value;
  const visit = (n: AxNode): void => {
    if (seen.has(n.nodeId)) return;
    seen.add(n.nodeId);
    const role = n.role?.value ?? "";
    if (!n.ignored && role && !DROP.has(role)) {
      const name = String(n.name?.value ?? "").trim();
      let line = name ? `${role}: ${name}` : role;
      const checked = prop(n, "checked");
      if (checked === "true" || checked === "mixed") line += " [checked]";
      if (prop(n, "selected") === true) line += " [selected]";
      out.push(line);
    }
    for (const id of n.childIds ?? []) {
      const c = byId.get(id);
      if (c) visit(c);
    }
  };
  for (const n of nodes) if (!n.parentId || !byId.has(n.parentId)) visit(n);
  return out;
}

let nextId = 0;
const pageIds = new WeakMap<object, string>();
const idOf = (page: object): string => {
  let id = pageIds.get(page);
  if (!id) pageIds.set(page, (id = `pw-${nextId++}`));
  return id;
};

/** Adapt one Playwright Page to the PageReader surface. Its tree comes from
 *  CDP; every other read is Playwright-native. */
export function playwrightReader(page: PwPage): PageReader {
  let cdp: Promise<PwCDPSession> | null = null;
  const session = (): Promise<PwCDPSession> =>
    (cdp ??= page
      .context()
      .newCDPSession(page)
      .then(async (s) => {
        await s.send("Accessibility.enable");
        return s;
      }));
  return {
    id: idOf(page),
    async snapshotTree() {
      try {
        const res = (await (await session()).send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
        return axToLines(res.nodes);
      } catch {
        return null; // detached / mid-navigation — an empty read is safe
      }
    },
    evaluate: <T>(fn: (arg: unknown) => T, arg?: unknown) => page.evaluate(fn, arg) as Promise<T>,
    url: () => Promise.resolve(page.url()),
    count: (selector) => page.locator(selector).count(),
    screenshot: () => page.screenshot() as Promise<Uint8Array>,
    waitForLoadState: (state, timeoutMs) => page.waitForLoadState(state, { timeout: timeoutMs }),
  };
}

interface PwAction {
  selector: string;
  method?: string;
  arguments?: string[];
}

/**
 * Adapt a Playwright Page to the Driver surface. `act` takes an action object
 * (a selector + method) — Playwright has no natural-language executor, so we
 * drive the locator directly and report `actions` for field verification, with
 * no claim. `extract`/`observe` have no Playwright equivalent and throw a clear
 * error; use `tr.page` for reads. Single-page for now (ponytail: multi-tab
 * needs `context.on('page')`, the same gap sidecar.ts flags).
 */
export function playwrightDriver(page: PwPage): Driver {
  const perform = async (a: PwAction): Promise<void> => {
    const loc = page.locator(a.selector);
    const arg = a.arguments?.[0] ?? "";
    switch (a.method) {
      case "fill":
        return loc.fill(arg);
      case "type":
        return loc.pressSequentially(arg);
      case "selectOption":
      case "selectOptionFromDropdown":
        await loc.selectOption(arg);
        return;
      default:
        return loc.click(); // click / undefined
    }
  };
  const unsupported = (verb: string) => (): never => {
    throw new Error(`TrueReplay: the Playwright driver has no ${verb}() — use tr.page for reads`);
  };
  return {
    act: async (instruction) => {
      if (typeof instruction === "string" || !instruction || !("selector" in (instruction as object))) {
        throw new Error(
          "TrueReplay: the Playwright driver's act() needs an action object, e.g. " +
            `{ selector: "#go", method: "click" } or { selector: "#e", method: "fill", arguments: ["x"] }`,
        );
      }
      const a = instruction as PwAction;
      await perform(a);
      // actions drive field verification; no `success` key ⇒ agent_claim is null.
      return { data: { actions: [a] } } as never;
    },
    extract: unsupported("extract"),
    observe: unsupported("observe"),
    goto: (url, opts) => page.goto(url, opts),
    activePage: () => Promise.resolve(playwrightReader(page)),
    readerFor: (handle) => playwrightReader(handle as PwPage),
  };
}
