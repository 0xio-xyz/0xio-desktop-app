import type { FeeRecommendation } from "src/services/network/networkService";

export type BatchFeePick = { mode: "slow" | "normal" | "fast" } | { mode: "custom"; ou: string };

const n = (v: string | undefined) => Number(v) || 0;

export function sumBatchFees(fees: FeeRecommendation[]): FeeRecommendation {
  const sum = (key: "minimum" | "recommended" | "fast") =>
    String(fees.reduce((total, f) => total + n(f[key]), 0));
  return {
    minimum: sum("minimum"),
    recommended: sum("recommended"),
    ...(fees.length && fees.every((f) => f.fast) ? { fast: sum("fast") } : {}),
  };
}

export function splitBatchFee(pick: BatchFeePick, fees: FeeRecommendation[]): string[] {
  if (pick.mode === "slow") return fees.map((f) => f.minimum);
  if (pick.mode === "fast") return fees.map((f) => f.fast ?? f.recommended);
  const floor = fees.reduce((total, f) => total + n(f.minimum), 0);
  const extra = pick.mode === "custom" ? Math.round(n(pick.ou)) - floor : -1;
  if (extra < 0 || floor <= 0) return fees.map((f) => f.recommended);
  const parts = fees.map((f) => n(f.minimum) + Math.floor((extra * n(f.minimum)) / floor));
  parts[0] += floor + extra - parts.reduce((total, p) => total + p, 0);
  return parts.map(String);
}

export const batchFeeTotal = (parts: string[]) =>
  String(parts.reduce((total, p) => total + n(p), 0));
