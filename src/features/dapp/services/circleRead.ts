import { jsonRpcCallAt } from "src/services/network/networkService";
import { circleAuthParams } from "src/features/dapp/services/circleBridgeService";
import type { SealedAsset } from "src/features/circles/services/circleSealed";
import { canonicalAssetPath } from "src/features/circles/services/circleUpload";

export function circleRpc(rpcUrl: string, method: string, params: string[]): Promise<any> {
  return jsonRpcCallAt(`${rpcUrl}/rpc`, method, params);
}

export type CircleReader = { id: string; address: string };

export async function fetchCircleInfo(
  rpcUrl: string,
  circleId: string,
  reader?: CircleReader | null,
): Promise<{ resource_mode: string } | null> {
  try {
    return await circleRpc(rpcUrl, "circle_info", [circleId]);
  } catch {
    if (!reader) return null;
  }
  try {
    return await circleRpc(rpcUrl, "octra_circleInfoAuth", [
      circleId,
      ...(await circleAuthParams(reader.id, reader.address, "octra_circle_info", circleId)),
    ]);
  } catch {
    return null;
  }
}

// Domain-separated framed resource key, byte-identical to the node / webcli:
//   SHA256( "octra:circle_resource_key:v1" ++ 0x00 ++ u32be(len(cid)) ++ cid ++ u32be(len(path)) ++ path )
// A plain concatenation yields the wrong key and the asset reads as not found.
export async function circleResourceKey(circleId: string, path: string): Promise<string> {
  const enc = new TextEncoder();
  const tag = enc.encode("octra:circle_resource_key:v1");
  const cid = enc.encode(circleId);
  const p = enc.encode(path.startsWith("/") ? path : `/${path}`);
  const u32be = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  };
  const buf = new Uint8Array(tag.length + 1 + 4 + cid.length + 4 + p.length);
  let off = 0;
  buf.set(tag, off);
  off += tag.length;
  buf[off++] = 0;
  buf.set(u32be(cid.length), off);
  off += 4;
  buf.set(cid, off);
  off += cid.length;
  buf.set(u32be(p.length), off);
  off += 4;
  buf.set(p, off);
  off += p.length;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchSealedAsset(
  rpcUrl: string,
  circleId: string,
  path: string,
  reader?: CircleReader | null,
): Promise<SealedAsset> {
  const resourceKey = await circleResourceKey(circleId, canonicalAssetPath(path));
  if (reader) {
    try {
      return await circleRpc(rpcUrl, "octra_circleAssetCiphertextByResourceKeyAuth", [
        circleId,
        resourceKey,
        ...(await circleAuthParams(
          reader.id,
          reader.address,
          "octra_circle_asset_ciphertext_by_resource_key",
          circleId,
          `resource_key|${resourceKey}`,
        )),
      ]);
    } catch {}
  }
  return circleRpc(rpcUrl, "circle_asset_ciphertext_by_resource_key", [circleId, resourceKey]);
}
