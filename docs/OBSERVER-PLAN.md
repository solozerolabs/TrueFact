# Observer liveness, context identity, actor identity (2026-09-23, rev 2)

Rev 1 came from a seven-lens review (CDP/Stagehand/Playwright/OTel docs, 2026 web research, OSS code, a codebase trace, a bug repro, live CDP probes on Chrome 153, a devil's advocate). Rev 2 re-read every file on the verdict path and ran three more probes against a real browser. Rev 2 corrects rev 1 where the probes contradicted it; those corrections are marked **[rev 2]**. No database, web or mobile surface exists in this repo, so none was reviewed.

## 0. The call

Ship all three, sized by what they protect.

- **A, observer liveness: a soundness fix, ships first.** Four false verdicts and one lost step are reproduced (§1).
- **B, context identity: one rule plus two recorded fields.** The rule is reachable today through our own driver (§1 case 5). Loader and frame IDs are rejected: no verdict reads them and they raise false alarms.
- **C, actor identity: one optional `actor` object plus an `observer` stamp**, sealed per step. No attestation format, no per-run header, no reconnect logic.

## 1. What is broken today

Every row was reproduced with a real Chrome, no LLM (scratch tests under the session scratchpad: `tests-lens/liveness.test.ts`, `critique/deadpage.test.ts`), except rows 6 and 7 which are code facts.

| # | Case | Today | Should be |
|---|---|---|---|
| 1 | Sidecar socket closes before the click; page shows ✅ over a POST that 500s | **`landed / confirmation`**, no `network` field | `inconclusive / observer-lost` |
| 2 | `network` requested but the sidecar never attached (bad port) | **`landed`**, indistinguishable from "watched and clean" | `inconclusive / observer-lost` |
| 3 | Reader can't read after the action (Playwright page closed; CDP reader socket dead) | `evalIn` returns `undefined` → `EMPTY_FP` (`href: ""`) → `urlDelta` throws → **`landed / navigated / high`**, which the network can't demote | `inconclusive / observer-lost` |
| 4 **[rev 2]** | Stagehand: the only tab closes during the action | `activePage()` throws → **`run()` throws and no step is recorded**. The write is missing from the chain | A step `inconclusive / observer-lost`, then rethrow |
| 5 **[rev 2]** | Stagehand: the active tab closes, an older tab exists | Our fallback `activePage() ?? pages()[0]` (`driver.ts:63`) silently reads the older tab → **`landed / new-page / high`** | `inconclusive / context-changed` |
| 6 | A popup's `Network.enable` fails or times out (`cdp.ts:85` ignores the result; the 2 s `firstPageEnabled` race can lose) | That target is silently unwatched | Counted as blind |
| 7 | `serve`'s CDP reader id is the constant `"cdp"` (`driver-cdp.ts:47`) | Recorded identity is meaningless | The real `targetId` |
| 8 | `watch` loses its socket | Keeps "watching", exits 0 | Says it went blind, records it, exits 1 |

Rev 1 claimed a dead Stagehand/Playwright read produced `blank → did-not-land`. **That was wrong**: Playwright's `page.url()` is synchronous and keeps returning the last URL, so the blank detector never fires, and Stagehand throws before any detector runs. Rows 3–5 are the real shapes.

## 2. Principles

1. **An observer that cannot see is a missing observer, not a clean one.** Invariant 3, applied to our own connections. A blind channel never contributes to `landed` and never to `did-not-land`.
2. **A write that ran always gets a step.** If the action was invoked, the chain records it, even when nothing can be read afterwards. A missing step is worse than any verdict: the run looks shorter than it was, and `verifyChain` cannot tell.
3. **Only record a field a verdict reads or an auditor asks for.**
4. **Quiet on healthy runs.** Demotion fires only when the observer is actually unhealthy. The benchmark's inconclusive rate must not move (checked in §9).
5. **The two channels stay separate (invariant 1).** Actor identity is caller data; no verdict function receives it.

## 3. Feature A: observer liveness

### API

No new caller options. The step gains:

```ts
evidence.observer?: { network: "watched" | "blind" | "off"; lost?: string }
// lost: "socket-closed" | "enable-failed" | "attach-failed" | "reader-unreadable" | "no-active-page" | "target-detached" | "target-crashed"
```

One new `PostReason`: `"observer-lost"`.

### Connection: `CdpConn.lost()`

- `lost(): string | null`, sticky, set once with the first reason.
- Set by `onclose`/`onerror` (WebSocket) and by `error`/`close` (fd socket). **Not** set by our own `close()` (browser-use's `_intentional_stop` idea, one boolean).
- Page-level conns (`cdpConnect`, the fd bridge): also set by `Inspector.detached` and `Inspector.targetCrashed`. That target *is* the observer.
- Browser-level conn (`cdpConnectBrowser`): **only** the socket events. **[rev 2]** `Target.detachedFromTarget` must not set it: a popup closing after a successful OAuth is normal, not observer loss. Rev 1 had this wrong.
- Once `lost()` is set, `cmd()` resolves `undefined` immediately. **[rev 2]** Today a crashed target accepts commands and never answers (probed), so each read waits the full `CMD_TIMEOUT_MS` (10 s); a dead reader could stretch one step past a minute. The short-circuit removes that.
- `cmd()` otherwise stays best-effort and still resolves `undefined`. Nothing that awaits it changes shape.
- **No generation counter.** Nothing reconnects; there's nothing to count.

### Network channel

The sidecar snapshots `lost()` at `mark()`. At settle, the network is **blind** when any of these holds:
- `lost()` is set (socket died since mark, or before it).
- `attachSidecar` returned `null` while `opts.network` was set (the sidecar promise resolves null today and every later step silently skips network; now every write step records `observer.network: "blind", lost: "attach-failed"`).
- `Network.enable` resolved `undefined` — per child session on the browser conn, on connect for a page/fd conn (each connector enables Network itself; `attachSidecarConn` no longer sends one, since a browser target has no Network domain and the old no-op read as a failure) — or the 2 s `firstPageEnabled` race lost.

**[rev 2] Dropped from rev 1: counting orphan network events as blindness.** The sidecar attaches lazily on the first write, after the page has loaded. A response to a request that started before `Network.enable` is a normal orphan, not a dropped socket. Since nothing reconnects, an orphan can't mean anything else, so the rule would only ever fire falsely and demote healthy writes.

### Reader channel

- `evalIn` (`driver-cdp.ts:31`) throws when the reply is `undefined`. A real CDP reply always carries `result`; `undefined` means a dead conn, a timeout, or an `{error}` reply, and all three are failed reads.
- `captureState` returns `readable: false` when the fingerprint is null, instead of fabricating `EMPTY_FP` and `[]`. `PageState.readable` replaces `PageState.pageId`, which nothing reads.
- `decideWrite` returns `inconclusive / observer-lost` when `before` or `firstAfter` is unreadable, **before** `classify` runs and without the `pollUntil` wait. `classify` stays pure and untouched.
- `detectSession` is skipped on an unreadable page; the step records `session.detail: "unreadable"`. An unreadable page is not a `blank` page.
- **[rev 2] `run()` in `index.ts`:** the post-action `activePage()` call is wrapped. If it throws, the step is recorded as `inconclusive / observer-lost` with `after: null` and `lost: "no-active-page"`, then the error is rethrown. This fixes case 4. Nothing changes when `activePage()` throws *before* the action: no action ran, so there's nothing to record.
- **[rev 2] Delete the fallback** `?? (await ctx.pages())[0]` in `driver.ts:63`. It is the same silent focus-recovery browser-use has, and the probe shows it produces a false `landed`. With it gone, a closed tab surfaces as "no active page" and lands in the rule above.

### Verdict rule

In `index.ts`, next to the existing `unsettled` rule:

| Page read | Network | Result |
|---|---|---|
| unreadable (either side) | any | `inconclusive / observer-lost` |
| heuristic `landed` (`confirmation`, `form-cleared`) | blind | `inconclusive / observer-lost` |
| high-confidence `landed` (`navigated`, `new-page`, `field-match`, declared) | blind | unchanged, with `observer.network: "blind"` recorded |
| `did-not-land` / `inconclusive` | blind | unchanged (blindness never promotes and never accuses) |

The heuristic-only demotion mirrors the `unsettled` rule: the network can only overturn an optimistic page read, so its absence only matters for one. **Open question "demote high-confidence too?": no.**

### `watch`

On `lost()`: print `✗ observer lost (<reason>)`, record a `kind: "observer"` step (verdict `inconclusive`, reason `observer-lost`, `before`/`after` null), mark every in-flight write `inconclusive / observer-lost`, and return exit code 1 at shutdown. `view`, `fleet` and `assert` already ignore non-`write` kinds, so the new kind needs no handling there (`view.ts:56-75`, `fleet.ts:27`, `assert.ts:65`).

### `serve`

No protocol change. The `after` reply carries the demoted step. Case 4's fix also guarantees `serve` never answers an `after` with no `step` when the action ran (`serve.ts:124` returns `undefined` today in that situation).

### Cost

Zero extra CDP calls on the healthy path. A dead sidecar now *stops* the `settle` spin instead of burning `waitMs` (the mid-flight repro waited the full budget for nothing). A crashed reader stops costing 10 s per read.

## 4. Feature B: observation context

### Recorded

```ts
evidence.context?: { before: { target: string; origin: string }; after: { target: string; origin: string } }
```

- **`target`** is the CDP `targetId`.
  - Stagehand: `page.pageId` (it *is* the targetId; verified in the 4.1.0 source).
  - Playwright: `Target.getTargetInfo` on the CDP session the reader already caches. Replaces our `pw-N` counter.
  - CDP driver: the same call. Fixes case 7.
- **`origin`** is `originOf(href)`; opaque origins read as `""`.
- Probed cost: about 0.25 ms per read.

### The rule (replaces the unconditional `pageSwitched → landed/new-page` at `postcondition.ts:247`)

Before a write step, snapshot the set of page ids (`ctx.pages()` on Stagehand; the other drivers are single-page and can only report their own target). After the action:

- `after.target` **not in the before-set** → the action opened it. `landed / new-page`, as today.
- `after.target` **in the before-set, ≠ `before.target`** → nothing this action did opened it. `inconclusive / context-changed`. This is case 5, the browser-use focus-recovery shape, and vercel agent-browser #1867.

One extra `pages()` call per write step on Stagehand; nothing on the other drivers.

### Rejected fields

| Field | Why not |
|---|---|
| `loader_id` | No verdict reads it. Changes on reload and on same-URL POST-redirect-GET (false alarms). A bfcache restore *reuses* an old id (probed). Stagehand doesn't expose it. |
| `frame_id` | For a main frame it equals the targetId (probed). We read the whole tree; nothing is frame-scoped. |
| `generation` | Nothing reconnects. |
| transition tables | Heuristics that only ever yield `inconclusive`, which the tree diff already yields. |

**Open question "same-document proof via loaderId?": no.** Reopen only if a fixture shows a same-target document swap producing a wrong verdict.

## 5. Feature C: actor identity

### API

```ts
withTrueFact(sh, { actor: { agent: "claims-bot", model: "claude-opus-5-5", run: "r-8841", principal: "okta|u123" } })
openRun({ actor })  ·  launch({ actor })
truefact serve --actor agent=claims-bot,run=r-8841
truefact watch --port 9222 --actor agent=claims-bot

type Actor = { agent?: string; version?: string; model?: string; run?: string; principal?: string; tenant?: string };
Step.actor?: Actor;     // omitted when not given
Step.observer: string;  // "truefact@<package version>", always
```

| Key | OpenTelemetry GenAI name |
|---|---|
| `agent` | `gen_ai.agent.id` |
| `version` | `gen_ai.agent.version` |
| `model` | `gen_ai.request.model` |
| `run` | `gen_ai.conversation.id` |
| `principal` | `user.id` |
| `tenant` | (none) |

- Literal `gen_ai.*` keys are not used: they are "development" status and still moving (checked 2026-09). The mapping goes in the README.
- Values are opaque and never authenticated. A missing value stays missing (OTel's rule: no synthetic ids).
- `observer` matches the IETF agent-audit-trail draft's `recording_component`: the verdict came from an independent recorder at a known version.
- **Per step, not a per-run header.** Auditors sample single steps; each must stand alone. `hashStep` already covers the whole step, so `verifyChain` and the four JSONL loaders are untouched. Cost: a few dozen bytes per step.
- **[rev 2] `actor` is stored verbatim, not passed through `redactText`.** `redactText` scrubs anything email-shaped (`redact.ts`), and a `principal` is very often an email or contains one. Redacting it would silently destroy the join key, which is the whole point of the field. Document it: the actor is identity by design; prefer an IdP subject over an email where the record will be shared.
- No verdict function receives `actor` (invariant 1).
- Honest line for the docs: unsigned, actor fields are self-asserted; signed, they're tamper-evident; either way they are a join key into the IdP/Teleport logs, not proof of identity.

**Decisions:** no attestation format (the RFC 8785 + ed25519 chain already matches the IETF draft's integrity design; add an in-toto *export* only when a customer asks). No free-form `meta` bag.

## 6. Deleted or merged while we're here (only because A–C touch it)

- `driver.ts:63` fallback `?? pages()[0]` (case 5).
- `watch.ts:87-111, 194-230`: its own chain/sign/redact code moves onto `recorder()` so `observer`/`actor` stamping lives in one place.
- `PageState.pageId` (written, never read) → `readable`.
- `sidecar.ts:11-12` re-export (no importers).
- `readTree` (`postcondition.ts:93`) pass-through.

## 7. Documentation that must change in the same commits

**AGENTS.md**
- Invariants, add **8**: *A blind observer never contributes to a verdict. A reader that cannot read, or a network channel whose socket closed / whose `Network.enable` failed / that never attached, yields `inconclusive / observer-lost` for anything that depended on it. Never `landed`, never `did-not-land`. A write that ran always records a step.*
- Day 3 rule "Detect a tab switch by the stable per-tab `pageId`": add *a switch to a tab that existed before the action is `context-changed`, not `new-page`; never fall back to `pages()[0]`.*
- Stagehand facts: *`context.activePage()` returns `undefined` when the active tab closed; `page.pageId` is the CDP targetId.*
- CDP multi-target facts: *targetId never changes on navigation, even cross-site (probed); a crashed target accepts commands and never replies; one client's disconnect is invisible to every other client; a popup detaching is not observer loss.*
- Module map: `evidence.observer` / `evidence.context` / `Step.actor` in one line each.

**Other docs:** README (`actor`, `observer`, `context`, the `observer-lost` reason, the OTel mapping, the redaction note); docs/SERVE.md (the `after` step always present; new evidence fields); docs/WATCH-PLAN.md (observer-lost record, exit 1); SPEC.md verdict table.

## 8. Tests (BDD, one `it` per branch; headless, `screenshots: false`, fixtures over HTTP, budget-relative timing only)

**A** (`test/sidecar-network.test.ts` for network; `test/driver.test.ts`, `test/driver-playwright.test.ts`, `test/serve.test.ts` for readers; pure in `test/postcondition.test.ts`)
1. given the sidecar conn closes before the click, when the page shows ✅, then `inconclusive/observer-lost`, never `landed`
2. given the conn closes after the POST is sent, when its 500 never arrives, then `inconclusive/observer-lost` before the full `waitMs`
3. given network was requested but attach failed, when the page shows ✅, then `inconclusive/observer-lost` with `observer.lost: "attach-failed"`
4. given the conn closes after the 500 was seen, then `did-not-land` stands
5. given a healthy conn and a clean 200, then `landed` with `observer.network: "watched"` (no false alarm)
6. given the serve fd socket closes mid-bracket, then `inconclusive/observer-lost` and `after` still returns a step
7. given a Playwright page that closes during the action, then `inconclusive/observer-lost`, not `landed/navigated`
8. given the only Stagehand tab closes during the action, then a step `inconclusive/observer-lost` is recorded and `act` rethrows
9. given a crashed reader target, when a read runs, then it resolves within one `CMD_TIMEOUT_MS`, not one per read
10. given `watch` loses its socket, then it records `kind: "observer"`, prints observer-lost, and exits 1
11. pure: given an unreadable before or after state, then `decideWrite` is `inconclusive/observer-lost`; given a blind network, then a high-confidence `landed` stands and a heuristic one demotes

**B** (`test/postcondition.test.ts` live block; `test/serve.test.ts`)
1. given a click that opens a new tab, then `landed/new-page` and `context.after.target` is not in the before-set
2. given the active tab closes and an older tab exists, then `inconclusive/context-changed` (the case-5 probe, as a test)
3. given the CDP driver, then `context.before.target` is a real targetId, not `"cdp"`

**C** (`test/chain.test.ts`, `test/replay.test.ts`, `test/watch.test.ts`)
1. given `actor`, then every step carries it plus `observer`, on `withTrueFact`, `openRun` and `watch`
2. given a stored run, when an actor field is edited, then `verifyChain` names that step
3. given a signed chain, when `actor` is stripped, then the signature check fails
4. given an actor `principal` containing an email, then it is stored verbatim

## 9. Order and size

| Phase | What | Size |
|---|---|---|
| 1 | A reader: `evalIn` throws, `readable`, `observer-lost`, the wrapped post-action `activePage()`, delete the `pages()[0]` fallback, invariant 9 | ~50 lines + tests A7–A9, A11 |
| 2 | A network: `lost()`, enable results, attach-null, short-circuit, `watch`/`serve` | ~60 lines + tests A1–A6, A10 |
| 3 | B: target/origin capture, the before-set rule, the CDP id fix | ~40 lines + tests B1–B3 |
| 4 | C: `actor`/`observer`, CLI flags, `watch` onto `recorder()` | ~50 lines + tests C1–C4 |

Each phase is one commit with the full suite green. After phases 1–3, re-run `npm run bench:score` and confirm 0/279 false halts and an unchanged inconclusive rate.

## 10. Separate follow-up, not part of A–C

**Browserbase teardown.** Stagehand's own network sidecar warns that closing an auxiliary *browser-level* WebSocket makes Browserbase end the whole browser session. `withTrueFact.close()` closes exactly that socket. Probe against a remote Browserbase endpoint before claiming Browserbase support (harmless on local Chrome).
