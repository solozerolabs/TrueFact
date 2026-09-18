import type { PageReader, Driver } from "./driver.js";
import type { CdpConn } from "./cdp.js";
/** An action the CALLER performs between before/after; the fields drive field
 *  verification exactly like the Playwright driver's action object. */
export interface CdpAction {
    selector?: string;
    method?: string;
    arguments?: string[];
}
/** How the driver performs (or awaits) an action. In `serve` this resolves when
 *  the external client says it is done. */
export type Perform = (kind: "act" | "goto", action: CdpAction | string) => Promise<unknown>;
/** Adapt a raw CDP page connection to the PageReader surface. */
export declare function cdpReader(conn: CdpConn, id?: string): PageReader;
/**
 * Adapt a raw CDP connection to the Driver surface. `act`/`goto` delegate to
 * `perform` — the caller owns the browser and does the clicking; the driver
 * reports the action so field verification works, and carries no claim
 * (agent_claim degrades to null, like the Playwright driver). Single page.
 */
export declare function cdpDriver(conn: CdpConn, perform: Perform): Driver;
