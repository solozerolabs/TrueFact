// Day 5 — grounding (the bonus check). After an `extract`, does each returned
// value actually appear on the page? Deterministic, no LLM. Emits landed or
// inconclusive only: absence from the a11y tree is an inference from absence
// (the tree drops title attrs / hidden nodes, and the page moves between
// snapshots), never a mechanism, so grounding never says did-not-land. The one
// error it can make is a false `landed`, so the match is strict on that side:
// >=3-char whole-value strings, numbers on digit-token boundaries. See docs/DAY5.md.
import { treeText } from "./postcondition.js";
const MAX_LEAVES = 50;
const isNumericStr = (s) => /\d/.test(s) && /^[\s\d.,:/%$€£₹+-]+$/.test(s);
const numCore = (s) => s.replace(/,/g, "").replace(/^[^\d]+/, "").replace(/[^\d]+$/, "");
/** A number grounds only as a whole digit token: left boundary not a digit or
 *  '.', right boundary not a digit — so 49 does not match $1,249.00, but 1249
 *  and 1249.00 do. ponytail: date sub-parts (16 in 2026-09-16) can match; the
 *  value is genuinely on the page, and a false inconclusive is the safe side. */
function groundNumber(raw, blobNoCommas) {
    const v = numCore(raw);
    if (!v)
        return false;
    for (let from = 0;;) {
        const i = blobNoCommas.indexOf(v, from);
        if (i === -1)
            return false;
        const l = blobNoCommas[i - 1] ?? " ";
        const r = blobNoCommas[i + v.length] ?? " ";
        if (!/\d/.test(l) && l !== "." && !/\d/.test(r))
            return true;
        from = i + 1;
    }
}
/** Every primitive leaf, recursing objects and arrays. Non-groundable leaves
 *  (boolean, null, undefined) are yielded too so the caller counts them as
 *  skipped rather than dropping them silently. */
function* leaves(data) {
    if (Array.isArray(data)) {
        for (const x of data)
            yield* leaves(x);
    }
    else if (data !== null && typeof data === "object") {
        for (const v of Object.values(data))
            yield* leaves(v);
    }
    else {
        yield data;
    }
}
/** Pure: match each groundable leaf of `data` against the a11y tree. `tree` is
 *  the normalized (node-id/indent-stripped) formattedTree lines. */
export function groundValues(data, tree) {
    // One text blob: role-stripped line text joined with a space. Values split
    // across inline markup (Total: <strong>$1,249.00</strong>) live on separate
    // StaticText lines, so a per-line match misses them — the blob does not.
    const blob = tree.map(treeText).filter(Boolean).join(" ");
    const blobLower = blob.toLowerCase();
    const blobNoCommas = blob.replace(/,/g, "");
    const values = [];
    let skipped = 0;
    for (const leaf of leaves(data)) {
        if (values.length >= MAX_LEAVES) {
            skipped++;
            continue;
        }
        if (typeof leaf === "number") {
            const raw = String(leaf);
            values.push({ value: raw, match: groundNumber(raw, blobNoCommas) ? "exact" : "absent" });
            continue;
        }
        if (typeof leaf !== "string") {
            skipped++; // boolean, null, undefined, bigint, symbol: not groundable
            continue;
        }
        if (isNumericStr(leaf)) {
            values.push({ value: leaf.trim(), match: groundNumber(leaf, blobNoCommas) ? "exact" : "absent" });
            continue;
        }
        const t = leaf.trim();
        if (t.length < 3 || t.length > 120) {
            skipped++;
            continue;
        }
        const match = blob.includes(t)
            ? "exact"
            : blobLower.includes(t.replace(/\s+/g, " ").toLowerCase())
                ? "normalized"
                : "absent";
        values.push({ value: t, match });
    }
    if (values.length === 0) {
        return { verdict: "inconclusive", reason: "nothing-to-ground", confidence: "heuristic", values, skipped };
    }
    if (values.some((v) => v.match === "absent")) {
        return { verdict: "inconclusive", reason: "ungrounded", confidence: "heuristic", values, skipped };
    }
    const confidence = values.every((v) => v.match === "exact") ? "high" : "heuristic";
    return { verdict: "landed", reason: "grounded", confidence, values, skipped };
}
