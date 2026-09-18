// M1 — the hash chain. Each recorded step commits to the one before it, so a
// stored run is tamper-evident: alter any field, drop a step, or reorder two,
// and verification fails at that point. This is the ledger core of SPEC-V2 §8;
// signing (ed25519) is layered on top in M9. Stdlib only (node:crypto).
//
// What the hash covers: the whole step INCLUDING prevHash and the sealed
// agent_claim, EXCLUDING only the step's own `hash`/`sig`. So the claim is
// tamper-evident even though no verdict/assertion path ever reads it.
//
// M9 signing: with a key set, each step also carries an ed25519 `sig` over its
// hash. `verifyChain(steps, { publicKey })` then checks integrity AND signature.
// Without a key, nothing changes — the hash chain alone still detects tamper.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/**
 * Canonical JSON per RFC 8785 (JCS): keys sorted by UTF-16 code unit, undefined
 * dropped, numbers and strings emitted by JSON.stringify — which is exactly the
 * ECMAScript Number-to-String and minimal string escaping JCS mandates. So the
 * bytes are third-party verifiable: any RFC 8785 implementation re-hashes a
 * TrueFact step to the same digest. Conformance is proven against the official
 * reference vectors in test/chain-jcs.test.ts — keep that green.
 */
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

/** An ed25519 signer over a step's hash. Caches the key; returns base64. */
export function makeSigner(privateKeyPem: string): (hashHex: string) => string {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  return (hashHex) => edSign(null, Buffer.from(hashHex), key).toString("base64");
}

/** Verify one hash's ed25519 signature against a public key. */
export function verifyHashSig(hashHex: string, sigB64: string, publicKeyPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(hashHex), createPublicKey(publicKeyPem), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export interface ChainResult {
  ok: boolean;
  length: number;
  brokenAt?: number; // index of the first bad step
  reason?: string;
}

/**
 * Recompute the chain and report the first break. A run's first step links to
 * "" (empty). One jsonl file is one run — the chain resets per withTrueFact
 * instance, so verify a single run's file, not several concatenated.
 */
export function verifyChain(steps: ChainLink[], opts: { publicKey?: string } = {}): ChainResult {
  let prev = "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if ((s.prevHash ?? "") !== prev) return { ok: false, length: steps.length, brokenAt: i, reason: "prevHash does not link to the previous step (reordered or dropped)" };
    if (s.hash !== hashStep(s)) return { ok: false, length: steps.length, brokenAt: i, reason: "hash mismatch (record was altered)" };
    if (opts.publicKey) {
      if (!s.sig) return { ok: false, length: steps.length, brokenAt: i, reason: "missing signature (a public key was given but this step is unsigned)" };
      if (!verifyHashSig(s.hash!, s.sig, opts.publicKey)) return { ok: false, length: steps.length, brokenAt: i, reason: "bad signature (wrong key or altered)" };
    }
    prev = s.hash!;
  }
  return { ok: true, length: steps.length };
}
