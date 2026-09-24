// `truefact serve` + the CDP driver — hermetic, keyless. A playwright-core
// Chromium is launched with --remote-debugging-port (the caller-owns-the-browser
// shape Syndai's Python patchright bridge uses); the test performs the actions
// itself via Playwright, exactly as an external client would, and only the
// before/after bracket goes through serve. Asserts: a click that lands
// (role=status confirmation) reads landed; a submit whose POST 500s reads
// did-not-land via the network sidecar even though the page shows ✅; a fill is
// field-verified; the chain verifies; a second `before` while parked is refused.
import { createServer, type Server } from "node:http";
import { createServer as createNet, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve as resolvePath } from "node:path";
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServe, type ServeSession } from "../src/serve.js";
import { verifyChain } from "../src/chain.js";
import type { Step } from "../src/index.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNet();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const page = (body: string) => `<!doctype html><meta charset=utf8><title>t</title>${body}`;

describe("truefact serve: DOM+network bracket over raw CDP for a caller-owned browser", () => {
  let browser: { newContext(): Promise<{ newPage(): Promise<PwPage> }>; close(): Promise<void> };
  let pw: PwPage;
  let app: Server;
  let base = "";
  let port = 0;
  let serve: ServeSession;
  const steps: Step[] = [];

  interface PwPage {
    goto(u: string): Promise<unknown>;
    click(sel: string): Promise<void>;
    fill(sel: string, v: string): Promise<void>;
  }

  before(async () => {
    app = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/order") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"error":"boom"}');
      }
      const routes: Record<string, string> = {
        "/ok": page(`<button id=go>Go</button><script>go.onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);}</script>`),
        "/optimistic": page(`<button id=buy>Buy</button><script>buy.onclick=async()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Order placed!';document.body.appendChild(p);await fetch('/order',{method:'POST'});}</script>`),
        "/form": page(`<label>City <input name=city></label>`),
      };
      const html = routes[req.url ?? ""];
      res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
      res.end(html ?? "nope");
    });
    base = await new Promise<string>((r) => app.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(app.address() as { port: number }).port}`)));

    port = await freePort();
    const { chromium } = (await import("playwright-core")) as unknown as {
      chromium: { launch(o: { headless: boolean; args: string[] }): Promise<typeof browser> };
    };
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    pw = await (await browser.newContext()).newPage();
    await pw.goto("about:blank"); // a page target must exist before serve attaches
    const s = await startServe({ port, waitMs: 400 });
    assert.ok(s, "serve must attach to the caller-owned Chrome by port");
    serve = s;
  });
  after(async () => {
    await serve?.close();
    await browser?.close();
    app.closeAllConnections?.();
    await new Promise<void>((r) => app.close(() => r()));
  });

  // The client protocol: before → (client acts) → after → step.
  async function bracket(kind: "write" | "nav", body: Record<string, unknown>, perform: () => Promise<unknown>): Promise<Step> {
    const id = steps.length + 1;
    const b = await serve.handle({ id, op: "before", kind, ...body } as never);
    assert.equal(b.ok, true, JSON.stringify(b));
    let threw: string | undefined;
    try {
      await perform();
    } catch (e) {
      threw = String(e);
    }
    const a = await serve.handle({ id, op: "after", ...(threw ? { threw } : {}) });
    assert.equal(a.ok, true, JSON.stringify(a));
    const step = (a as { step?: Step }).step!;
    // The recovery contract rides on the serve reply too (the one integration
    // that reads it), so a caller can gate an auto-retry without the full step.
    assert.equal(typeof (a as { retryable?: boolean }).retryable, "boolean", "serve reply carries retryable");
    steps.push(step);
    return step;
  }

  it("nav + a landed click: role=status confirmation read over CDP", async () => {
    const nav = await bracket("nav", { url: `${base}/ok` }, () => pw.goto(`${base}/ok`));
    assert.equal(nav.kind, "nav");
    const step = await bracket("write", { action: { selector: "#go", method: "click" } }, () => pw.click("#go"));
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "landed");
    assert.equal(step.agent_claim, null); // no self-report on this channel, ever
  });

  it("B3: given the CDP driver over a real port, when a write step is recorded, then context.before.target is the real 32-hex targetId, not the constant 'cdp'", () => {
    // OBSERVER-PLAN §4 case 7: the serve reader's id used to be the string "cdp".
    const step = steps.filter((s) => s.kind === "write").at(-1)!;
    const ctx = (step.evidence as typeof step.evidence & { context?: { before: { target: string; origin: string }; after: { target: string } } }).context;
    assert.ok(ctx, "evidence.context is recorded on a write step");
    assert.notEqual(ctx.before.target, "cdp");
    assert.match(ctx.before.target, /^[0-9A-F]{32}$/i, "a CDP targetId");
    assert.equal(ctx.after.target, ctx.before.target); // a same-tab click
    assert.equal(ctx.before.origin, base);
  });

  it("optimistic UI: page shows ✅ but the POST 500s → did-not-land via the network sidecar", async () => {
    await bracket("nav", { url: `${base}/optimistic` }, () => pw.goto(`${base}/optimistic`));
    const step = await bracket("write", { action: { selector: "#buy", method: "click" } }, async () => {
      await pw.click("#buy");
      await new Promise((r) => setTimeout(r, 300)); // let the POST finish
    });
    assert.equal(step.verdict, "did-not-land");
    assert.equal(step.evidence.postcondition?.reason, "network-error");
  });

  it("a fill is field-verified against the targeted input", async () => {
    await bracket("nav", { url: `${base}/form` }, () => pw.goto(`${base}/form`));
    // a non-secret value: emails/keys are length-masked by the redactor (by design)
    const step = await bracket("write", { action: { selector: "[name=city]", method: "fill", arguments: ["Lisbon"] } }, () => pw.fill("[name=city]", "Lisbon"));
    assert.equal(step.verdict, "landed");
    assert.equal(step.evidence.postcondition?.field?.actual, "Lisbon");
  });

  it("the recorded steps form a valid chain; a nested before is refused", async () => {
    assert.equal(verifyChain(steps as never).ok, true);
    const b = await serve.handle({ id: 99, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
    assert.equal(b.ok, true);
    const dup = await serve.handle({ id: 100, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
    assert.equal(dup.ok, false);
    await serve.handle({ id: 99, op: "after" });
  });

  it("a before with an invalid declaration fails fast (ok:false), never deadlocks", async () => {
    await bracket("nav", { url: `${base}/ok` }, () => pw.goto(`${base}/ok`));
    // a vacuous probe (no matcher) throws in run() BEFORE the before-state parks.
    const r = await serve.handle({ id: 500, op: "before", kind: "write", action: { selector: "#go", method: "click" }, expect: [{ kind: "probe", get: "/x" }] } as never);
    assert.equal(r.ok, false);
    // the pipeline is not stuck: a normal bracket still works afterwards.
    const ok = await bracket("write", { action: { selector: "#go", method: "click" } }, () => pw.click("#go"));
    assert.equal(ok.verdict, "landed");
  });

  it("an unknown op is rejected, not treated as after", async () => {
    const r = await serve.handle({ id: 600, op: "sideways" } as never);
    assert.equal(r.ok, false);
  });
});

// §A6 — observer liveness on the fd bridge (docs/OBSERVER-PLAN.md §3 "serve").
// This is the production shape: `truefact serve --cdp-fd 3` runs as a CHILD with
// an inherited socketpair end, and the parent (Syndai's bridge, here the test)
// pumps CDP between that socket and the browser. The bridge dying between
// `before` and `after` is the one observer-loss case serve can meet: the reader
// AND the network share that socket. The `after` reply must still carry a step
// (a write that ran always gets a step), verdict inconclusive / observer-lost —
// never `landed/navigated` fabricated from an unreadable page.
describe("truefact serve (fd bridge): observer lost mid-bracket", () => {
  interface PwPage { goto(u: string): Promise<unknown>; click(sel: string): Promise<void> }
  let browser: { newContext(): Promise<{ newPage(): Promise<PwPage> }>; close(): Promise<void> };
  let pw: PwPage;
  let app: Server;
  let base = "";
  let port = 0;
  let child: ChildProcess;
  let bridge: Socket; // our end of the socketpair (the child's fd 3)
  let ws: WebSocket;
  const replies: Record<string, unknown>[] = [];
  let stdoutBuf = "";

  const send = (req: Record<string, unknown>) => child.stdin!.write(JSON.stringify(req) + "\n");
  const reply = async (id: number, ms = 15000): Promise<Record<string, unknown>> => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const i = replies.findIndex((r) => r.id === id);
      if (i >= 0) return replies.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`serve never replied to id ${id}`);
  };

  before(async () => {
    app = createServer((req, res) => {
      const html = req.url === "/ok" ? page(`<button id=go>Go</button><script>go.onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Saved — #9';document.body.appendChild(p);}</script>`) : undefined;
      res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
      res.end(html ?? "nope");
    });
    base = await new Promise<string>((r) => app.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(app.address() as { port: number }).port}`)));
    port = await freePort();
    const { chromium } = (await import("playwright-core")) as unknown as {
      chromium: { launch(o: { headless: boolean; args: string[] }): Promise<typeof browser> };
    };
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    pw = await (await browser.newContext()).newPage();
    await pw.goto(`${base}/ok`);

    // The bridge: child fd 3 <-> the page target's DevTools WebSocket, in the
    // fd-bridge line format cdpConnectSocket speaks ({i,m,p} / {i,r}|{i,x} / {e,p}).
    const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
    const target = list.find((t) => t.type === "page" && t.url.startsWith(base))!;
    ws = new WebSocket(target.webSocketDebuggerUrl!);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });

    const script = `import("${resolvePath("src/serve.ts")}").then(async ({ startServe }) => {
      const s = await startServe({ cdpFd: 3, waitMs: 600, screenshots: false });
      if (!s) process.exit(3);
      process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
      let buf = "";
      for await (const c of process.stdin) { buf += String(c); let nl;
        while ((nl = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line) continue;
          const req = JSON.parse(line); const rep = await s.handle(req); process.stdout.write(JSON.stringify(rep) + "\\n"); if (req.op === "close") process.exit(0); } }
    });`;
    child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit", "pipe"] });
    bridge = child.stdio[3] as Socket;
    let inBuf = "";
    bridge.on("data", (d: Buffer) => {
      inBuf += d.toString("utf8");
      let nl: number;
      while ((nl = inBuf.indexOf("\n")) >= 0) {
        const line = inBuf.slice(0, nl);
        inBuf = inBuf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { i: number; m: string; p: unknown };
        ws.send(JSON.stringify({ id: m.i, method: m.m, params: m.p }));
      }
    });
    ws.onmessage = (ev: MessageEvent) => {
      if (bridge.destroyed) return;
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
      if (typeof msg.id === "number") bridge.write(JSON.stringify(msg.error ? { i: msg.id, x: msg.error } : { i: msg.id, r: msg.result }) + "\n");
      else if (msg.method) bridge.write(JSON.stringify({ e: msg.method, p: msg.params }) + "\n");
    };
    child.stdout!.on("data", (d: Buffer) => {
      stdoutBuf += d.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });
    const t = Date.now();
    while (!replies.some((r) => r.ready) && Date.now() - t < 20000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(replies.some((r) => r.ready), "serve --cdp-fd must come up over the bridge");
    replies.length = 0;
  });
  after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    try { ws?.close(); } catch { /* gone */ }
    await browser?.close();
    app.closeAllConnections?.();
    await new Promise<void>((r) => app.close(() => r()));
  });

  it("A6 given the fd socket is destroyed between before and after, when the click ran, then `after` still returns a step and it is inconclusive / observer-lost", async () => {
    send({ id: 1, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
    const b = await reply(1);
    assert.equal(b.ok, true, JSON.stringify(b));
    bridge.destroy(); // the bridge dies: serve's only eyes (reader + network) go with it
    await pw.click("#go"); // the write still runs — the page really shows the confirmation
    send({ id: 1, op: "after" });
    const a = await reply(1);
    assert.equal(a.ok, true, JSON.stringify(a));
    const step = a.step as Step | undefined;
    assert.ok(step, "a write that ran always gets a step, even when nothing can be read afterwards");
    assert.equal(step.kind, "write");
    assert.equal(step.verdict, "inconclusive");
    assert.equal(step.evidence.postcondition?.reason, "observer-lost");
    send({ op: "close" });
    await once(child, "exit");
  });
});
