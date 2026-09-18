// Regression: pendingWrites must scope to the CURRENT action's in-flight writes,
// not a straggler from a prior step. `sinceSeq` is the last seq at the action's
// start, so scoping is `> sinceSeq`. A `>=` off-by-one counts the previous step's
// hung write against this action and false-DEMOTES a genuinely-landed verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trackWrites, type WriteOutcome } from "../src/netwatch.js";

// Minimal CdpConn: capture handlers, replay events. cmd/close are unused here.
function fakeConn() {
  const handlers = new Map<string, ((p: Record<string, unknown>, s?: string) => void)[]>();
  return {
    conn: {
      cmd: async () => undefined,
      on: (m: string, h: (p: Record<string, unknown>, s?: string) => void) =>
        void (handlers.get(m) ?? handlers.set(m, []).get(m)!).push(h),
      close: () => {},
    },
    fire: (m: string, p: Record<string, unknown>) => (handlers.get(m) ?? []).forEach((h) => h(p)),
  };
}

test("pendingWrites excludes a prior step's straggler at seq===markSeq", () => {
  const { conn, fire } = fakeConn();
  const tracker = trackWrites(conn, { onOutcome: (_o: WriteOutcome) => {} });
  const all = () => true;

  // Step A fires a mutating POST that never answers (optimistic ✅, wire hung).
  fire("Network.requestWillBeSent", { requestId: "a", request: { url: "https://x/a", method: "POST" } });

  // Step B starts here — mark captures the last seq (A's request).
  const markSeq = tracker.seq();
  // Step B fires its own POST, which cleanly resolves (200) → drops out of pending.
  fire("Network.requestWillBeSent", { requestId: "b", request: { url: "https://x/b", method: "POST" } });
  fire("Network.responseReceived", { requestId: "b", response: { status: 200 } });

  // Only A is still in flight, and A belongs to the PRIOR step (seq === markSeq).
  // It must NOT be counted against B — B landed clean.
  assert.equal(tracker.pendingWrites(markSeq, all), 0);

  // Sanity: B's own in-flight write IS counted before it resolves.
  fire("Network.requestWillBeSent", { requestId: "c", request: { url: "https://x/c", method: "POST" } });
  assert.equal(tracker.pendingWrites(markSeq, all), 1);
});
