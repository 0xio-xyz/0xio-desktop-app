import { describe, it, expect, afterEach } from "vitest";
import { networkCapabilities, isCustomNetwork, NETWORKS } from "src/services/network/config";

const ID = "custom_1700000000000";

const addNode = (supportsPrivacy: boolean) => {
  NETWORKS[ID] = {
    id: ID,
    name: "My Node",
    rpcUrl: "http://10.0.0.5:8080",
    explorerUrl: "",
    explorerAddressUrl: "",
    indexerUrl: "",
    supportsPrivacy,
    color: "#22c55e",
  };
};

describe("network capabilities", () => {
  afterEach(() => {
    delete NETWORKS[ID];
  });

  it("tells a custom id from the built-ins", () => {
    expect(isCustomNetwork(ID)).toBe(true);
    expect(isCustomNetwork("mainnet")).toBe(false);
    expect(isCustomNetwork("devnet")).toBe(false);
  });

  it("gives a custom node no token list rather than mainnet's", () => {
    addNode(false);
    expect(networkCapabilities(ID).tokenListTag).toBeUndefined();
    expect(networkCapabilities("mainnet").tokenListTag).toBe("octra-mainnet");
    expect(networkCapabilities("devnet").tokenListTag).toBe("octra-devnet");
  });

  it("takes privacy from the config the user added", () => {
    addNode(false);
    expect(networkCapabilities(ID).privacy).toBe(false);
    addNode(true);
    expect(networkCapabilities(ID).privacy).toBe(true);
  });

  it("offers no 0xio-deployed feature on a custom node", () => {
    addNode(true);
    const caps = networkCapabilities(ID);
    expect([caps.market, caps.swap, caps.bridge]).toEqual([false, false, false]);
    expect(networkCapabilities("devnet").swap).toBe(true);
    expect(networkCapabilities("mainnet").bridge).toBe(true);
  });
});
