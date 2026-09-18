# Verdict-Indexed Replay (post-MVP)

> Status: **spec only, not in the 7-day MVP.** Build only after the Day 6 benchmark clears its gates. A replay is worthless if the verdict it indexes isn't proven real.

## One sentence

A session replay — the actual video/DOM timeline of the browser run — with every moment stamped by TrueFact's independent verdict, so a user can jump straight to the step where the agent said "done" and the page disagreed.

## The rule it must not break

The replay is a **viewing layer built from verdicts already computed**. It never feeds a verdict. The agent's claim channel and the page-truth channel stay separate exactly as in the MVP; the replay reads both after the fact and shows them side by side. If the replay ever became an input to the verdict, the false-success number would be worthless — the same rule that governs the whole product.

## Why this, and why not "just a video"

A raw session replay is table stakes. Playwright's trace viewer, Browserbase session replay, and browser-use all show one, and they look identical whether a checkout landed or silently failed. The video alone is the competitor's product: the agent's story told visually.

The differentiator is the **index**, not the picture. "Seek to every `did-not-land` write" is a query only TrueFact can answer, because only TrueFact computes the verdict independently. Video indexed by verdict turns a linear recording into something searchable by outcome. That is the wow — and it is impossible without the verdict, which is the moat.

The per-step screenshot in the MVP is a different artifact and stays: it is a **citation**, the single frame at the moment a verdict was decided, for auditing one failure. The replay is the continuous view. One does not replace the other; the screenshot is also the poster frame and the fallback when no video was recorded.

## Design

### Capture: delegate it, don't build it

TrueFact does not build a video pipeline. Stagehand runs on Playwright/CDP, where capture is a config line:

- **Playwright video** — `recordVideo` on the browser context yields one `.webm` per run.
- **Playwright trace** — `tracing.start({ screenshots: true, snapshots: true })` yields a `trace.zip`: a scrubbable DOM+screenshot+network timeline, openable in the existing trace viewer.
- **Browserbase** — every session already has a hosted, seekable replay URL.

`withReplay` gains an option to record the capture handle per run (a local path, or the Browserbase session id). It stores the handle; it does not process frames. Reinventing the trace viewer is the thing to not do.

### Index: the part TrueFact owns

Each `Step` already carries a `timestamp`. The run emits a sidecar index — one entry per step — joining the verdict to a position in the capture:

```
{ step, kind, action, verdict, reason, media: { source, offsetMs | traceTs | sessionTs } }
```

- For a Playwright video, `offsetMs = step.timestamp − run.start`.
- For a `trace.zip`, the step timestamp maps onto the trace timeline.
- For Browserbase, the step timestamp maps onto the session replay's clock.

The index is pure post-processing over data already recorded — no new capture, no coupling to the verdict logic.

### Viewer: thin

MVP-of-the-feature is the index JSON plus a static single-file HTML viewer that embeds the `.webm` (or links the trace/Browserbase URL), lists steps with their verdicts, filters to `did-not-land` / `inconclusive`, and seeks the media on click. No server, no build step, no dependency — same posture as the rest of the library.

## Privacy: the one thing not to simplify away

The MVP redacts secrets from the a11y tree, form snapshots, and step text. **Video and DOM snapshots defeat that** — a password typed into a field is visible pixel-by-pixel in a `.webm`, and a DOM snapshot carries input values the text redaction never saw. So:

- Capture is **off by default**; the caller opts in per run.
- When capture is on, warn once that frames may contain secrets and are not redacted.
- Prefer Playwright's input masking (`mask` / `maskColor` on screenshots) and password-field masking where the capture layer supports it; document that it is best-effort and pixels are not a trust boundary.

## Scope

**Build:** the capture-handle option, the sidecar index, the thin viewer.
**Delegate:** all frame/video/trace capture to Playwright or Browserbase.
**Do not build:** a screenshot-diffing judge, video as evidence that feeds the verdict, a hosted dashboard, or any capture pipeline of our own.

## Open questions

- **Storage for the benchmark.** 200+ write steps × 5+ runs × many tasks is a lot of `.webm`. The benchmark likely runs capture **off** (it needs the verdict, not the video); the replay is a user-facing feature, not a benchmark artifact. Confirm before wiring capture into the bench runner.
- **Local vs Browserbase.** The index format must abstract over a local file offset and a hosted session clock without special-casing the viewer. Verify both seek accurately against real timestamps.
- **Clock skew.** Step timestamps are wall-clock at record time; video offsets are capture-relative. Measure the drift on a real run before trusting click-to-seek to land on the right frame.

## Done when

- A completed run with capture on emits an index that lets the viewer seek to every `did-not-land` and `inconclusive` write step, verdict and reason shown beside each.
- With capture off, every step still carries its verdict-anchored screenshot (unchanged from the MVP).
- The verdict is computed identically whether or not capture is on — proven by a test that runs the same fixture both ways and asserts identical verdicts.
