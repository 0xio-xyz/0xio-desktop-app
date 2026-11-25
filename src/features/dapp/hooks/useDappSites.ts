import { useSyncExternalStore } from "react";
import * as dappService from "src/features/dapp/services/dappService";
import type { DappSite } from "src/features/dapp/services/siteModel";
import type { SiteWalletInfo } from "src/features/dapp/services/dappService";

export function useDappSites(networkId: string): DappSite[] {
  useSyncExternalStore(dappService.subscribeSites, dappService.sitesVersion);
  return dappService.listSites(networkId);
}

export function siteDisplayWallets(site: DappSite, wallets: SiteWalletInfo[]): SiteWalletInfo[] {
  const found = (a: string) => wallets.find((w) => w.address === a);
  const order = Object.entries(site.accounts)
    .sort((a, b) => b[1].connectedAt - a[1].connectedAt)
    .map(([a]) => a);
  const list = site.inUse ? [site.inUse, ...order.filter((a) => a !== site.inUse)] : order;
  return list.map(found).filter((w): w is SiteWalletInfo => !!w);
}

export const sitePath = (origin: string): string =>
  `/connected-sites/site?origin=${encodeURIComponent(origin)}`;
