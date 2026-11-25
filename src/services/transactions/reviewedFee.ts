import { FEE_CHANGED, FEE_UNAVAILABLE } from "./feeCopy";

export interface LiveFee {
  ou: number;
  floorOu: number;
}

export function feeOu(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function liveFeeOf(
  fee: string | number | null | undefined,
  minimum: string | number | null | undefined,
): LiveFee | null {
  const ou = feeOu(fee);
  if (ou === null) return null;
  const floor = feeOu(minimum);
  return { ou, floorOu: floor === null ? ou : Math.min(floor, ou) };
}

/**
 * Whether a reviewed fee can be signed as it was shown. The node's recommendation moves on
 * every read, so the reviewed fee stands while the node still takes it: FEE_CHANGED only when
 * the live minimum is above it, FEE_UNAVAILABLE when the fee could not be read.
 */
export function reviewedFeeError(reviewedOu: number, live: LiveFee | null): string | null {
  if (live === null) return FEE_UNAVAILABLE;
  return reviewedOu >= live.floorOu ? null : FEE_CHANGED;
}
