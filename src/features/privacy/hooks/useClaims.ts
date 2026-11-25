import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useQuery, useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useFee, useFeeRecheck } from "src/hooks/transactions/useFees";
import { usePersistedOU } from "src/hooks/transactions/usePersistedOU";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { useWalletQueue } from "src/hooks/privacy/useProofQueue";
import { withRefresh } from "src/hooks/privacy/usePrivateOp";
import { captureScope, type TxScope } from "src/services/network/networkService";
import * as privacyService from "src/features/privacy/services/privacyService";
import type { ClaimableOutput } from "src/features/privacy/services/privacyService";
import { claimJob } from "src/features/privacy/services/proofJobs";
import { enqueue } from "src/features/privacy/services/proofQueue";
import { claimBatch, showProgress } from "src/services/notices/activity";
import { FEE_SHORT } from "src/services/transactions/feeCopy";
import { feeOu } from "src/services/transactions/reviewedFee";

export function useClaims() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { activeWallet, networkId, pvacLegacy, showMessage } = useWallet();
  const { publicBalance, privateBalance, isLoading } = useBalance();
  const publicKnown = isLoading ? null : publicBalance;
  const quote = useFee("claim");
  const [ou, setOU] = usePersistedOU("claim", "", quote.fee ?? undefined);
  const recheck = useFeeRecheck("claim", quote, setOU);
  const txAuth = useTransactionAuth();
  const [review, setReview] = useState<{ outputs: ClaimableOutput[]; scope: TxScope } | null>(null);
  const [shortError, setShortError] = useState(false);
  const scope = activeWallet ? { networkId, address: activeWallet.address } : null;
  const queue = useWalletQueue(scope);

  const scanKey = ["claimOutputs", activeWallet?.id, networkId];
  const scan = useQuery({
    queryKey: scanKey,
    queryFn: async () => {
      if (!activeWallet) return [];
      return privacyService.getStealthOutputs(activeWallet.id, activeWallet.address, networkId);
    },
    enabled: !!activeWallet,
    staleTime: privacyService.suggestedScanIntervalMs(),
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const queuedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const j of [queue.top, ...queue.next])
      if (j?.kind === "claim" && j.ref != null) ids.add(Number(j.ref));
    return ids;
  }, [queue.top, queue.next]);

  const outputs = useMemo(
    () => [...(scan.data ?? [])].filter((o) => !queuedIds.has(o.id)).sort((a, b) => a.id - b.id),
    [scan.data, queuedIds],
  );

  const fee = quote.status === "ok" ? feeOu(ou) : null;
  const reviewShort =
    fee !== null && publicKnown !== null && publicKnown < fee * (review?.outputs.length ?? 1);

  const open = useCallback(
    (list: ClaimableOutput[]) => {
      if (!activeWallet || list.length === 0) return;
      if (pvacLegacy) {
        showMessage("error", t("proofs.claim.legacy"));
        return;
      }
      recheck.setError("");
      setShortError(false);
      setReview({ outputs: list, scope: captureScope(activeWallet.address) });
    },
    [activeWallet, pvacLegacy, showMessage, t, recheck],
  );

  const reject = useCallback(() => {
    if (!recheck.checking) setReview(null);
  }, [recheck.checking]);

  const confirm = useCallback(async () => {
    if (!review || !activeWallet || fee === null) return;
    const { outputs: list, scope: pinned } = review;
    if (await recheck.check(pinned.networkId, String(fee))) return;
    if (publicKnown === null || publicKnown < fee * list.length) {
      setShortError(true);
      return;
    }
    if (!(await txAuth.requestAuth(t("claim.claim")))) return;
    const ids = list.map((output) => {
      const job = claimJob({ scope: pinned, walletId: activeWallet.id, ou: String(fee), output });
      return enqueue(
        withRefresh(
          qc,
          { ...job, ref: output.id },
          {
            onDone: () =>
              qc.setQueryData<ClaimableOutput[]>(scanKey, (old) =>
                old?.filter((o) => o.id !== output.id),
              ),
          },
        ),
      );
    });
    claimBatch(ids);
    setReview(null);
    showProgress(ids[0]);
  }, [review, activeWallet, fee, recheck, publicKnown, txAuth, t, qc, scanKey]);

  return {
    outputs,
    loading: scan.isLoading,
    refreshing: scan.isRefetching,
    rescan: () => void scan.refetch(),
    quote,
    ou,
    setOU,
    fee,
    review,
    open,
    reject,
    confirm,
    recheck,
    txAuth,
    publicKnown,
    privateBalance,
    error: recheck.error || (shortError || (quote.status === "ok" && reviewShort) ? FEE_SHORT : ""),
    confirmDisabled: quote.status !== "ok" || fee === null || publicKnown === null || reviewShort,
  };
}

export type Claims = ReturnType<typeof useClaims>;
