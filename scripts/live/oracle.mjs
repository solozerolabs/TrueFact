// The live oracle — independent ground truth for a real-site trial, NEVER the
// agent's claim and NEVER TrueFact's own verdict. It is also never passed to
// withTrueFact as an `expect` declaration: that would feed the verdict it grades
// (circular). The runner calls it out of band, exactly as the fixture bench reads
// GET /truth out of band. See strategy/spec-real-site-2026-09-18.md §2.2.
//
// Three kinds:
//   { kind: "injected" }                      truth = did-not-land, VALID iff the
//                                             injector confirmed it paused the write
//                                             (the write never left the browser, so
//                                             non-persistence is true by construction).
//   { kind: "contract", landed }              an endpoint whose outcome is its
//                                             documented contract (httpbin /status/402
//                                             ⇒ false; /post ⇒ true).
//   { kind: "get", url, landedIf, headers? }  read the site's own state twice, T apart,
//                                             in a fresh context; agree or "unknown".
//
// `decide`/`evalGet` are PURE (fed captured reads) so they unit-test with no
// network; `truthOf` is the thin impure wrapper that does the two GETs.

const matches = (m, s) => (m instanceof RegExp ? m.test(s) : String(s).includes(m));

/** Did this single read show the write as landed? true | false | "unknown". */
export function evalGet(landedIf, res) {
  if (!res) return "unknown"; // unreadable / unreachable — never guess
  let ok = true;
  if (landedIf.status !== undefined) ok = res.status === landedIf.status;
  if (ok && landedIf.text !== undefined) ok = matches(landedIf.text, res.text ?? ""); // sentinel present ⇒ landed
  return ok;
}

/** Pure decision. `reads` supplies what the impure layer gathered:
 *  { injectorConfirmed?, get?: [readA, readB] } where a read is {status,text}|null. */
export function decide(oracle, reads = {}) {
  switch (oracle.kind) {
    case "injected":
      return reads.injectorConfirmed ? false : "unknown"; // unconfirmed ⇒ we don't actually know
    case "contract":
      return oracle.landed === true;
    case "get": {
      const [a, b] = reads.get ?? [null, null];
      const ea = evalGet(oracle.landedIf, a);
      const eb = evalGet(oracle.landedIf, b);
      if (ea === "unknown" || eb === "unknown" || ea !== eb) return "unknown"; // disagreement ⇒ eventual consistency / cache
      return ea;
    }
    default:
      throw new Error(`oracle: unknown kind ${JSON.stringify(oracle.kind)}`);
  }
}

async function readOnce(oracle) {
  try {
    const res = await fetch(oracle.url, { headers: { "cache-control": "no-store", ...(oracle.headers ?? {}) }, signal: AbortSignal.timeout(5000) });
    return { status: res.status, text: await res.text() };
  } catch {
    return null; // unreachable / timeout
  }
}

/** Resolve ground truth. ctx = { injectorConfirmed }. Reads twice for `get`
 *  (settle window between them is the caller's pause before this returns). */
export async function truthOf(oracle, ctx = {}) {
  if (oracle.kind !== "get") return decide(oracle, { injectorConfirmed: ctx.injectorConfirmed });
  const a = await readOnce(oracle);
  await new Promise((r) => setTimeout(r, oracle.settleMs ?? 600));
  const b = await readOnce(oracle);
  return decide(oracle, { get: [a, b] });
}
