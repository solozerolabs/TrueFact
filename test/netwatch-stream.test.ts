// The cross-origin fire-and-forget body read (EXPERIMENT-SITES Run #5). A real
// remote 2xx whose body the page never consumes emits `Network.responseReceived`
// but NEVER `Network.loadingFinished`, and `Network.getResponseBody` returns empty
// (the stream was never drained). The fix: when bodyErrors is on, drain the body
// with `Network.streamResourceContent` (proved in strategy/probes/probe-stream.mjs)
// and evaluate it at settle. These tests encode that exact CDP signature with a
// mock conn — hermetic and deterministic (the real trigger is HTTP/2 network
// timing, which a local instant-response server cannot reproduce).
import { test } from "node:test";
import assert from "node:assert/strict";
import { trackWrites, type WriteOutcome } from "../src/netwatch.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

// A mock CdpConn: fire events, stub cmd replies per method.
function mockConn(cmds: Record<string, (params: Record<string, unknown>) => unknown>) {
  const handlers: Record<string, ((p: Record<string, unknown>, sid?: string) => void)[]> = {};
  return {
    conn: {
      cmd: async (method: string, params?: Record<string, unknown>) => cmds[method]?.(params ?? {}),
      on: (m: string, h: (p: Record<string, unknown>, sid?: string) => void) => void (handlers[m] ??= []).push(h),
      close: () => {},
    },
    fire: (m: string, p: Record<string, unknown>, sid?: string) => (handlers[m] ?? []).forEach((h) => h(p, sid)),
  };
}

const post = (id: string) => ({ requestId: id, request: { url: "https://api.example/gql", method: "POST" } });

test("streamResourceContent catches a 2xx-with-errors that never emits loadingFinished", async () => {
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    // The undrained cross-origin body is empty via getResponseBody...
    "Network.getResponseBody": () => ({ body: "", base64Encoded: false }),
    // ...but streamResourceContent actively drains it.
    "Network.streamResourceContent": () => ({ bufferedData: b64('{"errors":[{"message":"rejected"}]}') }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  // No loadingFinished — the fire-and-forget cross-origin case.
  await t.settle();
  assert.equal(outcomes.length, 1, "an outcome must be emitted at settle");
  assert.equal(outcomes[0].bodyError, true, "the streamed errors body → bodyError");
  assert.equal(outcomes[0].status, 200);
});

test("a streamed clean 2xx never emits loadingFinished stays landed (no false demote)", async () => {
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    "Network.getResponseBody": () => ({ body: "", base64Encoded: false }),
    "Network.streamResourceContent": () => ({ bufferedData: b64('{"data":{"ok":true}}') }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  await t.settle();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].bodyError, false, "a clean streamed body must not demote");
});

test("streamed body accumulates across Network.dataReceived chunks", async () => {
  // CDP wire order: streamResourceContent returns bufferedData (the prefix received
  // before streaming was enabled) first, then dataReceived-with-data carries the
  // rest. Here the body arrives entirely as two streamed chunks (empty buffer).
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    "Network.getResponseBody": () => ({ body: "" }),
    "Network.streamResourceContent": () => ({ bufferedData: "" }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  fire("Network.dataReceived", { requestId: "1", data: b64('{"err') });
  fire("Network.dataReceived", { requestId: "1", data: b64('ors":[{"m":1}]}') });
  await t.settle();
  assert.equal(outcomes[0].bodyError, true, "chunks must be concatenated before matching");
});

test("regression: a finishing 2xx-with-errors is still caught via the existing path", async () => {
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    "Network.getResponseBody": () => ({ body: '{"errors":[{"message":"x"}]}', base64Encoded: false }),
    "Network.streamResourceContent": () => ({ bufferedData: "" }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  fire("Network.loadingFinished", { requestId: "1" });
  await t.settle();
  assert.equal(outcomes.length, 1, "no double-emit between the finished-body and stream paths");
  assert.equal(outcomes[0].bodyError, true);
});

test("2xx-with-errors whose body load is CANCELED (loadingFailed after 2xx) is still caught", async () => {
  // A cross-origin 200 {errors:[…]} whose body load is aborted by a navigation
  // fires loadingFailed AFTER the 2xx. The 2xx-then-cancel guard must keep the
  // accepted status (never cry-wolf), but the errors already streamed must still
  // demote — the emit must not discard the buffered body.
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    "Network.getResponseBody": () => ({ body: "" }),
    "Network.streamResourceContent": () => ({ bufferedData: b64('{"errors":[{"message":"rejected"}]}') }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  fire("Network.loadingFailed", { requestId: "1" });
  await t.settle();
  assert.equal(outcomes.length, 1, "exactly one outcome, no double-emit");
  assert.equal(outcomes[0].status, 200, "2xx-then-cancel keeps the accepted status, never null");
  assert.equal(outcomes[0].bodyError, true, "the streamed errors body must still demote");
});

test("clean 2xx whose body load is canceled stays landed (guard preserved)", async () => {
  const outcomes: WriteOutcome[] = [];
  const { conn, fire } = mockConn({
    "Network.getResponseBody": () => ({ body: "" }),
    "Network.streamResourceContent": () => ({ bufferedData: b64('{"data":{"ok":true}}') }),
  });
  const t = trackWrites(conn, { bodyErrors: true, onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  fire("Network.loadingFailed", { requestId: "1" });
  await t.settle();
  assert.equal(outcomes[0]?.bodyError, false, "a canceled clean body must not cry wolf");
});

test("bodyErrors off: no stream, no body read, a 2xx that never finishes just isn't an error", async () => {
  const outcomes: WriteOutcome[] = [];
  let streamed = false;
  const { conn, fire } = mockConn({ "Network.streamResourceContent": () => ((streamed = true), {}) });
  const t = trackWrites(conn, { onOutcome: (o) => outcomes.push(o) });
  fire("Network.requestWillBeSent", post("1"), "S1");
  fire("Network.responseReceived", { requestId: "1", response: { status: 200 } }, "S1");
  await t.settle();
  assert.equal(streamed, false, "no streaming work when bodyErrors is off");
  assert.equal(outcomes.length, 0, "a clean 2xx with no body check is simply not emitted as an error");
});
