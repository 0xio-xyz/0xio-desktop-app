import { useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { Screen, PageTitle, ScrollArea, Panel, Action } from "src/shared/ui/flat";
import { Btn, Caps, KV } from "src/shared/ui/look";
import Mascot from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useWallet } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import * as dappService from "src/features/dapp/services/dappService";
import { useDappSites, siteDisplayWallets, sitePath } from "src/features/dapp/hooks/useDappSites";
import { ReviewDialog, SiteMark, hostOf } from "src/features/dapp/components/ReviewParts";

export default function ConnectedSitesScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { wallets, networkId } = useWallet();
  const sites = useDappSites(networkId);
  const [pickedOrigin, setPickedOrigin] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const picked = sites.find((s) => s.origin === pickedOrigin) ?? sites[0] ?? null;
  const pickedWallets = picked ? siteDisplayWallets(picked, wallets) : [];
  const network = NETWORKS[networkId]?.name ?? networkId;

  const disconnect = () => {
    if (picked) dappService.disconnectSite(networkId, picked.origin);
    setEnding(false);
    setPickedOrigin(null);
  };

  return (
    <Screen>
      <PageTitle
        title={t("connectedSites.title")}
        right={
          <Action onClick={() => navigate("/browser")}>{t("connectedSites.toBrowser")}</Action>
        }
      />
      {sites.length === 0 ? (
        <section className="look-raise mt-6 flex min-h-0 flex-1 flex-col items-center justify-center rounded-[22px] bg-surface-card px-8 text-center">
          <Mascot id="sites-empty" phase="ok" size={72} />
          <h3 className="mt-5 text-title font-semibold text-content">
            {t("connectedSites.empty")}
          </h3>
        </section>
      ) : (
        <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(17.5rem,0.6fr)] gap-7">
          <ScrollArea fade>
            <Panel pad={false} className="space-y-0.5">
              {sites.map((site) => {
                const list = siteDisplayWallets(site, wallets);
                const first = list[0];
                return (
                  <button
                    key={site.origin}
                    type="button"
                    onClick={() => setPickedOrigin(site.origin)}
                    aria-current={picked?.origin === site.origin ? "true" : undefined}
                    className={`flex h-16 w-full cursor-pointer items-center gap-3.5 rounded-2xl px-4 text-left transition-colors duration-200 ${
                      picked?.origin === site.origin
                        ? "bg-surface-highlight"
                        : "hover:bg-surface-highlight"
                    }`}
                  >
                    <SiteMark origin={site.origin} favicon={site.favicon} size={32} />
                    <span className="min-w-0 flex-1 truncate text-body font-medium text-content">
                      {hostOf(site.origin)}
                    </span>
                    <span className="flex min-w-0 shrink-0 items-center gap-2 text-meta text-content-secondary">
                      {first ? (
                        <>
                          <WalletAvatar address={first.address} size={18} />
                          <span className="max-w-32 truncate">{first.name}</span>
                        </>
                      ) : (
                        <span>{t("connectedSites.walletGone")}</span>
                      )}
                      {list.length > 1 && <span className="shrink-0">+{list.length - 1}</span>}
                    </span>
                  </button>
                );
              })}
            </Panel>
          </ScrollArea>

          <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
            {picked && (
              <>
                <div className="flex items-center gap-3">
                  <SiteMark origin={picked.origin} favicon={picked.favicon} size={40} />
                  <div className="min-w-0">
                    <div className="truncate text-lead font-semibold text-content">
                      {hostOf(picked.origin)}
                    </div>
                    <div className="mt-0.5 truncate text-meta text-content-muted">
                      {picked.origin}
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  {pickedWallets.map((w, i) => (
                    <KV key={w.address} label={i === 0 ? t("connectedSites.wallets") : ""}>
                      <WalletAvatar address={w.address} size={22} />
                      {w.name}
                    </KV>
                  ))}
                  <KV label={t("connectedSites.network")}>{network}</KV>
                </div>
                <Caps className="mt-4">{t("connectedSites.canSee")}</Caps>
                <p className="mt-2 text-meta leading-normal text-content-secondary">
                  {t("connectedSites.canSeeText")}
                </p>
                <Caps className="mt-4">{t("connectedSites.mayAsk")}</Caps>
                <p className="mt-2 text-meta leading-normal text-content-secondary">
                  {t("connectedSites.mayAskText")}
                </p>
                <Caps className="mt-4">{t("connectedSites.canNever")}</Caps>
                <p className="mt-2 text-meta leading-normal text-content-secondary">
                  {t("connectedSites.canNeverText")}
                </p>
                <span className="min-h-6 flex-1" />
                <div className="flex gap-2">
                  <Btn
                    size="sm"
                    className="flex-1"
                    onClick={() => navigate(sitePath(picked.origin))}
                  >
                    {t("connectedSites.manage")}
                  </Btn>
                  <Btn size="sm" className="flex-1" onClick={() => setEnding(true)}>
                    {t("connectedSites.disconnect")}
                  </Btn>
                </div>
              </>
            )}
          </aside>
        </div>
      )}

      <ReviewDialog
        open={ending && !!picked}
        caps={t("connectedSites.endCaps")}
        origin={picked?.origin ?? ""}
        heading={t("connectedSites.endTitle")}
        reject={t("common.cancel")}
        action={t("connectedSites.disconnect")}
        onReject={() => setEnding(false)}
        onAction={disconnect}
        danger
      >
        <p className="px-1 text-meta leading-relaxed text-content-secondary">
          {pickedWallets.length > 1
            ? t("connectedSites.endNoteMany", { n: pickedWallets.length })
            : t("connectedSites.endNoteOne")}
        </p>
      </ReviewDialog>
    </Screen>
  );
}
