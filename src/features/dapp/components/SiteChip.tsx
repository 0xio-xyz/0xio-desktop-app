import { useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useWallet } from "src/contexts/useWallet";
import { useDappSites, siteDisplayWallets, sitePath } from "src/features/dapp/hooks/useDappSites";
import SiteConnectDialog from "src/features/dapp/components/SiteConnectDialog";
import { hostOf } from "src/features/dapp/components/ReviewParts";

export default function SiteChip({ origin }: { origin: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, wallets, networkId } = useWallet();
  const sites = useDappSites(networkId);
  const [connecting, setConnecting] = useState(false);

  if (!origin || !activeWallet) return null;
  const site = sites.find((s) => s.origin === origin);
  const inUse = site ? siteDisplayWallets(site, wallets)[0] : undefined;
  const base =
    "shrink-0 max-w-56 flex items-center gap-2 rounded-full px-3 py-1.5 text-meta transition-colors duration-200 cursor-pointer";

  if (!site || !inUse) {
    return (
      <>
        <button
          type="button"
          onClick={() => setConnecting(true)}
          className={`${base} text-content-secondary hover:text-content hover:bg-surface-card`}
          data-testid="site-chip"
        >
          {t("siteChip.notConnected")}
        </button>
        {connecting && (
          <SiteConnectDialog origin={origin} mode="open" onClose={() => setConnecting(false)} />
        )}
      </>
    );
  }

  const onOpen = inUse.address === activeWallet.address;
  return (
    <button
      type="button"
      onClick={() => navigate(sitePath(origin))}
      className={`${base} bg-surface-card text-content hover:bg-surface-highlight`}
      title={onOpen ? hostOf(origin) : `${hostOf(origin)} (${inUse.name})`}
      data-testid="site-chip"
    >
      {onOpen ? (
        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-hidden="true" />
      ) : (
        <WalletAvatar address={inUse.address} size={16} />
      )}
      <span className="truncate">{hostOf(origin)}</span>
    </button>
  );
}
