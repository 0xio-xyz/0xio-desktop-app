import type { Transaction } from "src/types/transaction";

// Submit only reaches the mempool, so a row is Pending until the node confirms it; dropped,
// expired or rejected reads Failed.
export type TxState = "confirmed" | "pending" | "stillPending" | "failed" | "dropped";

export const STILL_PENDING_MS = 5 * 60_000;

const DROPPED = new Set(["dropped", "expired", "replaced", "evicted"]);
const REJECTED = new Set(["rejected", "failed"]);

const norm = (s: string | null | undefined) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

const toMs = (ts: number | undefined) => {
  const n = Number(ts) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
};

// A failed or empty lookup (undefined, "error", "unknown") is never read as not found and never
// overrides what the list knew.
export function txState(
  tx: Pick<Transaction, "status" | "timestamp" | "chain_status">,
  detailStatus?: string | null,
  now: number = Date.now(),
): TxState {
  const detail = norm(detailStatus);
  const listed = norm(tx.chain_status);
  if (DROPPED.has(detail) || DROPPED.has(listed)) return "dropped";
  if (REJECTED.has(detail)) return "failed";
  if (detail === "confirmed" || detail === "success") return "confirmed";
  if (tx.status === "failed") return "failed";
  if (tx.status === "confirmed") return "confirmed";
  const ts = toMs(tx.timestamp);
  return ts > 0 && now - ts > STILL_PENDING_MS ? "stillPending" : "pending";
}

export const isDead = (state: TxState) => state === "failed" || state === "dropped";
export const isPendingState = (state: TxState) => state === "pending" || state === "stillPending";
