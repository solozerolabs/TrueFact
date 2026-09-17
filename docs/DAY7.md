# Day 7 — Publish (the final day)

Spec (2026-09-16). The last day of the 7-day MVP, and the only one whose *whether* is decided by the day before it: **publish iff a real Day-6 run cleared Gate A ∧ Gate B.** If it did not, the deliverable is the honest negative result, not a package. Everything technical here is small — a `LICENSE`, a dozen lines of `package.json`, a README rewrite, one `npm publish` — because the hard part shipped on Days 1–6. The work of Day 7 is making the number the front door and refusing to ship a product the number does not support.

## 0. The calls, up front

1. **The day is gated, and the gate is honest in both directions.** Read `bench/out/report.json` from a real ladder run (§1). If `gates.publish === true`, publish. If `marketExists` failed, the silent-failure rate is too low on these agents to build a verifier on — **do not publish a product**; publish the finding (§6). If `instrumentWorks` failed, the problem is real but TrueReplay is not good enough yet — **do not publish it as a verifier**; say so. A benchmark that can only ever conclude "ship it" was never a benchmark (the whole graded-party discipline, one last time).
2. **The README leads with the number, not the API.** The first thing below the tagline is the benchmark table: per-rung agent false-success `R` versus TrueReplay residual `M`, with intervals, the gate outcome, and the reproduce command. Someone who reads only the top of the README should learn *the fact nobody else has* before they learn how to install it. Install, the two-channel rule, and usage follow.
3. **Ship the library, not the workshop.** The npm tarball is `dist/` + `README.md` + `LICENSE` + `SPEC.md` — nothing else. `scripts/` (runner, fixtures, probes), `test/`, and `docs/DAY*.md` stay in the repo, linked from the README by URL, out of the install. The `files` field already enforces this; Day 7 only adds `LICENSE`. The scorer (`score()`) ships in `dist` because it is a real feature (§4), not because it is test code.
4. **`0.1.0`, not `1.0.0`.** Pre-1.0 signals what is true: the number is fresh, the API may still move, and the Stagehand-only scope is deliberate. A `1.0` would over-promise stability the one-week MVP has not earned. Semver from here; breaking changes bump the minor while `0.x`.
5. **The number is reproducible or it is marketing.** Publish `bench/out/report.json` and the manifest into the repo (not the tarball) and link them from the README beside `npm run bench`. The claim is falsifiable by anyone with the fixtures and a key — the local rung needs neither. A benchmark table with no way to re-run it is the thing this project exists to distrust.
6. **The honesty section is not optional.** The README states the known ceiling (the `optimistic-ui` miss — a page that lies to its user lies to the confirmation heuristic; the network/CDP upgrade path is named), the external-validity limit (owned fixtures, not production sites), and the under-confidence rate (the cost of R2's honesty). These are in the README body, not buried in `docs/`.

## 1. The gate read (before anything ships)

```
run:   npm run bench          # a real ladder — a cloud key for the frontier rungs,
                              # or just the local oMLX rung (no key); ≥ the §6 floors
score: npm run bench:score    # writes bench/out/report.{md,json}
gate:  report.json → gates.publish
```

Day 7 does not compute the gate — Day 6's scorer did, and pre-registered the thresholds. Day 7 *reads* it. If the run did not reach the count floors (`insufficient-n`), the fix is more runs, not a lower bar or a publish. The published table and the gate must come from the **same** `report.json`; the README number is not typed by hand (§5).

## 2. `LICENSE` + `package.json`

New file: `LICENSE` — MIT, the author's name, the year. `package.json` already declares `"license": "MIT"`; the file makes it real for the registry and for anyone vendoring the code.

`package.json` additions (KISS — only what publishing needs):

```jsonc
{
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./bench": { "types": "./dist/bench.d.ts", "default": "./dist/bench.js" }
  },
  "files": ["dist", "README.md", "LICENSE", "SPEC.md"],
  "engines": { "node": ">=20.6" },              // --import tsx / --env-file era
  "repository": { "type": "git", "url": "git+https://github.com/solozerolabs/TrueReplay.git" },
  "homepage": "https://github.com/solozerolabs/TrueReplay#readme",
  "bugs": "https://github.com/solozerolabs/TrueReplay/issues",
  "publishConfig": { "access": "public" },
  "prepublishOnly": "npm run build && npm test"
}
```

- **`exports` with a `./bench` subpath** so `import { score } from "truereplay/bench"` works without loading the wrapper — the scorer is usable on its own. The root stays `withReplay` + the types.
- **`prepublishOnly` runs build + the full suite** — nothing publishes on red. It does *not* run `npm run bench` (that needs a key/browser and is the human's pre-publish step, §1).
- `keywords`, `main`, `types`, `peerDependencies` (Stagehand) are already set. No `dependencies` — the wrapper has none, which is a selling point the README states.

## 3. The README rewrite

Order, top to bottom:

1. **Title + one line** (kept) and the "Proven on a real agent" callout (kept, now pointing at the benchmark).
2. **Benchmark** — the table, generated from `report.json` (§5), not hand-typed. One row per rung:

   | Model | Agent false-success (belief) | TrueReplay residual miss | Cry-wolf | $/run |
   |---|---|---|---|---|
   | … | R% [ci] (x/n) | M% [ci] (x/n) | …% | … |

   Below it: the one-sentence headline (`agent false-success R%, TrueReplay residual M%`), the gate line (`market exists ✓ · instrument works ✓`), and **Reproduce:** `npm run bench` (local rung needs no key) → `npm run bench:score`, linking `docs/FINDINGS.md` and `report.json`.
3. **Install** — `npm install truereplay`, one line, "zero runtime dependencies."
4. **The rule** (two channels) — kept, it is the thesis.
5. **Use** — `withReplay`, declarations, grounding, condensed from the current README (already accurate to the shipped API).
6. **Score your own fleet** — `import { score } from "truereplay/bench"`; feed it your `RunRecord[]` (agent claim, TrueReplay verdict, your own oracle) and get the same table. This is the SPEC's "per-fleet" output as a public function.
7. **What's not established** — the honesty section (§0.6).
8. **License** — MIT.

The current README's Benchmark section is a `_pending Day 6_` placeholder; Day 7 replaces it with the real table or, if the gate failed, with the §6 negative-result note.

## 4. `score()` as the shipped feature

`src/bench.ts` is already pure, exported, and tested. Day 7 does not change it — it documents it. The `truereplay/bench` subpath exports `score`, `wilson`, and the `RunRecord`/`BenchReport` types. A user who runs their own agents against their own sites builds a `RunRecord[]` from three channels they already have (the agent's claim, `replay.steps[].verdict`, their own success oracle) and gets the confusion matrix, the Wilson intervals, and the gates. Shipping the scorer is what turns "our benchmark" into "your benchmark," which is the only honest way to sell a measurement.

## 5. The number is not typed by hand

A tiny build step (`scripts/bench/readme-table.mjs`, dev-only, not in the tarball) reads `bench/out/report.json` and prints the markdown table + headline + gate line; Day 7 pastes its output into the README (or a `<!-- BENCH:START -->…<!-- BENCH:END -->` block it fills). This removes the one place a benchmark README always lies — a stale or rounded hand-typed number — and makes "the README matches `report.json`" a mechanical check (§7), not a promise. Ponytail: ~20 lines, reused from `score.mjs`'s formatter.

## 6. If the gate did not clear

The negative result is a deliverable, not a failure of the week. Do **not** `npm publish`. Instead:

- **Gate A failed (rate too low):** append to `docs/FINDINGS.md` the measured false-success rate with its interval per rung, and a one-paragraph README note: "On Stagehand agents against these fixtures, the write-side silent-failure rate is R% [ci] — below the bar we pre-registered to justify a standalone verifier. The instrument works (§Gate B); the market on *these* agents does not clear. The durable question is the long tail and harder traps (FINDINGS §5)." Leave the package unpublished, the code public.
- **Gate B failed (instrument misses or cries wolf):** publish nothing as a verifier; record which fixtures produced the misses / false accusations, and what the upgrade path is (network/CDP checks for `optimistic-ui`; a stricter obstruction corroboration for cry-wolf). This is the graded-party discipline turned on ourselves and passing.

Either way the repo stays public with the honest write-up — that is the reproducible contribution even when the product is not built.

## 7. Verification (the day's checks)

- `npm publish --dry-run` — the tarball is exactly `dist/**` + `README.md` + `LICENSE` + `SPEC.md`; **no `scripts/`, `test/`, `docs/`, `.env`, `bench/`, or `.truereplay/`**. Grep the packed tarball for `sk-`, `sk-ant-`, `sk-omlx`, `secret_key`, `@` (email) → clean (the redaction net is for runtime records; the package must carry no secret at all).
- **Install smoke:** `npm pack`, install the tarball into a temp dir, and `import { withReplay } from "truereplay"` + `import { score } from "truereplay/bench"` both resolve and run a trivial call (`score([])` returns a report; `withReplay` is a function). Proves the `exports` map and the entry points.
- **README ↔ report parity:** the numbers in the README's `BENCH` block byte-match `readme-table.mjs`'s output from the published `report.json` (§5).
- `prepublishOnly` green (build + 138+ tests).
- The `docs/FINDINGS.md` result table is updated with the Day-6 numbers (it currently holds the two probe anecdotes; Day 6 gives it the rate).

## 8. Not in Day 7 (post-1.0)

Browser-use / Playwright-MCP adapters (the SPEC's "after the number, not before" — now *is* after the number, but they are a 1.0+ scope, not a publish-day task) · a hosted service or dashboard (a company, not a package) · CI/scheduled benchmarking · more model rungs / provider matrix (Browserbase vs local overlay rates) · auto-repair · a screenshot judge · multi-tab task flows. The publish ships the wrapper, the three checks, and the scorer — the primitive and its measurement — and nothing that would make the number wait.

## 9. AGENTS.md + SPEC.md updates (do with the build)

- AGENTS "Built/Next" line → "Days 1–7 built; published `truereplay@0.1.0`" (or, if the gate failed, "Day 6 gate did not clear — negative result recorded, package unpublished").
- SPEC Day 7 bullet → link `docs/DAY7.md`, note the gate dependency and the `truereplay/bench` subpath.
- README no longer says "Days 1–4 built" — it says the real published state.

## 10. Review

Single-author spec against the shipped Days 1–6 and the current `package.json`/tarball (17 files, already lean; the only missing publish artifact is `LICENSE`). The one non-obvious call is that Day 7 has a real *stop* branch (§6): the discipline that made every prior day refuse to flatter the product is worth nothing if the last day publishes regardless. The rest is ordinary packaging — an `exports` map with a `/bench` subpath, a `prepublishOnly` gate, a generated (not hand-typed) benchmark table, and a tarball proven to carry no secret and no workshop.

VERDICT: **APPROVED FOR BUILD, CONDITIONAL ON THE GATE** — `LICENSE`, the `package.json` publish fields, `scripts/bench/readme-table.mjs`, the README rewrite from `report.json`, the dry-run + install-smoke checks, then `npm publish` iff `report.json.gates.publish`. If it does not clear, ship §6 instead.
