// cdpConnectFd — the fd transport used by `truefact serve --cdp-fd` (no debug
// port). A unix-socket pair stands in for the inherited socketpair Syndai's
// Python bridge passes: the peer answers CDP commands and pushes events exactly
// as the bridge's CDP pump does. Asserts id-correlated replies, event dispatch,
// and fail-open (an {x} error resolves to undefined, never throws).
import { createServer as createNet, connect, type Socket } from "node:net";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpConnectSocket, type CdpConn } from "../src/cdp.js";

describe("cdpConnectFd", () => {
  let server: ReturnType<typeof createNet>;
  let peer: Socket; // the fake CDP pump (bridge side)
  let conn: CdpConn;
  let peerBuf = "";
  const onCmd: ((m: { i: number; m: string; p: unknown }) => void)[] = [];

  before(async () => {
    const path = join(tmpdir(), `tf-cdpfd-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
    server = createNet();
    const gotPeer = new Promise<Socket>((res) => server.once("connection", res));
    await new Promise<void>((r) => server.listen(path, () => r()));
    const client = connect(path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    peer = await gotPeer;
    peer.on("data", (d) => {
      peerBuf += d.toString("utf8");
      let nl: number;
      while ((nl = peerBuf.indexOf("\n")) >= 0) {
        const line = peerBuf.slice(0, nl);
        peerBuf = peerBuf.slice(nl + 1);
        if (line) for (const h of onCmd) h(JSON.parse(line));
      }
    });
    conn = cdpConnectSocket(client); // cdpConnectFd wraps a fd into exactly this
  });

  after(() => {
    conn.close();
    peer.destroy();
    server.close();
  });

  it("id-correlates a command with its result", async () => {
    onCmd.push((m) => {
      if (m.m === "Runtime.evaluate") peer.write(JSON.stringify({ i: m.i, r: { result: { value: "ok" } } }) + "\n");
    });
    const r = (await conn.cmd("Runtime.evaluate", { expression: "1" })) as { result: { value: string } };
    assert.equal(r.result.value, "ok");
  });

  it("dispatches a pushed event to on() handlers", async () => {
    const seen: Record<string, unknown>[] = [];
    conn.on("Network.responseReceived", (p) => seen.push(p));
    peer.write(JSON.stringify({ e: "Network.responseReceived", p: { requestId: "1", response: { status: 500 } } }) + "\n");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 1);
    assert.equal((seen[0].response as { status: number }).status, 500);
  });

  it("fail-open: an error frame resolves to undefined, never throws", async () => {
    onCmd.push((m) => {
      if (m.m === "Broken.method") peer.write(JSON.stringify({ i: m.i, x: "no such domain" }) + "\n");
    });
    const r = await conn.cmd("Broken.method");
    assert.equal(r, undefined);
  });
});

// §A9 — observer liveness on the fd transport (docs/OBSERVER-PLAN.md §3,
// "Connection: CdpConn.lost()"). A dead peer is a dead observer: `lost()` is
// sticky with the first reason, `onLost` fires once with it, and a command on a
// lost conn resolves undefined AT ONCE — never after CMD_TIMEOUT_MS, which today
// stretches one dead read to 10 s and a dead step past a minute. Coordinator
// decision 2026-09-23: our own `close()` ALSO sets lost() (no intentional-close
// exemption — a close can never happen inside a bracket on the healthy path).
describe("cdpConnectSocket: observer liveness (lost / onLost)", () => {
  type LiveConn = CdpConn & { lost(): string | null; onLost(cb: (reason: string) => void): void };

  async function pair(): Promise<{ conn: LiveConn; client: Socket; peer: Socket; server: ReturnType<typeof createNet> }> {
    const path = join(tmpdir(), `tf-cdplost-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
    const server = createNet();
    const gotPeer = new Promise<Socket>((res) => server.once("connection", res));
    await new Promise<void>((r) => server.listen(path, () => r()));
    const client = connect(path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const peer = await gotPeer;
    return { conn: cdpConnectSocket(client) as LiveConn, client, peer, server };
  }
  const closed = (s: Socket) => (s.destroyed ? Promise.resolve() : new Promise<void>((r) => s.once("close", () => r())));

  it("given the peer socket closed, when lost() is read, then it is \"socket-closed\" and a subsequent cmd() resolves undefined immediately (< 100 ms, not CMD_TIMEOUT)", async () => {
    const { conn, client, peer, server } = await pair();
    try {
      assert.equal(conn.lost(), null, "a live conn is not lost");
      peer.destroy();
      await closed(client);
      assert.equal(conn.lost(), "socket-closed");
      const t = Date.now();
      const r = await conn.cmd("Runtime.evaluate", { expression: "1" });
      const ms = Date.now() - t;
      assert.equal(r, undefined);
      assert.ok(ms < 100, `cmd on a lost conn took ${ms}ms — it must short-circuit, not wait CMD_TIMEOUT_MS`);
    } finally {
      conn.close();
      server.close();
    }
  });

  it("given the conn's own close() was called, then lost() is \"socket-closed\" too and cmd() resolves undefined at once (no intentional-close exemption)", async () => {
    const { conn, client, peer, server } = await pair();
    try {
      conn.close();
      await closed(client);
      assert.equal(conn.lost(), "socket-closed");
      const t = Date.now();
      assert.equal(await conn.cmd("Runtime.evaluate", { expression: "1" }), undefined);
      assert.ok(Date.now() - t < 100);
    } finally {
      peer.destroy();
      server.close();
    }
  });

  it("given an onLost callback, when the peer goes away, then it fires exactly once with the same reason lost() reports", async () => {
    const { conn, client, peer, server } = await pair();
    try {
      const seen: string[] = [];
      conn.onLost((reason) => seen.push(reason));
      peer.destroy();
      await closed(client);
      await new Promise((r) => setTimeout(r, 20)); // 'error' + 'close' both fire on some paths; must not double-report
      assert.deepEqual(seen, ["socket-closed"]);
      assert.equal(conn.lost(), seen[0]);
    } finally {
      conn.close();
      server.close();
    }
  });
});
