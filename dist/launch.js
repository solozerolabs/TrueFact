// The one-call entry point. `launch()` owns the browser so the developer never
// has to know about the debug port that network verification needs: it picks a
// free one, starts Chrome on it, creates Stagehand, wraps it with the network
// sidecar ON, and folds browser teardown into close(). Zero config.
//
// Bring-your-own-browser? Use `withTrueFact(driver)` directly (network is then
// opt-in via { network: { port } }, since you own the launch). See README.
import { createServer } from "node:net";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { withTrueFact } from "./index.js";
/** An ephemeral free TCP port (bind :0, read it, release). */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
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
export async function launch(opts = {}) {
    const { model, headless, port: portOpt, ...replayOpts } = opts;
    const port = portOpt ?? (await freePort());
    const browser = await localBrowser.launch({ headless: headless ?? true, port });
    // Cast: Stagehand types modelName as a 140-model literal union; we accept any
    // string so callers aren't pinned to our copy of that list.
    const createOpts = { browser, logging: { level: "error" }, ...(model ? { model } : {}) };
    const stagehand = await Stagehand.create(createOpts);
    const wrapped = withTrueFact(stagehand, { ...replayOpts, network: { port } });
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
