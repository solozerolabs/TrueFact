# Flow — declared `probe` postcondition (catch optimistic-UI)

## Spec

**Outcome.** A new declared-postcondition kind, `probe`, lets a caller catch the
optimistic-UI failure the page cannot reveal: the page renders "✅ Order placed"
while the server call 500s. Stagehand v4 exposes no AJAX network response
(`page.on` supports only `console`; `Response` comes only from navigation), so
the only independent signal is one **TrueFact fetches itself** against real
server state. `probe` is that: data (a URL + a matcher), never a callback, so no
verdict path ever sees the agent's claim.

```ts
await act("click 'Place order'", {
  expect: [{ kind: "probe", get: "/api/orders/latest", text: /"placed":true/ }],
});
```

On optimistic-UI the independent GET shows no placed order → the probe is unmet →
`applyDeclarations` returns `did-not-land` (high), overriding the optimistic
`landed`. That composition already exists; this flow only adds the kind.

**Shape.**
`{ kind: "probe"; get: string; status?: "ok" | number; text?: string | RegExp; absent?: boolean }`
- `get` — URL TrueFact GETs. Relative resolves against the current page URL.
- `status` — `"ok"` (2xx) or an exact code. Optional.
- `text` — body match. Optional. At least one of `status`/`text` is required
  (a bare `get` matches nothing meaningful → vacuous → throws before the write).
- `absent` — negate the match (assert the state is NOT present).
- Met semantics: `met = statusOK && textOK` over whatever is specified; `absent`
  negates. Never false-halts on the probe's own ill health:
  - Fetch throws / times out → `met = null` → `declared-unreadable` → `inconclusive`.
  - Per-fetch timeout via `AbortSignal.timeout` (2s) so a hung endpoint can't
    stall the verdict poll.
  - A 5xx response when the caller did NOT explicitly expect a 5xx `status` →
    `met = null` (the verify endpoint is broken; that is not evidence the write
    failed). A 2xx/4xx response is evaluated normally.

**Non-goals.**
- Not wired into the benchmark runner (`scripts/bench/run.mjs`) — that would
  conflate the agent-claim and oracle channels and move the headline. `probe` is
  a product opt-in per write; the benchmark stays auto + page-based only.
- No raw-CDP network capture, no navigation-status kind (rejected in Understand).
- No new run/wrapper plumbing: `probe` evaluates inside `checkOne`, which already
  has the page; `applyDeclarations` already demotes on `met === false`.
- Response bodies are NOT stored in evidence — only `HTTP <status>` — so a probe
  cannot leak fetched body content into the replay record.

**Trade-off priority.** Correctness (catches optimistic-UI, never false-halts a
real landing) > independence (out-of-band, no claim, no body leak) > ergonomics
(relative URLs) > breadth (absent/status niceties).

## Plan

1. `src/declaration.ts`: extend the `Declaration` union with `probe`.
2. `validateDeclarations`: `probe` requires non-empty `get` and at least one of
   `status`/`text`; a present `text` must be non-vacuous.
3. `checkOne`: `probe` branch — resolve `get` against `page.url()`, GET it with a
   2s `AbortSignal.timeout`, compute status/text match, honor `absent`; throw /
   timeout / unexpected-5xx → `{met:null}`; store `actual = "HTTP <status>"` only
   (no body).
4. `test/probe-fixtures.test.ts`: a local server with an optimistic page (shows
   ✅, records the order FAILED) and a `/verify` endpoint reflecting true server
   state. Drive one click through `withReplay` + `fakeStagehand` with a `probe`
   expect; assert `did-not-land`. Also: clean mirror (server placed → `landed`);
   unreachable probe (→ `inconclusive`); relative-URL resolution; a 5xx verify
   endpoint (→ `inconclusive`, not a false halt).
5. `test/declaration.test.ts`: `validateDeclarations` unit cases — vacuous probe
   (no matcher) throws; valid probe (status-only, text-only, both) passes;
   `absent` negation and status-code(number) match evaluate correctly.
6. README `## Use`: add `probe` to the declared-postcondition example with the
   optimistic-UI note.

## Harness

```sh
npm run build
npm test
node -e "const{validateDeclarations}=require('./dist/declaration.js');let t=0;try{validateDeclarations([{kind:'probe',get:'/x'}])}catch(e){t=1};if(!t)throw new Error('vacuous probe (no matcher) must throw');validateDeclarations([{kind:'probe',get:'/x',text:/y/}]);console.log('probe validation ok')"
grep -q '"probe"' dist/declaration.d.ts
grep -q 'kind: "probe"' README.md
```
