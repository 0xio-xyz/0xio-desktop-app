// Resource limits for anything a browsed circle can put in front of the wallet.
//
// Ported from webcli lib/circle_verifier_policy.hpp. Circle content is untrusted: the page is
// fetched from the chain and can hand the bridge arbitrary blobs. Without caps a hostile circle
// (or a compromised node answering a sealed read) can exhaust memory, and a pathological cipher
// could make verification unbounded. The cipher SHAPE check needs a deserialized cipher, so it
// runs in Rust (src-tauri/src/pvac/circle_verifier.rs) before any verification; the sizes and the
// lane are checked here first and again there.

/** webcli: max_ciphertext_encoded_bytes. */
export const MAX_CIPHERTEXT_B64 = 96 * 1024;
/** webcli: max_proof_encoded_bytes. */
export const MAX_PROOF_B64 = 64 * 1024;
/** webcli: max_commitment_encoded_bytes. A Pedersen commitment is 32 raw bytes. */
export const MAX_COMMITMENT_B64 = 64;

const encoder = new TextEncoder();
// webcli measures std::string, so UTF-8 bytes, not UTF-16 units.
const byteLength = (s: string) => (/^[\x00-\x7f]*$/.test(s) ? s.length : encoder.encode(s).length);

const sized = (max: number) => (s: unknown) =>
  typeof s === "string" && s.length > 0 && byteLength(s) <= max;

export const ciphertextSizeAllowed = sized(MAX_CIPHERTEXT_B64);
export const proofSizeAllowed = sized(MAX_PROOF_B64);
export const commitmentSizeAllowed = sized(MAX_COMMITMENT_B64);

export const VERIFIER_INPUT_TOO_LARGE = "circle verifier input exceeds resource policy";

/** The routes' 413 check: strings, inside the caps, and the commitment when the route takes one. */
export function assertVerifierInputs(input: {
  ciphertext: unknown;
  proof: unknown;
  commitment?: unknown;
}): void {
  const withCommitment = Object.prototype.hasOwnProperty.call(input, "commitment");
  if (
    !ciphertextSizeAllowed(input.ciphertext) ||
    !proofSizeAllowed(input.proof) ||
    (withCommitment && !commitmentSizeAllowed(input.commitment))
  )
    throw new Error(VERIFIER_INPUT_TOO_LARGE);
}

export const VERIFIER_BUSY = "circle verifier busy";

/**
 * Single-flight lease (webcli's Lane). PVAC verification is CPU-bound, so a circle must not be
 * able to start a second one while the first runs: it refuses rather than queueing.
 */
export class VerifierLane {
  private busy = false;

  /** Returns a release fn, or null when a verification is already running. */
  tryAcquire(): (() => void) | null {
    if (this.busy) return null;
    this.busy = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.busy = false;
      }
    };
  }
}

export const circleVerifierLane = new VerifierLane();
