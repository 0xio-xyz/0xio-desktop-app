import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ calls: [] as unknown[][], answer: vi.fn() }));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCallOn: (...args: unknown[]) => {
    rpc.calls.push(args);
    return rpc.answer(...args);
  },
  getContractStorage: vi.fn(async () => null),
}));

import {
  loadMethods,
  MAX_METHODS,
  methodKey,
  peekMethod,
  rememberMethod,
  resetContractMethods,
} from "src/features/transactions/history/contractMethods";
import {
  CALL_DATA_MAX,
  callMethod,
  knownArgPlaceholders,
  octraArgRows,
  octraCallArgs,
  ouToOct,
} from "src/features/transactions/history/callRows";
import { CALL_VALUE_MAX, knownCallArgs } from "src/features/transactions/history/callArgs";
import { RpcError } from "src/services/network/submitErrors";

const t = (key: string, o?: Record<string, unknown>) => {
  let s = String(o?.defaultValue ?? key);
  for (const [k, v] of Object.entries(o ?? {})) s = s.replace(`{{${k}}}`, String(v));
  return s;
};
const noPause = () => Promise.resolve();

describe("method cache", () => {
  beforeEach(() => {
    localStorage.clear();
    resetContractMethods();
    rpc.calls = [];
    rpc.answer.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("reads each call's receipt on its own network and keys it by network + hash", async () => {
    rpc.answer.mockImplementation(async (net: string) => ({
      method: net === "mainnet" ? "list_nft" : "lock",
    }));
    await loadMethods(
      [
        { network: "mainnet", hash: "same" },
        { network: "devnet", hash: "same" },
      ],
      () => false,
      noPause,
    );
    expect(rpc.calls).toEqual([
      ["mainnet", "contract_receipt", ["same"]],
      ["devnet", "contract_receipt", ["same"]],
    ]);
    expect(peekMethod("mainnet", "same")).toBe("list_nft");
    expect(peekMethod("devnet", "same")).toBe("lock");
    const stored = JSON.parse(localStorage.getItem("0xio_contract_methods_v2")!);
    expect(stored).toEqual({ "mainnet:same": "list_nft", "devnet:same": "lock" });
  });

  it("never reads a call it already knows", async () => {
    rememberMethod("mainnet", "h", "approve");
    await loadMethods([{ network: "mainnet", hash: "h" }], () => false, noPause);
    expect(rpc.calls).toHaveLength(0);
  });

  it("drops the hash-only legacy store", () => {
    localStorage.setItem("0xio_contract_methods", JSON.stringify({ h: "transfer" }));
    resetContractMethods();
    expect(peekMethod("mainnet", "h")).toBeUndefined();
    expect(localStorage.getItem("0xio_contract_methods")).toBeNull();
  });

  it("keeps at most MAX_METHODS, oldest out first", () => {
    for (let i = 0; i <= MAX_METHODS; i++) rememberMethod("mainnet", `h${i}`, "m");
    expect(peekMethod("mainnet", "h0")).toBeUndefined();
    expect(peekMethod("mainnet", `h${MAX_METHODS}`)).toBe("m");
    const stored = JSON.parse(localStorage.getItem("0xio_contract_methods_v2")!);
    expect(Object.keys(stored)).toHaveLength(MAX_METHODS);
  });

  it("reads ten per pass and retries a failed read only after a minute", async () => {
    rpc.answer.mockRejectedValue(new Error("429"));
    const calls = Array.from({ length: 15 }, (_, i) => ({ network: "mainnet", hash: `f${i}` }));
    await loadMethods(calls, () => false, noPause);
    expect(rpc.calls).toHaveLength(10);
    await loadMethods(calls.slice(0, 10), () => false, noPause);
    expect(rpc.calls).toHaveLength(10);
  });

  it("never asks again for a receipt the node says is not there", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    rpc.answer.mockImplementation(async (_net: string, _m: string, [hash]: string[]) => {
      if (hash === "gone") throw new RpcError("not found: receipt not found", { code: 112 });
      if (hash === "bare") return {};
      throw new RpcError("RPC HTTP error: 429", { httpStatus: 429 });
    });
    const calls = ["gone", "bare", "busy"].map((hash) => ({ network: "mainnet", hash }));
    await loadMethods(calls, () => false, noPause);
    expect(rpc.calls).toHaveLength(3);

    vi.advanceTimersByTime(61_000);
    await loadMethods(calls, () => false, noPause);
    expect(rpc.calls.slice(3)).toEqual([["mainnet", "contract_receipt", ["busy"]]]);

    await loadMethods([{ network: "devnet", hash: "gone" }], () => false, noPause);
    expect(rpc.calls[4]).toEqual(["devnet", "contract_receipt", ["gone"]]);
  });

  it("stops when cancelled", async () => {
    rpc.answer.mockResolvedValue({ method: "transfer" });
    let n = 0;
    await loadMethods(
      [
        { network: "mainnet", hash: "a" },
        { network: "mainnet", hash: "b" },
      ],
      () => n++ > 0,
      noPause,
    );
    expect(rpc.calls.length).toBeLessThanOrEqual(1);
    expect(methodKey("devnet", "a")).toBe("devnet:a");
  });
});

describe("call data", () => {
  const lockArgs = octraCallArgs(
    '["swap_1b60d87e1e828f45ce7444a122b987de","sepolia","0xc68f177AC0465C51E6Cf37cB4068142802F69a78","1559940","151749169604113","ETH"]',
  )!;

  it("names a SwapVault lock with the curated map", () => {
    const specs = knownCallArgs("swapVault", "lock");
    const { rows, args } = octraArgRows(lockArgs, specs, null, t);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["To network", "Sepolia"],
      ["Recipient", "0xc68f177A...02F69a78"],
      ["Minimum received", "0.000151 ETH"],
      ["Expires", "Epoch 1559940"],
      ["Swap ID", "swap_1b60d...22b987de"],
    ]);
    expect(rows[1].copy).toBe("0xc68f177AC0465C51E6Cf37cB4068142802F69a78");
    expect(args).toHaveLength(6);
    expect(args[1]).toMatchObject({ label: "To network", type: "string", friendly: "Sepolia" });
    expect(args[3]).toMatchObject({ label: "Expires", friendly: "Epoch 1559940" });
    expect(args[5]).toMatchObject({ label: "Asset", value: "ETH" });
  });

  it("names the OCT bridge unlock and lock_to_eth", () => {
    const unlock = octraArgRows(
      [
        "oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio",
        "32988664",
        "0x030cfc900aa86123f390d8e2e9e4c8ac967e17ba19b42036b99c8cb0",
      ],
      knownCallArgs("octBridge", "unlock_trusted"),
      null,
      t,
    );
    expect(unlock.rows.map((r) => [r.label, r.value])).toEqual([
      ["Recipient", "oct2qyupyP...94NNoxio"],
      ["Amount", "32.988664 OCT"],
      ["Message ID", "0x030cfc90...b99c8cb0"],
    ]);
    const lock = octraArgRows(
      ["0xc68f177ac0465c51e6cf37cb4068142802f69a78"],
      knownCallArgs("octBridge", "lock_to_eth"),
      null,
      t,
    );
    expect(lock.rows[0].label).toBe("Recipient");
  });

  it("lists unnamed arguments as Value n with their types", () => {
    const { rows, args } = octraArgRows(["octX1", 13, true, { a: 1 }], null, null, t);
    expect(rows).toEqual([]);
    expect(args.map((a) => [a.label, a.type ?? null, a.value])).toEqual([
      ["Value 1", "string", "octX1"],
      ["Value 2", "int", "13"],
      ["Value 3", "bool", "true"],
      ["Value 4", null, '{"a":1}'],
    ]);
  });

  it("uses ABI names when the contract is not one the wallet maps", () => {
    const { rows, args } = octraArgRows(["octX1", "8"], null, ["spender", "token_id"], t);
    expect(rows.map((r) => r.label)).toEqual(["Spender", "Token ID"]);
    expect(args[1]).toMatchObject({ name: "token_id", label: "Token ID" });
  });

  it("caps a huge value and the number of arguments", () => {
    const huge = "f".repeat(CALL_VALUE_MAX * 3);
    const many = Array.from({ length: CALL_DATA_MAX + 20 }, (_, i) => (i === 0 ? huge : i));
    const { args } = octraArgRows(many, null, null, t);
    expect(args).toHaveLength(CALL_DATA_MAX);
    expect(args[0].value).toHaveLength(CALL_VALUE_MAX + 3);
    expect(args[0].value.endsWith("...")).toBe(true);
  });

  it("holds the named rows' heights while the arguments load", () => {
    const rows = knownArgPlaceholders(knownCallArgs("swapVault", "lock")!, t);
    expect(rows.map((r) => r.label)).toEqual([
      "To network",
      "Recipient",
      "Minimum received",
      "Expires",
      "Swap ID",
    ]);
    expect(rows.every((r) => r.pending)).toBe(true);
  });

  it("reads the method, the fee and bad arguments", () => {
    expect(callMethod("list_nft")).toEqual({ method: "List NFT", functionName: "list_nft" });
    expect(callMethod(null)).toEqual({ method: null, functionName: null });
    expect(ouToOct("10000")).toBe("0.01");
    expect(ouToOct(3000)).toBe("0.003");
    expect(ouToOct("0")).toBeNull();
    expect(octraCallArgs("not json")).toBeNull();
    expect(octraCallArgs('{"a":1}')).toBeNull();
  });
});
