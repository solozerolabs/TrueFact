// The one-call entry point. `launch()` owns the browser so the developer never
// has to know about the debug port that network verification needs: it picks a
// free one, starts Chrome on it, creates Stagehand, wraps it with the network
// sidecar ON, and folds browser teardown into close(). Zero config.
//
// Bring-your-own-browser? Use `withReplay(driver)` directly (network is then
// opt-in via { network: { port } }, since you own the launch). See README.
import { createServer } from "node:net";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { withReplay, type Wrapped, type ReplayOptions } from "./index.js";

/** An ephemeral free TCP port (bind :0, read it, release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface LaunchOptions extends Omit<ReplayOptions, "network"> {
  model?: { modelName: string; apiKey?: string }; // your Stagehand model; TrueFact is model-agnostic
  headless?: boolean; // default true
  port?: number; // override the auto-picked Chrome debug port (rarely needed)
}

export interface Launched extends Wrapped {
  stagehand: Stagehand;
  browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  /** Close the network sidecar AND the browser this launched. */
  close(): Promise<void>;
}

/**
 * Launch a browser with network verification on, and return the wrapped driver.
 *
 *   const tr = await launch({ model: { modelName: "anthropic/claude-sonnet-5", apiKey } });
 *   await tr.page.goto(url);
 *   await tr.act("click 'Place order'");
 *   console.log(tr.replay.verdict);
 *   await tr.close();
 */
export async function launch(opts: LaunchOptions = {}): Promise<Launched> {
  const { model, headless, port: portOpt, ...replayOpts } = opts;
  const port = portOpt ?? (await freePort());
  const browser = await localBrowser.launch({ headless: headless ?? true, port });
  // Cast: Stagehand types modelName as a 140-model literal union; we accept any
  // string so callers aren't pinned to our copy of that list.
  const createOpts = { browser, logging: { level: "error" }, ...(model ? { model } : {}) } as Parameters<typeof Stagehand.create>[0];
  const stagehand = await Stagehand.create(createOpts);
  const wrapped = withReplay(stagehand, { ...replayOpts, network: { port } });
  const closeReplay = wrapped.close;
  return Object.assign(wrapped, {
    stagehand,
    browser,
    close: async () => {
      await closeReplay();
      await browser.close();
    },
  });
}
