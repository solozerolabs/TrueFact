/**
 * Canonical JSON per RFC 8785 (JCS): keys sorted by UTF-16 code unit, undefined
 * dropped, numbers and strings emitted by JSON.stringify — which is exactly the
 * ECMAScript Number-to-String and minimal string escaping JCS mandates. So the
 * bytes are third-party verifiable: any RFC 8785 implementation re-hashes a
 * TrueFact step to the same digest. Conformance is proven against the official
 * reference vectors in test/chain-jcs.test.ts — keep that green.
 */
export declare function canonical(v: unknown): string;
/** sha256 of a step's canonical form, minus its own hash/sig. */
export declare function hashStep(step: object): string;
export interface ChainLink {
    prevHash?: string;
    hash?: string;
    sig?: string;
}
/** An ed25519 signer over a step's hash. Caches the key; returns base64. */
export declare function makeSigner(privateKeyPem: string): (hashHex: string) => string;
/** Verify one hash's ed25519 signature against a public key. */
export declare function verifyHashSig(hashHex: string, sigB64: string, publicKeyPem: string): boolean;
export interface ChainResult {
    ok: boolean;
    length: number;
    brokenAt?: number;
    reason?: string;
}
/**
 * Recompute the chain and report the first break. A run's first step links to
 * "" (empty). One jsonl file is one run — the chain resets per withTrueFact
 * instance, so verify a single run's file, not several concatenated.
 */
export declare function verifyChain(steps: ChainLink[], opts?: {
    publicKey?: string;
}): ChainResult;
