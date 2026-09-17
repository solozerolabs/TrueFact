// Scrub secrets from the free-text fields of a step before it is persisted or
// shared. Password field *values* are already masked at capture time
// (postcondition.ts); this is the second net for keys, tokens and emails that
// ride along in an instruction, an agent message, or a tool argument.
// Ported from manasvardhan/agent-replay's redact.py (MIT).

// Ordered: more specific patterns first so the label is accurate.
const PATTERNS: [string, RegExp][] = [
  ["anthropic_key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai_key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["aws_access_key", /AKIA[0-9A-Z]{16}/g],
  ["github_token", /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ["bearer_token", /bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+\w/g],
];

/** Replace every secret-shaped run with `[REDACTED:label]`. */
export function redactText(text: string): string {
  let out = text;
  for (const [label, re] of PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}
