// M3 — the assertion engine (offline re-assert). An assertion is a function over
// a BROWSER VIEW: what the world showed after a write, reconstructed from a
// recorded step. It never receives the agent's claim, so the two-channel rule
// (docs/DAY2) holds for callbacks exactly as it does for declared `expect`.
//
// The value: change an assertion, re-run it against a stored run (a `jsonl`
// from withTrueFact) with no browser and no model — see which historical steps
// now pass or fail. A flaky agent run becomes a deterministic, $0 unit test.
// See docs/SPEC-V2.md §4 / §5.1.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const pass = () => ({ ok: true });
export const fail = (message) => ({ ok: false, message });
/** Identity helper for types + a default-export a module can carry. */
export const defineAssertions = (a) => a;
/** A module's default export may be an Assertions object or a bare browser fn. */
export function toAssertions(mod) {
    const d = mod?.default ?? mod;
    if (typeof d === "function")
        return { browser: d };
    if (d && typeof d === "object" && "browser" in d)
        return d;
    throw new Error("TrueFact: assertion module must default-export a function or { browser } (see defineAssertions)");
}
/** Reconstruct a write step's browser view from its recorded evidence. */
export function viewOf(step) {
    const p = step.evidence.postcondition;
    if (step.kind !== "write" || !p)
        return null;
    return {
        action: step.action,
        url: step.evidence.after?.href ?? "",
        verdict: step.verdict,
        treeAdded: p.treeAdded ?? [],
        treeRemoved: p.treeRemoved ?? [],
        forms: p.formsAfter ?? {},
        network: p.network?.errors ?? [],
    };
}
/** Evaluate the assertion against every write step. Pure: no fs, no browser. */
export function reassert(steps, a) {
    const items = [];
    steps.forEach((s, i) => {
        const v = viewOf(s);
        if (!v || !a.browser)
            return;
        const r = a.browser(v);
        items.push({ index: i, action: s.action, ok: r.ok, message: r.message });
    });
    return { total: items.length, failed: items.filter((x) => !x.ok).length, items };
}
/** Read a `jsonl` run + an assertion module, and reassert. */
export async function reassertFile(jsonlPath, modulePath) {
    const steps = readFileSync(jsonlPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const mod = await import(pathToFileURL(resolve(modulePath)).href);
    return reassert(steps, toAssertions(mod));
}
