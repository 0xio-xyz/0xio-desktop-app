import { useState } from "react";
import { useNavigate, useSearchParams } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { Screen, PageTitle, ScrollArea, Panel, Action } from "src/shared/ui/flat";
import { useWallet } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import * as dappService from "src/features/dapp/services/dappService";
import { canSignWallet, type SiteWalletInfo } from "src/features/dapp/services/dappService";
import { useDappSites, siteDisplayWallets } from "src/features/dapp/hooks/useDappSites";
import { announceSiteWallet } from "src/features/dapp/hooks/useDappBridge";
import SiteConnectDialog from "src/features/dapp/components/SiteConnectDialog";
import {
  ReviewDialog,
  SiteMark,
  WalletRow,
  hostOf,
} from "src/features/dapp/components/ReviewParts";

export default function ConnectedSiteScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const origin = params.get("origin") ?? "";
  const { wallets, networkId } = useWallet();
  const site = useDappSites(networkId).find((s) => s.origin === origin) ?? null;
  const [removing, setRemoving] = useState<SiteWalletInfo | null>(null);
  const [ending, setEnding] = useState(false);
  const [adding, setAdding] = useState(false);

  const back = () => navigate("/connected-sites", { replace: true });
  const shown = site ? siteDisplayWallets(site, wallets) : [];
  const canAdd = !!site && wallets.some((w) => canSignWallet(w) && !site.accounts[w.address]);

  const remove = () => {
    if (!removing || !site) return;
    const wasInUse = site.inUse === removing.address;
    const next = dappService.removeWallet(networkId, origin, removing.address);
    setRemoving(null);
    if (!next) {
      back();
      return;
    }
    const now = next.inUse ? wallets.find((w) => w.address === next.inUse) : undefined;
    if (wasInUse && now) void announceSiteWallet([origin], now);
  };

  const disconnect = () => {
    dappService.disconnectSite(networkId, origin);
    setEnding(false);
    back();
  };

  return (
    <Screen>
      <PageTitle
        leading={origin ? <SiteMark origin={origin} favicon={site?.favicon} size={38} /> : null}
        title={hostOf(origin)}
        subtitle={origin}
        right={
          <Action weight="text" onClick={back} className="text-meta">
            {t("common.back")}
          </Action>
        }
      />
      <ScrollArea className="mt-6">
        {!site ? (
          <p className="text-meta text-content-secondary py-10">
            {t("connectedSites.notConnected")}
          </p>
        ) : (
          <div className="max-w-xl space-y-5">
            <section>
              <p className="text-meta text-content-secondary mb-2 px-1">
                {t("connectedSites.wallets")}
              </p>
              <Panel pad={false}>
                {shown.map((w, i) => (
                  <WalletRow
                    key={w.address}
                    wallet={w}
                    selected={i === 0}
                    right={
                      shown.length > 1 ? (
                        <Action weight="text" className="text-meta" onClick={() => setRemoving(w)}>
                          {t("connectedSites.remove")}
                        </Action>
                      ) : undefined
                    }
                  />
                ))}
                {canAdd && (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="w-full rounded-2xl px-3 py-3 text-left text-body text-content-secondary hover:text-content hover:bg-surface-highlight transition-colors duration-200 cursor-pointer"
                  >
                    {t("connectedSites.connectAnother")}
                  </button>
                )}
              </Panel>
            </section>
            <section>
              <p className="text-meta text-content-secondary mb-2 px-1">
                {t("connectedSites.network")}
              </p>
              <Panel pad={false}>
                <div className="px-4 py-3 text-body text-content">
                  {NETWORKS[networkId]?.name ?? networkId}
                </div>
              </Panel>
            </section>
          </div>
        )}
      </ScrollArea>

      {site && (
        <div className="shrink-0 pt-4 max-w-xl">
          <Action weight="raised" full className="text-danger" onClick={() => setEnding(true)}>
            {t("connectedSites.disconnect")}
          </Action>
        </div>
      )}

      <ReviewDialog
        open={!!removing}
        caps={t("connectedSites.removeCaps")}
        origin={origin}
        heading={t("connectedSites.removeTitle")}
        reject={t("common.cancel")}
        action={t("connectedSites.remove")}
        onReject={() => setRemoving(null)}
        onAction={remove}
        danger
      >
        {removing && (
          <>
            <div className="rounded-2xl bg-surface-card">
              <WalletRow wallet={removing} />
            </div>
            <p className="text-meta leading-relaxed text-content-secondary px-1">
              {t("connectedSites.removeNote")}
            </p>
          </>
        )}
      </ReviewDialog>

      <ReviewDialog
        open={ending}
        caps={t("connectedSites.endCaps")}
        origin={origin}
        heading={t("connectedSites.endTitle")}
        reject={t("common.cancel")}
        action={t("connectedSites.disconnect")}
        onReject={() => setEnding(false)}
        onAction={disconnect}
        danger
      >
        <p className="text-meta leading-relaxed text-content-secondary px-1">
          {shown.length > 1
            ? t("connectedSites.endNoteMany", { n: shown.length })
            : t("connectedSites.endNoteOne")}
        </p>
      </ReviewDialog>

      {adding && (
        <SiteConnectDialog origin={origin} mode="another" onClose={() => setAdding(false)} />
      )}
    </Screen>
  );
}
