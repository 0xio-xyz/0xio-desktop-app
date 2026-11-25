import { invoke } from "@tauri-apps/api/core";
import { logger } from "src/lib/logger";
import { logPvacTiming } from "src/shared/dev/debugLogs";
import { canonicalAddress } from "src/services/crypto/cryptoService";
import type { ProofPolicy } from "src/features/privacy/services/proofPolicy";

export interface CipherLayer {
  idx: number;
  is_base: boolean;
  depth: number;
  pa: number;
  pb: number;
  pc_count: number;
  r_pc_count: number;
  has_r_com: boolean;
  edges: number;
  sigma_ones: number;
  sigma_bits: number;
}

interface EdgeSample {
  layer_id: number;
  idx: number;
  sign: "+" | "-";
  sigma_density: number;
}

export interface CipherStructure {
  num_layers: number;
  num_edges: number;
  num_c0: number;
  slots: number;
  cipher_bytes_len: number;
  base_layers: number;
  prod_layers: number;
  max_depth: number;
  sigma_ones: number;
  sigma_bits: number;
  layers: CipherLayer[];
  edge_samples: EdgeSample[];
}

interface CipherProofMigration {
  migration_mode: "cipher_proof";
  source_cipher_hash: string;
  new_cipher: string;
  old_zero_proof: string;
  new_range_proof: string;
  amount_commitment: string;
}

let initPromise: Promise<void> | null = null;
let initialized = false;
let initGen = 0;
let pendingOwner: string | null = null;
let ctxId: string | null = null;
let ctxOwner: string | null = null;

function resetLocal(): void {
  initGen++;
  initialized = false;
  initPromise = null;
  pendingOwner = null;
  ctxId = null;
  ctxOwner = null;
}

function call<T>(cmd: string, args: Record<string, unknown> = {}, ctx = ctxId): Promise<T> {
  if (!ctx) return Promise.reject(new Error("PVAC not initialized"));
  return invoke<T>(cmd, { ...args, ctxId: ctx }).catch((e) => {
    if (ctx === ctxId && /not initialized|belongs to another/i.test(String(e))) resetLocal();
    throw e;
  });
}

export const pvacBridge = {
  isInitialized(): boolean {
    return initialized;
  },

  contextId(): string | null {
    return initialized ? ctxId : null;
  },

  isInitializedFor(address: string): boolean {
    return initialized && ctxOwner === canonicalAddress(address);
  },

  requireContext(address: string): string {
    if (!initialized || !ctxId) throw new Error("PVAC not initialized");
    if (ctxOwner !== canonicalAddress(address)) {
      const e = new Error("Privacy engine is set up for another wallet. Try again.");
      e.name = "PvacContextMismatch";
      throw e;
    }
    return ctxId;
  },

  async ensureInit(walletId: string, ownerAddress: string): Promise<void> {
    const owner = canonicalAddress(ownerAddress);
    if (initialized && ctxOwner === owner) return;
    if (initPromise && pendingOwner === owner) return initPromise;
    if (initialized || initPromise) await this.destroy();
    logger.info("pvac", "initializing PVAC context...");
    const gen = ++initGen;
    pendingOwner = owner;
    const start = performance.now();
    initPromise = invoke<{ ready: boolean; init_ms?: number; ctx?: string }>("pvac_init_wallet", {
      walletId,
      expectAddress: ownerAddress,
    })
      .then((result) => {
        if (gen !== initGen) return;
        if (!result.ctx) throw new Error("PVAC init returned no context id");
        ctxId = result.ctx;
        ctxOwner = owner;
        initialized = true;
        const elapsed = performance.now() - start;
        logger.info(
          "pvac",
          `init complete - Rust: ${result.init_ms ?? "?"}ms, total IPC: ${elapsed.toFixed(0)}ms`,
        );
        logPvacTiming({
          operation: "init",
          duration: elapsed,
          timestamp: Date.now(),
          details: `Rust: ${result.init_ms ?? "?"}ms`,
        });
      })
      .catch((e) => {
        if (gen === initGen) {
          initPromise = null;
          pendingOwner = null;
        }
        logger.error("pvac", "init failed", e);
        throw e;
      });
    return initPromise;
  },

  async destroy(): Promise<void> {
    resetLocal();
    await invoke("pvac_destroy");
    logger.info("pvac", "context destroyed");
  },

  async encrypt(value: number): Promise<{ cipher: string; commitment: string; ms: number }> {
    const t0 = performance.now();
    const result = await call<{ cipher: string; commitment: string; ms: number }>("pvac_encrypt", {
      value,
    });
    const elapsed = performance.now() - t0;
    logger.pvacOp(`encrypt(${value})`, result);
    logPvacTiming({
      operation: "encrypt",
      duration: elapsed,
      timestamp: Date.now(),
      details: `value=${value}, cipher=${result.cipher.length} chars, Rust: ${result.ms}ms`,
    });
    return result;
  },

  async decrypt(
    cipher: string,
  ): Promise<{ value: number; ms: number; corrupted?: boolean; legacy?: boolean }> {
    const t0 = performance.now();
    const result = await call<{
      value: number;
      ms: number;
      corrupted?: boolean;
      // Cipher was written by an older pvac-rs build (pre-canonical-parity H) - readable via
      // the fallback keys, but canonical private ops cannot touch it until re-encrypted.
      legacy?: boolean;
    }>("pvac_decrypt", { cipher: cipher });
    const elapsed = performance.now() - t0;
    logger.pvacOp(
      `decrypt -> ${result.value}${result.corrupted ? " (CORRUPTED)" : ""}${result.legacy ? " (LEGACY)" : ""}`,
      result,
    );
    logPvacTiming({
      operation: "decrypt",
      duration: elapsed,
      timestamp: Date.now(),
      details: `value=${result.value}, cipher=${cipher.length} chars, Rust: ${result.ms}ms${result.corrupted ? " CORRUPTED" : ""}`,
    });
    return result;
  },

  async makeRangeProof(cipher: string, value: number): Promise<{ proof: string; ms: number }> {
    logger.info("pvac", `makeRangeProof started (value=${value})...`);
    const start = performance.now();
    const result = await call<{ proof: string; ms: number }>("pvac_make_range_proof", {
      cipher,
      value,
    });
    const total = performance.now() - start;
    logger.info(
      "pvac",
      `makeRangeProof done - Rust: ${result.ms}ms, IPC total: ${total.toFixed(0)}ms, proofLen=${result.proof.length}`,
    );
    logPvacTiming({
      operation: "rangeProof",
      duration: total,
      timestamp: Date.now(),
      details: `value=${value}, proof=${result.proof.length} chars, Rust: ${result.ms}ms`,
    });
    return result;
  },

  async makeParallelRangeProofs(
    cipher1: string,
    value1: number,
    cipher2: string,
    value2: number,
  ): Promise<{ proof1: string; proof2: string; ms: number }> {
    logger.info("pvac", `makeParallelRangeProofs started (v1=${value1}, v2=${value2})...`);
    const start = performance.now();
    const result = await call<{ proof1: string; proof2: string; ms: number }>(
      "pvac_make_parallel_range_proofs",
      { cipher1, value1, cipher2, value2 },
    );
    const total = performance.now() - start;
    logger.info(
      "pvac",
      `makeParallelRangeProofs done - Rust: ${result.ms}ms, IPC total: ${total.toFixed(0)}ms`,
    );
    logPvacTiming({
      operation: "parallelRangeProofs",
      duration: total,
      timestamp: Date.now(),
      details: `v1=${value1}, v2=${value2}, Rust: ${result.ms}ms`,
    });
    return result;
  },

  async makeBoundProof(
    cipher: string,
    amount: number,
    blinding: string,
    policy: ProofPolicy,
  ): Promise<{ proof: string; ms: number }> {
    logger.info("pvac", `makeBoundProof started (amount=${amount})...`);
    const start = performance.now();
    const result = await call<{ proof: string; ms: number }>("pvac_make_bound_proof", {
      cipher,
      amount,
      blinding,
      policy,
    });
    const total = performance.now() - start;
    logger.info(
      "pvac",
      `makeBoundProof done - Rust: ${result.ms}ms, IPC total: ${total.toFixed(0)}ms, proofLen=${result.proof.length}`,
    );
    logPvacTiming({
      operation: "boundProof",
      duration: total,
      timestamp: Date.now(),
      details: `amount=${amount}, proof=${result.proof.length} chars, Rust: ${result.ms}ms`,
    });
    return result;
  },

  async pedersenCommit(amount: number, blinding: string): Promise<{ commitment: string }> {
    const result = await call<{ commitment: string }>("pvac_pedersen_commit", {
      amount,
      blinding,
    });
    logger.debug("pvac", `pedersenCommit(${amount})`);
    return result;
  },

  async serializePubkey(ctx = ctxId): Promise<{ pubkey: string }> {
    const start = performance.now();
    const result = await call<{ pubkey: string }>("pvac_serialize_pubkey", {}, ctx);
    const elapsed = performance.now() - start;
    logger.info(
      "pvac",
      `serializePubkey done (${elapsed.toFixed(0)}ms, len=${result.pubkey.length})`,
    );
    logPvacTiming({
      operation: "serializePubkey",
      duration: elapsed,
      timestamp: Date.now(),
      details: `${result.pubkey.length} chars`,
    });
    return result;
  },

  async makeBoundRangeProof(
    cipher: string,
    value: number,
    policy: ProofPolicy,
  ): Promise<{ proof: string; ms: number }> {
    const start = performance.now();
    const result = await call<{ proof: string; ms: number }>("pvac_make_bound_range_proof", {
      cipher,
      value,
      policy,
    });
    const elapsed = performance.now() - start;
    logger.info(
      "pvac",
      `makeBoundRangeProof done - Rust: ${result.ms}ms, IPC total: ${elapsed.toFixed(0)}ms, proofLen=${result.proof.length}`,
    );
    return result;
  },

  async checkBoundProvable(cipher: string): Promise<{
    provable: boolean;
    reason: string;
    base_layers: number;
    canonical_r_com: boolean;
  }> {
    return await call<{
      provable: boolean;
      reason: string;
      base_layers: number;
      canonical_r_com: boolean;
    }>("pvac_check_bound_provable", {
      cipher,
    });
  },

  async diagnoseCipher(cipher: string): Promise<CipherStructure> {
    const res = await invoke<CipherStructure & { error?: string }>("pvac_diagnose_cipher", {
      cipher,
    });
    if (res?.error) throw new Error(res.error);
    return res;
  },

  async makeBoundKeySwitchProof(
    cipher: string,
    amount: number,
    blinding: string,
    policy: ProofPolicy,
  ): Promise<{ proof: string; ms: number }> {
    const start = performance.now();
    const result = await call<{ proof: string; ms: number }>("pvac_make_bound_key_switch_proof", {
      cipher,
      amount,
      blinding,
      policy,
    });
    logger.info(
      "pvac",
      `makeBoundKeySwitchProof done - Rust: ${result.ms}ms, IPC total: ${(performance.now() - start).toFixed(0)}ms`,
    );
    return result;
  },

  async verifyBoundProof(
    cipher: string,
    proof: string,
    commitment: string,
    policy: ProofPolicy,
  ): Promise<{ valid: boolean }> {
    const result = await call<{ valid: boolean }>("pvac_verify_bound_proof", {
      cipher,
      proof,
      commitment,
      policy,
    });
    logger.info("pvac", `verifyBoundProof -> ${result.valid}`);
    return result;
  },

  async circleVerifyZero(
    input: { ciphertext: string; zero_proof: string; pubkey: string; policy: ProofPolicy },
    ctx: string,
  ): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>(
      "pvac_circle_verify_zero",
      {
        ciphertext: input.ciphertext,
        zeroProof: input.zero_proof,
        pubkey: input.pubkey,
        policy: input.policy,
      },
      ctx,
    );
  },

  async circleVerifyBound(
    input: {
      ciphertext: string;
      zero_proof: string;
      amount_commitment?: string;
      pubkey: string;
      policy: ProofPolicy;
    },
    ctx: string,
  ): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>(
      "pvac_circle_verify_bound",
      {
        ciphertext: input.ciphertext,
        zeroProof: input.zero_proof,
        amountCommitment: input.amount_commitment ?? "",
        pubkey: input.pubkey,
        policy: input.policy,
      },
      ctx,
    );
  },

  // v3 bound-migration old_zero_proof: KeySwitchRefresh proof over the deep on-chain cipher, proven
  // under the OLD registered pubkey (webcli make_zero_proof_bound_key_switch_with_pubkey).
  async makeBoundKeySwitchProofWithPubkey(
    cipher: string,
    amount: number,
    blinding: string,
    pubkey: string,
    policy: ProofPolicy,
  ): Promise<{ proof: string; ms: number }> {
    const start = performance.now();
    const result = await call<{ proof: string; ms: number }>(
      "pvac_make_bound_key_switch_proof_with_pubkey",
      { cipher, amount, blinding, pubkey, policy },
    );
    logger.info(
      "pvac",
      `makeBoundKeySwitchProofWithPubkey done - Rust: ${result.ms}ms, IPC total: ${(performance.now() - start).toFixed(0)}ms`,
    );
    return result;
  },

  async verifyBoundKeySwitchProofWithPubkey(
    cipher: string,
    proof: string,
    commitment: string,
    pubkey: string,
    policy: ProofPolicy,
  ): Promise<{ valid: boolean }> {
    const result = await call<{ valid: boolean }>(
      "pvac_verify_bound_key_switch_proof_with_pubkey",
      { cipher, proof, commitment, pubkey, policy },
    );
    logger.info("pvac", `verifyBoundKeySwitchProofWithPubkey -> ${result.valid}`);
    return result;
  },

  /** key_switch owner_cipher and owner_proof (webcli fill_pvac_key_switch_tx). */
  async makeKeyOwnerProof(
    address: string,
    policy: ProofPolicy,
  ): Promise<{ owner_cipher: string; owner_proof: string }> {
    const result = await call<{ owner_cipher: string; owner_proof: string; ms: number }>(
      "pvac_make_key_owner_proof",
      { address, policy },
    );
    logger.info("pvac", `makeKeyOwnerProof done - Rust: ${result.ms}ms`);
    return { owner_cipher: result.owner_cipher, owner_proof: result.owner_proof };
  },

  /** Migration fields (webcli cipher_migration): `source` is the on-chain hfhe_v1| string. */
  async buildCipherProofMigration(
    pubkey: string,
    source: string,
    amount: number,
    policy: ProofPolicy,
  ): Promise<CipherProofMigration> {
    const start = performance.now();
    const { ms, ...migration } = await call<CipherProofMigration & { ms: number }>(
      "pvac_build_cipher_proof_migration",
      { pubkey, source, amount, policy },
    );
    logger.info(
      "pvac",
      `buildCipherProofMigration done - Rust: ${ms}ms, IPC total: ${(performance.now() - start).toFixed(0)}ms`,
    );
    return migration;
  },

  async matchesSecretProfile(
    pubkey: string,
    ctx = ctxId,
  ): Promise<{ matches: boolean; profile: number }> {
    const start = performance.now();
    const result = await call<{ matches: boolean; profile: number }>(
      "pvac_matches_secret_profile",
      { pubkey },
      ctx,
    );
    const elapsed = performance.now() - start;
    logger.info(
      "pvac",
      `matchesSecretProfile done (${elapsed.toFixed(0)}ms, matches=${result.matches}, profile=${result.profile})`,
    );
    return result;
  },

  async ctSub(a: string, b: string): Promise<{ result: string; ms: number }> {
    const t0 = performance.now();
    const res = await call<{ result: string; ms: number }>("pvac_ct_sub", { a, b });
    const elapsed = performance.now() - t0;
    logger.pvacOp("ctSub", res);
    logPvacTiming({
      operation: "ctSub",
      duration: elapsed,
      timestamp: Date.now(),
      details: `a=${a.length} chars, b=${b.length} chars, result=${res.result.length} chars`,
    });
    return res;
  },

  async commit(cipher: string): Promise<{ commitment: string }> {
    const result = await call<{ commitment: string }>("pvac_commit", { cipher });
    logger.debug("pvac", "commit done");
    return result;
  },

  async aesKat(): Promise<string> {
    const result = await invoke<{ kat: string }>("pvac_aes_kat");
    return result.kat;
  },
};
