// A circle gets the wallet the way a site does: the connect review once, then the circle is a
// connected site (oct://<circle id>) on that network with that wallet, listed and revoked in
// Connected sites. The grant is network plus address plus circle.

import * as dappService from "src/features/dapp/services/dappService";
import {
  canSignWallet,
  WATCH_ONLY_ERROR,
  type SiteWalletInfo,
} from "src/features/dapp/services/dappService";

export const circleOrigin = (circleId: string): string => `oct://${circleId}`;

export class CircleAccessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CircleWallet {
  walletId: string;
  address: string;
  networkId: string;
  /** False once the open wallet or the network changed, or the grant was removed. */
  current: () => boolean;
}

export interface CircleAccessDeps {
  network: () => string;
  openWallet: () => SiteWalletInfo | null;
  /** The connect review for the open wallet; resolves with the user's answer. */
  ask: (origin: string, wallet: SiteWalletInfo) => Promise<{ approved: boolean }>;
  announce?: (origin: string, wallet: SiteWalletInfo) => void;
}

export function circleGranted(networkId: string, circleId: string, address: string): boolean {
  return !!dappService.getSite(networkId, circleOrigin(circleId))?.accounts[address];
}

export function createCircleAccess(deps: CircleAccessDeps) {
  const pending = new Map<string, Promise<CircleWallet>>();

  const walletFor = (networkId: string, circleId: string, w: SiteWalletInfo): CircleWallet => ({
    walletId: w.id,
    address: w.address,
    networkId,
    current: () =>
      deps.network() === networkId &&
      deps.openWallet()?.address === w.address &&
      circleGranted(networkId, circleId, w.address),
  });

  return function access(circleId: string): Promise<CircleWallet> {
    const open = deps.openWallet();
    if (!open) return Promise.reject(new CircleAccessError("WALLET_LOCKED", "No active wallet"));
    if (!canSignWallet(open))
      return Promise.reject(new CircleAccessError(WATCH_ONLY_ERROR.code, WATCH_ONLY_ERROR.message));
    const networkId = deps.network();
    if (circleGranted(networkId, circleId, open.address))
      return Promise.resolve(walletFor(networkId, circleId, open));

    const origin = circleOrigin(circleId);
    const key = `${networkId}|${open.address}|${origin}`;
    const asked = pending.get(key);
    if (asked) return asked;
    const ask = (async () => {
      let approved = false;
      try {
        approved = (await deps.ask(origin, open)).approved;
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        throw new CircleAccessError(
          typeof code === "string" ? code : "USER_REJECTED",
          e instanceof Error ? e.message : String(e),
        );
      }
      if (!approved) throw new CircleAccessError("USER_REJECTED", "User rejected the connection.");
      if (deps.network() !== networkId || deps.openWallet()?.address !== open.address)
        throw new CircleAccessError("WALLET_CHANGED", "The wallet or network changed. Try again.");
      const site = dappService.getSite(networkId, origin);
      dappService.connectWallet(networkId, origin, open, open.address, {
        permissions: site?.permissions,
      });
      deps.announce?.(origin, open);
      return walletFor(networkId, circleId, open);
    })();
    pending.set(key, ask);
    void ask.finally(() => pending.delete(key)).catch(() => {});
    return ask;
  };
}
