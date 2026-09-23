// Verify an API / tool-call agent's writes — no browser. The tool's "ok" is the
// untrusted claim; the verdict is whether the record actually changed. Swap the
// in-memory CRM for your own read (GET the deal, SELECT the row).
// Runs as-is, no key: node examples/api-agent.mjs
import { openRun } from "truefact";

const crm = new Map([[123, { id: 123, stage: "Open", amount: 500 }]]);
const getDeal = (id) => crm.get(id) ?? null;

// Two tools an agent might call. The second one lies: it says ok, writes nothing.
const tools = {
  updateStage: (id, stage) => (crm.set(id, { ...crm.get(id), stage }), "Deal updated"),
  updateAmount: (_id, _amount) => "Amount updated",
};

const run = openRun({ jsonl: "runs/api-agent.jsonl", waitMs: 500 });

for (const [label, action, expect] of [
  ["move deal 123 to Closed Won", () => tools.updateStage(123, "Closed Won"), { stage: "Closed Won" }],
  ["set deal 123 amount to 5000", () => tools.updateAmount(123, 5000), { amount: 5000 }],
  ["touch deal 123", () => tools.updateStage(123, "Closed Won"), undefined], // no expect: can't decide
]) {
  const { value, truefact } = await run.write(label, action, { read: () => getDeal(123), expect });
  console.log(`${truefact.verdict.padEnd(13)} ${label}  (agent said: ${value}) — ${truefact.why}`);
}

console.log(`\nrun: ${run.replay.verdict}. See it: npx truefact view runs/api-agent.jsonl`);
