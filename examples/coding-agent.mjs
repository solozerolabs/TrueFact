// Let a coding agent verify its own web change. "Tests pass" is the untrusted
// channel; the verdict is whether the server actually agrees. Declare what
// "landed" means — a page read AND an out-of-band probe of your own API.
// Run against your dev server: node examples/coding-agent.mjs
import { launch } from "truefact";

const tr = await launch({ model: { modelName: "anthropic/claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY } });

await tr.page.goto("http://localhost:3000/login");
await tr.act("sign in as the demo user");

const res = await tr.act("open the dashboard", {
  expect: [
    { kind: "probe", get: "/api/me", text: /"authenticated":true/ }, // the server agrees you're in
    { kind: "text", matches: /Signed in as/, role: "status" },        // and the UI reflects it
  ],
});
console.log(res.truefact.verdict, "—", res.truefact.why);

await tr.close();
process.exit(tr.replay.verdict === "landed" ? 0 : 1); // fail the PR unless the write actually landed
