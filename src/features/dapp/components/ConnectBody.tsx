import { useTranslation } from "src/i18n/react";
import { canSignWallet, type SiteWalletInfo } from "src/features/dapp/services/dappService";
import { ReviewNote, WalletRow } from "src/features/dapp/components/ReviewParts";

export default function ConnectBody({
  open,
  choices,
  selected,
  onPick,
}: {
  /** The open wallet, or null when the open wallet cannot be offered (already on the site). */
  open: SiteWalletInfo | null;
  choices: SiteWalletInfo[];
  selected: string | null;
  onPick: (address: string) => void;
}) {
  const { t } = useTranslation();
  const watch = !!open && !canSignWallet(open);
  const others = choices.filter((w) => w.address !== open?.address && canSignWallet(w));
  const list = [...(open ? [open] : []), ...(watch || !open ? others : [])];
  const pickable = list.length > 1;

  return (
    <>
      {watch && (
        <ReviewNote>
          <span className="text-content">{t("dappReview.watchOnlyTitle")}</span>{" "}
          {others.length ? t("dappReview.watchOnlyPick") : t("dappReview.watchOnlyNone")}
        </ReviewNote>
      )}
      <div>
        <p className="text-meta text-content-secondary mb-1.5 px-1">
          {t("dappReview.connectWith")}
        </p>
        <div className="rounded-2xl bg-surface-card p-1 space-y-0.5">
          {list.map((w) => (
            <WalletRow
              key={w.address}
              wallet={w}
              selected={pickable && selected === w.address}
              onClick={pickable ? () => onPick(w.address) : undefined}
            />
          ))}
        </div>
      </div>
      <p className="text-meta leading-relaxed text-content-secondary px-1">
        {t("dappReview.connectAbilities")}
      </p>
    </>
  );
}
