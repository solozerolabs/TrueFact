import { type CdpAction } from "./driver-cdp.js";
import { type Step, type TrueFactOptions } from "./index.js";
import type { Declaration } from "./declaration.js";
export interface ServeOptions extends Omit<TrueFactOptions, "network"> {
    port: number;
    apiOrigins?: string[];
    bodyErrors?: boolean | RegExp;
}
export type ServeRequest = {
    id: number;
    op: "before";
    kind: "write" | "nav";
    action?: CdpAction;
    url?: string;
    expect?: Declaration | Declaration[];
} | {
    id: number;
    op: "after";
    threw?: string;
} | {
    op: "close";
};
export type ServeReply = {
    id?: number;
    ok: true;
    step?: Step;
} | {
    id?: number;
    ok: false;
    error: string;
};
export interface ServeSession {
    /** Handle one request; resolves with the reply to write back. */
    handle(req: ServeRequest): Promise<ServeReply>;
    close(): Promise<void>;
}
/** Attach to Chrome on `port`; null when there is no DevTools endpoint. */
export declare function startServe(opts: ServeOptions): Promise<ServeSession | null>;
export declare function runServeCli(argv: string[], io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
}): Promise<number>;
