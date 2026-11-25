// The read-method allowlist is the security boundary: no path to signing, keys or writes, and
// jsonRpcCall never signs. The program never touches the network itself (no IP leak).

import { getNetwork, jsonRpcCall, jsonRpcCallOn } from "src/services/network/networkService";
import {
  resolveCircleAssetReply,
  type CircleAssetReply,
} from "src/features/circles/services/circleAsset";
import { logger } from "src/lib/logger";

const READ_METHODS = new Set(["contract_call", "circle_asset", "octra_contractAbi"]);

export async function handleLivingBridgeRequest(
  networkId: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  if (!READ_METHODS.has(method)) {
    throw new Error(`method not allowed: ${method}`);
  }
  if (!Array.isArray(params)) {
    throw new Error("params must be an array");
  }
  // The frame belongs to the network it opened on; after a switch it gets nothing.
  if (getNetwork() !== networkId) {
    throw new Error("network changed");
  }
  logger.debug("nft", `[LivingNFT bridge] ${method}(${params.length} args)`);
  if (method === "circle_asset") {
    const [circleId, path] = params;
    if (typeof circleId !== "string" || typeof path !== "string") {
      throw new Error("circle_asset takes a circle id and a path");
    }
    return resolveCircleAssetReply(
      (p) => jsonRpcCallOn<CircleAssetReply>(networkId, "circle_asset", [circleId, p]),
      path,
    );
  }
  return jsonRpcCall(method, params);
}
