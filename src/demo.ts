// `truefact demo` — the optimistic-UI catch, keyless, in one command.
//
// No API key: the demo drives a scripted click, not an agent, so no model is
// ever called — not to act, and (as always) not to judge. It serves a checkout
// page that shows "✅ Order placed" while its own POST 500s, then shows the two
// channels TrueFact already computes:
//   page-read alone → fooled (the ✅ text reads as landed)
//   with network    → did-not-land (the 5xx behind the ✅)
// The gap between those two lines is the whole product. Writes demo-run.jsonl
// so the viewer/asserter/verifier have something real to open.
//
// Stagehand is a peer dep and only supplies a keyless Chrome + Playwright page;
// it is dynamic-imported here so `view`/`verify`/`assert`/`fleet` stay engine-free.
import { createServer } from "node:http";
import net from "node:net";
import { withTrueFact } from "./index.js";
import { playwrightDriver } from "./driver-playwright.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => res(port));
    });
  });

// The trap, mirrored from the benchmark fixture: banner shown regardless, POST 500s.
const PAGE = `<!doctype html><meta charset=utf8><title>Checkout</title>
<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p>
<button id="place" type="button">Place order</button><p id="ok"></p>
<script>
  document.getElementById('place').onclick = async () => {
    try { await fetch('/submit', { method: 'POST' }); } catch (e) {}
    document.getElementById('ok').textContent = '✅ Order placed — confirmation #4242';
  };
</script>`;

export async function runDemo(): Promise<number> {
  let localBrowser: { launch(o: unknown): Promise<unknown> };
  let Stagehand: { create(o: unknown): Promise<{ browser: { context: { activePage(): Promise<unknown>; pages(): Promise<unknown[]> } }; close(): Promise<void> }> };
  try {
    ({ localBrowser, Stagehand } = (await import("@browserbasehq/stagehand")) as never);
  } catch {
    process.stderr.write(
      "truefact demo needs a browser engine. Install the peer:\n" +
        "  npm i @browserbasehq/stagehand   # or: bun add @browserbasehq/stagehand\n",
    );
    return 2;
  }

  // Fixture server: any GET serves the trap page; POST 500s (truth: NOT placed).
  const fx = createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end('{"ok":false,"error":"payment declined"}');
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  const fxPort = await freePort();
  await new Promise<void>((r) => fx.listen(fxPort, "127.0.0.1", () => r()));

  const port = await freePort();
  const browser = await localBrowser.launch({ headless: true, port });
  const sh = await Stagehand.create({ browser, logging: { level: "error" } });
  const ctx = sh.browser.context;
  const page = (await ctx.activePage()) ?? (await ctx.pages())[0];

  const jsonl = "demo-run.jsonl";
  const w = withTrueFact(playwrightDriver(page as never), { network: { port }, screenshots: false, waitMs: 1500, jsonl });
  await w.page.goto(`http://127.0.0.1:${fxPort}/`);
  await w.act({ selector: "#place", description: "Place order button", method: "click" });

  const step = w.replay.steps.at(-1)!;
  const pc = step.evidence.postcondition!;
  process.stdout.write("\n  The page said:  ✅ Order placed — confirmation #4242\n");
  process.stdout.write("  The server said: HTTP 500 (payment declined)\n\n");
  process.stdout.write(`  page-read alone : ${pc.auto.verdict}  ← the ✅ is not proof the order landed\n`);
  process.stdout.write(`  with network    : ${step.verdict}  ← ${pc.reason} (the POST behind the ✅)\n\n`);
  process.stdout.write(`  Recorded ${jsonl}. Now try:\n`);
  process.stdout.write(`    truefact view ${jsonl}      # the timeline\n`);
  process.stdout.write(`    truefact verify ${jsonl}    # the tamper-evident chain\n\n`);

  await w.close();
  await sh.close();
  fx.close();
  return step.verdict === "did-not-land" ? 0 : 1;
}
