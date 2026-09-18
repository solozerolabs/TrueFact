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
export function axToLines(nodes) {
    const byId = new Map();
    for (const n of nodes)
        byId.set(n.nodeId, n);
    const seen = new Set(); // guard a malformed tree with a child cycle
    const out = [];
    const prop = (n, k) => n.properties?.find((p) => p.name === k)?.value?.value;
    const visit = (n) => {
        if (seen.has(n.nodeId))
            return;
        seen.add(n.nodeId);
        const role = n.role?.value ?? "";
        if (!n.ignored && role && !DROP.has(role)) {
            const name = String(n.name?.value ?? "").trim();
            let line = name ? `${role}: ${name}` : role;
            const checked = prop(n, "checked");
            if (checked === "true" || checked === "mixed")
                line += " [checked]";
            if (prop(n, "selected") === true)
                line += " [selected]";
            out.push(line);
        }
        for (const id of n.childIds ?? []) {
            const c = byId.get(id);
            if (c)
                visit(c);
        }
    };
    for (const n of nodes)
        if (!n.parentId || !byId.has(n.parentId))
            visit(n);
    return out;
}
let nextId = 0;
const pageIds = new WeakMap();
const idOf = (page) => {
    let id = pageIds.get(page);
    if (!id)
        pageIds.set(page, (id = `pw-${nextId++}`));
    return id;
};
// One reader per Page, reused. driver.activePage() is called several times per
// step; a fresh reader each time would open (and leak) a new CDP session with
// Accessibility.enable on every read.
const readers = new WeakMap();
/** Adapt one Playwright Page to the PageReader surface. Its tree comes from
 *  CDP; every other read is Playwright-native. Memoized per page. */
export function playwrightReader(page) {
    const cached = readers.get(page);
    if (cached)
        return cached;
    let cdp = null;
    const session = () => (cdp ??= page
        .context()
        .newCDPSession(page)
        .then(async (s) => {
        await s.send("Accessibility.enable");
        return s;
    }));
    const reader = {
        id: idOf(page),
        async snapshotTree() {
            try {
                const res = (await (await session()).send("Accessibility.getFullAXTree"));
                return axToLines(res.nodes);
            }
            catch {
                return null; // detached / mid-navigation — an empty read is safe
            }
        },
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        url: () => Promise.resolve(page.url()),
        count: (selector) => page.locator(selector).count(),
        screenshot: () => page.screenshot(),
        waitForLoadState: (state, timeoutMs) => page.waitForLoadState(state, { timeout: timeoutMs }),
    };
    readers.set(page, reader);
    return reader;
}
/**
 * Adapt a Playwright Page to the Driver surface. `act` takes an action object
 * (a selector + method) — Playwright has no natural-language executor, so we
 * drive the locator directly and report `actions` for field verification, with
 * no claim. `extract`/`observe` have no Playwright equivalent and throw a clear
 * error; use `tr.page` for reads. Single-page for now (ponytail: multi-tab
 * needs `context.on('page')`, the same gap sidecar.ts flags).
 */
export function playwrightDriver(page) {
    const perform = async (a) => {
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
    const unsupported = (verb) => () => {
        throw new Error(`TrueFact: the Playwright driver has no ${verb}() — use tr.page for reads`);
    };
    return {
        act: async (instruction) => {
            if (typeof instruction === "string" || !instruction || !("selector" in instruction)) {
                throw new Error("TrueFact: the Playwright driver's act() needs an action object, e.g. " +
                    `{ selector: "#go", method: "click" } or { selector: "#e", method: "fill", arguments: ["x"] }`);
            }
            const a = instruction;
            await perform(a);
            // actions drive field verification; no `success` key ⇒ agent_claim is null.
            return { data: { actions: [a] } };
        },
        extract: unsupported("extract"),
        observe: unsupported("observe"),
        goto: (url, opts) => page.goto(url, opts),
        activePage: () => Promise.resolve(playwrightReader(page)),
        readerFor: (handle) => playwrightReader(handle),
    };
}
