// The failure injector — manufactures a KNOWN did-not-land on a real site with
// zero server-side effect, so the campaign has real failures to score against
// (the denominator the whole metric needs). Probed in scripts/probe-inject.mjs.
//
// Design invariants (strategy/spec-real-site-2026-09-18.md §2.1, C5/C7):
//   - It runs on its OWN CdpConn, never the sidecar's: CDP `Fetch` is single-owner
//     per session, and netwatch has no requestPaused handler, so enabling Fetch on
//     the sidecar's connection would hang the page. `arm(conn, …)` takes the conn so
//     the caller owns the second client (the runner opens cdpConnect(port), tests too).
//   - Truth is by construction: a Request-stage intercept kills the write inside the
//     browser — it never reaches the server. `confirmed()` reports whether the write
//     actually paused; an unconfirmed trial is discarded, never scored (a pattern miss,
//     or client-side validation blocked the request before it fired).
//   - Only MUTATING methods are failed; reads and telemetry pass through untouched.
//
// Modes: "status:<code>" (fulfill 4xx/5xx) · "wire" (failRequest, a dropped write) ·
//        "body-lie" (fulfill 200 + a GraphQL-style errors[] — the 200-that-lies).
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const b64 = (s) => Buffer.from(s).toString("base64");

/**
 * Arm `conn` to fail the first mutating request matching `urlPattern`.
 * Returns { confirmed(), paused(), disarm() }. Stays armed until disarm() so a
 * page-level retry dies too. Does not close `conn` — the caller owns it.
 */
export async function arm(conn, { urlPattern, mode }) {
  let paused = 0;
  conn.on("Fetch.requestPaused", (p) => {
    const requestId = p.requestId;
    const method = String(p.request?.method ?? "GET").toUpperCase();
    if (!MUTATING.has(method)) return void conn.cmd("Fetch.continueRequest", { requestId });
    paused++;
    if (mode === "wire") return void conn.cmd("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" });
    if (mode === "body-lie")
      return void conn.cmd("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: b64('{"errors":[{"message":"rejected by measurement harness"}]}'),
      });
    const code = Number(String(mode).split(":")[1] || 500); // status:<code>
    return void conn.cmd("Fetch.fulfillRequest", { requestId, responseCode: code, body: b64("blocked by measurement harness") });
  });
  await conn.cmd("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
  return {
    paused: () => paused,
    confirmed: () => paused > 0,
    async disarm() {
      try {
        await conn.cmd("Fetch.disable");
      } catch {
        /* best-effort */
      }
    },
  };
}
