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
