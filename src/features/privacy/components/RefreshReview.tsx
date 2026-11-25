import { useTranslation } from "src/i18n/react";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Amount, Hero, KV, LayerDots, Skel, Small } from "src/shared/ui/look";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import type { useMigrateBalance } from "src/hooks/privacy/useMigrateBalance";
import { NETWORKS } from "src/services/network/config";
import { FEE_SHORT } from "src/services/transactions/feeCopy";
import { formatOCT, truncateAddress } from "src/lib/format";

const LAYERS_AFTER = 2;

export default function RefreshReview({
  open,
  mode,
  migrate,
  privateMicro,
  baseLayers,
  then,
}: {
  open: boolean;
  mode: "refresh" | "migrate";
  migrate: ReturnType<typeof useMigrateBalance>;
  privateMicro: number | null;
  baseLayers: number;
  then?: { label: string; amount: string } | null;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  const r = migrate.review;
  const fee = migrate.feeOct ? (
    <Amount value={formatOCT(Math.round(parseFloat(migrate.feeOct) * 1_000_000))} />
  ) : r.feeFailed ? (
    <span className="inline-flex items-center gap-3">
      {t("fee.unavailable")}
      <button type="button" onClick={r.retryFee} className="cursor-pointer font-semibold">
        {t("fee.retry")}
      </button>
    </span>
  ) : (
    <Skel />
  );
  const balance =
    privateMicro === null ? <Skel w="w-24" /> : <Amount value={formatOCT(privateMicro)} />;
  const wallet = (
    <KV label={t("proofs.wallet")}>
      <WalletAvatar address={r.address} size={22} />
      {r.walletName || truncateAddress(r.address)}
    </KV>
  );
  const refresh = mode === "refresh";
  return (
    <>
      <ReviewPopup
        open={open}
        label={t(refresh ? "proofs.refresh.caption" : "proofs.migrate.caption")}
        caption={t(refresh ? "proofs.refresh.caption" : "proofs.migrate.caption")}
        hero={
          refresh ? (
            <h2 className="look-figure text-[2.875rem] text-content">
              {t("proofs.refresh.title")}
            </h2>
          ) : privateMicro === null ? (
            <Skel w="w-40" />
          ) : (
            <Hero value={formatOCT(privateMicro)} size="xl" />
          )
        }
        verb={t(refresh ? "proofs.refresh.verb" : "proofs.migrate.verb")}
        onReject={migrate.closePopup}
        onConfirm={() => void migrate.submit()}
        confirmDisabled={r.blocked || migrate.feeShort || !migrate.feeOct}
        busy={migrate.verifying}
        error={r.message ?? (migrate.feeShort ? FEE_SHORT : null)}
      >
        {wallet}
        {refresh ? (
          <>
            <KV label={t("proofs.layersNow")}>
              <LayerDots n={baseLayers} />
            </KV>
            <KV label={t("proofs.layersAfter")}>
              <LayerDots n={LAYERS_AFTER} />
            </KV>
            <KV label={t("sendFlow.networkFee")}>{fee}</KV>
            <KV label={t("proofs.privateBalance")}>
              {balance}
              <Small>{t("proofs.unchanged")}</Small>
            </KV>
            {then && (
              <KV label={t("proofs.then")}>
                {then.label} <Amount value={then.amount} />
              </KV>
            )}
          </>
        ) : (
          <>
            <KV label={t("proofs.network")}>{NETWORKS[r.networkId]?.name ?? r.networkId}</KV>
            <KV label={t("sendFlow.networkFee")}>{fee}</KV>
            <KV label={t("proofs.privateAfter")}>{balance}</KV>
            <KV label={t("proofs.layersAfter")}>
              <LayerDots n={LAYERS_AFTER} />
            </KV>
          </>
        )}
      </ReviewPopup>
      <TransactionAuthModal
        isOpen={r.auth.isOpen}
        onResult={r.auth.handleResult}
        title={r.auth.title}
      />
    </>
  );
}
