# `truefact serve` — the verdict bracket for a browser you own

`watch` gives any framework the network floor, passively. `serve` gives any
framework the FULL verdict — DOM postcondition + session state + network — for a
browser TrueFact did not launch and cannot drive. The caller performs every
action; TrueFact only reads the world before and after, over raw CDP.

First consumer: Syndai's Python patchright bridge (`mcp__browser__*` tools inside a
coding sandbox), where each click/fill the agent makes is bracketed and the Step
rides into the run transcript as evidence the model cannot fake.

## Protocol

1. Launch Chrome/Chromium and open one page. Two ways to give serve CDP:
   - **`--cdp-fd <N>` (preferred, no open port).** Pass serve an inherited duplex
     socket fd; you proxy each CDP command into a CDP session you already own
     (e.g. Playwright's `new_cdp_session`, itself pipe-based) and stream events
     back. Nothing binds a debug port, so no same-UID process can reach the
     browser's control plane. Wire protocol on that fd: serve sends
     `{"i":<id>,"m":<method>,"p":<params>}`; you reply `{"i":<id>,"r":<result>}`
     (or `{"i":<id>,"x":"<error>"}`) and push events as `{"e":<method>,"p":<params>}`,
     one JSON object per line. Reads AND network events share this one channel.
     Note: this is TrueFact's own newline-JSON bridge, **not** Chrome's
     `--remote-debugging-pipe` (that speaks raw CDP on fds 3/4, NUL-delimited).
     They are not wire-compatible; the peer proxies into a CDP session it owns.
   - **`--port <N>` (debug-port mode).** Launch Chrome with
     `--remote-debugging-port=<N>`; serve attaches a WebSocket CDP client itself.
     Simpler, but the port is reachable by any same-UID process — use only where
     that is acceptable.
2. Spawn `truefact serve (--cdp-fd <N> | --port <N>) [--jsonl run.jsonl] [--api-origins a,b] [--body-errors]`.
   It prints `{"ok":true,"ready":true}` once attached.
3. One JSON object per line, request → reply, strictly one bracket at a time:

```
→ {"id":1,"op":"before","kind":"nav","url":"https://…"}
← {"id":1,"ok":true}                     # before-state captured — NOW perform it
→ {"id":1,"op":"after"}
← {"id":1,"ok":true,"step":{…}}          # kind:"nav", session evidence

→ {"id":2,"op":"before","kind":"write","action":{"selector":"#buy","method":"click"},"expect":[…]?}
← {"id":2,"ok":true}
→ {"id":2,"op":"after","threw":"TimeoutError …"}?   # include `threw` if your action failed
← {"id":2,"ok":true,"step":{"verdict":"did-not-land","evidence":{…},"hash":"…"}}

→ {"op":"close"}   ← {"ok":true}
```

`action.method` ∈ `click | fill | type | selectOption | …` and `arguments` (the fill
value) drive field verification exactly like the Playwright driver. `expect` takes
the same data-only declarations as `act(…, { expect })`. Steps are redacted,
chained and (with `--jsonl`) appended as they happen, so `truefact verify` /
`view` / `assert` work on a serve run unchanged.

## What is honest about it

- `agent_claim` is always `null`: this channel never carries the agent's opinion.
- A second `before` while one is open is refused (`ok:false`); a bracket is causal
  or it is nothing.
- No DevTools endpoint → `serve` exits 2. It never fabricates a verdict.
- Same limits as the Playwright driver: one page target, no popups/iframes.

## Library form

```ts
import { startServe } from "truefact";
const s = await startServe({ port, jsonl: "run.jsonl" });
await s.handle({ id: 1, op: "before", kind: "write", action: { selector: "#go", method: "click" } });
await myBrowser.click("#go");
const { step } = await s.handle({ id: 1, op: "after" });
```

`cdpReader(conn)` / `cdpDriver(conn, perform)` are exported too, for wiring the
bracket in-process around your own CDP connection.

Test: `test/serve.test.ts` (a playwright-core Chromium launched with the debug
port, actions performed by Playwright, verdicts read by serve — landed click,
optimistic-UI 500 → did-not-land, field-verified fill, chain verifies).
