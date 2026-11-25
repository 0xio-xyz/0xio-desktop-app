import { beforeEach, describe, expect, it, vi } from "vitest";

const COLLECTION = `oct${"C".repeat(44)}`;
const ME = "octkj7UCF12TYNsUtivfccTnUyNY2xnRtuVGqjejzo5kcRF";

const m = vi.hoisted(() => ({ view: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", () => ({
  getNetwork: () => "devnet",
  jsonRpcCall: async (method: string, params: unknown[]) => {
    if (method === "octra_contractAbi") return { methods: [] };
    const [, name, args] = params as [string, string, unknown];
    return { result: await m.view(name, Array.isArray(args) ? args : []) };
  },
  jsonRpcCallOn: vi.fn(),
  sanitizeDisplay: (s: string) => s,
}));
vi.mock("src/services/names/onsService", () => ({
  namesOf: vi.fn(),
  onsContractFor: async () => null,
}));
vi.mock("src/features/nft/services/xpectrum", () => ({ resolveXpectrumToken: vi.fn() }));
vi.mock("src/features/circles/services/circleAsset", () => ({
  bytesToB64: () => "",
  resolveCircleAsset: async () => null,
}));

import { fetchOwnedTokenIds, stillOwned } from "src/features/nft/services/data";

const reverted = () => new Error("execution reverted");
const missing = () => new Error("method not found");
const unanswered = () => new Error("committed state changed during read; retry");
const asked = (name: string) => m.view.mock.calls.filter(([n]) => n === name).length;

function chain(views: Record<string, (args: unknown[]) => unknown>) {
  m.view.mockImplementation(async (name: string, args: unknown[]) => {
    if (!views[name]) throw missing();
    return views[name](args);
  });
}

beforeEach(() => {
  m.view.mockReset();
});

describe("which token ids a wallet holds in a collection", () => {
  it("does not start the one by one scan when the node failed to answer the storage read", async () => {
    chain({
      total_supply: () => {
        throw unanswered();
      },
      owner_of: () => ME,
    });
    await expect(fetchOwnedTokenIds(COLLECTION, ME, null, 2)).rejects.toThrow("incomplete");
    expect(asked("owner_of")).toBe(0);
  });

  it("scans one by one when the collection has no storage view at all", async () => {
    chain({
      owner_of: ([id]) => {
        if (id === "3") return ME;
        throw reverted();
      },
    });
    const out = await fetchOwnedTokenIds(COLLECTION, ME, null, 1).catch((e) => {
      console.log("CALLS", JSON.stringify(m.view.mock.calls), String(e));
      throw e;
    });
    expect(out).toEqual(["3"]);
    expect(asked("owner_of")).toBe(4);
  });

  it("gives the scan up after three reads in a row the node did not answer", async () => {
    chain({
      owner_of: ([id]) => {
        if (id === "0") throw reverted();
        throw unanswered();
      },
    });
    await expect(fetchOwnedTokenIds(COLLECTION, ME, null, 2)).rejects.toThrow("incomplete");
    expect(asked("owner_of")).toBe(4);
  });

  it("keeps scanning past ids that revert and past a single failed read", async () => {
    let failedOnce = false;
    chain({
      owner_of: ([id]) => {
        if (id === "2" && !failedOnce) {
          failedOnce = true;
          throw unanswered();
        }
        if (id === "6") return ME;
        throw reverted();
      },
    });
    await expect(fetchOwnedTokenIds(COLLECTION, ME, null, 1)).resolves.toEqual(["6"]);
  });
});

describe("asking for the ids known before", () => {
  it("answers yes with one read per id when every one is still held", async () => {
    chain({ owner_of: () => ME });
    expect(await stillOwned(COLLECTION, ME, ["30", "40"])).toBe(true);
    expect(m.view.mock.calls.map(([n, a]) => [n, a])).toEqual([
      ["owner_of", ["30"]],
      ["owner_of", ["40"]],
    ]);
  });

  it("answers no when an id went to someone else or no longer exists", async () => {
    chain({ owner_of: ([id]) => (id === "30" ? ME : "someone") });
    expect(await stillOwned(COLLECTION, ME, ["30", "40"])).toBe(false);
    chain({
      owner_of: () => {
        throw reverted();
      },
    });
    expect(await stillOwned(COLLECTION, ME, ["30"])).toBe(false);
  });

  it("answers no without asking for nothing known or a long list", async () => {
    chain({ owner_of: () => ME });
    expect(await stillOwned(COLLECTION, ME, [])).toBe(false);
    expect(
      await stillOwned(
        COLLECTION,
        ME,
        Array.from({ length: 11 }, (_, i) => String(i)),
      ),
    ).toBe(false);
    expect(asked("owner_of")).toBe(0);
  });

  it("keeps what was known when the node does not answer", async () => {
    chain({
      owner_of: () => {
        throw unanswered();
      },
    });
    await expect(stillOwned(COLLECTION, ME, ["30"])).rejects.toThrow("incomplete");
  });
});
