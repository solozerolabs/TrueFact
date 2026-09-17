// M1 — the hash chain. Each recorded step commits to the one before it, so a
// stored run is tamper-evident: alter any field, drop a step, or reorder two,
// and verification fails at that point. This is the ledger core of SPEC-V2 §8;
// signing (ed25519) is layered on top in M9. Stdlib only (node:crypto).
//
// What the hash covers: the whole step INCLUDING prevHash and the sealed
// agent_claim, EXCLUDING only the step's own `hash`/`sig`. So the claim is
// tamper-evident even though no verdict/assertion path ever reads it.
import { createHash } from "node:crypto";

/** Deterministic JSON: keys sorted, undefined dropped. Same bytes on re-hash. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

/** sha256 of a step's canonical form, minus its own hash/sig. */
export function hashStep(step: object): string {
  const rest: Record<string, unknown> = { ...(step as Record<string, unknown>) };
  delete rest.hash;
  delete rest.sig;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export interface ChainLink {
  prevHash?: string;
  hash?: string;
  sig?: string;
}

export interface ChainResult {
  ok: boolean;
  length: number;
  brokenAt?: number; // index of the first bad step
  reason?: string;
}

/**
 * Recompute the chain and report the first break. A run's first step links to
 * "" (empty). One jsonl file is one run — the chain resets per withReplay
 * instance, so verify a single run's file, not several concatenated.
 */
export function verifyChain(steps: ChainLink[]): ChainResult {
  let prev = "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if ((s.prevHash ?? "") !== prev) return { ok: false, length: steps.length, brokenAt: i, reason: "prevHash does not link to the previous step (reordered or dropped)" };
    if (s.hash !== hashStep(s)) return { ok: false, length: steps.length, brokenAt: i, reason: "hash mismatch (record was altered)" };
    prev = s.hash!;
  }
  return { ok: true, length: steps.length };
}
