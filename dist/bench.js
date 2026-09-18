export const DEFAULT_THRESHOLDS = {
    marketMinRate: 0.05,
    marketMinEvents: 3,
    marketMinN: 30,
    missMaxRate: 0.05,
    missZeroN: 20,
    missRateN: 40,
    cryWolfMaxRate: 0.02,
    cryWolfZeroN: 60,
    cryWolfRateN: 100,
};
/** Wilson score interval for a binomial proportion. Chosen over the normal
 *  approximation because the rates sit near 0 and n is small; n===0 is p 0 on
 *  [0,1] with no divide-by-zero. */
export function wilson(x, n, z = 1.96) {
    if (n === 0)
        return { x: 0, n: 0, p: 0, lo: 0, hi: 1 };
    const p = x / n;
    const z2 = z * z;
    const d = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / d;
    const half = (z / d) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return { x, n, p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}
const claimOf = (r, kind) => kind === "exec" ? r.claimExec : r.claimBelief;
function sliceOf(runs, kind) {
    const known = runs.filter((r) => claimOf(r, kind) !== null);
    const claimed = known.filter((r) => claimOf(r, kind) === true);
    const silent = claimed.filter((r) => !r.oracleLanded); // claim=success ∧ oracle=fail
    const matrix = [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
    ].map(([claim, oracle]) => ({
        claim,
        oracle,
        n: known.filter((r) => (claimOf(r, kind) === true) === claim && r.oracleLanded === oracle).length,
    }));
    return {
        falseSuccess: wilson(silent.length, claimed.length),
        miss: wilson(silent.filter((r) => r.verdict === "landed").length, silent.length),
        caught: wilson(silent.filter((r) => r.verdict !== "landed").length, silent.length),
        matrix,
    };
}
function modelReport(runs) {
    const landed = runs.filter((r) => r.oracleLanded);
    return {
        exec: sliceOf(runs, "exec"),
        belief: sliceOf(runs, "belief"),
        falseAccusation: wilson(landed.filter((r) => r.verdict === "did-not-land").length, landed.length),
        underConfidence: wilson(landed.filter((r) => r.verdict === "inconclusive").length, landed.length),
        usd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
        n: runs.length,
    };
}
const byModel = (runs) => {
    const m = {};
    for (const r of runs)
        (m[r.model] ??= []).push(r);
    return m;
};
/** Gate A — the market exists. Passes if at least one rung (the weakest, i.e.
 *  any that clears the bar) has enough belief-claimed silent failures. A frontier
 *  at ~0 does not fail this gate; the long tail is the market. */
function marketGate(groups, t) {
    const readable = Object.values(groups).filter((g) => g.belief.falseSuccess.n >= t.marketMinN);
    if (readable.length === 0)
        return { pass: null, detail: "insufficient-n" };
    const winner = Object.entries(groups).find(([, g]) => g.belief.falseSuccess.n >= t.marketMinN &&
        g.belief.falseSuccess.x >= t.marketMinEvents &&
        g.belief.falseSuccess.p >= t.marketMinRate);
    return winner
        ? { pass: true, detail: `${winner[0]}: belief false-success ${(winner[1].belief.falseSuccess.p * 100).toFixed(1)}% (${winner[1].belief.falseSuccess.x}/${winner[1].belief.falseSuccess.n})` }
        : { pass: false, detail: `no rung reaches ${(t.marketMinRate * 100).toFixed(0)}% with ≥${t.marketMinEvents} events over ≥${t.marketMinN} writes` };
}
/** Gate B — the instrument works, pooled over the rungs that cleared Gate A's
 *  per-rung market bar. Point estimates over count floors: an interval-based gate
 *  cannot pass at MVP n (docs/DAY6.md §6). */
function instrumentGate(runs, groups, t) {
    const marketModels = new Set(Object.entries(groups)
        .filter(([, g]) => g.belief.falseSuccess.n >= t.marketMinN && g.belief.falseSuccess.x >= t.marketMinEvents && g.belief.falseSuccess.p >= t.marketMinRate)
        .map(([m]) => m));
    const pool = runs.filter((r) => marketModels.has(r.model));
    const silent = pool.filter((r) => r.claimBelief === true && !r.oracleLanded);
    const landed = pool.filter((r) => r.oracleLanded);
    const missX = silent.filter((r) => r.verdict === "landed").length;
    const wolfX = landed.filter((r) => r.verdict === "did-not-land").length;
    if (silent.length < t.missZeroN || landed.length < t.cryWolfZeroN)
        return { pass: null, detail: "insufficient-n" };
    const missPass = missX === 0 || (silent.length >= t.missRateN && missX / silent.length <= t.missMaxRate);
    const wolfPass = wolfX === 0 || (landed.length >= t.cryWolfRateN && wolfX / landed.length <= t.cryWolfMaxRate);
    const detail = `miss ${missX}/${silent.length}, cry-wolf ${wolfX}/${landed.length}`;
    return { pass: missPass && wolfPass, detail };
}
export function score(runs, opts = {}) {
    const t = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    const groups = byModel(runs);
    const byModelReport = {};
    for (const [m, rs] of Object.entries(groups))
        byModelReport[m] = modelReport(rs);
    const overallBase = modelReport(runs);
    const marketExists = marketGate(byModelReport, t);
    const instrumentWorks = instrumentGate(runs, byModelReport, t);
    return {
        byModel: byModelReport,
        overall: overallBase,
        gates: { marketExists, instrumentWorks, publish: marketExists.pass === true && instrumentWorks.pass === true },
    };
}
