// redactText is the always-on secret scrubber over every stored string. One
// case per pattern, plus the non-secret pass-through. See src/redact.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../src/redact.js";

describe("redactText: one case per pattern", () => {
  const cases: [string, string, string][] = [
    ["anthropic key", "key sk-ant-api03-AbC123_def456ghi789jkl now", "anthropic_key"],
    ["openai key", "OPENAI=sk-proj-AbC123def456ghi789jklmno done", "openai_key"],
    ["aws access key", "id AKIAIOSFODNN7EXAMPLE here", "aws_access_key"],
    ["github token", "ghp_" + "A".repeat(36) + " token", "github_token"],
    ["bearer token", "Authorization: Bearer aGVsbG8td29ybGQtdG9rZW4=", "bearer_token"],
    ["email", "reach me at ada@example.com please", "email"],
  ];
  for (const [name, input, label] of cases)
    it(`redacts a ${name}`, () => {
      const out = redactText(input);
      assert.match(out, new RegExp(`\\[REDACTED:${label}\\]`));
      // the raw secret run is gone
      assert.ok(!/sk-ant-api03-AbC123|sk-proj-AbC123|AKIAIOSFODNN7EXAMPLE|ghpAAA|aGVsbG8|ada@example\.com/.test(out.replace(/\[REDACTED:[a-z_]+\]/g, "")));
    });

  it("leaves ordinary text untouched", () => {
    const s = "click the Place order button and wait for 'Order #4242'";
    assert.equal(redactText(s), s);
  });
});
