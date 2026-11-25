import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import { Amount, KV, Skel } from "src/shared/ui/look";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { useTurnOn } from "src/features/privacy/hooks/useTurnOn";
import { NETWORKS } from "src/services/network/config";
import { formatOCT, truncateAddress } from "src/lib/format";

export default function TurnOnReview({
  open,
  publicBalance,
  onReject,
}: {
  open: boolean;
  publicBalance: number | null;
  onReject: () => void;
}) {
  if (!open) return null;
  return <TurnOn publicBalance={publicBalance} onReject={onReject} />;
}

function TurnOn({
  publicBalance,
  onReject,
}: {
  publicBalance: number | null;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const s = useTurnOn(publicBalance);
  const fee = s.feeRaw !== null ? Number(s.feeRaw) : null;
  return (
    <>
      <ReviewPopup
        open={!s.queued}
        label={t("proofs.turnOn.title")}
        caption={t("proofs.turnOn.caption")}
        hero={
          <div className="flex items-center gap-5">
            <Mascot id="turn-on" phase={s.queued ? "ld" : "ok"} size={56} />
            <h2 className="min-w-0 text-[1.625rem] font-semibold tracking-[-0.01em] text-content">
              {t("proofs.turnOn.title")}
            </h2>
          </div>
        }
        verb={t("proofs.turnOn.verb")}
        onReject={onReject}
        onConfirm={() => void s.turnOn()}
        confirmDisabled={!s.canTurnOn}
        error={s.message}
      >
        <div className="mt-5">
          <KV label={t("proofs.wallet")}>
            <WalletAvatar address={s.review.address} size={22} />
            {s.review.name || truncateAddress(s.review.address)}
          </KV>
          <KV label={t("proofs.network")}>
            {NETWORKS[s.review.networkId]?.name ?? s.review.networkId}
          </KV>
          <KV label={t("proofs.turnOn.fee")}>
            {s.feeFailed ? (
              <span className="inline-flex items-center gap-3">
                {t("fee.unavailable")}
                <button type="button" onClick={s.retryFee} className="cursor-pointer font-semibold">
                  {t("fee.retry")}
                </button>
              </span>
            ) : fee === null ? (
              <Skel />
            ) : (
              <span className={s.fetching ? "opacity-50" : ""}>
                <Amount value={formatOCT(fee)} />
              </span>
            )}
          </KV>
          <KV label={t("proofs.publicAfter")}>
            {fee === null || publicBalance === null ? (
              <Skel w="w-24" still={s.feeFailed} />
            ) : (
              <Amount value={formatOCT(Math.max(0, publicBalance - fee))} />
            )}
          </KV>
        </div>
      </ReviewPopup>
      <TransactionAuthModal
        isOpen={s.txAuth.isOpen}
        onResult={s.txAuth.handleResult}
        title={s.txAuth.title}
      />
    </>
  );
}
