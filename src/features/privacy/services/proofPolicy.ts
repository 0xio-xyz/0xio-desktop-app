import * as networkService from "src/services/network/networkService";
import { PROOF_POLICY_CHANGED, PROOF_POLICY_UNAVAILABLE } from "src/services/transactions/feeCopy";
import { logger } from "src/lib/logger";

/** The webcli proof policy int: bit 0 wide arithmetic, bit 1 key bound proofs. */
export type ProofPolicy = 0 | 1 | 2 | 3;

export const PROOF_POLICY_BIND_KEY = 2;

export class ProofPolicyError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "ProofPolicy";
    this.detail = detail;
  }
}

const ARITHMETIC = "network proof arithmetic is unavailable";
const KEY_POLICY = "network proof key policy is unavailable";
const CHANGED = "proof policy changed; nothing sent; prepare the transaction again";

// webcli octra::profile_math: the one devnet runtime that predates proof_math reporting.
const DEVNET_RUNTIME = {
  schema: "octra-runtime-release-v1",
  chain_id: "octra-devnet-9871-cluster",
  consensus_rules_id: "finalized_rejection_commitment",
  consensus_profile: 16,
};
const DEVNET_PROFILE_HASHES = new Set([
  "86a3e354b18cad2cd2ec35c63a61924aa78363fef2e93e1b5f5b37badd7d0c0c",
  "1d46b19e336be6978b7a27b3fc04eda930cd58114858fd8a822c29c2e96ff13a",
]);

const READ_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30_000;

const unavailable = (detail: string) => new ProofPolicyError(PROOF_POLICY_UNAVAILABLE, detail);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const has = (o: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(o, key);

/** webcli octra::proof_policy over an octra_pvacMigrationStatus object that has proof_math. */
export function policyFromStatus(status: Record<string, unknown>): ProofPolicy {
  const key = has(status, "proof_key") ? status.proof_key : false;
  if (typeof key !== "boolean") throw unavailable(KEY_POLICY);
  let wide: boolean;
  if (status.proof_math === "wide") wide = true;
  else if (status.proof_math === "prior") wide = false;
  else throw unavailable(ARITHMETIC);
  return ((wide ? 1 : 0) | (key ? 2 : 0)) as ProofPolicy;
}

/** webcli octra::profile_math: policy 1 for the listed devnet runtime, refused for any other. */
export function policyFromRuntime(runtime: unknown): ProofPolicy {
  if (
    isRecord(runtime) &&
    runtime.schema === DEVNET_RUNTIME.schema &&
    runtime.chain_id === DEVNET_RUNTIME.chain_id &&
    runtime.consensus_rules_id === DEVNET_RUNTIME.consensus_rules_id &&
    runtime.consensus_profile === DEVNET_RUNTIME.consensus_profile &&
    typeof runtime.runtime_profile_hash === "string" &&
    DEVNET_PROFILE_HASHES.has(runtime.runtime_profile_hash)
  )
    return 1;
  throw unavailable(ARITHMETIC);
}

/** webcli read_proof_policy, given the migration status reply and a runtime reader. */
export async function resolveProofPolicy(
  address: string,
  status: unknown,
  readRuntime: () => Promise<unknown>,
): Promise<ProofPolicy> {
  if (!isRecord(status) || status.address !== address) throw unavailable(ARITHMETIC);
  if (has(status, "proof_math")) return policyFromStatus(status);
  let runtime: unknown;
  try {
    runtime = await readRuntime();
  } catch {
    throw unavailable(ARITHMETIC);
  }
  return policyFromRuntime(runtime);
}

const cache = new Map<string, { policy: ProofPolicy; at: number }>();
const inFlight = new Map<string, Promise<ProofPolicy>>();

async function readFresh(address: string, networkId: string): Promise<ProofPolicy> {
  const key = networkService.scopeKey(address, networkId);
  try {
    let status: unknown;
    try {
      status = await networkService.jsonRpcCallOn<unknown>(
        networkId,
        "octra_pvacMigrationStatus",
        [address],
        READ_TIMEOUT_MS,
      );
    } catch {
      throw unavailable(ARITHMETIC);
    }
    const policy = await resolveProofPolicy(address, status, () =>
      networkService.jsonRpcCallOn<unknown>(networkId, "octra_runtimeVersion", [], READ_TIMEOUT_MS),
    );
    cache.set(key, { policy, at: Date.now() });
    return policy;
  } catch (e) {
    cache.delete(key);
    if (e instanceof ProofPolicyError) logger.warn("privacy", `proof policy: ${e.detail}`);
    throw e;
  }
}

/** The proof policy to build a private op with on this network for this address. A read from
 *  the last few seconds is reused; checkProofPolicy always reads again before submit. */
export function proofPolicyFor(address: string, networkId: string): Promise<ProofPolicy> {
  const key = networkService.scopeKey(address, networkId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return Promise.resolve(hit.policy);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const read = readFresh(address, networkId).finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

/** webcli check_proof_policy: a fresh read right before submit, refusing when the policy the
 *  op was built with is no longer the network's. */
export async function checkProofPolicy(
  address: string,
  networkId: string,
  prepared: ProofPolicy,
): Promise<void> {
  const current = await readFresh(address, networkId);
  if (current !== prepared) throw new ProofPolicyError(PROOF_POLICY_CHANGED, CHANGED);
}
