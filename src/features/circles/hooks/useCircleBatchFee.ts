import { useCallback, useMemo, useState } from "react";
import { useQueries } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import type { FeeMode } from "src/shared/ui/FeePicker";
import {
  feeQueryOptions,
  feeStatusOf,
  recheckReviewedFee,
  type FeeQuote,
} from "src/hooks/transactions/useFees";
import type { CircleUploadOp } from "src/features/circles/services/circleUpload";
import {
  batchFeeTotal,
  splitBatchFee,
  sumBatchFees,
  type BatchFeePick,
} from "src/features/circles/services/circleBatchFee";

export function useCircleBatchFee(op: CircleUploadOp, lens: number[]) {
  const { networkId } = useWallet();
  const sizes = useMemo(() => [...new Set(lens)].sort((a, b) => a - b), [lens]);
  const reads = useQueries({
    queries: sizes.map((len) => feeQueryOptions(op, networkId, { encrypted_data_len: len })),
  });
  const [pick, setPick] = useState<BatchFeePick>({ mode: "normal" });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const statuses = reads.map(feeStatusOf);
  const status: FeeQuote["status"] =
    !lens.length || statuses.some((s) => s === "loading")
      ? "loading"
      : statuses.some((s) => s === "error")
        ? "error"
        : "ok";
  const fees = status === "ok" ? lens.map((len) => reads[sizes.indexOf(len)].data!) : null;
  const parts = fees ? splitBatchFee(pick, fees) : [];
  const total = fees ? sumBatchFees(fees) : null;
  const retry = () => reads.forEach((r) => void r.refetch());
  const quote: FeeQuote = { status, fee: total, last: total, retry };

  const setOU = useCallback((ou: string, mode: FeeMode) => {
    setPick(mode === "custom" ? { mode, ou } : { mode });
  }, []);

  const check = async (reviewNetwork: string, reviewed: string[]): Promise<string | null> => {
    setChecking(true);
    setError("");
    try {
      const asked = new Set<number>();
      for (let i = 0; i < lens.length; i++) {
        if (asked.has(lens[i])) continue;
        asked.add(lens[i]);
        const lowest = Math.min(...reviewed.filter((_, j) => lens[j] === lens[i]).map(Number));
        const r = await recheckReviewedFee(op, reviewNetwork, String(lowest), {
          encrypted_data_len: lens[i],
        });
        if (!r.error) continue;
        setPick({ mode: "normal" });
        retry();
        setError(r.error);
        return r.error;
      }
      return null;
    } finally {
      setChecking(false);
    }
  };

  return {
    quote,
    ou: fees ? batchFeeTotal(parts) : "",
    parts,
    setOU,
    recheck: { checking, error, setError, check },
  };
}
