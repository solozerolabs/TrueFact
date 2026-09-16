// TrueReplay — Day 1: wrapper skeleton + two-channel logging.
// Verdicts are stubbed to "inconclusive" until the three checks land (Days 2–5).
// The one architectural invariant, present from the first commit: the agent's
// claim and the page's truth are recorded on SEPARATE fields and never compared here.

export type Verdict = "landed" | "did-not-land" | "inconclusive";

export interface Step {
  action: string;
  declaration: "auto" | Record<string, unknown>;
  verdict: Verdict;
  evidence: Record<string, unknown>; // page-truth channel (filled Days 2–5)
  agent_claim: unknown; // agent-claim channel — recorded, never read during measurement
  timestamp: string;
}

export interface Replay {
  steps: Step[];
  get verdict(): Verdict; // per-run roll-up
}

// ponytail: minimal Stagehand surface; type as the real Page once we depend on it.
interface StagehandPage {
  act(...args: unknown[]): Promise<unknown>;
  extract(...args: unknown[]): Promise<unknown>;
}

class ReplayImpl implements Replay {
  steps: Step[] = [];
  get verdict(): Verdict {
    if (this.steps.some((s) => s.verdict === "did-not-land")) return "did-not-land";
    if (this.steps.some((s) => s.verdict === "inconclusive")) return "inconclusive";
    return this.steps.length ? "landed" : "inconclusive";
  }
}

function describe(args: unknown[]): string {
  const a = args[0];
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && "instruction" in a) return String((a as any).instruction);
  return JSON.stringify(a);
}

export function withReplay<T extends StagehandPage>(page: T): { page: T; replay: Replay } {
  const replay = new ReplayImpl();

  const record = (action: string, decl: Step["declaration"], claim: unknown) => {
    replay.steps.push({
      action,
      declaration: decl,
      verdict: "inconclusive", // Days 2–5 compute this from the page
      evidence: {},
      agent_claim: claim,
      timestamp: new Date().toISOString(),
    });
  };

  const wrapped = new Proxy(page, {
    get(target, prop, recv) {
      if (prop === "act" || prop === "extract") {
        return async (...args: unknown[]) => {
          const claim = await (target as any)[prop](...args); // agent-claim channel
          record(`${String(prop)}: ${describe(args)}`, "auto", claim);
          return claim;
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as T;

  return { page: wrapped, replay };
}

// ponytail: one runnable self-check. `npm run check`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake: StagehandPage = {
    async act(a) { return { success: true, note: a }; },
    async extract() { return { total: "$42.00" }; },
  };
  const { page, replay } = withReplay(fake);
  await page.act("click submit");
  await page.extract({ instruction: "get order total" });
  const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  assert(replay.steps.length === 2, "two steps recorded");
  assert(replay.steps[0].agent_claim !== undefined, "agent claim on its own channel");
  assert(Object.keys(replay.steps[0].evidence).length === 0, "page-truth channel empty at Day 1");
  assert(replay.verdict === "inconclusive", "verdicts stubbed until checks land");
  console.log("ok — replay:", JSON.stringify(replay.steps, null, 2));
}
