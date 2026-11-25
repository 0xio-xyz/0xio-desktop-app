import { logger } from "src/lib/logger";
import { base64ToBytes, bytesToHex } from "src/services/crypto/cryptoService";
import type { Transaction } from "src/types/transaction";

// v1 records had no network and are dropped; resolveRotationState recovers them from chain history.
const STORAGE_KEY = "0xio_pending_key_switch_v2";
const LEGACY_STORAGE_KEY = "0xio_pending_key_switch";

interface PendingKeySwitch {
  networkId: string;
  address: string;
  txHash: string;
  submittedAt: number;
  // "keys match" settles a rotation; a migration is a same-key switch whose keys match while it
  // is still staged, so only its tx status settles it. A missing kind counts as a rotation.
  kind?: "rotation" | "migration";
}

type PendingMap = Record<string, PendingKeySwitch>;

function recordKey(networkId: string, address: string): string {
  return `${networkId}:${address}`;
}

function load(): PendingMap {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PendingMap) : {};
  } catch {
    return {};
  }
}

function save(map: PendingMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    logger.warn("keySwitch", `could not persist pending key switch: ${e}`);
  }
}

export function recordPendingKeySwitch(
  networkId: string,
  address: string,
  txHash: string,
  kind: "rotation" | "migration" = "rotation",
): void {
  const map = load();
  map[recordKey(networkId, address)] = {
    networkId,
    address,
    txHash,
    submittedAt: Date.now(),
    kind,
  };
  save(map);
  logger.info("keySwitch", `recorded pending ${kind} for ${address.slice(0, 8)}... -> ${txHash}`);
}

export function getPendingKeySwitch(networkId: string, address: string): PendingKeySwitch | null {
  return load()[recordKey(networkId, address)] ?? null;
}

export function clearPendingKeySwitch(
  networkId: string,
  address: string,
  onlyTxHash?: string,
): void {
  const map = load();
  const key = recordKey(networkId, address);
  const record = map[key];
  if (!record) return;
  // Guarded clear: only remove the record the caller actually resolved. A settled-status check
  // races with a resubmit writing a NEW record into the same slot - an unguarded delete would
  // drop the live tx's record and re-offer Migrate while it sat in staging.
  if (onlyTxHash && record.txHash !== onlyTxHash) {
    logger.debug(
      "keySwitch",
      `not clearing pending record for ${address.slice(0, 8)}... - record now tracks ${record.txHash.slice(0, 8)}..., caller resolved ${onlyTxHash.slice(0, 8)}...`,
    );
    return;
  }
  delete map[key];
  save(map);
  logger.info("keySwitch", `cleared pending key switch for ${address.slice(0, 8)}...`);
}

function blockedAckKey(networkId: string, address: string): string {
  return `0xio_pvac_blocked_ack_${networkId}_${address}`;
}

export function loadBlockedAck(networkId: string, address: string): string | null {
  try {
    const v = localStorage.getItem(blockedAckKey(networkId, address));
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function saveBlockedAck(networkId: string, address: string, reason: string): void {
  try {
    localStorage.setItem(blockedAckKey(networkId, address), reason);
  } catch (e) {
    logger.warn("keySwitch", `could not persist blocked ack: ${e}`);
  }
}

export function clearBlockedAck(networkId: string, address: string): void {
  try {
    localStorage.removeItem(blockedAckKey(networkId, address));
  } catch {}
}

export const STAGED_WINDOW_MS = 30 * 60_000;

const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RotationState =
  | { kind: "none" }
  | { kind: "pending"; txHash: string; submittedAt: number }
  | { kind: "stuck"; txHash: string; submittedAt: number };

/**
 * SHA-256 over the base64-decoded pubkey, first 8 bytes as hex. This is the
 * `new_key:` value webcli writes into the key_switch memo.
 */
async function pubkeyHashPrefix(pubkeyB64: string): Promise<string> {
  const bytes = base64ToBytes(pubkeyB64);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest).slice(0, 8));
}

const MAX_ROTATION_DETAIL_LOOKUPS = 4;

export function findKeySwitchCandidates(txs: Transaction[], address: string): Transaction[] {
  return txs
    .filter((tx) => tx.from === address && tx.op_type === "key_switch")
    .sort((a, b) => b.timestamp - a.timestamp);
}

function classify(txHash: string, rawTimestamp: number, now: number): RotationState {
  const submittedAt = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
  return {
    kind: now - submittedAt < PENDING_WINDOW_MS ? "pending" : "stuck",
    txHash,
    submittedAt,
  };
}

/**
 * Chain history is the authority and also catches rotations from another client or before a
 * reinstall. octra_transactionsByAddress omits `message`, so candidates are found by op_type and
 * confirmed against the memo via octra_transaction.
 */
export async function resolveRotationState(
  networkId: string,
  address: string,
  localPubkeyB64: string,
  now = Date.now(),
): Promise<RotationState> {
  const record = getPendingKeySwitch(networkId, address);
  if (record && now - record.submittedAt < PENDING_WINDOW_MS) {
    return { kind: "pending", txHash: record.txHash, submittedAt: record.submittedAt };
  }
  try {
    const prefix = await pubkeyHashPrefix(localPubkeyB64);
    const { getTransactionHistory, getTransactionDetails } =
      await import("src/services/network/networkService");
    const { transactions } = await getTransactionHistory(address, 20, 0, networkId);
    const candidates = findKeySwitchCandidates(transactions, address);
    const marker = `new_key:${prefix}`.toLowerCase();

    for (const candidate of candidates.slice(0, MAX_ROTATION_DETAIL_LOOKUPS)) {
      const detail = await getTransactionDetails(candidate.hash, networkId);
      if (detail?.message?.toLowerCase().includes(marker)) {
        return classify(candidate.hash, detail.timestamp || candidate.timestamp, now);
      }
    }
    return { kind: "none" };
  } catch (e) {
    logger.warn("keySwitch", `rotation history lookup failed: ${e}`);
    return record
      ? { kind: "stuck", txHash: record.txHash, submittedAt: record.submittedAt }
      : { kind: "none" };
  }
}
