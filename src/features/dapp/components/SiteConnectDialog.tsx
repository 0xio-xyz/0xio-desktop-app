import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useWallet } from "src/contexts/useWallet";
import * as dappService from "src/features/dapp/services/dappService";
import { canSignWallet } from "src/features/dapp/services/dappService";
import { announceSiteWallet } from "src/features/dapp/hooks/useDappBridge";
import ConnectBody from "src/features/dapp/components/ConnectBody";
import { ReviewDialog } from "src/features/dapp/components/ReviewParts";

/**
 * "open" connects the open wallet (or offers the wallets that can sign when it is watch-only);
 * "another" picks a wallet the site does not have yet.
 */
export default function SiteConnectDialog({
  origin,
  mode,
  onClose,
}: {
  origin: string | null;
  mode: "open" | "another";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { activeWallet, wallets, networkId } = useWallet();
  const site = origin ? dappService.getSite(networkId, origin) : null;
  const onSite = (a: string) => !!site?.accounts[a];
  const free = wallets.filter((w) => canSignWallet(w) && !onSite(w.address));
  const open =
    mode === "open" && activeWallet && !onSite(activeWallet.address) ? activeWallet : null;
  const [pick, setPick] = useState<string | null>(
    open?.address ?? (free.length === 1 ? free[0].address : null),
  );
  const [error, setError] = useState("");

  if (!origin) return null;
  const list = open ? [open, ...free] : free;
  const empty = list.length === 0;

  const connect = () => {
    const w = wallets.find((x) => x.address === pick);
    if (!w) return;
    try {
      dappService.connectWallet(networkId, origin, w, activeWallet?.address ?? null, {
        permissions: site?.permissions,
      });
      void announceSiteWallet([origin], w);
      onClose();
    } catch {
      setError(t("dappReview.connectFailed"));
    }
  };

  return (
    <ReviewDialog
      open
      caps={t("dappReview.connectCaps")}
      origin={origin}
      heading={empty ? t("dappReview.noWalletToAdd") : t("dappReview.connectHeading")}
      reject={empty ? t("common.close") : t("dappReview.reject")}
      action={t("dappReview.connect")}
      onReject={onClose}
      onAction={connect}
      disabled={empty || !pick}
      error={error || undefined}
    >
      {!empty && <ConnectBody open={open} choices={free} selected={pick} onPick={setPick} />}
    </ReviewDialog>
  );
}
