import { describe, it, expect, afterAll } from "vitest";
import { getRpcUrl, getBaseUrl, setNetwork, getNetwork } from "src/services/network/networkService";
import { NETWORKS } from "src/services/network/config";

const original = getNetwork();

describe("getRpcUrl", () => {
  afterAll(() => setNetwork(original));

  it("appends /rpc to a base host", () => {
    setNetwork("devnet");
    expect(getRpcUrl()).toBe("https://devnet.octrascan.io/rpc");
    setNetwork("mainnet");
    expect(getRpcUrl()).toBe("https://octra.network/rpc");
  });

  it("uses rpcEndpoint verbatim and does not produce /rpc/rpc", () => {
    setNetwork("devnet2");
    expect(getRpcUrl()).toBe("https://rpc-proxy.0xio.xyz/rpc/devnet");
    expect(getRpcUrl()).not.toContain("/rpc/rpc");
  });

  it("keeps getBaseUrl as the host, not the endpoint", () => {
    setNetwork("devnet2");
    expect(getBaseUrl()).toBe("https://rpc-proxy.0xio.xyz");
  });

  it("gives every network exactly one endpoint and no fallback list", () => {
    for (const [id, net] of Object.entries(NETWORKS)) {
      expect(net, `${id} must not carry a fallback list`).not.toHaveProperty("rpcFallbackUrls");
      setNetwork(id);
      expect(getRpcUrl(), `${id} endpoint`).toMatch(/^https?:\/\//);
    }
  });

  it("no longer points at the dead 165.227.225.79 node", () => {
    expect(JSON.stringify(NETWORKS)).not.toContain("165.227.225.79");
  });
});
