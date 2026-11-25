import { useState } from "react";
import { useQuery, useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import {
  SetupReviewError,
  readSetupFee,
  setupScopeError,
  turnOnReviewed,
} from "src/features/privacy/services/setupReview";
import * as privacyService from "src/features/privacy/services/privacyService";
import { SETUP_FEE_QUERY } from "src/features/privacy/components/SetupPrivateDrawer";
import { STEPS } from "src/features/privacy/services/proofJobs";
import { enqueue } from "src/features/privacy/services/proofQueue";
import { FEE_SHORT, FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";
import { showProgress } from "src/services/notices/activity";

const CONFIRM_POLL_MS = 4000;
const CONFIRM_WINDOW_MS = 3 * 60_000;

export function useTurnOn(publicBalance: number | null) {
  const { activeWallet, networkId } = useWallet();
  const qc = useQueryClient();
  const txAuth = useTransactionAuth();
  const [review] = useState(() => ({
    walletId: activeWallet?.id ?? "",
    address: activeWallet?.address ?? "",
    name: activeWallet?.name ?? "",
    networkId,
  }));
  const feeKey = [SETUP_FEE_QUERY, review.networkId, review.address];
  const fee = useQuery({
    queryKey: feeKey,
    enabled: !!review.address,
    queryFn: () => readSetupFee(review.networkId),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const scopeError = setupScopeError(review, {
    walletId: activeWallet?.id ?? null,
    address: activeWallet?.address ?? null,
    networkId,
  });
  const feeRaw = fee.data ?? null;
  const feeFailed = fee.isError && !fee.isFetching;
  const feeShort = feeRaw !== null && publicBalance !== null && publicBalance < Number(feeRaw);
  const blocked = scopeError ?? (feeShort ? FEE_SHORT : null);

  const retryFee = () => {
    setError(null);
    void fee.refetch();
  };

  const turnOn = async () => {
    if (!feeRaw || blocked || queued) return;
    const shown = feeRaw;
    setError(null);
    if (!(await txAuth.requestAuth("Turn on private balance"))) return;
    setQueued(true);
    const scope = { networkId: review.networkId, address: review.address };
    const id = enqueue({
      kind: "setup",
      scope,
      amount: 0,
      steps: STEPS.setup,
      run: async (step) => {
        await turnOnReviewed({ ...review, feeRaw: shown }, publicBalance);
        step(1);
        const until = Date.now() + CONFIRM_WINDOW_MS;
        while (Date.now() < until) {
          const state = await privacyService.getPvacRegistrationState(
            scope.address,
            scope.networkId,
          );
          if (state !== "pending") break;
          await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
        }
        return {};
      },
      onDone: () => {
        setQueued(false);
        void qc.invalidateQueries({ queryKey: ["pvacSetup", scope.address, scope.networkId] });
      },
      onFail: (e) => {
        setQueued(false);
        void qc.invalidateQueries({ queryKey: ["pvacSetup", scope.address, scope.networkId] });
        if (!(e instanceof SetupReviewError)) return false;
        if (e.liveFeeRaw) qc.setQueryData(feeKey, e.liveFeeRaw);
        setError(e.message);
        return true;
      },
    });
    showProgress(id);
  };

  return {
    review,
    feeRaw,
    fetching: fee.isFetching,
    feeFailed,
    message: blocked ?? (feeFailed ? FEE_UNAVAILABLE : error),
    canTurnOn: !!feeRaw && !blocked && !fee.isFetching && !queued,
    queued,
    retryFee,
    turnOn,
    txAuth,
  };
}
