import { describe, expect, it } from "vitest";
import {
  followOpen,
  readSite,
  siteWalletInUse,
  siteWallets,
  withWallet,
  withoutWallets,
  type DappSite,
} from "src/features/dapp/services/siteModel";

const A = `oct${"A".repeat(44)}`;
const B = `oct${"B".repeat(44)}`;
const C = `oct${"C".repeat(44)}`;
const ORIGIN = "https://dapp.example";
const all = () => true;

function siteWith(...pairs: Array<[string, number]>): DappSite {
  let s: DappSite | null = null;
  for (const [address, at] of pairs) {
    s = withWallet(s, ORIGIN, { address, id: `id-${address.slice(3, 4)}` }, address, at);
  }
  return s!;
}

describe("site model", () => {
  it("follows the open wallet when it is one of the site's wallets", () => {
    const site = siteWith([A, 1], [B, 2]);
    expect(siteWalletInUse(site, B, all)).toBe(B);
    expect(siteWalletInUse(site, A, all)).toBe(A);
  });

  it("keeps its last wallet when the open wallet is not one of them", () => {
    const site = siteWith([A, 1]);
    const moved = followOpen(site, C, all);
    expect(moved.inUse).toBe(A);
    expect(moved.seenOpen).toBe(C);
    expect(siteWalletInUse(moved, C, all)).toBe(A);
  });

  it("never loses its connection on a wallet switch", () => {
    let site = siteWith([A, 1], [B, 2]);
    for (const open of [C, A, C, B, C]) {
      site = followOpen(site, open, all);
      expect(Object.keys(site.accounts).sort()).toEqual([A, B].sort());
      expect(siteWalletInUse(site, open, all)).not.toBeNull();
    }
  });

  it("exposes only the wallet in use, then the others", () => {
    const site = followOpen(siteWith([A, 1], [B, 2], [C, 3]), A, all);
    expect(siteWallets(site, A, all)[0]).toBe(A);
    expect(siteWallets(site, A, all)).toHaveLength(3);
  });

  it("skips wallets that left 0xio", () => {
    const site = siteWith([A, 1], [B, 2]);
    expect(siteWalletInUse(site, B, (a) => a !== B)).toBe(A);
    expect(siteWalletInUse(site, B, () => false)).toBeNull();
  });

  it("hands over to the wallet connected last when the one in use is removed", () => {
    const site = siteWith([A, 1], [B, 2], [C, 3]);
    const next = withoutWallets(site, (a) => a === C);
    expect(next.inUse).toBe(B);
    expect(withoutWallets(next, () => true).inUse).toBeUndefined();
  });

  it("reads a stored site field by field and drops bad entries", () => {
    const s = readSite(ORIGIN, {
      accounts: {
        [A]: { walletId: "a", connectedAt: 5 },
        "not-an-address": { walletId: "x", connectedAt: 9 },
        [B]: { connectedAt: 7 },
      },
      permissions: ["accounts", 3],
      favicon: "javascript:alert(1)",
    });
    expect(Object.keys(s!.accounts)).toEqual([A]);
    expect(s!.inUse).toBe(A);
    expect(s!.permissions).toEqual(["accounts"]);
    expect(s!.favicon).toBeUndefined();
    expect(readSite(ORIGIN, "nope")).toBeNull();
  });
});
