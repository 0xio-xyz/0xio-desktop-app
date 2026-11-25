import * as privacyService from "src/features/privacy/services/privacyService";
import * as networkService from "src/services/network/networkService";
import type { TxScope } from "src/services/network/networkService";
import {
  clearPendingKeySwitch,
  recordPendingKeySwitch,
} from "src/features/privacy/services/keySwitchService";
import { logger } from "src/lib/logger";
import type { LiveFee } from "src/services/transactions/reviewedFee";
import { assertReviewedFee, type SetupReview } from "src/features/privacy/services/setupReview";
import { proofPolicyFor, type ProofPolicy } from "src/features/privacy/services/proofPolicy";

type Payload = Record<string, unknown>;

const payloadKey = (networkId: string, address: string) =>
  `pvac_mig_payload_${networkId}_${address}`;

function readMigrationPayload(
  networkId: string,
  address: string,
): { sourceHash: string; migration: Payload; policy?: ProofPolicy } | null {
  try {
    const raw = localStorage.getItem(payloadKey(networkId, address));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeMigrationPayload(
  networkId: string,
  address: string,
  sourceHash: string,
  migration: Payload,
  policy: ProofPolicy,
): void {
  try {
    localStorage.setItem(
      payloadKey(networkId, address),
      JSON.stringify({ sourceHash, migration, policy }),
    );
  } catch (e) {
    logger.warn("migrate", `payload cache write failed (${e}) - an expiry will cost a rebuild`);
  }
}

function dropMigrationPayload(networkId: string, address: string): void {
  try {
    localStorage.removeItem(payloadKey(networkId, address));
  } catch {}
}

export async function cachedPayloadIsLive(
  address: string,
  walletId: string,
  networkId: string,
): Promise<boolean> {
  try {
    const stored = readMigrationPayload(networkId, address);
    if (!stored?.migration) {
      logger.debug("migrate", "no cached payload - full proof build on submit");
      return false;
    }
    const cipher = await networkService.getEncryptedBalance(address, walletId, networkId);
    const liveHash = cipher ? await privacyService.sourceCipherHash(cipher) : null;
    const reuse =
      !!liveHash &&
      liveHash === stored.sourceHash &&
      stored.policy === (await proofPolicyFor(address, networkId));
    logger.info(
      "migrate",
      `cached payload: stored=${stored.sourceHash.slice(0, 8)}... live=${liveHash?.slice(0, 8) ?? "none"} -> ${reuse ? "REUSE (skip proofs)" : "stale, discarding"}`,
    );
    if (!reuse) dropMigrationPayload(networkId, address);
    return reuse;
  } catch (e) {
    logger.warn("migrate", `cached-payload check failed (${e}) - will build fresh`);
    return false;
  }
}

export function refreshFeeQuote(reuse: boolean, networkId: string): Promise<string> {
  return privacyService.getKeySwitchFeeQuote(reuse ? "fast" : "recommended", networkId);
}

function refreshFeeLive(reuse: boolean, networkId: string): Promise<LiveFee> {
  return privacyService.getKeySwitchFeeLive(reuse ? "fast" : "recommended", networkId);
}

export async function quoteBalanceRefresh(
  address: string,
  walletId: string,
  networkId: string,
): Promise<{ reuse: boolean; fee: LiveFee }> {
  const reuse = await cachedPayloadIsLive(address, walletId, networkId);
  return { reuse, fee: await refreshFeeLive(reuse, networkId) };
}

export interface RefreshOutcome {
  txHash: string;
  status: "confirmed" | "rejected" | "pending";
  reason?: string;
}

export async function runBalanceRefresh(params: {
  scope: TxScope;
  walletId: string;
  reuse: boolean;
  ou: string;
  onProgress?: (msg: string) => void;
  onSubmitted?: (txHash: string) => void;
}): Promise<RefreshOutcome> {
  const { scope, walletId, reuse, ou, onProgress, onSubmitted } = params;
  const { address, networkId } = scope;
  logger.info("migrate", `starting for ${address.slice(0, 8)}... reuse=${reuse} reviewedFee=${ou}`);
  let migration: Payload | undefined;
  let policy: ProofPolicy | undefined;
  let owner: Record<string, string> | undefined;
  if (reuse) {
    const stored = readMigrationPayload(networkId, address);
    migration = stored?.policy === undefined ? undefined : stored.migration;
    policy = stored?.policy;
    if (migration) {
      logger.info("migrate", "reusing cached payload - skipping proof build");
      onProgress?.("Reusing prepared migration...");
    }
  }
  if (!migration || policy === undefined) {
    const buildT0 = Date.now();
    const built = await privacyService.buildKeyBoundMigrationPayload(
      address,
      walletId,
      onProgress,
      networkId,
    );
    migration = built.migration;
    policy = built.policy;
    owner = built.owner;
    logger.info(
      "migrate",
      `payload built + locally verified in ${Math.round((Date.now() - buildT0) / 1000)}s (source=${String(built.migration.source_cipher_hash).slice(0, 8)}...)`,
    );
    writeMigrationPayload(
      networkId,
      address,
      String(built.migration.source_cipher_hash),
      migration,
      policy,
    );
  }
  onProgress?.("Submitting migration...");
  let submitted: { txHash: string };
  try {
    submitted = await privacyService.submitKeyBoundMigration(scope, walletId, migration, {
      ou,
      policy,
      owner,
    });
  } catch (e) {
    // Built under a policy the network no longer uses: never resubmit it.
    if (e instanceof Error && e.name === "ProofPolicy") dropMigrationPayload(networkId, address);
    throw e;
  }
  const { txHash } = submitted;
  logger.info("migrate", `submitted key_switch ${txHash.slice(0, 8)}... (ou=${ou})`);
  // Kind 'migration': a same-key switch - the background keys-match check must NOT clear it.
  recordPendingKeySwitch(networkId, address, txHash, "migration");
  onSubmitted?.(txHash);
  onProgress?.("Confirming migration on-chain...");
  const exec = await privacyService.confirmKeySwitchOutcome(txHash, 240_000, networkId);
  if (exec.status === "rejected") {
    logger.error("migrate", `rejected on-chain: ${exec.reason}`);
    // A node rejection means the payload itself is bad - never resubmit it.
    dropMigrationPayload(networkId, address);
    clearPendingKeySwitch(networkId, address, txHash);
  } else if (exec.status === "confirmed") {
    logger.info("migrate", `CONFIRMED on-chain: ${txHash.slice(0, 8)}... - balance migrated`);
    dropMigrationPayload(networkId, address);
    clearPendingKeySwitch(networkId, address, txHash);
  } else {
    // Still pending: keep the record AND the cached payload; if the tx expires, the next
    // refresh reuses the payload instead of re-proving.
    logger.info(
      "migrate",
      `still pending after confirm window: ${txHash.slice(0, 8)}... - record + cached payload kept`,
    );
  }
  return { txHash, ...exec };
}

export async function refreshReviewed(
  review: SetupReview & { reuse: boolean },
  publicRaw: number | null,
  hooks?: Pick<Parameters<typeof runBalanceRefresh>[0], "onProgress" | "onSubmitted">,
): Promise<RefreshOutcome> {
  const scope = await assertReviewedFee(review, publicRaw, () =>
    refreshFeeLive(review.reuse, review.networkId),
  );
  return runBalanceRefresh({
    scope,
    walletId: review.walletId,
    reuse: review.reuse,
    ou: review.feeRaw,
    ...hooks,
  });
}
