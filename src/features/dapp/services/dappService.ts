/**
 * Connected sites, persisted per network and origin (siteModel.ts picks the wallet in use). Sites
 * stored by the old origin list are moved in on the first read that knows the open wallet, so no
 * connection is lost.
 */

import { logger } from "src/lib/logger";
import { NETWORKS } from "src/services/network/config";
import { publishDappEvent } from "src/features/dapp/services/dappEvents";
import { setSiteScopeCheck, type TxScope } from "src/services/network/networkService";
import {
  readSite,
  followOpen,
  siteWalletInUse,
  siteConnectedAt,
  withWallet,
  withoutWallets,
  type DappSite,
  type UsableWallet,
} from "src/features/dapp/services/siteModel";

const SITES_KEY = "0xio_dapp_sites";
export const LEGACY_KEY = "0xio_approved_dapps";
export const LEGACY_PERMS_KEY = "0xio_dapp_permissions";

type Store = Record<string, Record<string, DappSite>>;

export interface SiteWalletInfo {
  id: string;
  address: string;
  name: string;
  wallet_type: string;
}

export const canSignWallet = (w: { wallet_type?: string } | null | undefined): boolean =>
  !!w && w.wallet_type !== "watch";

export const WATCH_ONLY_ERROR = Object.freeze({
  code: "WATCH_ONLY",
  message: "This wallet is watch-only and cannot sign.",
});

export const GONE_ERROR = Object.freeze({
  code: "NOT_CONNECTED",
  message: "The wallet this site was connected to is no longer in 0xio. Connect again.",
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function load(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(SITES_KEY) || "{}");
  } catch {
    raw = {};
  }
  const store: Store = {};
  if (!isRecord(raw)) return store;
  for (const [networkId, sites] of Object.entries(raw)) {
    if (!isRecord(sites)) continue;
    const out: Record<string, DappSite> = {};
    for (const [origin, s] of Object.entries(sites)) {
      const site = readSite(origin, s);
      if (site && Object.keys(site.accounts).length) out[origin] = site;
    }
    if (Object.keys(out).length) store[networkId] = out;
  }
  return store;
}

const listeners = new Set<() => void>();
let version = 0;

function save(store: Store): void {
  localStorage.setItem(SITES_KEY, JSON.stringify(store));
  version++;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

/** For useSyncExternalStore: screens re-read when any site changes. */
export function subscribeSites(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const sitesVersion = (): number => version;

/**
 * Moves the old origin list in. The old model gave a site whatever wallet was open, so each old
 * site gets the wallet open now, on every network (the old list was not per network), with the
 * scopes it was granted. Returns true when something moved.
 */
export function migrateLegacy(open: { id: string; address: string } | null): boolean {
  let origins: unknown;
  try {
    origins = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch {
    origins = null;
  }
  if (!Array.isArray(origins)) return false;
  if (!open) return false;
  let perms: Record<string, unknown> = {};
  try {
    const p = JSON.parse(localStorage.getItem(LEGACY_PERMS_KEY) || "{}");
    if (isRecord(p)) perms = p;
  } catch {}
  const store = load();
  const now = Date.now();
  for (const origin of origins) {
    if (typeof origin !== "string" || !origin) continue;
    const granted = Array.isArray(perms[origin])
      ? (perms[origin] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    for (const networkId of Object.keys(NETWORKS)) {
      const sites = (store[networkId] ??= {});
      if (sites[origin]) continue;
      sites[origin] = {
        ...withWallet(null, origin, open, open.address, now),
        permissions: granted,
      };
    }
  }
  save(store);
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(LEGACY_PERMS_KEY);
  logger.info("dapp", `moved ${origins.length} connected site(s) to the per-wallet model`);
  return true;
}

export function getSite(networkId: string, origin: string): DappSite | null {
  return load()[networkId]?.[origin] ?? null;
}

export function isConnected(networkId: string, origin: string): boolean {
  return !!getSite(networkId, origin);
}

export function listSites(networkId: string): DappSite[] {
  return Object.values(load()[networkId] ?? {}).sort(
    (a, b) => siteConnectedAt(b) - siteConnectedAt(a),
  );
}

export function connectedOrigins(networkId: string): string[] {
  return Object.keys(load()[networkId] ?? {});
}

export function sitesUsing(networkId: string, address: string): string[] {
  return listSites(networkId)
    .filter((s) => s.inUse === address)
    .map((s) => s.origin);
}

/**
 * The site and the one wallet it sees, after the open wallet is taken into account. A move to the
 * open wallet is stored, so the next read and the signing scope agree. `address` is null when
 * the site is not connected or none of its wallets is left in 0xio.
 */
export function resolveSite(
  networkId: string,
  origin: string,
  open: string | null,
  usable: UsableWallet,
): { site: DappSite | null; address: string | null } {
  const store = load();
  const site = store[networkId]?.[origin];
  if (!site) return { site: null, address: null };
  const followed = followOpen(site, open, usable);
  const address = siteWalletInUse(followed, open, usable);
  const next = address && address !== followed.inUse ? { ...followed, inUse: address } : followed;
  if (next !== site) {
    store[networkId][origin] = next;
    save(store);
  }
  return { site: next, address };
}

export function connectWallet(
  networkId: string,
  origin: string,
  wallet: { id: string; address: string },
  open: string | null,
  opts: { permissions?: string[]; favicon?: string } = {},
): DappSite {
  const store = load();
  const sites = (store[networkId] ??= {});
  const next = withWallet(sites[origin] ?? null, origin, wallet, open);
  if (opts.permissions) next.permissions = opts.permissions;
  if (opts.favicon) next.favicon = opts.favicon;
  sites[origin] = next;
  save(store);
  logger.info("dapp", `connected - ${origin} on ${networkId}`);
  return next;
}

export function getPermissions(networkId: string, origin: string): string[] {
  return getSite(networkId, origin)?.permissions ?? [];
}

export function disconnectSite(networkId: string, origin: string, reason = "revoked"): void {
  const store = load();
  if (!store[networkId]?.[origin]) return;
  delete store[networkId][origin];
  save(store);
  logger.info("dapp", `disconnected - ${origin} on ${networkId}`);
  // Addressed explicitly: by now the origin is no longer in the connected list.
  publishDappEvent("disconnect", { origin, reason }, [origin]);
}

/**
 * Takes one wallet off a site. The last wallet leaving disconnects the site. Returns the site
 * after the change, or null when it was disconnected.
 */
export function removeWallet(networkId: string, origin: string, address: string): DappSite | null {
  const store = load();
  const site = store[networkId]?.[origin];
  if (!site) return null;
  const next = withoutWallets(site, (a) => a === address);
  if (!Object.keys(next.accounts).length) {
    disconnectSite(networkId, origin);
    return null;
  }
  store[networkId][origin] = next;
  save(store);
  return next;
}

export function followOpenAll(
  networkId: string,
  open: string | null,
  usable: UsableWallet,
): Array<{ origin: string; address: string }> {
  const store = load();
  const sites = store[networkId];
  if (!sites || !open) return [];
  const moved: Array<{ origin: string; address: string }> = [];
  let changed = false;
  for (const [origin, site] of Object.entries(sites)) {
    const next = followOpen(site, open, usable);
    if (next === site) continue;
    sites[origin] = next;
    changed = true;
    if (next.inUse && next.inUse !== site.inUse) moved.push({ origin, address: next.inUse });
  }
  if (changed) save(store);
  return moved;
}

/**
 * A site that asked to move 0xio to another network goes with it: the user approved that switch
 * for this site, so it stays connected there with the wallet it had.
 */
export function carrySite(fromNetwork: string, toNetwork: string, origin: string): void {
  const store = load();
  const site = store[fromNetwork]?.[origin];
  if (!site || store[toNetwork]?.[origin]) return;
  (store[toNetwork] ??= {})[origin] = site;
  save(store);
}

/**
 * A signing scope pinned to a site stays current while that site, on that network, still uses
 * the wallet the review showed.
 */
export function siteScopeCurrent(scope: TxScope): boolean {
  if (!scope.site) return false;
  const site = getSite(scope.networkId, scope.site);
  return !!site && site.inUse === scope.address && !!site.accounts[scope.address];
}

setSiteScopeCheck(siteScopeCurrent);
