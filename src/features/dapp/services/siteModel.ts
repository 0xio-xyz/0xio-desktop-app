// The wallets a site is connected with and which one it uses. Pure, so the bridge, the screens
// and the tests read a site the same way.
//
// A site keeps every wallet the user connected to it. It follows the open wallet when that wallet
// is one of them, keeps the wallet it had otherwise, and never loses its connection because the
// user opened another wallet. A site only ever sees the wallet it uses.

interface SiteAccount {
  walletId: string;
  connectedAt: number;
}

export interface DappSite {
  origin: string;
  accounts: Record<string, SiteAccount>;
  inUse?: string;
  /** The open wallet when the site last looked: opening another connected wallet moves the site. */
  seenOpen?: string;
  /** Scopes granted on connect, exposed through octra_permissions. */
  permissions: string[];
  favicon?: string;
}

export type UsableWallet = (address: string) => boolean;

const OCT_ADDRESS = /^oct[1-9A-HJ-NP-Za-km-z]{40,50}$/;

export const isOctAddress = (v: unknown): v is string =>
  typeof v === "string" && OCT_ADDRESS.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const newestFirst = (accounts: DappSite["accounts"]): string[] =>
  Object.entries(accounts)
    .sort((a, b) => b[1].connectedAt - a[1].connectedAt)
    .map(([address]) => address);

/**
 * A stored site, checked field by field. A site without `inUse` uses the wallet connected last,
 * so no connection is lost.
 */
export function readSite(origin: string, raw: unknown): DappSite | null {
  if (!isRecord(raw)) return null;
  const accounts: DappSite["accounts"] = {};
  if (isRecord(raw.accounts)) {
    for (const [address, a] of Object.entries(raw.accounts)) {
      if (!isOctAddress(address) || !isRecord(a) || typeof a.walletId !== "string") continue;
      accounts[address] = {
        walletId: a.walletId,
        connectedAt: Number.isFinite(a.connectedAt) ? (a.connectedAt as number) : 0,
      };
    }
  }
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const site: DappSite = { origin, accounts, permissions };
  if (typeof raw.inUse === "string" && accounts[raw.inUse]) site.inUse = raw.inUse;
  else {
    const latest = newestFirst(accounts)[0];
    if (latest) site.inUse = latest;
  }
  if (typeof raw.seenOpen === "string") site.seenOpen = raw.seenOpen;
  if (typeof raw.favicon === "string" && /^https?:\/\//.test(raw.favicon)) {
    site.favicon = raw.favicon;
  }
  return site;
}

/**
 * The site after the open wallet is taken into account: when the user opened a different wallet
 * since the site last looked and that wallet is connected here, the site moves to it. Opening a
 * wallet that is not connected leaves the site on the wallet it had.
 */
export function followOpen(site: DappSite, open: string | null, usable: UsableWallet): DappSite {
  if (!open || open === site.seenOpen) return site;
  const follows = !!site.accounts[open] && usable(open);
  return { ...site, seenOpen: open, ...(follows ? { inUse: open } : {}) };
}

/**
 * The connected wallets that can serve the site, the one it uses first. When that one cannot
 * (removed from 0xio) the wallet connected last takes its place.
 */
export function siteWallets(
  site: DappSite | null | undefined,
  open: string | null,
  usable: UsableWallet,
): string[] {
  if (!site) return [];
  const s = followOpen(site, open, usable);
  const list = newestFirst(s.accounts).filter((a) => usable(a));
  return s.inUse && list.includes(s.inUse) ? [s.inUse, ...list.filter((a) => a !== s.inUse)] : list;
}

export function siteWalletInUse(
  site: DappSite | null | undefined,
  open: string | null,
  usable: UsableWallet,
): string | null {
  return siteWallets(site, open, usable)[0] ?? null;
}

export function withWallet(
  site: DappSite | null,
  origin: string,
  wallet: { address: string; id: string },
  open: string | null,
  now = Date.now(),
): DappSite {
  const base: DappSite = site ?? { origin, accounts: {}, permissions: [] };
  return {
    ...base,
    accounts: { ...base.accounts, [wallet.address]: { walletId: wallet.id, connectedAt: now } },
    inUse: wallet.address,
    ...(open ? { seenOpen: open } : {}),
  };
}

/** Drops wallets from the site; when the one in use leaves, the one connected last takes over. */
export function withoutWallets(site: DappSite, gone: (address: string) => boolean): DappSite {
  const accounts = Object.fromEntries(Object.entries(site.accounts).filter(([a]) => !gone(a)));
  const next: DappSite = { ...site, accounts };
  if (!next.inUse || !accounts[next.inUse]) {
    const latest = newestFirst(accounts)[0];
    if (latest) next.inUse = latest;
    else delete next.inUse;
  }
  return next;
}

export const siteConnectedAt = (site: DappSite): number =>
  Math.max(0, ...Object.values(site.accounts).map((a) => a.connectedAt));
