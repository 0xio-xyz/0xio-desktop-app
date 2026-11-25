import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dappService from "src/features/dapp/services/dappService";
import * as networkService from "src/services/network/networkService";
import { onDappEvent } from "src/features/dapp/services/dappEvents";

const A = { id: "wa", address: `oct${"A".repeat(44)}` };
const B = { id: "wb", address: `oct${"B".repeat(44)}` };
const C = { id: "wc", address: `oct${"C".repeat(44)}` };
const SITE = "https://dapp.example";
const OTHER = "https://other.example";
const all = () => true;

beforeEach(() => {
  localStorage.clear();
  networkService.setNetwork("mainnet");
  networkService.setActiveAddress(A.address);
});

describe("dapp service: per-site wallets", () => {
  it("moves the old origin list in on every network without losing a connection", () => {
    localStorage.setItem(dappService.LEGACY_KEY, JSON.stringify([SITE, OTHER]));
    localStorage.setItem(
      dappService.LEGACY_PERMS_KEY,
      JSON.stringify({ [SITE]: ["accounts", "private_proofs"] }),
    );
    expect(dappService.migrateLegacy(null)).toBe(false);
    expect(localStorage.getItem(dappService.LEGACY_KEY)).not.toBeNull();

    expect(dappService.migrateLegacy(A)).toBe(true);
    for (const net of ["mainnet", "devnet"]) {
      expect(dappService.connectedOrigins(net).sort()).toEqual([OTHER, SITE].sort());
      expect(dappService.getSite(net, SITE)!.inUse).toBe(A.address);
    }
    expect(dappService.getPermissions("mainnet", SITE)).toEqual(["accounts", "private_proofs"]);
    expect(localStorage.getItem(dappService.LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(dappService.LEGACY_PERMS_KEY)).toBeNull();
    expect(dappService.migrateLegacy(A)).toBe(false);
  });

  it("keeps connections per network and origin", () => {
    dappService.connectWallet("mainnet", SITE, A, A.address);
    expect(dappService.isConnected("mainnet", SITE)).toBe(true);
    expect(dappService.isConnected("devnet", SITE)).toBe(false);
    expect(dappService.isConnected("mainnet", OTHER)).toBe(false);
  });

  it("follows the open wallet, keeps its own otherwise, never disconnects", () => {
    dappService.connectWallet("mainnet", SITE, A, A.address);
    dappService.connectWallet("mainnet", SITE, B, A.address);
    dappService.connectWallet("mainnet", OTHER, A, A.address);
    expect(dappService.resolveSite("mainnet", SITE, A.address, all).address).toBe(B.address);

    const moved = dappService.followOpenAll("mainnet", A.address, all);
    expect(moved).toEqual([]);
    const toB = dappService.followOpenAll("mainnet", B.address, all);
    expect(toB).toEqual([]);
    const toC = dappService.followOpenAll("mainnet", C.address, all);
    expect(toC).toEqual([]);
    expect(dappService.resolveSite("mainnet", SITE, C.address, all).address).toBe(B.address);
    expect(dappService.resolveSite("mainnet", OTHER, C.address, all).address).toBe(A.address);

    const backToA = dappService.followOpenAll("mainnet", A.address, all);
    expect(backToA).toEqual([{ origin: SITE, address: A.address }]);
    expect(dappService.connectedOrigins("mainnet").sort()).toEqual([OTHER, SITE].sort());
    expect(dappService.sitesUsing("mainnet", A.address).sort()).toEqual([OTHER, SITE].sort());
  });

  it("removing the last wallet disconnects and tells only that site", () => {
    const heard: Array<[string, string[]]> = [];
    const off = onDappEvent((type, _d, origins) => heard.push([type, origins]));
    dappService.connectWallet("mainnet", SITE, A, A.address);
    dappService.connectWallet("mainnet", SITE, B, A.address);
    dappService.connectWallet("mainnet", OTHER, A, A.address);
    expect(dappService.removeWallet("mainnet", SITE, B.address)!.inUse).toBe(A.address);
    expect(dappService.removeWallet("mainnet", SITE, A.address)).toBeNull();
    expect(dappService.isConnected("mainnet", SITE)).toBe(false);
    expect(heard).toEqual([["disconnect", [SITE]]]);
    off();
  });

  it("carries a site to the network it asked for", () => {
    dappService.connectWallet("mainnet", SITE, B, A.address);
    dappService.carrySite("mainnet", "devnet", SITE);
    expect(dappService.getSite("devnet", SITE)!.inUse).toBe(B.address);
  });

  it("a site-pinned scope holds while the site still uses that wallet", () => {
    dappService.connectWallet("mainnet", SITE, B, A.address);
    const scope = networkService.captureSiteScope(B.address, SITE);
    expect(networkService.isScopeCurrent(scope)).toBe(true);
    networkService.setActiveAddress(C.address);
    expect(networkService.isScopeCurrent(scope)).toBe(true);
    dappService.connectWallet("mainnet", SITE, A, A.address);
    expect(networkService.isScopeCurrent(scope)).toBe(false);
    dappService.connectWallet("mainnet", SITE, B, A.address);
    networkService.setNetwork("devnet");
    expect(networkService.isScopeCurrent(scope)).toBe(false);
  });
});
