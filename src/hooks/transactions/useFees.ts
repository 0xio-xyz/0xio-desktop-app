import { useCallback, useState } from "react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import {
  FeeUnavailableError,
  getRecommendedFeeStrict,
  type FeeHint,
  type FeeOpType,
  type FeeRecommendation,
} from "src/services/network/networkService";
import { usePersistedOU } from "src/hooks/transactions/usePersistedOU";
import {
  feeOu,
  liveFeeOf,
  reviewedFeeError,
  type LiveFee,
} from "src/services/transactions/reviewedFee";

type FeeStatus = "loading" | "error" | "ok";

export interface FeeQuote {
  status: FeeStatus;
  /** The live fee, only while the last read for this network succeeded. */
  fee: FeeRecommendation | null;
  /** The last live read for this network, to show dimmed while a read runs or after one failed. */
  last: FeeRecommendation | null;
  retry: () => void;
}

export const FEE_QUERY = "fee";

export function feeQueryOptions(op: FeeOpType, networkId: string, hint?: FeeHint) {
  return {
    queryKey: [FEE_QUERY, networkId, op, hint?.encrypted_data_len ?? null],
    queryFn: async () => {
      const fee = await getRecommendedFeeStrict(op, networkId, hint);
      if (!fee) throw new FeeUnavailableError();
      return fee;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  };
}

export function feeStatusOf(q: {
  data: FeeRecommendation | undefined;
  isError: boolean;
  isFetching: boolean;
}): FeeStatus {
  if (q.data && !q.isError) return "ok";
  if (q.isFetching) return "loading";
  return q.isError ? "error" : "loading";
}

/** The live fee for an op. A size-priced op passes its payload length and waits for it. */
export function useFee(op: FeeOpType, opts: { hint?: FeeHint; enabled?: boolean } = {}): FeeQuote {
  const { networkId } = useWallet();
  const q = useQuery({
    ...feeQueryOptions(op, networkId, opts.hint),
    enabled: opts.enabled ?? true,
  });
  const status = feeStatusOf(q);
  return {
    status,
    fee: status === "ok" ? (q.data ?? null) : null,
    last: q.data ?? null,
    retry: () => void q.refetch(),
  };
}

/** Whether a reviewed fee still holds against a fresh read: null, FEE_CHANGED or FEE_UNAVAILABLE,
 *  with the fresh read to review again. */
export async function recheckReviewedFee(
  op: FeeOpType,
  networkId: string,
  reviewedOu: string,
  hint?: FeeHint,
): Promise<{ error: string | null; live: LiveFee | null }> {
  const rec = await getRecommendedFeeStrict(op, networkId, hint);
  const live = liveFeeOf(rec?.recommended, rec?.minimum);
  return { error: reviewedFeeError(feeOu(reviewedOu) ?? 0, live), live };
}

/**
 * The last check before signing: the fee the review showed is read against the network again.
 * When the live minimum moved above it the review switches to the live fee and shows why, so the
 * user reviews again before anything is signed.
 */
export function useFeeRecheck(
  op: FeeOpType,
  quote: FeeQuote,
  setOU: (value: string, mode?: string) => void,
  hint?: FeeHint,
) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const { retry } = quote;
  const dataLen = hint?.encrypted_data_len;
  const check = useCallback(
    async (networkId: string, reviewedOu: string): Promise<string | null> => {
      setChecking(true);
      setError("");
      try {
        const r = await recheckReviewedFee(
          op,
          networkId,
          reviewedOu,
          dataLen === undefined ? undefined : { encrypted_data_len: dataLen },
        );
        if (!r.error) return null;
        if (r.live) setOU(String(r.live.ou), "normal");
        retry();
        setError(r.error);
        return r.error;
      } finally {
        setChecking(false);
      }
    },
    [op, setOU, retry, dataLen],
  );
  return { checking, error, setError, check };
}

/**
 * One write's fee: the live quote, the fee the review signs (the user's preset over the live
 * read, empty until a read is in), and the check before signing. A preset is kept per `key`.
 */
export function useReviewFee(
  op: FeeOpType,
  key: string,
  opts: { hint?: FeeHint; enabled?: boolean } = {},
) {
  const quote = useFee(op, opts);
  const [chosen, setOU] = usePersistedOU(key, "", quote.fee ?? undefined);
  const recheck = useFeeRecheck(op, quote, setOU, opts.hint);
  const ou = quote.status === "ok" ? chosen : "";
  return { quote, ou, setOU, recheck };
}
