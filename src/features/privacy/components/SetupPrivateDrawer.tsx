import { useCallback, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useQuery, useQueryClient } from "src/lib/query";
import Mascot from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import { Amount, KV, Skel } from "src/shared/ui/look";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import {
  SetupReviewError,
  readSetupFee,
  setupScopeError,
  turnOnReviewed,
} from "src/features/privacy/services/setupReview";
import { NETWORKS } from "src/services/network/config";
import { FEE_SHORT, FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";
import { formatOCT, truncateAddress } from "src/lib/format";

export const SETUP_FEE_QUERY = "setupPrivateFee";

interface SetupPrivateDrawerProps {
  publicBalance: number | null;
  onClose: () => void;
  onDone: () => void;
}

export default function SetupPrivateDrawer({
  publicBalance,
  onClose,
  onDone,
}: SetupPrivateDrawerProps) {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const [review] = useState(() => ({
    walletId: activeWallet?.id ?? "",
    address: activeWallet?.address ?? "",
    name: activeWallet?.name ?? "",
    networkId,
  }));
  const qc = useQueryClient();
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
  const txAuth = useTransactionAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeError = setupScopeError(review, {
    walletId: activeWallet?.id ?? null,
    address: activeWallet?.address ?? null,
    networkId,
  });
  const feeRaw = fee.data ?? null;
  const feeFailed = fee.isError && !fee.isFetching;
  const feeShort = feeRaw !== null && publicBalance !== null && publicBalance < Number(feeRaw);
  const blocked = scopeError ?? (feeFailed ? FEE_UNAVAILABLE : feeShort ? FEE_SHORT : null);
  const message = blocked ?? error;

  const dismiss = useCallback(() => {
    if (busy || txAuth.isOpen) return;
    onClose();
  }, [busy, txAuth.isOpen, onClose]);

  const retryFee = () => {
    setError(null);
    void fee.refetch();
  };

  const turnOn = async () => {
    if (!feeRaw || blocked) return;
    const shown = feeRaw;
    setError(null);
    if (!(await txAuth.requestAuth(t("proofs.turnOn.title")))) return;
    setBusy(true);
    try {
      await turnOnReviewed({ ...review, feeRaw: shown }, publicBalance);
      void qc.invalidateQueries({ queryKey: ["pvacSetup", review.address, review.networkId] });
      onDone();
    } catch (e) {
      if (e instanceof SetupReviewError && e.liveFeeRaw) qc.setQueryData(feeKey, e.liveFeeRaw);
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const feeValue = feeRaw !== null ? Number(feeRaw) : null;
  return (
    <>
      <ReviewPopup
        open
        label={t("proofs.turnOn.title")}
        caption={t("proofs.turnOn.caption")}
        hero={
          <div className="flex items-center gap-5">
            <Mascot id="setup-private" phase={busy ? "ld" : "ok"} size={56} />
            <h2 className="min-w-0 text-[1.625rem] font-semibold tracking-[-0.01em] text-content">
              {t("proofs.turnOn.title")}
            </h2>
          </div>
        }
        verb={t("proofs.turnOn.verb")}
        onReject={dismiss}
        onConfirm={() => void turnOn()}
        confirmDisabled={!feeRaw || !!blocked || fee.isFetching}
        busy={busy}
        error={message}
      >
        <div className="mt-5">
          <KV label={t("proofs.wallet")}>
            <WalletAvatar address={review.address} size={22} />
            {review.name || truncateAddress(review.address)}
          </KV>
          <KV label={t("proofs.network")}>
            {NETWORKS[review.networkId]?.name ?? review.networkId}
          </KV>
          <KV label={t("proofs.turnOn.fee")}>
            {feeFailed && !scopeError ? (
              <span className="inline-flex items-center gap-3">
                {t("fee.unavailable")}
                <button type="button" onClick={retryFee} className="cursor-pointer font-semibold">
                  {t("fee.retry")}
                </button>
              </span>
            ) : feeValue === null ? (
              <Skel />
            ) : (
              <span className={fee.isFetching ? "opacity-50" : ""}>
                <Amount value={formatOCT(feeValue)} />
              </span>
            )}
          </KV>
          <KV label={t("proofs.publicAfter")}>
            {feeValue === null || publicBalance === null ? (
              <Skel w="w-24" still={feeFailed} />
            ) : (
              <Amount value={formatOCT(Math.max(0, publicBalance - feeValue))} />
            )}
          </KV>
        </div>
      </ReviewPopup>
      <TransactionAuthModal
        isOpen={txAuth.isOpen}
        onResult={txAuth.handleResult}
        title={txAuth.title}
      />
    </>
  );
}
