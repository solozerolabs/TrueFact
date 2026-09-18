# TrueFact v2 — Ground truth for agent actions

Status: proposal, 2026-09-17. Supersedes the direction in [SPEC.md](../SPEC.md) (the 7-day MVP, which is built and benchmarked). Nothing here is implemented unless marked **(exists)**.

## 0. Why we don't have this already

The MVP scoped one question: *did the write land?* It was built as a Stagehand wrapper because that made the 520-run benchmark honest (a wrapper can't be skipped). Three consequences:

1. **Capture is thin.** A step stores accessibility-tree lines, field values, the URL, an optional screenshot, and a verdict. Not the DOM, not network. Assertions can't be re-run offline against what isn't stored.
2. **Network is invisible.** Stagehand v4 exposes no response events (see `docs/DAY4.md` §4). That is why `probe` exists and why optimistic UI is the one trap missed 40/40.
3. **No offline anything.** No timeline, no re-assert, no resume. Every step record is written to JSONL as it happens **(exists)**, so the raw material is there; nothing reads it back.

v2 fixes the capture layer once, and every developer and enterprise feature below is a reader over that one record.

## 1. Thesis

Every tool that monitors agents reads the agent's own trace and grades it, usually with another model. TrueFact reads the **world** the agent acted on and records it independently. The record serves three jobs, in order:

| Job | Buyer | Surface |
|---|---|---|
| Catch and fix silent failures | developer | verdict, timeline, re-assert, resume |
| Know today's true success rate and act | ops | queue, fleet number, canary halt |
| Prove what happened | risk / compliance | signed hash-chained export |

Same packet, three readers. Build in that order.

## 2. The packet (the unified asset)

One packet per agent action, appended to a run log. **The agent's claim is stored, but on a channel no assertion or verdict can read** — this is the MVP rule kept: the object handed to assertions simply does not contain `claim`.

```ts
type Packet = {
  id: string;                 // monotonic within run
  runId: string;
  ts: number;
  prevHash: string;           // hash of previous packet's canonical JSON ("" for first)
  hash: string;               // sha256(canonical JSON minus hash/sig)
  sig?: string;               // ed25519 over hash, when a signing key is configured

  intent: string;             // the instruction given to the agent for this step
  boundary: Boundary;         // what the world looked like — see §3
  verdict: Verdict;           // landed | did-not-land | inconclusive + reason + confidence  (exists)
  cost?: Cost;                // model tokens/ms if the framework reports it        (exists)

  claim: Claim;               // agent self-report. SEALED: hashed into the chain, never passed to assertions
};

type Boundary =
  | { kind: "browser"; url: string; before: PageSnap; after: PageSnap; network: NetEvent[] }
  | { kind: "http";    request: HttpReq; response: HttpRes }
  | { kind: "mcp";     server: string; method: string; params: unknown; result: unknown; error?: unknown }
  | { kind: "cli";     cmd: string; cwd: string; stdin?: string; stdout: string; stderr: string; exit: number; fsDiff?: FsDiff };

type PageSnap = {
  tree: string[];             // a11y tree lines                                   (exists)
  forms: Record<string, FieldState>;                                          //  (exists)
  dom?: string;               // serialized HTML, opt-in (size)
  screenshot?: string;        // path or base64, opt-in                             (exists as option)
  storage?: { cookies: Cookie[]; local: Record<string,string>; session: Record<string,string> }; // for resume
};

type NetEvent = { url: string; method: string; status: number; mime: string; reqBody?: string; resBody?: string; ms: number };
```

Size discipline: tree + forms + network summary (no bodies) by default. `dom`, `screenshot`, bodies, and `storage` are opt-in flags. A 50-step browser run at defaults is a few hundred KB.

Format: JSONL, one packet per line, written on the spot **(exists for the current step shape)**. A crashed run leaves a readable file.

## 3. Capture — one recorder per boundary

Priority order is by pain concentration and by how cheap the recorder is.

### 3.1 Browser via CDP sidecar — **VERIFIED 2026-09-17 (M0 PASS)**

Attach a second Chrome DevTools Protocol session to the browser the agent is driving, independent of the driving framework. Chrome allows multiple CDP clients per target over the remote-debugging port.

What it gives:
- `Network.responseReceived` for every fetch the page makes → optimistic UI (page ✅, server 500) becomes catchable with **no declaration**. The 40/40 miss column goes to zero.
- `DOM.getDocument` / `Runtime.evaluate` for before/after snapshots → a uniform read *seam* (`PageReader`) behind which every driver plugs in. (M7 finding: Stagehand walls off raw CDP, so it keeps its native tree; Playwright reads over CDP. Per-driver readers, one classifier — see docs/M7-PLAN.md.)
- Independence by construction: the verdict process is a different client. The framework cannot touch it.

**M0 result** (`scripts/m0-sidecar.mjs`, run it to reproduce): a second CDP client attached to a Stagehand-launched Chrome observed `POST /submit → 500` while the page it drove displayed `✅ Order placed`. What made it work, and what to reuse in M2:
- `localBrowser.launch({ port })` exposes the remote-debugging port. No `--remote-debugging-port` arg, no self-launched Chrome, no `localBrowser.connect` needed — the `port` option is enough.
- The second client is **stdlib**: Node 24's global `WebSocket` to the page target's `webSocketDebuggerUrl` (found via `GET http://127.0.0.1:<port>/json`), plus `Network.enable`. No `ws`, no `chrome-remote-interface` dependency.
- The brand guard (`stagehandBrowserBrand`, typedefs §2751) only blocks passing a foreign CDP *into* Stagehand. It does not stop an outside client attaching to the same browser.
- The separate client is **required**, not just cleaner: Stagehand's own `subscription.on(event)` still accepts only `"console"` (see `[[stagehand-v4-no-network-events]]`), so its channel cannot surface `Network.*`.

Ordering that matters for M2: `Network.enable` must run after navigation but **before** the write, or the fetch is missed.

Stagehand wrapper stays as the *driver adapter* (intent, timing, claim) **(exists)**; the sidecar becomes the *reader*.

### 3.2 HTTP (agent's own calls) — cheap

In-process: Node `diagnostics_channel` for undici/fetch captures request and response without wrapping user code. Python later via `httpx` event hooks. One packet per call. Verdict rule for http is trivial and deterministic: status class + optional declared body match, same `Declaration` shape as today.

### 3.3 MCP — cheap

A stdio/HTTP JSON-RPC pass-through proxy. Every `tools/call` in and result out is a packet. Zero agent change: point the client at the proxy. This is the same shape Salus uses to gate; we record instead of block.

### 3.4 CLI — moderate, last

`node-pty` wrapper around a shell; stdin/stdout/stderr per command, cwd, optional `git diff`-style fs delta. Only build when a paying browser customer has a CLI agent. Rewind already lives here.

## 4. Assertions — one engine, every boundary

Assertions are functions over a **boundary snapshot**. Callbacks are allowed in v2 because independence is enforced by *what is passed*, not by the form: the argument is the `boundary` (+ `intent`), never the `claim`.

```ts
import { defineAssertions } from "truefact";

export default defineAssertions({
  // browser: runs after every browser packet
  browser: ({ intent, url, after, network }) => {
    const charge = network.find(n => n.url.includes("/charge") && n.method === "POST");
    if (charge && charge.status >= 400) return fail(`charge ${charge.status} behind a ✅ page`);
    if (/place order/i.test(intent) && !after.tree.some(l => /^status\b.*Order #\d+/.test(l))) return fail("no order confirmation");
    return pass();
  },
  http: ({ request, response }) => response.status === 200 && response.body === "" ? fail("200 with empty body") : pass(),
  mcp:  ({ result }) => /\b\d{3}-\d{2}-\d{4}\b/.test(JSON.stringify(result)) ? fail("SSN in MCP result") : pass(),
});
```

Composition with the auto verdict keeps today's rule **(exists as `applyDeclarations`)**: an assertion `fail` → `did-not-land` (high); `pass` lifts only the auto default's uncertain outcomes and never overrides a mechanism-backed `did-not-land`. Declarative `expect` **(exists)** stays as the zero-code form and compiles to the same engine.

Assertions run **live** (inside the run, gating the verdict) and **offline** (§5.1) with identical semantics, because both take a packet.

## 5. Replay — three honest capabilities, not one

"Fix and re-run from the failed point" is three different things with three different ceilings. Name them separately so nobody is sold a rewind that can't exist.

### 5.1 Re-assert (offline, exact, $0)

```
truefact assert runs/2026-09-17.jsonl --with assertions.ts
```

Evaluates the assertion file against every stored packet. No browser, no model, milliseconds. Change the regex, re-run, see which of 10,000 historical steps now fail. This is the "unit test from a flaky run" claim and it is fully true, because assertions only ever read packets. Ceiling: only as rich as what was captured (defaults vs opt-in `dom`/bodies).

### 5.2 Resume (live, from a checkpoint, best-effort)

```
truefact resume runs/x.jsonl --from 44
```

Launches a browser, navigates to packet 44's `url`, restores `storage` (cookies/local/session) from the snapshot, hands the page to the caller's agent loop with a `resumeFrom` hook. Ceiling, stated up front: **server-side state is not restored.** A resume works for read-heavy and idempotent flows (searches, form fills not yet submitted, multi-page navigation) and does not work after a consumed one-time action (a payment already placed). The tool reports which prior packets contained writes with `landed` verdicts so the user knows what the world already absorbed.

### 5.3 Fork (new prompt from step N) — sandbox-dependent, not v2

Changing the agent's prompt at step N produces new decisions, for which no page is cached. A real fork needs a re-creatable world: Arga-style API twins or a recorded-site proxy. Out of scope until a customer has one. Rewind does this for LLM-only agents because their world is the prompt tape; ours is a website.

## 6. Timeline (the developer screen)

One static HTML file that loads a JSONL. Left: intent, verdict, assertion results per packet. Right: screenshot if present, else rendered a11y tree diff (before → after), plus the network list for that step. Scrub, click a step, see why. Served by `truefact view run.jsonl` (opens the file). No server, no accounts, no build step. This is deliberately a page, not a product; viewers are commodity.

## 7. Ops surfaces (small, on the same packets)

- **Queue:** `did-not-land` and `inconclusive` packets in a list with before/after and reason. Halt-and-hold: park, never auto-halt on inconclusive.
- **Fleet number:** true landed rate over the last N runs, from verdicts, never from claims.
- **Canary halt:** `withTrueFact({ halt: { window: 50, maxDidNotLandRate: 0.05, onTrip } })` — trips a caller-supplied callback (pause the queue, page someone). TrueFact never stops the fleet itself; it fires the signal.
- **Compare:** group verdicts by `agentVersion` tag; one table. This is the eval angle for free.

## 8. Ledger (the harvest, twenty lines)

- `hash` and `prevHash` on every packet from day one (§2). `truefact verify run.jsonl` recomputes the chain and reports the first break.
- `sig` when `TRUEFACT_SIGNING_KEY` (ed25519, `node:crypto`) is set. Public key published by the operator.
- Sinks: file (default), S3-compatible, HTTPS POST. A "vault" is a sink with a retention policy someone else runs. No on-chain.
- What makes this different from a signed trace (AEVS): the signed object contains the independently-read boundary and the verdict, with the claim sealed alongside. It is a signed observation, not a signed diary.

## 9. Non-goals for v2

- An LLM anywhere in the verdict path. (TypeSafe/Jev may be trialled to *lift the parked tier* behind a flag; it never overrides a mechanism-backed `did-not-land`. Bench against the 520-run oracle first.)
- Bit-exact browser replay (Replay.io's job).
- Prompt forking (§5.3).
- A hosted dashboard, auth, teams. Files and a static page until a customer pays for hosting.
- Blocking/gating actions before execution (Salus's job). We record and verdict after.

## 10. Milestones

| # | Deliverable | Depends on | CC effort |
|---|---|---|---|
| M0 | ✅ **DONE 2026-09-17** — optimistic-UI 500 visible from a second CDP client while Stagehand drives (`scripts/m0-sidecar.mjs`) | — | 0.5 d |
| M1 | ✅ **DONE 2026-09-17 (chain slice)** — tamper-evident hash chain over the existing JSONL record: `record()` sets `prevHash`/`hash` (sha256 of the canonical step incl. the sealed agent_claim, minus hash/sig) per step; `verifyChain` (pure) + `truefact verify <run.jsonl>` exit 1 at the first break. `src/chain.ts`, 178 tests incl. a real-run chain check. **Deferred:** the Step→Packet rename and the `boundary`/`actor` restructure (§2/§12) — pulled forward at M8 when a 2nd boundary needs the unified shape; `sig` is M9. The claim is already structurally sealed (no verdict/assertion path reads `agent_claim`; `viewOf` never touches it). | — | 1 d |
| M2 | ✅ **DONE 2026-09-17 (network slice)** — opt-in `withTrueFact(sh, { network: { port } })` sidecar; same-origin 5xx/failed request in a write's window → `did-not-land`/`network-error` (high), overriding an optimistic ✅. `src/sidecar.ts` + pure `applyNetwork`. 157 tests incl. cry-wolf guard (3rd-party 500 does not halt). **Deferred:** tree/forms via CDP (Stagehand still reads them) and `storage` capture — pulled forward only when M7 (cross-driver) / M5 (resume) need them. | M0 | 2 d |
| M3 | ✅ **DONE 2026-09-17 (offline slice)** — assertion engine (`defineAssertions`, `BrowserView`, `pass`/`fail`) + offline re-assert: `reassert(steps, a)` (pure), `reassertFile(jsonl, module)`, and `truefact assert <run.jsonl> --with <mod.mjs>` (exits 1 on any failing write step, drops into CI). `src/assert.ts` + `src/cli.ts`, 167 tests. **Deferred:** live callback gating in the write path — declarative `expect` already gates live; add `act(i, { assert: fn })` when a user needs logic `expect` can't express. Runs over today's `Step` jsonl; migrates to the M1 packet when that lands. | M1 | 1 d |
| M4 | ✅ **DONE 2026-09-17** — `truefact view <run.jsonl>` writes a standalone HTML timeline (`<run>.html`) beside the run and opens it (`TRUEFACT_NO_OPEN` skips the open for CI/headless). Left: steps + verdict badges; right: reason, a11y tree diff (added/removed), network errors, field, screenshot, and the agent's claim shown separately as the untrusted channel. Auto-selects the first non-`landed` write. `src/view.ts`, `renderHtml`/`viewFile` re-exported, 185 tests. No server, no build step, self-contained. `</script>` in data is neutralized. | M1 | 1 d |
| M5 | Resume from checkpoint | M2 | 1 d |
| M6 | ✅ **DONE 2026-09-17 (number + gate slice)** — `rollupRuns` (pure, true landed rate from verdicts), `truefact fleet <run.jsonl...>` (prints landed/did-not-land rate + which runs need review), `truefact gate <...> [--max-did-not-land 0.05]` (CI exit code). `src/fleet.ts`, 198 tests. **Deferred:** multi-file HTML fleet header and compare-by-tag (needs a run tag = a new user concept) — until a user wants the visual/grouping. Canary halt stays a CI exit code; a runtime hook waits for demand. | M1 | 1 d |
| M7 | ✅ **DONE 2026-09-17** — driver seam (`PageReader`/`Driver`, Phase 0) + `playwrightDriver`/`playwrightReader` (Phase 2), tree via CDP `getFullAXTree`→`axToLines`, claim honestly null. Phase 1 (migrate Stagehand onto CDP) **dropped**: Stagehand exposes no raw CDP, so per-driver readers. Redaction gate (Phase 1.5) folded in. 202 tests. See docs/M7-PLAN.md. | M0 | 1 d |
| M8 | HTTP + MCP recorders + their assertion slots | M1, M3 | 1.5 d |
| M9 | ✅ **DONE 2026-09-17 (signing slice)** — ed25519 `sig` over each step's hash when `signingKey`/`TRUEFACT_SIGNING_KEY` is set; `verifyChain(steps, { publicKey })` and `truefact verify --pubkey <key.pem>` check integrity AND signature. `src/chain.ts` (`makeSigner`/`verifyHashSig`), 198 tests incl. a real signed run through `launch()`. Off by default; the hash chain alone still detects tamper. **Deferred:** chain-status badge in `view`, and S3/HTTPS sinks (a jsonl file is already a sink) — until asked. | M1 | 0.5 d |

M0 gates M2/M5/M7. If M0 fails, M2 becomes "richer Stagehand-side capture" (tree, forms, storage, screenshots; no network) and the value line shifts to §5.1 + §7 + §8, which don't need it.

Proof is at the mechanism level, by a targeted hermetic fixture — not a benchmark re-run. `test/sidecar-network.test.ts` pins the exact trap: an optimistic ✅ over a same-origin 500 → `did-not-land`, while a clean 200 and a third-party 500 are both left alone (the cry-wolf guard). The 520-run ladder established the instrument once (cry-wolf 0/279, optimistic-UI the only miss) and is not re-run; every later change is proven this way. See `[[prove-with-tiny-runs]]`.

## 10b. The surface, and the pivot to outreach (2026-09-17)

Build cost is low; the real constraint is surface area. Rule: **every milestone ships as zero new user-facing concepts** — a reader over the same jsonl, an env var, or a CLI flag. The runtime API is exactly one call in (`withTrueFact`, or `launch()` for zero-config) and one command out (`truefact view`). `expect` is there for precision; `assert`/`verify` are CI/compliance plumbing found via `--help`.

- **`launch()` (done):** owns the browser, picks a free debug port, wraps with the network sidecar ON, folds browser teardown into `close()`. Kills the only friction (the port). `withTrueFact` stays for BYO-browser.
- **README (done):** rewritten as the one-screen dev pitch — the pain, the zero-config quickstart, `view`, `assert`, `expect`, and the 0/279 cry-wolf line below the fold. It doubles as the outreach artifact and the surface lock: anything that can't fit the one screen goes behind a flag/env/advanced page.

**Decision:** stop building the ladder here and put M0–M4 + `launch()` in front of ~3 real browser-agent developers. The one thing analysis can't settle (do buyers value a trustworthy verdict over zero-config breadth?) is settled by users, not code. Their pull picks what comes next — likely **M7 (Playwright driver, same `withTrueFact`, widens the funnel)** over M5/M6. When M6–M9 do land, they follow the zero-concept rule: M6 = `truefact view runs/*.jsonl` (fleet header) + `truefact gate` (CI exit code); M9 = `TRUEFACT_SIGNING_KEY` env + chain status shown in `view`; M5 = `truefact resume` (CLI, never the wrapper); M8 = auto HTTP + `truefact mcp -- <server>` proxy.

## 11. Open questions (settle with users, not analysis)

1. Do buyers value a trustworthy number over zero-config breadth? Three conversations with fintech/ops teams running browser agents at volume.
2. Default capture size: is tree + network summary enough for re-assert in practice, or does everyone turn `dom` on?
3. Which second driver first: Browser-Use (Python, biggest community) or Playwright (Node, same process)?

## 12. Gaps found on review (2026-09-17)

Ranked by what they block. Each is a spec addition, not a new product.

### Blocks developer adoption
- **Redaction at capture (§2/§3).** v2 stores DOM, bodies, cookies, storage — i.e. tokens and PII by default. Policy at capture time: never store `authorization`/`cookie` headers; cookie values hashed; declared field masks (`redact: ["#ssn", "input[type=password]"]`); bodies opt-in per host allowlist. MVP only redacts password fields.
- **Observe vs gate (§4/§7).** `withTrueFact({ mode: "observe" })` records without polling; verdicts computed offline by `truefact assert`. Gate mode (today's inline poll) stays for declared writes. Long runs need observe.
- **Multi-target (§3.1).** Sidecar must follow `Target.targetCreated`/`attachedToTarget`: new tabs, popups (payment, OAuth), iframes. Fintech flows live there.
- **Learned postconditions (§4).** After N `landed` runs sharing an intent, propose an `expect` from tree lines present after-but-not-before with high frequency. Ships as `truefact suggest run.jsonl`. Zero-config → precision ramp; only possible with ground-truth verdicts.
- **Intent-value match (§4).** Numbers/IDs/emails in `intent` must appear in `after` for `landed` (heuristic reason `value-mismatch` → `inconclusive`, never a halt). Catches "$500 → $5,000".

### Blocks the enterprise rung
- **Actor block (§2).** `actor: { agentId, agentVersion, principal, approvalRef? }` on every packet. Audit asks "who" first.
- **Human decisions as packets (§7/§8).** Queue resolutions (`{ kind: "review", by, decision, note }`) are appended to the same chain. No holes where liability lives.
- **Tamper-evidence ceiling (§8).** Stated plainly: the chain proves integrity since recording; the operator holds the key. Upgrade path: RFC 3161 timestamps or hosted counter-signing.
- **Read-only sidecar (§3.1).** CDP domain allowlist (`Network`, `DOM` reads, `Page` events, `Runtime.evaluate` with side-effect-free expressions only). Published, testable.
- **Retention/sampling (§2).** Full packets for non-`landed` + N% sample; summaries for the rest. S3 Object Lock as the "vault" — no vault product.

### Distribution and ladder mechanics
- **OpenTelemetry export.** Packets as spans with `truefact.verdict` attributes → Raindrop/Sentrial/Datadog ingest us as the ground-truth feed.
- **Sidecar as a process** with a JSONL/stdio contract, so Python (Browser-Use) and Node drivers share one reader.
- **Compliance mapping** in docs: SOC 2 CC7.x, EU AI Act Art. 12 record-keeping, FINRA 2026 agentic supervision.
- **First paid SKU:** hosted queue + retention + third-party `verify`, priced per verified action.
- **Insurer channel:** Klaimee-style underwriters verify runs with the operator's public key. Partnership, not code.
- **Public verifier accuracy per release** (cry-wolf, miss) from the fixture set, so trust in the verdict is itself audited.
