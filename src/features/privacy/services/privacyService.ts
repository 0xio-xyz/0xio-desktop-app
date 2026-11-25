import { pvacBridge } from "src/services/pvac/pvacBridge";
import { walletBridge } from "src/services/wallet/walletBridge";
import * as networkService from "src/services/network/networkService";
import * as cryptoService from "src/services/crypto/cryptoService";
import { buildHfheTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import type { TxScope } from "src/services/network/networkService";
import type { SignedTransaction } from "src/types/transaction";
import { logger } from "src/lib/logger";
import { liveFeeOf, type LiveFee } from "src/services/transactions/reviewedFee";
import { feeFloor } from "src/services/network/feePolicy";
import { TxSubmitError, UnclearSubmitError } from "src/services/network/submitErrors";
import {
  keyUpdateMismatch,
  type KeyUpdateExpectation,
} from "src/features/privacy/services/keyUpdatePolicy";
import {
  recordPendingKeySwitch,
  getPendingKeySwitch,
  clearPendingKeySwitch,
  STAGED_WINDOW_MS,
} from "src/features/privacy/services/keySwitchService";
import {
  claimCap,
  boundedKeySwitchFee,
  cipherProofRoute,
  PRIVATE_SPEND_REFRESH_BASE_LAYERS,
} from "src/features/privacy/services/pvacUpgradePolicy";
import {
  checkProofPolicy,
  proofPolicyFor,
  PROOF_POLICY_BIND_KEY,
  type ProofPolicy,
} from "src/features/privacy/services/proofPolicy";
import {
  seedClaimBudget,
  seedClaimBudgetEmpty,
  consumeClaimSlot,
  refundClaimSlot,
  hasClaimSlot,
  plausibleLayers,
} from "src/features/privacy/services/claimBudget";
import { scanDone, scanStart } from "src/features/privacy/services/scanCursor";
import {
  CLAIM_CONFLICT,
  ClaimRefusedError,
  claimResendFor,
  claimSlot,
  forgetClaimTx,
  outputRefusal,
  readOutputState,
  recordClaim,
  watchClaims,
} from "src/features/privacy/services/claimLedger";

let cachedLocalPubkey: { ctx: string; pubkey: string } | null = null;
const confirmedRegistered = new Map<string, number>();

let localPubkeyInFlight: { ctx: string; promise: Promise<string> } | null = null;

function forgetLocalPubkey(): void {
  cachedLocalPubkey = null;
  localPubkeyInFlight = null;
}

export async function getLocalPubkey(address: string): Promise<string> {
  const ctx = pvacBridge.requireContext(address);
  if (cachedLocalPubkey?.ctx === ctx) return cachedLocalPubkey.pubkey;
  if (localPubkeyInFlight?.ctx === ctx) return localPubkeyInFlight.promise;
  logger.info("privacy", "serializing PVAC pubkey (first time, will cache)...");
  const entry = {
    ctx,
    promise: pvacBridge
      .serializePubkey(ctx)
      .then(({ pubkey }) => {
        if (localPubkeyInFlight === entry) cachedLocalPubkey = { ctx, pubkey };
        return pubkey;
      })
      .finally(() => {
        if (localPubkeyInFlight === entry) localPubkeyInFlight = null;
      }),
  };
  localPubkeyInFlight = entry;
  return entry.promise;
}

const ourPubkeyCache = new Map<string, boolean>();
let ourPubkeyCacheCtx: string | null = null;

/** Mirrors webcli pvac_pubkey_matches_secret_profile; its pubkey_extends_local and legacy_v1 routes are not ported. */
export async function isOurPubkey(address: string, remotePubkey: string): Promise<boolean> {
  const ctx = pvacBridge.requireContext(address);
  if (ourPubkeyCacheCtx !== ctx) {
    ourPubkeyCache.clear();
    ourPubkeyCacheCtx = ctx;
  }
  const cached = ourPubkeyCache.get(remotePubkey);
  if (cached !== undefined) return cached;
  try {
    const { matches, profile } = await pvacBridge.matchesSecretProfile(remotePubkey, ctx);
    logger.info("privacy", `remote pubkey profile=${profile} derived-from-our-secret=${matches}`);
    if (ourPubkeyCacheCtx === ctx) ourPubkeyCache.set(remotePubkey, matches);
    return matches;
  } catch (e) {
    logger.warn("privacy", `matchesSecretProfile failed, treating as foreign: ${e}`);
    return false;
  }
}

export const PVAC_CACHE_TTL_KEY = "0xio_pvac_cache_ttl_minutes";
const PVAC_CACHE_TTL_DEFAULT_MINUTES = 30;

export function pvacCacheTtlMinutes(): number {
  const saved = parseInt(localStorage.getItem(PVAC_CACHE_TTL_KEY) ?? "", 10);
  return Number.isFinite(saved) && saved > 0 ? saved : PVAC_CACHE_TTL_DEFAULT_MINUTES;
}

function getPvacCacheTtlMs(): number {
  return pvacCacheTtlMinutes() * 60 * 1000;
}

export function pvacVerifiedCount(): number {
  const ttl = getPvacCacheTtlMs();
  let n = 0;
  for (const ts of confirmedRegistered.values()) if (Date.now() - ts <= ttl) n++;
  return n;
}

function isRegistrationCached(regKey: string): boolean {
  const ts = confirmedRegistered.get(regKey);
  if (ts === undefined) return false;
  if (Date.now() - ts > getPvacCacheTtlMs()) {
    confirmedRegistered.delete(regKey);
    return false;
  }
  return true;
}

// webcli MAX_SANE_ENC: 100M OCT in raw units.
const MAX_SANE_ENC = 100_000_000 * 1_000_000;

const CIPHER_PREFIX = "hfhe_v1|";

// A real balance cipher is tens of thousands of base64 characters: anything shorter is an empty
// value, never a corrupted cipher, so it must not raise the key switch overlay.
const MIN_CIPHER_CHARS = 64;

/**
 * `corrupted` is per call, not a module flag: concurrent decrypts for two wallets must not
 * pollute each other.
 */
interface PrivateBalanceResult {
  value: number | null;
  corrupted: boolean;
  /** Readable through the legacy fallback keys, but canonical private ops must not touch it. */
  legacy?: boolean;
}

/** pvac-handler expects raw base64 for every op except encode. */
function stripCipherPrefix(cipher: string): string {
  if (cipher.startsWith(CIPHER_PREFIX)) {
    return cipher.slice(CIPHER_PREFIX.length);
  }
  return cipher;
}

function randomBlindingB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return cryptoService.bytesToBase64(bytes);
}

// Keys stay in the wallet; these return only public values. initPvac must have run.

export async function encryptValue(
  valueRaw: number,
): Promise<{ cipher: string; commitment: string }> {
  const r = await pvacBridge.encrypt(valueRaw);
  const cipher = r.cipher.startsWith(CIPHER_PREFIX) ? r.cipher : CIPHER_PREFIX + r.cipher;
  return { cipher, commitment: r.commitment };
}

/**
 * The scheme binds the proof to a fresh Pedersen commitment and blinding, so all three come back;
 * a contract takes the fields it verifies.
 */
export async function makeZeroProof(
  cipher: string,
  valueRaw: number,
  scope: Pick<TxScope, "address" | "networkId">,
): Promise<{ proof: string; commitment: string; blinding: string }> {
  const policy = await proofPolicyFor(scope.address, scope.networkId);
  const blinding = randomBlindingB64();
  const { commitment } = await pvacBridge.pedersenCommit(valueRaw, blinding);
  const { proof } = await pvacBridge.makeBoundProof(
    stripCipherPrefix(cipher),
    valueRaw,
    blinding,
    policy,
  );
  await checkProofPolicy(scope.address, scope.networkId, policy);
  return { proof, commitment, blinding };
}

export async function makeRangeProof(cipher: string, valueRaw: number): Promise<{ proof: string }> {
  const { proof } = await pvacBridge.makeRangeProof(stripCipherPrefix(cipher), valueRaw);
  return { proof };
}

export async function initPvac(walletId: string, address: string): Promise<void> {
  await pvacBridge.ensureInit(walletId, address);
}

export async function destroyPvac(): Promise<void> {
  forgetLocalPubkey();
  networkService.clearPvacPubkeyCache();
  confirmedRegistered.clear();
  await pvacBridge.destroy();
}

export async function decryptCipher(
  address: string,
  cipher: string,
): Promise<PrivateBalanceResult> {
  const stripped = stripCipherPrefix(cipher);
  if (stripped.length < MIN_CIPHER_CHARS) return { value: 0, corrupted: false };
  pvacBridge.requireContext(address);
  try {
    const result = await pvacBridge.decrypt(stripped);
    if (result.corrupted || result.value < 0 || result.value > MAX_SANE_ENC) {
      logger.warn(
        "privacy",
        `decryptCipher: CORRUPTED - value=${result.value}, corrupted=${result.corrupted}`,
      );
      return { value: 0, corrupted: true };
    }
    logger.info(
      "privacy",
      `decryptCipher: value = ${result.value}${result.legacy ? " (legacy cipher)" : ""}`,
    );
    return { value: result.value, corrupted: false, legacy: result.legacy === true };
  } catch (e) {
    logger.error("privacy", "decryptCipher failed", e);
    return { value: null, corrupted: false };
  }
}

export async function getPrivateBalance(
  address: string,
  walletId: string,
  networkId: string = networkService.getNetwork(),
): Promise<PrivateBalanceResult> {
  return logger.timed("privacy", "getPrivateBalance", async () => {
    const regKey = networkService.scopeKey(address, networkId);
    const encrypted = await networkService.getEncryptedBalance(address, walletId, networkId);
    if (!encrypted) {
      logger.debug(
        "privacy",
        "getPrivateBalance: no cipher returned (PVAC pubkey not registered or no encrypted balance)",
      );
      return { value: 0, corrupted: false };
    }
    const stripped = stripCipherPrefix(encrypted);
    if (stripped.length < MIN_CIPHER_CHARS) {
      logger.debug(
        "privacy",
        `getPrivateBalance: placeholder cipher (${stripped.length} chars) -> 0`,
      );
      return { value: 0, corrupted: false };
    }
    logger.debug("privacy", `getPrivateBalance: cipher received (${encrypted.length} chars)`);
    pvacBridge.requireContext(address);
    try {
      const result = await pvacBridge.decrypt(stripped);
      if (result.corrupted || result.value < 0 || result.value > MAX_SANE_ENC) {
        logger.warn(
          "privacy",
          `getPrivateBalance: CORRUPTED - value=${result.value}, corrupted=${result.corrupted} (likely wrong encryption key)`,
        );
        confirmedRegistered.delete(regKey);
        return { value: 0, corrupted: true };
      }
      if (result.value === 0 && encrypted.length > 100 && !result.legacy) {
        logger.warn(
          "privacy",
          "getPrivateBalance: cipher exists but decrypted to 0 - invalidating PVAC registration cache (possible pubkey mismatch)",
        );
        confirmedRegistered.delete(regKey);
      }
      logger.info(
        "privacy",
        `getPrivateBalance: decrypted value = ${result.value}${result.legacy ? " (legacy cipher)" : ""}`,
      );
      return { value: result.value, corrupted: false, legacy: result.legacy === true };
    } catch (e) {
      logger.error("privacy", "getPrivateBalance: decrypt failed", e);
      confirmedRegistered.delete(regKey);
      return { value: null, corrupted: false };
    }
  });
}

export type PvacRegistrationState = "registered" | "unregistered" | "pending";

// Check only, never submits a key_switch. A secret derived remote key counts as registered; a
// different one is a rotation the key switch overlay owns.
export async function getPvacRegistrationState(
  address: string,
  networkId: string = networkService.getNetwork(),
): Promise<PvacRegistrationState> {
  const regKey = networkService.scopeKey(address, networkId);
  // The node sometimes answers octra_pvacPubkey without the key for a registered one; a confirmed
  // registration is trusted, or one such reply would ask a working wallet to set up again.
  if (isRegistrationCached(regKey)) return "registered";

  const [localPubkey, remotePubkey] = await Promise.all([
    getLocalPubkey(address),
    getPendingKeySwitch(networkId, address)
      ? networkService.getPvacPubkey(address, networkId, { fresh: true })
      : networkService.getPvacPubkey(address, networkId),
  ]);
  if (remotePubkey) {
    if (remotePubkey === localPubkey || (await isOurPubkey(address, remotePubkey))) {
      confirmedRegistered.set(regKey, Date.now());
    }
    return "registered";
  }
  const pending = getPendingKeySwitch(networkId, address);
  if (!pending) return "unregistered";
  // The node can keep answering null after the registration key_switch executed (devnet read lag):
  // once the tx is in a block the key counts as registered, and a rejected tx drops back.
  try {
    const detail = await networkService.getTransactionDetails(pending.txHash, networkId);
    const status = detail?.status?.toLowerCase();
    const confirmedOnChain =
      detail != null &&
      (detail.epoch != null ||
        detail.block_height != null ||
        status === "confirmed" ||
        status === "success" ||
        status === "executed");
    if (confirmedOnChain) {
      confirmedRegistered.set(regKey, Date.now());
      clearPendingKeySwitch(networkId, address, pending.txHash);
      return "registered";
    }
    const stillStaged = detail != null && status === "pending";
    const lapsed = !stillStaged && Date.now() - pending.submittedAt >= STAGED_WINDOW_MS;
    if (status === "failed" || status === "rejected" || lapsed) {
      clearPendingKeySwitch(networkId, address, pending.txHash);
      return "unregistered";
    }
  } catch {}
  return "pending";
}

export async function getPvacKeyOwnership(
  address: string,
  networkId: string = networkService.getNetwork(),
): Promise<PvacRegistrationState | "foreign"> {
  const state = await getPvacRegistrationState(address, networkId);
  if (state !== "registered") return state;
  return isRegistrationCached(networkService.scopeKey(address, networkId))
    ? "registered"
    : "foreign";
}

interface SpendReadiness {
  ready: boolean;
  needsCompact: boolean;
  /** 4 blocks spends; 6 is the last compactable state: one more private op is unrecoverable. */
  baseLayers: number;
  /** Advisory only: webcli would refresh, which loops on devnet. */
  nonCanonical: boolean;
  reason?: string;
}

// needsCompact: migrate first. ready false without it: not provable, the key must rotate.
export async function getSpendReadiness(
  address: string,
  walletId: string,
  networkId: string = networkService.getNetwork(),
): Promise<SpendReadiness> {
  const cipher = await networkService.getEncryptedBalance(address, walletId, networkId);
  const stripped = cipher ? stripCipherPrefix(cipher) : "";
  if (stripped.length < MIN_CIPHER_CHARS)
    return { ready: true, needsCompact: false, baseLayers: 0, nonCanonical: false };
  pvacBridge.requireContext(address);
  const check = await pvacBridge.checkBoundProvable(stripped);
  if (!check.provable)
    return {
      ready: false,
      needsCompact: false,
      baseLayers: check.base_layers,
      nonCanonical: false,
      reason: check.reason,
    };
  // Base layers only: webcli also refreshes a non-canonical balance, but the devnet v3 bound
  // migration cannot produce a canonical cipher yet and the fold would loop forever.
  const needsCompact = check.base_layers >= PRIVATE_SPEND_REFRESH_BASE_LAYERS;
  return {
    ready: !needsCompact,
    needsCompact,
    baseLayers: check.base_layers,
    nonCanonical: !check.canonical_r_com,
  };
}

export async function registerPvacKey(
  scope: TxScope,
  walletId: string,
  opts: { ou: string },
): Promise<void> {
  await ensurePvacRegistered(scope, walletId, true, opts.ou);
}

// Chain state cannot bound a burst of signatures (base layers move only when a tx lands), so this
// takes a slot from the persisted in-flight counter claims use, keyed by the cipher fingerprint.
export async function reserveLayerSlot(scope: TxScope, walletId: string): Promise<boolean> {
  // Seeding is idempotent per cipher fingerprint; unseeded, only one op would pass.
  try {
    const cipher = await networkService.getEncryptedBalance(
      scope.address,
      walletId,
      scope.networkId,
    );
    if (cipher) {
      pvacBridge.requireContext(scope.address);
      const check = await pvacBridge.checkBoundProvable(stripCipherPrefix(cipher));
      seedClaimBudget(scope, cipher, check?.base_layers ?? NaN);
    } else {
      seedClaimBudgetEmpty(scope);
    }
  } catch {}
  if (!hasClaimSlot(scope)) return false;
  return consumeClaimSlot(scope);
}

export async function assertSpendReady(
  address: string,
  walletId: string,
  networkId: string = networkService.getNetwork(),
): Promise<void> {
  const reg = await getPvacRegistrationState(address, networkId);
  if (reg !== "registered") {
    const e = new Error(
      reg === "pending"
        ? "Private balance setup is confirming on-chain. Try again in a moment."
        : "Set up your private balance first.",
    );
    e.name = "PvacSetupPending";
    throw e;
  }
  let spend: SpendReadiness;
  try {
    spend = await getSpendReadiness(address, walletId, networkId);
  } catch (e) {
    logger.warn("privacy", `spend-readiness pre-op check failed (${e}) - continuing (fail-open)`);
    return;
  }
  if (!spend.ready) {
    const e = new Error(
      spend.needsCompact
        ? "Migrate your balance first - use the Migrate balance button"
        : `This balance can't be spent privately yet: ${spend.reason ?? "needs key rotation"}.`,
    );
    e.name = spend.needsCompact ? "PvacCompactNeeded" : "PvacNotSpendable";
    throw e;
  }
}

export async function encryptBalance(
  scope: TxScope,
  amount: number,
  walletId: string,
  ou?: string,
  onProgress?: StealthProgressCallback,
): Promise<{ txHash: string }> {
  return logger.timed("privacy", "encryptBalance", async () => {
    const { address, networkId } = scope;
    networkService.assertScope(scope);
    pvacBridge.requireContext(address);
    const policy = await proofPolicyFor(address, networkId);
    // Registration and compaction are explicit user actions: the op only verifies.
    await assertSpendReady(address, walletId, networkId);

    logger.info("privacy", "encrypt: generating ciphertext...");
    const encResult = await pvacBridge.encrypt(amount);
    onProgress?.(1);

    logger.info("privacy", "encrypt: generating Pedersen commitment + bound proof...");
    const blinding = randomBlindingB64();
    const { commitment: amountCommitment } = await pvacBridge.pedersenCommit(amount, blinding);
    const proofResult = await pvacBridge.makeBoundProof(
      stripCipherPrefix(encResult.cipher),
      amount,
      blinding,
      policy,
    );
    onProgress?.(2);

    const encryptedData = JSON.stringify({
      cipher: encResult.cipher,
      amount_commitment: amountCommitment,
      zero_proof: proofResult.proof,
      blinding,
    });

    logger.info(
      "privacy",
      `encrypt: encrypted_data (${encryptedData.length} chars): cipher=${encResult.cipher.slice(0, 30)}... (${encResult.cipher.length}), commit=${amountCommitment.slice(0, 24)}..., proof=${proofResult.proof.slice(0, 30)}... (${proofResult.proof.length}), blinding=${blinding.slice(0, 16)}...`,
    );
    logger.info("privacy", `encrypt: building tx (dataLen=${encryptedData.length})...`);
    pvacBridge.requireContext(address);
    const tx = await buildHfheTx({
      from: address,
      to: address,
      amount: String(amount),
      opType: "encrypt",
      encryptedData,
      walletId,
      ou,
      scope,
    });
    onProgress?.(3);

    await checkProofPolicy(address, networkId, policy);
    const txHash = await broadcastSignedTx(tx, scope);
    return { txHash };
  });
}

export async function decryptBalance(
  scope: TxScope,
  amount: number,
  walletId: string,
  ou?: string,
  onProgress?: StealthProgressCallback,
): Promise<{ txHash: string }> {
  return logger.timed("privacy", "decryptBalance", async () => {
    const { address, networkId } = scope;
    networkService.assertScope(scope);
    pvacBridge.requireContext(address);
    const policy = await proofPolicyFor(address, networkId);
    // Registration and compaction are explicit user actions: the op only verifies.
    await assertSpendReady(address, walletId, networkId);

    logger.info("privacy", "decrypt: generating ciphertext...");
    const encResult = await pvacBridge.encrypt(amount);
    onProgress?.(1);

    logger.info("privacy", "decrypt: generating Pedersen commitment + bound proof...");
    const blinding = randomBlindingB64();
    const { commitment: amountCommitment } = await pvacBridge.pedersenCommit(amount, blinding);
    const proofResult = await pvacBridge.makeBoundProof(
      stripCipherPrefix(encResult.cipher),
      amount,
      blinding,
      policy,
    );
    onProgress?.(2);

    logger.info("privacy", "decrypt: fetching current cipher + computing range proof...");
    const currentCipher = await networkService.getEncryptedBalance(address, walletId, networkId);
    if (!currentCipher) {
      throw new Error("No encrypted balance - cannot compute remaining balance proof");
    }
    const currentBalance = await pvacBridge.decrypt(stripCipherPrefix(currentCipher));
    const deltaCipherB64 = stripCipherPrefix(encResult.cipher);
    const currentCipherB64 = stripCipherPrefix(currentCipher);
    const ctSubResult = await pvacBridge.ctSub(currentCipherB64, deltaCipherB64);
    const newBalanceCipherB64 = stripCipherPrefix(ctSubResult.result);
    const newBalanceVal = currentBalance.value - amount;
    // Key-bound range proof (webcli make_bound_range_proof): the chain rejects the old rp_v1 proof.
    const rpBalResult = await pvacBridge.makeBoundRangeProof(
      newBalanceCipherB64,
      newBalanceVal,
      policy,
    );
    logger.info("privacy", `decrypt: bound range proof done in ${rpBalResult.ms}ms`);
    onProgress?.(3);

    const encryptedData = JSON.stringify({
      cipher: encResult.cipher,
      amount_commitment: amountCommitment,
      zero_proof: proofResult.proof,
      blinding,
      range_proof_balance: rpBalResult.proof,
    });

    logger.info(
      "privacy",
      `decrypt: encrypted_data (${encryptedData.length} chars): cipher=${encResult.cipher.slice(0, 30)}... (${encResult.cipher.length}), commit=${amountCommitment.slice(0, 24)}..., proof=${proofResult.proof.slice(0, 30)}... (${proofResult.proof.length}), blinding=${blinding.slice(0, 16)}...`,
    );
    logger.info("privacy", `decrypt: building tx (dataLen=${encryptedData.length})...`);
    pvacBridge.requireContext(address);
    const tx = await buildHfheTx({
      from: address,
      to: address,
      amount: String(amount),
      opType: "decrypt",
      encryptedData,
      walletId,
      ou,
      scope,
    });
    onProgress?.(4);

    await checkProofPolicy(address, networkId, policy);
    const txHash = await broadcastSignedTx(tx, scope);
    return { txHash };
  });
}

export interface ClaimableOutput {
  id: number;
  amount: number;
  claimSecret: string; // hex
  blinding: string; // base64
  sender?: string;
  epoch?: number;
}

async function requireUnspent(scope: TxScope, output: ClaimableOutput): Promise<void> {
  const state = await readOutputState(output.id, scope.networkId, output.epoch);
  if (state !== "unspent") {
    logger.warn("privacy", `claim: output ${output.id} reads ${state}, nothing sent`);
    throw outputRefusal(state);
  }
}

function forgetClaimable(scope: TxScope, id: number): void {
  const scanKey = networkService.scopeKey(scope.address, scope.networkId);
  const cachedForScope = claimableByScope.get(scanKey);
  if (cachedForScope)
    claimableByScope.set(
      scanKey,
      cachedForScope.filter((c) => c.id !== id),
    );
}

async function recoverClaim(
  scope: TxScope,
  output: ClaimableOutput,
  hash: string,
  tx: SignedTransaction,
): Promise<{ txHash: string }> {
  logger.info(
    "privacy",
    `claim: resubmitting saved claim ${hash.slice(0, 12)} for output ${output.id}`,
  );
  networkService.assertScope(scope);
  try {
    const txHash = await broadcastSignedTx(tx, scope);
    recordClaim(scope, output.id, txHash, tx);
    forgetClaimable(scope, output.id);
    return { txHash };
  } catch (err) {
    if (err instanceof UnclearSubmitError) recordClaim(scope, output.id, err.hash, tx);
    else if (err instanceof TxSubmitError) forgetClaimTx(scope, hash);
    throw err;
  }
}

export async function claimOutput(
  scope: TxScope,
  output: ClaimableOutput,
  walletId: string,
  ou?: string,
  nonce?: number,
  onProgress?: StealthProgressCallback,
): Promise<{ txHash: string }> {
  return logger.timed("privacy", "claimOutput", async () => {
    const { address, networkId } = scope;
    networkService.assertScope(scope);
    pvacBridge.requireContext(address);
    logger.info(
      "privacy",
      `claim: output_id=${output.id}, amount=${output.amount}${nonce != null ? `, nonce=${nonce}` : ""}`,
    );

    const slot = claimSlot(scope, output.id);
    if (slot.kind === "blocked") throw new ClaimRefusedError("CLAIM_CONFLICT", CLAIM_CONFLICT);
    if (slot.kind === "previous") {
      forgetClaimable(scope, output.id);
      return { txHash: slot.hash };
    }
    if (slot.kind === "recovery") {
      const resend = await claimResendFor(scope, output, slot.tx, ou);
      if (resend === "resend") return recoverClaim(scope, output, slot.hash, slot.tx);
      if (resend !== "fresh") throw outputRefusal(resend === "spent" ? "spent" : "unknown");
      logger.info(
        "privacy",
        `claim: saved claim ${slot.hash.slice(0, 12)} is stale, building fresh`,
      );
    }
    await requireUnspent(scope, output);

    const policy = await proofPolicyFor(address, networkId);

    await ensurePvacRegistered(scope, walletId);

    // Transport errors fail open; an implausible layer reading fails closed.
    try {
      const cipher = await networkService.getEncryptedBalance(address, walletId, networkId);
      if (cipher) {
        const check = await pvacBridge.checkBoundProvable(stripCipherPrefix(cipher));
        if (!plausibleLayers(check.base_layers)) {
          const e = new Error("Balance state unreadable - claim blocked to protect the balance.");
          e.name = "PvacCompactNeeded";
          throw e;
        }
        // At 4 or more layers a claim walks toward the unrecoverable cap while the node refuses the
        // key_switch that could fold it back.
        if (check.base_layers >= PRIVATE_SPEND_REFRESH_BASE_LAYERS) {
          const mig = await networkService.getPvacMigrationStatus(address, networkId);
          const isV3 = mig?.cipher_class === "v3" || mig?.cipher_class === "key_bound";
          if (isV3 && mig?.can_key_switch === false) {
            const e = new Error("Migrate your balance first, then claim");
            e.name = "PvacCompactNeeded";
            throw e;
          }
        }
        seedClaimBudget(scope, cipher, check.base_layers);
      } else {
        seedClaimBudgetEmpty(scope);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "PvacCompactNeeded") throw err;
      logger.warn("privacy", `claim: layer pre-check failed (continuing): ${err}`);
    }
    // The slot itself is taken right before broadcast, so a failed proof build never burns it.
    if (!hasClaimSlot(scope)) {
      const e = new Error(
        "Migrate your balance first, then claim - one more claim would make it unrecoverable.",
      );
      e.name = "PvacCompactNeeded";
      throw e;
    }

    onProgress?.(1);

    logger.info("privacy", `claim: encrypting amount=${output.amount}...`);
    const encResult = await pvacBridge.encrypt(output.amount);
    logger.info(
      "privacy",
      `claim: encrypted - cipher=${encResult.cipher.length} chars, commitment=${encResult.commitment.slice(0, 24)}...`,
    );
    onProgress?.(2);

    const rawCipher = stripCipherPrefix(encResult.cipher);
    logger.info("privacy", `claim: generating bound proof...`);
    const proofResult = await pvacBridge.makeBoundProof(
      rawCipher,
      output.amount,
      output.blinding,
      policy,
    );
    logger.info("privacy", `claim: bound proof done - ${proofResult.proof.length} chars`);
    onProgress?.(3);

    const claimData = JSON.stringify({
      version: 5,
      output_id: output.id,
      claim_cipher: encResult.cipher,
      commitment: encResult.commitment,
      claim_secret: output.claimSecret,
      zero_proof: proofResult.proof,
    });

    logger.info("privacy", `claim: building tx (dataLen=${claimData.length})...`);
    pvacBridge.requireContext(address);
    const tx = await buildHfheTx({
      from: address,
      to: address,
      amount: "0",
      opType: "claim",
      encryptedData: claimData,
      walletId,
      ou,
      nonce,
      scope,
    });

    networkService.assertScope(scope);
    await checkProofPolicy(address, networkId, policy);
    await requireUnspent(scope, output);
    networkService.assertScope(scope);
    if (!consumeClaimSlot(scope)) {
      const e = new Error(
        "Migrate your balance first, then claim - one more claim would make it unrecoverable.",
      );
      e.name = "PvacCompactNeeded";
      throw e;
    }
    onProgress?.(4);
    let txHash: string;
    try {
      txHash = await broadcastSignedTx(tx, scope);
    } catch (err) {
      if (err instanceof UnclearSubmitError) recordClaim(scope, output.id, err.hash, tx);
      // Refund only on a definite rejection: anything else may have been accepted, and two phantom
      // layers beat a brick.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof TxSubmitError ||
        /rejected|invalid|nonce|duplicate|insufficient|malformed/i.test(msg)
      ) {
        refundClaimSlot(scope);
      }
      throw err;
    }
    recordClaim(scope, output.id, txHash, tx);
    forgetClaimable(scope, output.id);
    logger.info("privacy", `claim: broadcast OK -> ${txHash}`);
    return { txHash };
  });
}

export async function ensurePvacRegistered(
  scope: TxScope,
  walletId: string,
  allowRegister = false,
  ou?: string,
): Promise<void> {
  return logger.timed("privacy", "ensurePvacRegistered", async () => {
    const { address, networkId } = scope;
    const regKey = networkService.scopeKey(address, networkId);
    if (isRegistrationCached(regKey)) {
      logger.debug("privacy", "PVAC pubkey already confirmed registered (cached)");
      return;
    }

    const localPubkey = await getLocalPubkey(address);

    let remotePubkey: string | null;
    try {
      remotePubkey = await networkService.getPvacPubkey(address, networkId, { fresh: true });
    } catch {
      // An unreachable node is not "no key on chain": never register a duplicate on it.
      throw new Error("Network busy, could not verify encryption key. Please try again.");
    }
    logger.info(
      "privacy",
      `PVAC local pubkey: ${localPubkey.length} chars (~${Math.round(localPubkey.length / 1024)}KB), prefix=${localPubkey.slice(0, 24)}...`,
    );
    logger.info(
      "privacy",
      `PVAC remote pubkey: ${remotePubkey ? `${remotePubkey.length} chars (~${Math.round(remotePubkey.length / 1024)}KB), prefix=${remotePubkey.slice(0, 24)}...` : "null (not registered)"}`,
    );

    if (remotePubkey && remotePubkey === localPubkey) {
      logger.info(
        "privacy",
        `PVAC pubkey already registered (verified match, ${localPubkey.length} chars)`,
      );
      confirmedRegistered.set(regKey, Date.now());
      return;
    }

    if (remotePubkey) {
      // A registered key changes only by key_switch (the node refuses a re-registration); the
      // mismatch overlay owns this state.
      logger.info(
        "privacy",
        `PVAC pubkey MISMATCH: local=${localPubkey.length} vs remote=${remotePubkey.length} - rotation flow owns this, skipping re-register`,
      );
      confirmedRegistered.set(regKey, Date.now());
      return;
    }

    // The node registers a key only through a canonical key_switch tx, and only a user initiated op
    // may spend that fee.
    if (!allowRegister) {
      logger.debug("privacy", "no PVAC key on-chain - check-only, not registering");
      return;
    }
    if (!ou) throw new networkService.FeeUnavailableError();
    // Pending until it confirms: never submitted and paid twice.
    if (getPendingKeySwitch(networkId, address)) {
      const pendingErr = new Error(
        "Private balance setup is pending confirmation. Try again in a moment.",
      );
      pendingErr.name = "PvacSetupPending";
      throw pendingErr;
    }
    logger.info("privacy", "no PVAC key on-chain - submitting key_switch registration...");
    const { txHash } = await keySwitchBalance(scope, walletId, { ou });
    logger.info("privacy", `PVAC key_switch registration submitted (${txHash})`);
    // The key applies only once the tx confirms; a private op before that would be rejected.
    const setupErr = new Error(
      "Setting up private balance. This takes a moment - try again shortly.",
    );
    setupErr.name = "PvacSetupPending";
    throw setupErr;
  });
}

export type StealthProgressCallback = (step: number) => void;

export async function sendStealth(params: {
  scope: TxScope;
  recipient: string;
  amount: number;
  walletId: string;
  ou?: string;
  onProgress?: StealthProgressCallback;
}): Promise<{ txHash: string }> {
  const { scope, recipient, amount, walletId, ou, onProgress } = params;
  const { address, networkId } = scope;

  return logger.timed("privacy", "sendStealth", async () => {
    networkService.assertScope(scope);
    pvacBridge.requireContext(address);
    const policy = await proofPolicyFor(address, networkId);
    onProgress?.(0);

    await ensurePvacRegistered(scope, walletId);
    // Compaction is an explicit gate: PvacCompactNeeded or PvacNotSpendable for the Send screen,
    // never a hidden key_switch.
    await assertSpendReady(address, walletId, networkId);

    const viewPubB64 = await networkService.getViewPubkey(recipient, networkId);
    if (!viewPubB64) {
      throw new Error("Recipient has no view pubkey registered. They need to register first.");
    }

    let currentCipher: string | null = await networkService.getEncryptedBalance(
      address,
      walletId,
      networkId,
    );
    if (!currentCipher) {
      throw new Error("No encrypted balance - use Encrypt to deposit funds first.");
    }

    let currentBalance = await pvacBridge.decrypt(stripCipherPrefix(currentCipher));

    // A 0 from a real cipher can mean another client overwrote the PVAC key: register again and
    // retry once.
    if (currentBalance.value === 0 && currentCipher.length > 100) {
      logger.warn(
        "privacy",
        "stealth: balance decrypted to 0 with valid cipher - re-registering PVAC pubkey and retrying...",
      );
      confirmedRegistered.delete(networkService.scopeKey(address, networkId));
      await ensurePvacRegistered(scope, walletId);
      currentCipher = await networkService.getEncryptedBalance(address, walletId, networkId);
      if (currentCipher) {
        currentBalance = await pvacBridge.decrypt(stripCipherPrefix(currentCipher));
      }
    }

    if (!currentCipher || currentBalance.value < amount) {
      throw new Error(
        `Insufficient private balance: ${(currentBalance.value / 1_000_000).toFixed(6)} OCT < ${(amount / 1_000_000).toFixed(6)} OCT`,
      );
    }

    const { ephSk, ephPub } = cryptoService.generateEphemeralKeypair();
    const recipientViewPub = cryptoService.base64ToBytes(viewPubB64);
    const shared = await cryptoService.ecdhSharedSecret(ephSk, recipientViewPub);

    const [tag, claimSecret] = await Promise.all([
      cryptoService.computeStealthTag(shared),
      cryptoService.computeClaimSecret(shared),
    ]);
    const tagHex = cryptoService.bytesToHex(tag);
    const claimPub = await cryptoService.computeClaimPub(claimSecret, recipient);
    const claimPubHex = cryptoService.bytesToHex(claimPub);
    logger.debug(
      "privacy",
      `stealth setup done: ephPub=${cryptoService.bytesToBase64(ephPub).slice(0, 24)}...`,
    );

    const blinding = new Uint8Array(32);
    crypto.getRandomValues(blinding);
    const blindingB64 = cryptoService.bytesToBase64(blinding);
    const encAmount = await cryptoService.encryptStealthAmount(shared, amount, blinding);

    logger.info("privacy", "stealth: encrypting delta...");
    const encResult = await pvacBridge.encrypt(amount);
    const deltaCipherB64 = stripCipherPrefix(encResult.cipher);
    const currentCipherB64 = stripCipherPrefix(currentCipher);

    const ctSubResult = await pvacBridge.ctSub(currentCipherB64, deltaCipherB64);
    const newBalanceCipherB64 = stripCipherPrefix(ctSubResult.result);
    const newBalanceVal = currentBalance.value - amount;

    // The bound zero proof (consensus requires it) reads only the delta cipher, so it runs before
    // the range proofs.
    onProgress?.(1);
    const { commitment: amountCommitment } = await pvacBridge.pedersenCommit(amount, blindingB64);
    logger.info("privacy", "stealth: computing send_zero_proof (bound to amount)...");
    const sendZpResult = await pvacBridge.makeBoundProof(
      stripCipherPrefix(encResult.cipher),
      amount,
      blindingB64,
      policy,
    );
    logger.info("privacy", `stealth: send_zero_proof done (${sendZpResult.proof.length} chars)`);

    // Bound range proofs (webcli make_bound_range_proof), about 60 KB each instead of 2.8 MB per bit
    // proofs, keep the tx under the node's request size cap.
    onProgress?.(2);
    logger.info("privacy", "stealth: generating bound range proofs...");
    const rpDelta = await pvacBridge.makeBoundRangeProof(deltaCipherB64, amount, policy);
    const rpBalance = await pvacBridge.makeBoundRangeProof(
      newBalanceCipherB64,
      newBalanceVal,
      policy,
    );

    onProgress?.(3);

    const privateTransferData = JSON.stringify({
      version: 5,
      delta_cipher: encResult.cipher,
      commitment: encResult.commitment,
      range_proof_delta: rpDelta.proof,
      range_proof_balance: rpBalance.proof,
      eph_pub: cryptoService.bytesToBase64(ephPub),
      stealth_tag: tagHex,
      enc_amount: encAmount,
      claim_pub: claimPubHex,
      amount_commitment: amountCommitment,
      send_zero_proof: sendZpResult.proof,
    });

    logger.info("privacy", `stealth: building tx (dataLen=${privateTransferData.length})...`);
    pvacBridge.requireContext(address);
    const tx = await buildHfheTx({
      from: address,
      to: "stealth",
      amount: "0",
      opType: "stealth",
      encryptedData: privateTransferData,
      walletId,
      ou,
      scope,
    });
    onProgress?.(4);

    await checkProofPolicy(address, networkId, policy);
    const txHash = await broadcastSignedTx(tx, scope);
    return { txHash };
  });
}

// A scan starts at the cursor of its network and address (scanCursor.ts) and from epoch 0 once a
// day, so an output is never skipped for good.
const claimableByScope = new Map<string, ClaimableOutput[]>();
const scansInFlight = new Map<string, Promise<ClaimableOutput[]>>();
let scanGeneration = 0;
let lastScanMs = 0;
const SCAN_MS_CEILING = 5 * 60_000;

export function suggestedScanIntervalMs(): number {
  return Math.max(5 * 60_000, lastScanMs * 12);
}

/** A scan already running cannot repopulate it. */
export function resetStealthScanCache(): void {
  scanGeneration++;
  claimableByScope.clear();
  scansInFlight.clear();
}

type NodeStealthOutput = Awaited<ReturnType<typeof networkService.getStealthOutputs>>[number];

const STEALTH_MATCH_BATCH = 256;
const ASCII = /^[\x00-\x7f]*$/;

function isScannable(o: NodeStealthOutput): boolean {
  return (
    Number.isSafeInteger(o.id) &&
    o.id >= 0 &&
    [o.eph_pub, o.stealth_tag, o.enc_amount].every((v) => typeof v === "string" && ASCII.test(v))
  );
}

async function refuseUnlessScannable(walletId: string, address: string): Promise<void> {
  await walletBridge.matchStealthOutputs(walletId, address, []);
}

export function getStealthOutputs(
  walletId: string,
  address: string,
  networkId: string = networkService.getNetwork(),
): Promise<ClaimableOutput[]> {
  const key = networkService.scopeKey(address, networkId);
  const inFlight = scansInFlight.get(key);
  if (inFlight) {
    logger.debug("privacy", "scan: reusing in-flight scan");
    return inFlight;
  }
  const generation = scanGeneration;

  const doScan = logger.timed("privacy", "getStealthOutputs", async () => {
    await refuseUnlessScannable(walletId, address);
    let found = [...(claimableByScope.get(key) ?? [])];
    await watchClaims({ networkId, address }, new Map(found.map((c) => [c.id, c.epoch]))).catch(
      (e) => logger.warn("privacy", `scan: claim watch failed: ${e}`),
    );

    const head = await networkService.getChainHead(networkId).catch(() => null);
    const waitingFrom = Math.min(...found.map((c) => c.epoch ?? 0));
    const from = Math.min(scanStart(key, head, Date.now()), waitingFrom);
    logger.info(
      "privacy",
      `scan: fetching stealth outputs from epoch ${from} (paginated, cached=${found.length})...`,
    );
    const { outputs, complete } = await networkService.scanStealthOutputs(from, networkId);

    if (outputs.length === 0 && found.length > 0) {
      logger.info("privacy", "scan: RPC returned empty (timeout?), returning cached results");
      return found;
    }

    const claimedIds = new Set(outputs.filter((o) => o.claimed !== 0).map((o) => o.id));
    found = found.filter((c) => !claimedIds.has(c.id));

    const matchedIds = new Set(found.map((c) => c.id));
    const toCheck = outputs.filter((o) => o.claimed === 0 && !matchedIds.has(o.id));
    const scannable = toCheck.filter(isScannable);
    if (scannable.length < toCheck.length) {
      logger.warn(
        "privacy",
        `scan: ${toCheck.length - scannable.length} malformed output(s) skipped`,
      );
    }

    let newMatches = 0;

    for (let start = 0; start < scannable.length; start += STEALTH_MATCH_BATCH) {
      const batch = scannable.slice(start, start + STEALTH_MATCH_BATCH);
      const matches = await walletBridge.matchStealthOutputs(
        walletId,
        address,
        batch.map(({ id, eph_pub, stealth_tag, enc_amount }) => ({
          id,
          eph_pub,
          stealth_tag,
          enc_amount,
        })),
      );
      let at = 0;
      for (const match of matches) {
        while (at < batch.length && batch[at].id !== match.id) at++;
        const out = batch[at++];
        if (!out) break;
        const amount = Number(match.amount);
        logger.info(
          "privacy",
          `scan: MATCH output #${out.id} - amount=${amount}, epoch=${out.epoch_id}`,
        );
        found.push({
          id: out.id,
          amount,
          claimSecret: match.claim_secret,
          blinding: match.blinding,
          sender: out.sender_addr,
          epoch: out.epoch_id,
        });
        newMatches++;
      }
    }

    logger.info(
      "privacy",
      `scan: ${outputs.length} fetched, ${scannable.length} evaluated, ${newMatches} new match(es), ${found.length} claimable total`,
    );
    if (generation === scanGeneration) {
      claimableByScope.set(key, found);
      if (complete)
        scanDone(key, { from, head, waitingEpochs: found.map((c) => c.epoch), now: Date.now() });
    }
    return [...found];
  });

  const startedAt = Date.now();
  const scan: Promise<ClaimableOutput[]> = doScan.finally(() => {
    lastScanMs = Math.min(Date.now() - startedAt, SCAN_MS_CEILING);
    if (scansInFlight.get(key) === scan) scansInFlight.delete(key);
  });
  scansInFlight.set(key, scan);
  return scan;
}

// A locked balance migrates inside the key_switch tx (webcli build_pvac_migration_payload); the
// node refuses a bare rotation while one exists.

export type KeySwitchMode =
  | { mode: "empty_key_switch" }
  | { mode: "legacy_public_migration"; amount: number; oldCipher: string }
  | { mode: "legacy_zero_reset" }
  // The node migrates it through equality proofs (status.can_v3_migrate): a new bound proof and an
  // old bound key switch proof under the registered pubkey, sharing one Pedersen commitment.
  | {
      mode: "key_bound_migration";
      amount: number;
      oldCipher: string;
      oldPubkey: string;
      keyCurrent: boolean;
    }
  // The node does not allow the migration yet: reported instead of a bare key_switch that fails
  // after a fee. keyCurrent tells a fine key with a waiting balance from a real key issue.
  | { mode: "key_bound_unavailable"; keyCurrent: boolean }
  // webcli cipher_route: a history proof under the registered key plus a range proof of the new
  // cipher.
  | { mode: "cipher_proof"; amount: number; oldCipher: string; oldPubkey: string }
  | { mode: "blocked"; reason: string };

export async function resolveKeySwitchMode(
  address: string,
  walletId: string,
  networkId: string = networkService.getNetwork(),
): Promise<KeySwitchMode> {
  // Run together: this resolver is the user's wait in the key switch dialog.
  const [status, cipher] = await Promise.all([
    networkService.getPvacMigrationStatus(address, networkId),
    networkService.getEncryptedBalance(address, walletId, networkId),
  ]);
  const cls = status?.cipher_class ?? "";

  if (!cipher || cls === "empty") return { mode: "empty_key_switch" };

  // No migration audit: either the node lacks the RPC (all of mainnet today), where "try again"
  // never works, or a transient failure worth retrying. webcli words it the same way.
  if (!status) {
    return {
      mode: "blocked",
      reason: networkService.isMigrationStatusUnsupported(networkId)
        ? "this network does not report migration status for encrypted balances - no local upgrade is available, and your balance is unchanged"
        : "couldn't verify the encryption key state (node busy) - try again in a moment",
    };
  }

  if (cipherProofRoute(status)) return resolveCipherProof(address, cipher, networkId);

  if (cls === "v3" || cls === "key_bound") {
    const keyCurrent = status.key_class === "current";
    // Built only when the node opened the bound migration; otherwise reported unavailable rather
    // than a bare key_switch that fails after a fee.
    if (status.can_v3_migrate) {
      pvacBridge.requireContext(address);
      const dec = await pvacBridge.decrypt(stripCipherPrefix(cipher));
      if (dec.corrupted) return { mode: "key_bound_unavailable", keyCurrent };
      const oldPubkey = await getLocalPubkey(address);
      return {
        mode: "key_bound_migration",
        amount: dec.value,
        oldCipher: cipher,
        oldPubkey,
        keyCurrent,
      };
    }
    return { mode: "key_bound_unavailable", keyCurrent };
  }

  const replay = status?.legacy_public_replay;
  const replayNet = replay?.public_net_raw ?? replay?.public_net;
  if (replay?.can_public_migrate && replayNet != null) {
    const replayAmount = parseInt(String(replayNet), 10);
    if (!Number.isFinite(replayAmount) || replayAmount < 0) {
      return { mode: "blocked", reason: "legacy public migration replay amount is invalid" };
    }
    pvacBridge.requireContext(address);
    const dec = await pvacBridge.decrypt(stripCipherPrefix(cipher));
    if (dec.corrupted || dec.value !== replayAmount) {
      return {
        mode: "blocked",
        reason: "legacy public replay does not match the locally decoded balance",
      };
    }
    if (replayAmount === 0) return { mode: "legacy_zero_reset" };
    return { mode: "legacy_public_migration", amount: replayAmount, oldCipher: cipher };
  }
  if (replay?.audit_class === "hidden_witness") {
    return {
      mode: "blocked",
      reason: "legacy hidden balance needs commitment migration (not supported yet)",
    };
  }
  return {
    mode: "blocked",
    reason:
      replay?.reason || status?.reason || "the node does not allow a key switch for this account",
  };
}

async function resolveCipherProof(
  address: string,
  cipher: string,
  networkId: string,
): Promise<KeySwitchMode> {
  pvacBridge.requireContext(address);
  const dec = await pvacBridge.decrypt(stripCipherPrefix(cipher));
  if (dec.corrupted || dec.value < 0)
    return { mode: "blocked", reason: "historical balance cannot be opened by this wallet" };
  const oldPubkey = await networkService.getPvacPubkey(address, networkId, { fresh: true });
  if (!oldPubkey) return { mode: "blocked", reason: "registered pvac key is unavailable" };
  return { mode: "cipher_proof", amount: dec.value, oldCipher: cipher, oldPubkey };
}

/** Only when the policy binds proofs to the key (webcli fill_pvac_key_switch_tx). */
async function keyOwnerFields(
  address: string,
  policy: ProofPolicy,
): Promise<Record<string, string>> {
  if ((policy & PROOF_POLICY_BIND_KEY) === 0) return {};
  return pvacBridge.makeKeyOwnerProof(address, policy);
}

async function assertMigrationSourceLive(
  address: string,
  walletId: string,
  networkId: string,
  migration: Record<string, unknown>,
): Promise<void> {
  const source = migration.source_cipher_hash;
  if (typeof source !== "string") return;
  const latest = await networkService.getEncryptedBalance(address, walletId, networkId);
  if (!latest || (await sha256Hex(latest)) !== source)
    throw new Error("Your private balance changed. Review again.");
}

// webcli source_cipher_hash: sha256_hex of the cipher string.
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Over the cipher string as the RPC gave it, hfhe_v1| prefix included. */
export async function sourceCipherHash(cipher: string): Promise<string> {
  return sha256Hex(cipher);
}

export async function getKeySwitchFeeLive(
  tier: "recommended" | "fast" = "recommended",
  networkId: string = networkService.getNetwork(),
): Promise<LiveFee> {
  const rec = await networkService.getRecommendedFeeStrict("key_switch", networkId);
  const live = liveFeeOf(
    boundedKeySwitchFee(tier === "fast" ? (rec?.fast ?? rec?.recommended) : rec?.recommended),
    rec?.minimum,
  );
  if (!live) throw new networkService.FeeUnavailableError();
  return { ou: live.ou, floorOu: Math.max(live.floorOu, feeFloor("key_switch")) };
}

export async function getKeySwitchFeeQuote(
  tier: "recommended" | "fast" = "recommended",
  networkId: string = networkService.getNetwork(),
): Promise<string> {
  return String((await getKeySwitchFeeLive(tier, networkId)).ou);
}

async function buildMigrationPayload(
  mode: KeySwitchMode,
  policy: ProofPolicy,
): Promise<Record<string, unknown>> {
  if (mode.mode === "empty_key_switch") return {};
  if (mode.mode === "blocked") throw new Error(`key switch blocked: ${mode.reason}`);
  if (mode.mode === "key_bound_unavailable") {
    // The node refuses key updates while the balance waits for its v3 bound migration.
    throw new Error(
      "Network is not accepting key updates for this account yet - nothing is lost, try again later",
    );
  }

  if (mode.mode === "cipher_proof") {
    logger.info("privacy", "cipher_proof: building historical cipher and range proofs...");
    return {
      ...(await pvacBridge.buildCipherProofMigration(
        mode.oldPubkey,
        mode.oldCipher,
        mode.amount,
        policy,
      )),
    };
  }

  if (mode.mode === "key_bound_migration") {
    // webcli build_pvac_migration_payload, key_bound case.
    const { amount, oldCipher, oldPubkey } = mode;
    const blinding = randomBlindingB64();
    const { commitment } = await pvacBridge.pedersenCommit(amount, blinding);
    logger.info("privacy", `key_bound_migration: encrypting ${amount} for the fresh cipher...`);
    const encResult = await pvacBridge.encrypt(amount);
    const newCipher = stripCipherPrefix(encResult.cipher);
    const oldCipherRaw = stripCipherPrefix(oldCipher);
    logger.info(
      "privacy",
      "key_bound_migration: proving new (bound) + old (bound key-switch w/ pubkey)...",
    );
    const [newZp, oldZp] = await Promise.all([
      pvacBridge.makeBoundProof(newCipher, amount, blinding, policy),
      pvacBridge.makeBoundKeySwitchProofWithPubkey(
        oldCipherRaw,
        amount,
        blinding,
        oldPubkey,
        policy,
      ),
    ]);
    // Both proofs are checked against the shared commitment before submit, as webcli does.
    const [newOk, oldOk] = await Promise.all([
      pvacBridge.verifyBoundProof(newCipher, newZp.proof, commitment, policy),
      pvacBridge.verifyBoundKeySwitchProofWithPubkey(
        oldCipherRaw,
        oldZp.proof,
        commitment,
        oldPubkey,
        policy,
      ),
    ]);
    if (!newOk.valid || !oldOk.valid) {
      throw new Error(
        `local migration proof verification failed (new=${newOk.valid}, old=${oldOk.valid}) - not submitting`,
      );
    }
    logger.info("privacy", "key_bound_migration: both proofs verified locally");
    return {
      new_cipher: encResult.cipher,
      new_zero_proof: newZp.proof,
      amount_commitment: commitment,
      old_zero_proof: oldZp.proof,
      // The cipher string exactly as the RPC gave it, prefix included (see sourceCipherHash).
      source_cipher_hash: await sha256Hex(oldCipher),
    };
  }

  const amount = mode.mode === "legacy_zero_reset" ? 0 : mode.amount;
  const blinding = randomBlindingB64();
  logger.info("privacy", `keySwitch migration: mode=${mode.mode} encrypting ${amount}...`);
  const encResult = await pvacBridge.encrypt(amount);
  const { commitment } = await pvacBridge.pedersenCommit(amount, blinding);
  const newZp = await pvacBridge.makeBoundProof(
    stripCipherPrefix(encResult.cipher),
    amount,
    blinding,
    policy,
  );
  // Both proofs are checked against the commitment before submit, as webcli does.
  const check = await pvacBridge.verifyBoundProof(
    stripCipherPrefix(encResult.cipher),
    newZp.proof,
    commitment,
    policy,
  );
  if (!check.valid) {
    throw new Error("local migration proof verification failed - not submitting");
  }

  const payload: Record<string, unknown> = {
    new_cipher: encResult.cipher,
    new_zero_proof: newZp.proof,
    amount_commitment: commitment,
  };

  if (mode.mode === "legacy_public_migration") {
    payload.legacy_public_migration = true;
    payload.amount_blinding = blinding;
  } else if (mode.mode === "legacy_zero_reset") {
    payload.legacy_zero_reset = true;
    payload.amount_blinding = blinding;
  }
  return payload;
}

/** "pending" after the window means still staged, not failed. */
export async function confirmKeySwitchOutcome(
  txHash: string,
  timeoutMs = 240_000,
  networkId: string = networkService.getNetwork(),
): Promise<{ status: "confirmed" | "rejected" | "pending"; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const tx = await networkService.getTransactionDetails(txHash, networkId);
      const status = (tx?.status ?? "pending").toLowerCase();
      if (status === "confirmed" || status === "accepted") return { status: "confirmed" };
      if (status === "rejected" || status === "failed")
        return { status: "rejected", reason: tx?.reject_reason ?? "unknown reason" };
    } catch {}
  }
  return { status: "pending" };
}

/**
 * Proofs are verified locally before broadcast, so a malformed one costs no fee, and only the
 * fee the review showed is spent.
 */
export async function migrateKeyBound(
  scope: TxScope,
  walletId: string,
  review: { ou: string; expect?: KeyUpdateExpectation },
): Promise<{ txHash: string; status: "confirmed" | "rejected" | "pending"; reason?: string }> {
  return logger.timed("privacy", "migrateKeyBound", async () => {
    const { txHash } = await keySwitchBalance(scope, walletId, review);
    const outcome = await confirmKeySwitchOutcome(txHash, 180_000, scope.networkId);
    return { txHash, ...outcome };
  });
}

export async function buildKeyBoundMigrationPayload(
  address: string,
  walletId: string,
  onProgress?: (msg: string) => void,
  networkId: string = networkService.getNetwork(),
): Promise<{
  migration: Record<string, unknown>;
  policy: ProofPolicy;
  owner: Record<string, string>;
}> {
  pvacBridge.requireContext(address);
  const policy = await proofPolicyFor(address, networkId);
  const owner = keyOwnerFields(address, policy);
  owner.catch(() => {});
  const built = await buildKeyBoundMigration(address, walletId, policy, onProgress, networkId);
  return { migration: built, policy, owner: await owner };
}

async function buildKeyBoundMigration(
  address: string,
  walletId: string,
  policy: ProofPolicy,
  onProgress: ((msg: string) => void) | undefined,
  networkId: string,
): Promise<Record<string, unknown>> {
  const status = await networkService.getPvacMigrationStatus(address, networkId);
  if (cipherProofRoute(status)) {
    onProgress?.("Fetching balance...");
    const source = await networkService.getEncryptedBalance(address, walletId, networkId);
    if (!source) throw new Error("No encrypted balance on-chain");
    const mode = await resolveCipherProof(address, source, networkId);
    if (mode.mode === "blocked") throw new Error(`key switch blocked: ${mode.reason}`);
    onProgress?.("Building migration proofs (this takes a few minutes)...");
    return buildMigrationPayload(mode, policy);
  }
  if (!status || status.can_v3_migrate !== true) {
    throw new Error(
      `The node has not opened the v3 migration for this account yet (can_v3_migrate=${status?.can_v3_migrate}).`,
    );
  }
  onProgress?.("Fetching balance...");
  const cipher = await networkService.getEncryptedBalance(address, walletId, networkId);
  if (!cipher) throw new Error("No encrypted balance on-chain");
  // The old proof verifies under the registered pubkey: the same key can serialize differently
  // locally.
  const oldPubkey = await networkService.getPvacPubkey(address, networkId, { fresh: true });
  if (!oldPubkey) throw new Error("Registered PVAC pubkey unavailable");
  const dec = await pvacBridge.decrypt(stripCipherPrefix(cipher));
  if (dec.corrupted) throw new Error("Could not read the encrypted balance under the current key");
  const amount = dec.value;
  onProgress?.("Building migration proofs (this takes a few minutes)...");
  // webcli build_pvac_migration_payload, key_bound case.
  const blinding = randomBlindingB64();
  const { commitment } = await pvacBridge.pedersenCommit(amount, blinding);
  const encResult = await pvacBridge.encrypt(amount);
  const newCipher = stripCipherPrefix(encResult.cipher);
  const oldCipherRaw = stripCipherPrefix(cipher);
  const [newZp, oldZp] = await Promise.all([
    pvacBridge.makeBoundProof(newCipher, amount, blinding, policy),
    pvacBridge.makeBoundKeySwitchProofWithPubkey(oldCipherRaw, amount, blinding, oldPubkey, policy),
  ]);
  // Both proofs are checked against the shared commitment before submit, as webcli does.
  const [newOk, oldOk] = await Promise.all([
    pvacBridge.verifyBoundProof(newCipher, newZp.proof, commitment, policy),
    pvacBridge.verifyBoundKeySwitchProofWithPubkey(
      oldCipherRaw,
      oldZp.proof,
      commitment,
      oldPubkey,
      policy,
    ),
  ]);
  if (!newOk.valid || !oldOk.valid) {
    throw new Error(
      `Local migration proof verification failed (new=${newOk.valid}, old=${oldOk.valid}) - not submitting, no fee spent.`,
    );
  }
  const migration = {
    new_cipher: encResult.cipher,
    new_zero_proof: newZp.proof,
    old_zero_proof: oldZp.proof,
    amount_commitment: commitment,
    // The prefixed cipher string, see sourceCipherHash.
    source_cipher_hash: await sourceCipherHash(cipher),
  };
  logger.info(
    "migrate",
    `built + verified payload for ${address.slice(0, 8)}... (source=${String(migration.source_cipher_hash).slice(0, 8)}...)`,
  );
  return migration;
}

export async function submitKeyBoundMigration(
  scope: TxScope,
  walletId: string,
  migration: Record<string, unknown>,
  opts: { ou: string; policy: ProofPolicy; owner?: Record<string, string> },
): Promise<{ txHash: string }> {
  const { address, networkId } = scope;
  networkService.assertScope(scope);
  const { ou, policy } = opts;
  if (!ou) throw new networkService.FeeUnavailableError();
  const pubB64 = await getLocalPubkey(address);
  const rawPubBytes = cryptoService.base64ToBytes(pubB64);
  const hashBuf = await crypto.subtle.digest("SHA-256", rawPubBytes.buffer as ArrayBuffer);
  const pubkeyHashPrefix = cryptoService.bytesToHex(new Uint8Array(hashBuf).slice(0, 8));
  const aesKat = await pvacBridge.aesKat();
  const encryptedData = JSON.stringify({
    new_pubkey: pubB64,
    aes_kat: aesKat,
    ...migration,
    ...(opts.owner ?? (await keyOwnerFields(address, policy))),
  });
  logger.info(
    "migrate",
    `submitting same-key key_switch (ou=${ou}, dataLen=${encryptedData.length})`,
  );
  const tx = await buildHfheTx({
    from: address,
    to: address,
    amount: "0",
    opType: "key_switch",
    encryptedData,
    walletId,
    ou,
    message: `encryption key switch | new_key:${pubkeyHashPrefix}`,
    scope,
  });
  await checkProofPolicy(address, networkId, policy);
  const txHash = await broadcastSignedTx(tx, scope);
  // Same key switch: the local pubkey cache stays.
  confirmedRegistered.delete(networkService.scopeKey(address, networkId));
  networkService.clearPvacPubkeyCache();
  return { txHash };
}

/** A batch is capped at floor((6 - B) / 2) from a fresh read; an implausible reading gives 0. */
export async function getStealthSendBudget(
  address: string,
  walletId: string,
  networkId: string = networkService.getNetwork(),
): Promise<{ cap: number | null; baseLayers: number | null }> {
  try {
    const cipher = await networkService.getEncryptedBalance(address, walletId, networkId);
    if (!cipher) return { cap: null, baseLayers: null };
    pvacBridge.requireContext(address);
    const check = await pvacBridge.checkBoundProvable(stripCipherPrefix(cipher));
    if (!plausibleLayers(check.base_layers)) {
      logger.warn(
        "send",
        `stealth budget: implausible layer reading (${check.base_layers}) - failing closed`,
      );
      return { cap: 0, baseLayers: null };
    }
    return { cap: claimCap(check.base_layers), baseLayers: check.base_layers };
  } catch (e) {
    logger.warn("send", `stealth budget check failed (${e}) - continuing (fail-open)`);
    return { cap: null, baseLayers: null };
  }
}

export async function keySwitchBalance(
  scope: TxScope,
  walletId: string,
  opts: {
    ou: string;
    expect?: KeyUpdateExpectation;
    onStep?: (step: "resolve" | "build" | "send") => void;
  },
): Promise<{ txHash: string }> {
  return logger.timed("privacy", "keySwitchBalance", async () => {
    const { address, networkId } = scope;
    networkService.assertScope(scope);
    const policy = await proofPolicyFor(address, networkId);
    const pubB64 = await getLocalPubkey(address);

    const rawPubBytes = cryptoService.base64ToBytes(pubB64);
    const hashBuf = await crypto.subtle.digest("SHA-256", rawPubBytes.buffer as ArrayBuffer);
    const pubkeyHashPrefix = cryptoService.bytesToHex(new Uint8Array(hashBuf).slice(0, 8));
    logger.info("privacy", `keySwitch: pubkeyHashPrefix=${pubkeyHashPrefix}`);

    const aesKat = await pvacBridge.aesKat();
    logger.info("privacy", `keySwitch: aesKat=${aesKat}`);

    // A locked balance must migrate inside this tx, and a blocked account must not submit a rotation
    // the node will reject.
    opts.onStep?.("resolve");
    const mode = await resolveKeySwitchMode(address, walletId, networkId);
    logger.info("privacy", `keySwitch: mode=${mode.mode}`);
    if (opts.expect) {
      const changed = keyUpdateMismatch(mode, opts.expect);
      if (changed) throw new Error(changed);
    }
    opts.onStep?.("build");
    const owner = keyOwnerFields(address, policy);
    owner.catch(() => {});
    const migration = await buildMigrationPayload(mode, policy);
    await assertMigrationSourceLive(address, walletId, networkId, migration);

    const encryptedData = JSON.stringify({
      new_pubkey: pubB64,
      aes_kat: aesKat,
      ...migration,
      ...(await owner),
    });

    const { ou } = opts;
    if (!ou) throw new networkService.FeeUnavailableError();
    logger.info("privacy", `keySwitch: ou=${ou} (reviewed)`);

    pvacBridge.requireContext(address);
    const tx = await buildHfheTx({
      from: address,
      to: address,
      amount: "0",
      opType: "key_switch",
      encryptedData,
      walletId,
      ou,
      message: `encryption key switch | new_key:${pubkeyHashPrefix}`,
      scope,
    });

    opts.onStep?.("send");
    await checkProofPolicy(address, networkId, policy);
    const txHash = await broadcastSignedTx(tx, scope).catch((err) => {
      if (err instanceof UnclearSubmitError) recordPendingKeySwitch(networkId, address, err.hash);
      throw err;
    });

    confirmedRegistered.delete(networkService.scopeKey(address, networkId));
    networkService.clearPvacPubkeyCache();
    forgetLocalPubkey();

    recordPendingKeySwitch(networkId, address, txHash);

    logger.info("privacy", `keySwitch: broadcast OK -> ${txHash}`);
    return { txHash };
  });
}
