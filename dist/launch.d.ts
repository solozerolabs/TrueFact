import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { type Wrapped, type TrueFactOptions } from "./index.js";
export interface LaunchOptions extends Omit<TrueFactOptions, "network"> {
    model?: {
        modelName: string;
        apiKey?: string;
    };
    headless?: boolean;
    port?: number;
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
export declare function launch(opts?: LaunchOptions): Promise<Launched>;
