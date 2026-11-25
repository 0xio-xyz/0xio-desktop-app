import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "src/lib/query";

vi.mock("src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    pvacOp: vi.fn(),
    timed: vi.fn(async (_tag: string, _label: string, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("src/shared/dev/debugLogs", () => ({ logPvacTiming: vi.fn() }));

// Stand-in for the Rust PVAC slot: one context at a time, every op must name it.
const rust = vi.hoisted(() => ({
  fp: null as string | null,
  serializeGate: null as Promise<void> | null,
  vault: new Map<string, { address: string; byte: number }>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "pvac_init_wallet") {
      const wallet = rust.vault.get(args.walletId as string);
      if (!wallet) throw "Wallet not found";
      if (wallet.address !== args.expectAddress) throw "Wallet does not match the expected address";
      rust.fp = `fp-${wallet.byte}`;
      return { ready: true, init_ms: 1, ctx: rust.fp };
    }
    if (cmd === "stealth_match_outputs") {
      const wallet = rust.vault.get(args.walletId as string);
      if (!wallet) throw "Wallet not found";
      if (wallet.address !== args.expectAddress) throw "Wallet does not match the expected address";
      return (args.outputs as { id: number; stealth_tag: string; enc_amount: string }[])
        .filter((o) => o.stealth_tag === `tag-${wallet.byte}`)
        .map((o) => ({ id: o.id, amount: o.enc_amount, claim_secret: "cs", blinding: "bl" }));
    }
    if (cmd === "pvac_destroy") {
      rust.fp = null;
      return null;
    }
    if (cmd === "wallet_lock") return null;
    if (!rust.fp) throw "PVAC not initialized. Call pvac_init first.";
    if (args.ctxId !== rust.fp) throw "PVAC context belongs to another wallet. Try again.";
    if (cmd === "pvac_serialize_pubkey") {
      const fp = rust.fp;
      if (rust.serializeGate) await rust.serializeGate;
      return { pubkey: `pub-${fp}` };
    }
    if (cmd === "pvac_matches_secret_profile") {
      return { matches: args.pubkey === `pub-${rust.fp}`, profile: 1 };
    }
    throw `unexpected ${cmd}`;
  }),
}));

vi.mock("src/services/network/networkService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/services/network/networkService")>();
  const getStealthOutputs = vi.fn();
  return {
    ...actual,
    getPvacPubkey: vi.fn(),
    getStealthOutputs,
    getChainHead: vi.fn(async () => 5000),
    scanStealthOutputs: vi.fn(async (from: number, networkId: string) => ({
      outputs: await getStealthOutputs(from, networkId),
      complete: true,
    })),
    getTransactionDetails: vi.fn(),
  };
});

import * as networkService from "src/services/network/networkService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { invoke } from "@tauri-apps/api/core";
import {
  initPvac,
  destroyPvac,
  getLocalPubkey,
  isOurPubkey,
  getPvacRegistrationState,
  getStealthOutputs,
  resetStealthScanCache,
} from "src/features/privacy/services/privacyService";
import {
  recordPendingKeySwitch,
  getPendingKeySwitch,
} from "src/features/privacy/services/keySwitchService";
import {
  seedClaimBudget,
  consumeClaimSlot,
  hasClaimSlot,
} from "src/features/privacy/services/claimBudget";

import { dropLockedData } from "src/features/security/services/lockCleanup";
import { endStaleSession } from "src/features/security/services/bootSession";

const ns = vi.mocked(networkService);

const WALLET_A = "wallet-a";
const WALLET_B = "wallet-b";
const ADDR_A = `oct${"A".repeat(44)}`;
const ADDR_B = `oct${"B".repeat(44)}`;

type Output = Awaited<ReturnType<typeof networkService.getStealthOutputs>>[number];

function outputFor(byte: number, id: number, amount: number): Output {
  return {
    id,
    eph_pub: "eph",
    stealth_tag: `tag-${byte}`,
    enc_amount: String(amount),
    claimed: 0,
    epoch_id: 1,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  rust.vault.clear();
  rust.vault.set(WALLET_A, { address: ADDR_A, byte: 1 });
  rust.vault.set(WALLET_B, { address: ADDR_B, byte: 2 });
  rust.serializeGate = null;
  await pvacBridge.destroy();
  resetStealthScanCache();
  localStorage.clear();
  ns.getPvacPubkey.mockReset();
  ns.getStealthOutputs.mockReset();
  ns.getTransactionDetails.mockReset();
});

describe("local PVAC pubkey", () => {
  it("never returns wallet A's key for wallet B after a switch", async () => {
    await initPvac(WALLET_A, ADDR_A);
    expect(await getLocalPubkey(ADDR_A)).toBe("pub-fp-1");

    await pvacBridge.destroy();
    await initPvac(WALLET_B, ADDR_B);
    expect(await getLocalPubkey(ADDR_B)).toBe("pub-fp-2");
    await expect(getLocalPubkey(ADDR_A)).rejects.toMatchObject({ name: "PvacContextMismatch" });
  });

  it("serialises once for callers at once and for later ones", async () => {
    await initPvac(WALLET_A, ADDR_A);
    vi.mocked(invoke).mockClear();
    const gate = deferred<void>();
    rust.serializeGate = gate.promise;
    const all = [getLocalPubkey(ADDR_A), getLocalPubkey(ADDR_A), getLocalPubkey(ADDR_A)];
    gate.resolve();
    expect(await Promise.all(all)).toEqual(["pub-fp-1", "pub-fp-1", "pub-fp-1"]);
    expect(await getLocalPubkey(ADDR_A)).toBe("pub-fp-1");
    const serialised = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "pvac_serialize_pubkey");
    expect(serialised).toHaveLength(1);
  });

  it("re-inits for the new wallet even without an explicit destroy", async () => {
    await initPvac(WALLET_A, ADDR_A);
    await getLocalPubkey(ADDR_A);
    await initPvac(WALLET_B, ADDR_B);
    expect(await getLocalPubkey(ADDR_B)).toBe("pub-fp-2");
  });

  it("keeps a serialize that finished after a switch bound to its own wallet", async () => {
    await initPvac(WALLET_A, ADDR_A);
    const gate = deferred<void>();
    rust.serializeGate = gate.promise;
    const slow = getLocalPubkey(ADDR_A);
    rust.serializeGate = null;
    await initPvac(WALLET_B, ADDR_B);
    gate.resolve();
    expect(await slow).toBe("pub-fp-1");
    expect(await getLocalPubkey(ADDR_B)).toBe("pub-fp-2");
  });

  it("rejects an op sent with a stale context id", async () => {
    await initPvac(WALLET_A, ADDR_A);
    const stale = pvacBridge.contextId()!;
    await initPvac(WALLET_B, ADDR_B);
    await expect(pvacBridge.serializePubkey(stale)).rejects.toMatch(/another wallet/);
    expect(pvacBridge.isInitializedFor(ADDR_B)).toBe(true);
  });

  it("matches a remote key against the wallet's own context only", async () => {
    await initPvac(WALLET_A, ADDR_A);
    expect(await isOurPubkey(ADDR_A, "pub-fp-1")).toBe(true);
    await initPvac(WALLET_B, ADDR_B);
    expect(await isOurPubkey(ADDR_B, "pub-fp-1")).toBe(false);
    await expect(isOurPubkey(ADDR_A, "pub-fp-1")).rejects.toMatchObject({
      name: "PvacContextMismatch",
    });
  });
});

describe("PVAC init by wallet", () => {
  it("names the wallet and its address and sends no key", async () => {
    vi.mocked(invoke).mockClear();
    await initPvac(WALLET_A, ADDR_A);
    const inits = vi.mocked(invoke).mock.calls.filter(([cmd]) => /^pvac_init/.test(String(cmd)));
    expect(inits).toEqual([["pvac_init_wallet", { walletId: WALLET_A, expectAddress: ADDR_A }]]);
  });

  it("leaves no context when the wallet is not the expected address", async () => {
    await expect(initPvac(WALLET_A, ADDR_B)).rejects.toMatch(/expected address/);
    expect(pvacBridge.isInitialized()).toBe(false);
    expect(pvacBridge.isInitializedFor(ADDR_A)).toBe(false);
    expect(pvacBridge.isInitializedFor(ADDR_B)).toBe(false);
    await initPvac(WALLET_B, ADDR_B);
    expect(pvacBridge.isInitializedFor(ADDR_B)).toBe(true);
  });

  it("drops the running context when an init for another address is refused", async () => {
    await initPvac(WALLET_A, ADDR_A);
    await expect(initPvac(WALLET_A, ADDR_B)).rejects.toMatch(/expected address/);
    expect(pvacBridge.isInitialized()).toBe(false);
    expect(pvacBridge.isInitializedFor(ADDR_B)).toBe(false);
  });
});

describe("registration cache", () => {
  it("does not let a devnet registration answer for mainnet", async () => {
    await initPvac(WALLET_A, ADDR_A);
    ns.getPvacPubkey.mockImplementation(async (_addr, net) =>
      net === "devnet" ? "pub-fp-1" : null,
    );
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("registered");
    expect(await getPvacRegistrationState(ADDR_A, "mainnet")).toBe("unregistered");
    expect(ns.getPvacPubkey).toHaveBeenLastCalledWith(ADDR_A, "mainnet");
  });
});

describe("stealth scan cache", () => {
  it("keeps each network's claimable outputs apart", async () => {
    const outA = outputFor(1, 7, 5_000);
    ns.getStealthOutputs.mockImplementation(async (_epoch, net) =>
      net === "devnet" ? [outA] : [],
    );
    const devnet = await getStealthOutputs(WALLET_A, ADDR_A, "devnet");
    expect(devnet.map((o) => o.id)).toEqual([7]);
    expect(await getStealthOutputs(WALLET_A, ADDR_A, "mainnet")).toEqual([]);
  });

  it("serves the empty-RPC fallback only from the same scope", async () => {
    const outA = outputFor(1, 7, 5_000);
    ns.getStealthOutputs.mockResolvedValueOnce([outA]);
    await getStealthOutputs(WALLET_A, ADDR_A, "devnet");
    ns.getStealthOutputs.mockResolvedValue([]);
    expect(await getStealthOutputs(WALLET_A, ADDR_A, "mainnet")).toEqual([]);
    expect((await getStealthOutputs(WALLET_A, ADDR_A, "devnet")).map((o) => o.id)).toEqual([7]);
  });

  it("does not join a scan running for another network or wallet", async () => {
    const pending = deferred<Output[]>();
    ns.getStealthOutputs.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const devnetScan = getStealthOutputs(WALLET_A, ADDR_A, "devnet");
    const mainnetScan = getStealthOutputs(WALLET_A, ADDR_A, "mainnet");
    const otherWallet = getStealthOutputs(WALLET_B, ADDR_B, "devnet");
    expect(mainnetScan).not.toBe(devnetScan);
    expect(otherWallet).not.toBe(devnetScan);
    expect(await mainnetScan).toEqual([]);
    expect(await otherWallet).toEqual([]);
    pending.resolve([outputFor(1, 9, 1_000)]);
    expect((await devnetScan).map((o) => o.id)).toEqual([9]);
    expect(ns.getStealthOutputs.mock.calls.map((c) => c[1])).toEqual([
      "devnet",
      "mainnet",
      "devnet",
    ]);
  });

  it("drops a scan result that lands after the cache was reset", async () => {
    const pending = deferred<Output[]>();
    ns.getStealthOutputs.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const late = getStealthOutputs(WALLET_A, ADDR_A, "devnet");
    resetStealthScanCache();
    pending.resolve([outputFor(1, 11, 2_000)]);
    await late;
    expect(await getStealthOutputs(WALLET_A, ADDR_A, "devnet")).toEqual([]);
  });

  it("refuses to scan a wallet under another address, before any fetch", async () => {
    ns.getStealthOutputs.mockResolvedValue([outputFor(1, 7, 5_000)]);
    await expect(getStealthOutputs(WALLET_A, ADDR_B, "devnet")).rejects.toMatch(/expected address/);
    await expect(getStealthOutputs("gone", ADDR_A, "devnet")).rejects.toMatch(/not found/);
    expect(ns.getStealthOutputs).not.toHaveBeenCalled();
    expect(await getStealthOutputs(WALLET_B, ADDR_B, "devnet")).toEqual([]);
  });
});

describe("network-scoped records", () => {
  it("keeps a pending key switch on the network it was sent to", () => {
    localStorage.setItem("0xio_pending_key_switch", JSON.stringify({ [ADDR_A]: { txHash: "x" } }));
    recordPendingKeySwitch("devnet", ADDR_A, "0xdev");
    expect(getPendingKeySwitch("devnet", ADDR_A)?.txHash).toBe("0xdev");
    expect(getPendingKeySwitch("mainnet", ADDR_A)).toBeNull();
    expect(localStorage.getItem("0xio_pending_key_switch")).toBeNull();
  });

  it("keeps claim budgets per network", () => {
    const devnet = { networkId: "devnet", address: ADDR_A };
    const mainnet = { networkId: "mainnet", address: ADDR_A };
    seedClaimBudget(devnet, "c".repeat(100), 4);
    expect(consumeClaimSlot(devnet)).toBe(true);
    expect(consumeClaimSlot(devnet)).toBe(false);
    seedClaimBudget(mainnet, "d".repeat(100), 2);
    expect(hasClaimSlot(mainnet)).toBe(true);
    expect(hasClaimSlot(devnet)).toBe(false);
  });
});

describe("a first registration that never lands", () => {
  const HALF_HOUR = 30 * 60_000;
  afterEach(() => vi.useRealTimers());

  async function staged(ageMs: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    await destroyPvac();
    await initPvac(WALLET_A, ADDR_A);
    ns.getPvacPubkey.mockResolvedValue(null);
    recordPendingKeySwitch("devnet", ADDR_A, "tx-setup");
    vi.setSystemTime(Date.now() + ageMs);
  }

  it("stays pending inside the window", async () => {
    await staged(HALF_HOUR - 1000);
    ns.getTransactionDetails.mockResolvedValue(null);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("pending");
    expect(getPendingKeySwitch("devnet", ADDR_A)?.txHash).toBe("tx-setup");
  });

  it("is forgotten after the window when the node no longer lists it", async () => {
    await staged(HALF_HOUR);
    ns.getTransactionDetails.mockResolvedValue(null);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("unregistered");
    expect(getPendingKeySwitch("devnet", ADDR_A)).toBeNull();
  });

  it("is forgotten after the window when the node calls it dropped", async () => {
    await staged(HALF_HOUR);
    ns.getTransactionDetails.mockResolvedValue({ status: "dropped" } as never);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("unregistered");
  });

  it("stays pending past the window while the node still holds it", async () => {
    await staged(HALF_HOUR * 4);
    ns.getTransactionDetails.mockResolvedValue({ status: "pending" } as never);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("pending");
    expect(getPendingKeySwitch("devnet", ADDR_A)?.txHash).toBe("tx-setup");
  });

  it("stays pending past the window when the node cannot be read", async () => {
    await staged(HALF_HOUR * 4);
    ns.getPvacPubkey.mockRejectedValue(new Error("offline"));
    await expect(getPvacRegistrationState(ADDR_A, "devnet")).rejects.toThrow("offline");
    expect(getPendingKeySwitch("devnet", ADDR_A)?.txHash).toBe("tx-setup");
  });

  it("counts as registered once confirmed, however late", async () => {
    await staged(HALF_HOUR * 4);
    ns.getTransactionDetails.mockResolvedValue({ status: "confirmed", epoch: 9 } as never);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("registered");
  });

  it("keeps another network's record", async () => {
    await staged(0);
    recordPendingKeySwitch("mainnet", ADDR_A, "tx-main");
    vi.setSystemTime(Date.now() + HALF_HOUR);
    ns.getTransactionDetails.mockResolvedValue(null);
    expect(await getPvacRegistrationState(ADDR_A, "devnet")).toBe("unregistered");
    expect(getPendingKeySwitch("mainnet", ADDR_A)?.txHash).toBe("tx-main");
  });
});

describe("lock", () => {
  it("forgets claim secrets and the private balance, keeps the rest", async () => {
    ns.getStealthOutputs.mockResolvedValueOnce([outputFor(1, 7, 5_000)]);
    const found = await getStealthOutputs(WALLET_A, ADDR_A, "devnet");
    expect(found[0].claimSecret).toBe("cs");
    const qc = new QueryClient();
    qc.setQueryData(["claimOutputs", WALLET_A, "devnet"], found);
    qc.setQueryData(["privateBalance", ADDR_A, "devnet"], 42);
    qc.setQueryData(["privateBalance", ADDR_B, "mainnet"], 43);
    qc.setQueryData(["balance", ADDR_A, "devnet"], { balance: 1, nonce: 0 });

    dropLockedData(qc);

    expect(qc.getQueryData(["claimOutputs", WALLET_A, "devnet"])).toBeUndefined();
    expect(qc.getQueryData(["privateBalance", ADDR_A, "devnet"])).toBeUndefined();
    expect(qc.getQueryData(["privateBalance", ADDR_B, "mainnet"])).toBeUndefined();
    expect(qc.getQueryData(["balance", ADDR_A, "devnet"])).toEqual({ balance: 1, nonce: 0 });
    ns.getStealthOutputs.mockResolvedValue([]);
    expect(await getStealthOutputs(WALLET_A, ADDR_A, "devnet")).toEqual([]);
  });

  it("ends a session left over from before a reload", async () => {
    vi.mocked(invoke).mockClear();
    await endStaleSession();
    const sent = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(sent).toContain("wallet_lock");
    expect(sent).toContain("pvac_destroy");
  });
});
