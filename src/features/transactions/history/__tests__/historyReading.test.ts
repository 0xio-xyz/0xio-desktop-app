import { describe, expect, it } from "vitest";
import { NETWORKS } from "src/services/network/config";
import {
  chainOf,
  explorerTxUrl,
  networkLabel,
  readNetworks,
  sideOf,
} from "src/features/transactions/history/sides";
import {
  callAction,
  callTitle,
  knownOctraContract,
  methodRow,
  methodWords,
} from "src/features/transactions/history/callReading";
import { octraContractName, tokenSpamReason } from "src/features/transactions/history/tokenNames";
import { txState, STILL_PENDING_MS } from "src/features/transactions/history/outcome";
import { txView, rowFromDetail } from "src/features/transactions/history/txView";
import type { Transaction } from "src/types/transaction";

const t = (key: string, o?: Record<string, unknown>) => {
  let s = String(o?.defaultValue ?? key);
  for (const [k, v] of Object.entries(o ?? {})) s = s.replace(`{{${k}}}`, String(v));
  return s;
};

const ME = "oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio";
const BRIDGE = "oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq";
const VAULT = "octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc";
const MARKET = "octGoeTjaF8MiKTP5ad5FJfWMCZmmEdnrfxTow6UUVmBj6h";

const row = (over: Partial<Transaction>): Transaction => ({
  hash: "h1",
  type: "contract_call",
  amount: 0,
  fee: 3000,
  from: ME,
  to: MARKET,
  timestamp: 1_792_152_321_701,
  status: "confirmed",
  network: "mainnet",
  ...over,
});

describe("pages and networks", () => {
  it("puts the testnet on Testnet and everything else on Mainnet", () => {
    expect(sideOf("mainnet")).toBe("mainnet");
    expect(sideOf("devnet")).toBe("testnet");
    expect(sideOf("devnet2")).toBe("testnet");
    expect(sideOf("custom_1")).toBe("mainnet");
  });

  it("reads each side's networks and a custom node only while it is active", () => {
    expect(readNetworks("mainnet", "mainnet")).toEqual(["mainnet"]);
    expect(readNetworks("testnet", "mainnet")).toEqual(["devnet"]);
    expect(readNetworks("testnet", "devnet2")).toEqual(["devnet2"]);
    NETWORKS.custom_9 = { ...NETWORKS.mainnet, id: "custom_9", name: "My node" };
    try {
      expect(readNetworks("mainnet", "custom_9")).toEqual(["mainnet", "custom_9"]);
      expect(readNetworks("testnet", "custom_9")).toEqual(["devnet"]);
      expect(networkLabel("custom_9", t)).toBe("My node");
    } finally {
      delete NETWORKS.custom_9;
    }
  });

  it("names rows Octra Mainnet and Octra Testnet, never Devnet", () => {
    expect(networkLabel("mainnet", t)).toBe("Octra Mainnet");
    expect(networkLabel("devnet", t)).toBe("Octra Testnet");
    expect(networkLabel("devnet2", t)).toBe("Octra Testnet");
    expect(chainOf("devnet2")).toBe("devnet");
  });

  it("links each row to its own network's explorer", () => {
    expect(explorerTxUrl("devnet", "abc")).toBe("https://devnet.octrascan.io/tx.html?hash=abc");
    expect(explorerTxUrl("mainnet", "abc")).toBe("https://octrascan.io/tx.html?hash=abc");
  });
});

describe("contract calls read as actions", () => {
  it.each([
    ["approve", ["octX", "5"], "Approve"],
    ["approve", ["octX", "0"], "Revoke"],
    ["set_approval_for_all", ["octX", false], "Revoke"],
    ["transfer", null, "Transfer"],
    ["mint_nft", null, "Mint"],
    ["list_nft", null, "List"],
    ["buy_nft", null, "Buy"],
    ["lock_to_eth", null, "Bridge"],
    ["claim_rewards", null, "Claim"],
    ["swap_exact_in", null, "Swap"],
    ["withdraw_bond", null, "Withdraw"],
    ["unlock_trusted", null, "Unlock Trusted"],
    ["cancel_listing", null, "Cancel Listing"],
    [undefined, null, "Contract call"],
    ["0xa9059cbb", null, "Contract call"],
  ])("%s reads %s", (method, args, title) => {
    expect(callTitle(method, t, { args })).toBe(title);
  });

  it("reads a swap vault lock as Swap and a plain lock by its words", () => {
    const vault = knownOctraContract("devnet", VAULT);
    expect(vault?.name).toBe("SwapVault");
    expect(callAction("lock", { swapVault: vault?.swapVault })).toBe("swap");
    expect(callTitle("lock", t)).toBe("Lock");
    expect(knownOctraContract("devnet2", VAULT)?.name).toBe("SwapVault");
    expect(knownOctraContract("mainnet", VAULT)).toBeNull();
  });

  it("shows the Method row only when it says more than the title", () => {
    expect(methodRow("list_nft", "List")).toBe("List NFT");
    expect(methodRow("transfer", "Transfer")).toBeNull();
    expect(methodWords("lockToEth")).toBe("Lock To ETH");
  });
});

describe("contract names", () => {
  it("names known contracts, the network's WOCT and listed tokens", () => {
    expect(octraContractName("mainnet", BRIDGE)).toBe("OCT Bridge");
    expect(octraContractName("devnet", "octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs")).toBe(
      "WOCT",
    );
    const listed = [{ network: "octra-devnet", address: "octZ", symbol: "0XIO" }];
    expect(octraContractName("devnet", "octZ", null, listed)).toBe("0XIO");
    expect(octraContractName("mainnet", "octZ", null, listed)).toBeNull();
  });

  it("shows a token's own name only when it passes the spam rules", () => {
    expect(octraContractName("mainnet", MARKET, { symbol: "ZXC", name: "Zed" })).toBe("ZXC");
    expect(octraContractName("mainnet", MARKET, { symbol: "visit-oct.io" })).toBeNull();
    expect(octraContractName("mainnet", MARKET, { symbol: "AIRDROP" })).toBeNull();
    expect(octraContractName("mainnet", MARKET, { symbol: "OCT" })).toBeNull();
    expect(octraContractName("mainnet", MARKET, { symbol: "ОСТ" })).toBeNull();
    expect(tokenSpamReason("mainnet", MARKET, { name: "Free gift" })).toBe("bait");
    expect(octraContractName("mainnet", MARKET, null)).toBeNull();
  });
});

describe("rows", () => {
  it("reads a call by its action and contract, with no amount when nothing moved", () => {
    const v = txView(row({}), { me: ME, network: "mainnet", method: "list_nft" }, t);
    expect(v.title).toBe("List");
    expect(v.contract).toEqual({ address: MARKET, name: null });
    expect(v.amount).toBeNull();
    expect(v.sign).toBe("");
  });

  it("keeps the amount of a call that carried OCT", () => {
    const v = txView(
      row({
        to: BRIDGE,
        amount: 2_500_000_000,
        message: '["0xc68f177ac0465c51e6cf37cb4068142802f69a78"]',
      }),
      { me: ME, network: "mainnet", method: "lock_to_eth" },
      t,
    );
    expect(v.title).toBe("Bridge");
    expect(v.contract?.name).toBe("OCT Bridge");
    expect(v.amount).toBe("2,500");
    expect(v.sign).toBe("-");
  });

  it("reads a revoke from the row's own arguments", () => {
    const v = txView(
      row({ message: '["octDpvujku1YTWeEWKbqADu9nuWVQznW5GJy3e9Keru97ic","0"]' }),
      { me: ME, network: "mainnet", method: "approve" },
      t,
    );
    expect(v.title).toBe("Revoke");
  });

  it("reads transfers as Sent and Received with the other side", () => {
    const sent = txView(
      row({ type: "send", to: "octB", amount: 1_000_000 }),
      { me: ME, network: "devnet" },
      t,
    );
    expect([sent.title, sent.counterparty, sent.sign]).toEqual(["Sent", "octB", "-"]);
    const got = txView(
      row({ type: "receive", from: "octA", to: ME, amount: 1_000_000 }),
      { me: ME, network: "devnet" },
      t,
    );
    expect([got.title, got.counterparty, got.sign]).toEqual(["Received", "octA", "+"]);
  });

  it("builds a row from the node's detail alone", () => {
    const r = rowFromDetail(
      {
        hash: "x",
        from: ME,
        to: VAULT,
        amount_raw: "10000000",
        op_type: "call",
        status: "confirmed",
        timestamp: 1790152512.834,
        nonce: 260,
        ou: "10000",
      },
      "devnet",
      ME,
    );
    expect(r.type).toBe("contract_call");
    expect(r.network).toBe("devnet");
    expect(r.timestamp).toBe(1790152512834);
  });
});

describe("honest states", () => {
  const now = 1_800_000_000_000;
  it("keeps a fresh mempool row pending and calls an old one out", () => {
    expect(txState({ status: "pending", timestamp: now - 1000 }, undefined, now)).toBe("pending");
    expect(
      txState({ status: "pending", timestamp: now - STILL_PENDING_MS - 1 }, undefined, now),
    ).toBe("stillPending");
  });

  it("reads dropped and expired as dropped, which the list shows as failed", () => {
    expect(txState({ status: "failed", timestamp: 1, chain_status: "dropped" })).toBe("dropped");
    expect(txState({ status: "pending", timestamp: now }, "expired", now)).toBe("dropped");
    expect(txState({ status: "failed", timestamp: 1, chain_status: "rejected" })).toBe("failed");
  });

  it("never reads a failed lookup as anything but what the list knew", () => {
    expect(txState({ status: "pending", timestamp: now }, "error", now)).toBe("pending");
    expect(txState({ status: "pending", timestamp: now }, undefined, now)).toBe("pending");
    expect(txState({ status: "confirmed", timestamp: now }, "unknown", now)).toBe("confirmed");
    expect(txState({ status: "pending", timestamp: now }, "confirmed", now)).toBe("confirmed");
  });
});
