# Security

TrueFact reads a browser it (or you) drives, and writes an evidence log. Two
areas matter.

## Reporting

Email the maintainers (see `package.json` `bugs`) with a description and a repro.
Please don't open a public issue for a vulnerability until it's fixed.

## What the tool exposes

- **`truefact serve --port <N>` / `truefact watch --port <N>`** attach to a
  Chrome DevTools port. That port is reachable by **any process running as the
  same user** — it is full control of the browser. Prefer `serve --cdp-fd <N>`
  (an inherited socket, no open port) on shared or multi-tenant hosts.
- **The evidence log** (`*.jsonl`) never stores cookies, request headers, or
  response bodies — those aren't captured. Password field values are masked at
  capture; API keys, tokens, and emails are scrubbed from every stored string.
  Name any other sensitive fields with `redactFields` to length-mask them.
- **The hash chain is integrity-checked, not tamper-proof.** Unsigned, anyone
  holding the file can recompute it, and dropping trailing steps leaves a valid
  shorter chain. Sign runs (`signingKey` / `TRUEFACT_SIGNING_KEY`) and verify
  with `--pubkey` when the log must be trustworthy against its own author.
