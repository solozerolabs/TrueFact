import type { Step } from "./index.js";
/** Render a standalone HTML timeline for a set of recorded steps. Pure. */
export declare function renderHtml(steps: Step[], title?: string): string;
/** Read a run's jsonl, write `<path>.html` beside it, and return the html path. */
export declare function viewFile(jsonlPath: string): string;
