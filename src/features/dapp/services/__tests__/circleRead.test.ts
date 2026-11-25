import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sign = vi.hoisted(() => vi.fn());
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: (walletId: string, message: string) => sign(walletId, message),
    getPublicKey: vi.fn(async () => "PUB"),
  },
}));
const node = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCallAt: (url: string, method: string, params: string[]) => node.call(url, method, params),
}));

import {
  circleResourceKey,
  fetchCircleInfo,
  fetchSealedAsset,
} from "src/features/dapp/services/circleRead";
import { circleAuthMessage } from "src/features/dapp/services/circleBridgeService";

const CIRCLE = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const READER = { id: "w1", address: `oct${"A".repeat(44)}` };
const RPC = "https://node.test";

type Reply = { result?: unknown; error?: { message: string } };
let replies: Record<string, Reply>;
const calls: { method: string; params: string[] }[] = [];

beforeEach(() => {
  calls.length = 0;
  replies = {};
  sign.mockReset().mockResolvedValue("SIG");
  node.call
    .mockReset()
    .mockImplementation(async (_url: string, method: string, params: string[]) => {
      calls.push({ method, params });
      const reply = replies[method] ?? { error: { message: "not found" } };
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    });
});
afterEach(() => vi.unstubAllGlobals());

describe("circle info", () => {
  it("takes the public read without signing", async () => {
    replies.circle_info = { result: { resource_mode: "sealed_read" } };
    expect(await fetchCircleInfo(RPC, CIRCLE, READER)).toEqual({ resource_mode: "sealed_read" });
    expect(calls.map((c) => c.method)).toEqual(["circle_info"]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("falls back to the signed read", async () => {
    replies.circle_info = { error: { message: "authenticated circle info required" } };
    replies.octra_circleInfoAuth = { result: { resource_mode: "public_resources" } };
    expect(await fetchCircleInfo(RPC, CIRCLE, READER)).toEqual({
      resource_mode: "public_resources",
    });
    expect(sign).toHaveBeenCalledWith(
      "w1",
      circleAuthMessage("octra_circle_info", CIRCLE, READER.address, ""),
    );
    expect(calls[1]).toEqual({
      method: "octra_circleInfoAuth",
      params: [CIRCLE, READER.address, "PUB", "SIG"],
    });
  });

  it("answers null without a wallet or when both reads fail", async () => {
    expect(await fetchCircleInfo(RPC, CIRCLE)).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["circle_info"]);
    expect(await fetchCircleInfo(RPC, CIRCLE, READER)).toBeNull();
  });
});

describe("sealed asset read", () => {
  it("signs the owner read over the resource key of the canonical path", async () => {
    const key = await circleResourceKey(CIRCLE, "/a/my file.html");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    replies.octra_circleAssetCiphertextByResourceKeyAuth = {
      result: { ciphertext_b64: "AAAA", key_id: "default", plaintext_hash: "ab".repeat(32) },
    };
    const asset = await fetchSealedAsset(RPC, CIRCLE, "/a//./my%20file.html", READER);
    expect(asset.key_id).toBe("default");
    expect(sign).toHaveBeenCalledWith(
      "w1",
      circleAuthMessage(
        "octra_circle_asset_ciphertext_by_resource_key",
        CIRCLE,
        READER.address,
        `resource_key|${key}`,
      ),
    );
    expect(calls).toEqual([
      {
        method: "octra_circleAssetCiphertextByResourceKeyAuth",
        params: [CIRCLE, key, READER.address, "PUB", "SIG"],
      },
    ]);
  });

  it("falls back to the public read when the signed one is refused", async () => {
    const key = await circleResourceKey(CIRCLE, "/index.html");
    replies.octra_circleAssetCiphertextByResourceKeyAuth = {
      error: { message: "circle owner authorization required" },
    };
    replies.circle_asset_ciphertext_by_resource_key = { result: { ciphertext_b64: "BBBB" } };
    expect(await fetchSealedAsset(RPC, CIRCLE, "/index.html", READER)).toEqual({
      ciphertext_b64: "BBBB",
    });
    expect(calls.map((c) => c.method)).toEqual([
      "octra_circleAssetCiphertextByResourceKeyAuth",
      "circle_asset_ciphertext_by_resource_key",
    ]);
    expect(calls[1].params).toEqual([CIRCLE, key]);
  });

  it("reads publicly without a wallet, and refuses a path that climbs", async () => {
    replies.circle_asset_ciphertext_by_resource_key = { result: { ciphertext_b64: "CCCC" } };
    await fetchSealedAsset(RPC, CIRCLE, "/index.html");
    expect(sign).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["circle_asset_ciphertext_by_resource_key"]);
    await expect(fetchSealedAsset(RPC, CIRCLE, "/../x", READER)).rejects.toThrow(
      "Path traversal is not allowed",
    );
  });
});
