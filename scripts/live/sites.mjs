// The pre-registered trial table for the real-site false-`landed` campaign.
// Pre-registration is the point: each row states the stratum and the EXPECTED
// outcome per config BEFORE running, so a contradicted cell is a finding, not a
// number we went looking for. See strategy/spec-real-site-2026-09-18.md §3 and
// docs/EXPERIMENT-SITES.md. Keyless and no-login by design in v1, so anyone can
// reproduce it; logged-in read-back is v2.
//
// Two row shapes the runner understands:
//   page:   navigate to a real third-party page and drive `steps` (CSS selectors).
//   postTo: the runner serves a one-button page that POSTs to a real third-party
//           endpoint (the EXPERIMENT-SITES §B pattern) — the write is third-party,
//           the shim page is ours. `steps` is then just the button click.
//
// inject: null | "status:<code>" | "wire" | "body-lie" (scripts/live/inject.mjs).
//   With inject set, truth is `{ kind:"injected" }` (did-not-land by construction)
//   and `write.urlPattern` scopes the intercept + must be in apiOrigins so the
//   sidecar's origin filter lets the forced failure demote.
// oracle: how truth is known when NOT injected (scripts/live/oracle.mjs).
// expect: the pre-registered verdict per config, for the score report to check.

const clickPlace = [{ selector: "#place", method: "click" }];

export const TRIALS = [
  // ── S1 server-rejected (injected on a real form) + contract endpoints ───────
  {
    id: "the-internet/status-500", stratum: "S1", checkedLive: "2026-09-17",
    postTo: "https://the-internet.herokuapp.com/status_codes/500", steps: clickPlace,
    inject: null, oracle: { kind: "contract", landed: false },
    write: { urlPattern: "*the-internet.herokuapp.com*", apiOrigins: ["https://the-internet.herokuapp.com"] },
    expect: { zero: "did-not-land" },
  },
  {
    id: "httpbin/402", stratum: "S1", checkedLive: "2026-09-17",
    postTo: "https://httpbin.org/status/402", steps: clickPlace,
    inject: null, oracle: { kind: "contract", landed: false },
    write: { urlPattern: "*httpbin.org*", apiOrigins: ["https://httpbin.org"] },
    expect: { zero: "did-not-land" },
  },
  // Injection turns a genuine landing into a known did-not-land, zero server effect.
  {
    id: "httpbin/post+inject500", stratum: "S1", checkedLive: "2026-09-17",
    postTo: "https://httpbin.org/post", steps: clickPlace,
    inject: "status:500", oracle: { kind: "injected" },
    write: { urlPattern: "*httpbin.org/post*", apiOrigins: ["https://httpbin.org"] },
    expect: { zero: "did-not-land" },
  },

  // ── S2 wire failure (injected drop) ────────────────────────────────────────
  {
    id: "httpbin/post+inject-wire", stratum: "S2", checkedLive: "2026-09-17",
    postTo: "https://httpbin.org/post", steps: clickPlace,
    inject: "wire", oracle: { kind: "injected" },
    write: { urlPattern: "*httpbin.org/post*", apiOrigins: ["https://httpbin.org"] },
    expect: { zero: "did-not-land" },
  },

  // ── S3 body-lie (live GraphQL + injected) ──────────────────────────────────
  {
    id: "trevorblades/bad-field", stratum: "S3", checkedLive: "2026-09-17",
    postTo: "https://countries.trevorblades.com/", body: '{"query":"{ __typenope }"}', steps: clickPlace,
    inject: null, oracle: { kind: "contract", landed: false }, // 200 + errors[]
    write: { urlPattern: "*countries.trevorblades.com*", apiOrigins: ["https://countries.trevorblades.com"] },
    expect: { zero: "landed", bodyErrors: "did-not-land" }, // opt-in feature off ⇒ expected miss at default
  },

  // ── S4 fake-persist (clean 2xx that never persists) ─────────────────────────
  {
    id: "jsonplaceholder/posts", stratum: "S4", checkedLive: "2026-09-17",
    postTo: "https://jsonplaceholder.typicode.com/posts", steps: clickPlace,
    inject: null,
    // 201 with a fabricated id, nothing persists — the readback would 404. Kept as
    // contract here because the id is fabricated (no stable URL to re-read).
    oracle: { kind: "contract", landed: false },
    write: { urlPattern: "*jsonplaceholder.typicode.com*", apiOrigins: ["https://jsonplaceholder.typicode.com"] },
    expect: { zero: "landed" }, // network-invisible ceiling — only a declared probe/readback catches it
  },

  // ── S5 client-only (no server write ⇒ must not cry-wolf) ────────────────────
  {
    id: "todomvc/add", stratum: "S5", checkedLive: "2026-09-17",
    page: "https://todomvc.com/examples/react/dist/",
    steps: [{ selector: ".new-todo", method: "fill", arguments: ["tf-live-check"] }, { selector: ".new-todo", method: "press", arguments: ["Enter"] }],
    inject: null, oracle: { kind: "contract", landed: true }, // persists client-side; network sees nothing
    write: { urlPattern: "*", apiOrigins: [] },
    expect: { zero: "not:did-not-land" }, // inconclusive or a page-read landed — never a false did-not-land
  },

  // ── S6 clean positives (genuine landings ⇒ cry-wolf must be 0) ──────────────
  {
    id: "httpbin/post-clean", stratum: "S6", checkedLive: "2026-09-17",
    postTo: "https://httpbin.org/post", steps: clickPlace,
    inject: null, oracle: { kind: "contract", landed: true },
    write: { urlPattern: "*httpbin.org*", apiOrigins: ["https://httpbin.org"] },
    expect: { zero: "not:did-not-land" },
  },
];

// A one-button optimistic page for `postTo` rows: shows ✅ immediately, fires the
// POST without awaiting it — the exact optimistic-UI shape the product exists for.
export const shimPage = (postTo, body = "{}") =>
  `<!doctype html><meta charset=utf8><title>write shim</title><h1>write shim</h1>
   <button id=place type=button>Place order</button><p id=ok role=status></p>
   <script>document.getElementById('place').onclick=()=>{fetch(${JSON.stringify(postTo)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(body)}}).catch(()=>{});document.getElementById('ok').textContent='✅ Order placed — confirmation #4242';};</script>`;
