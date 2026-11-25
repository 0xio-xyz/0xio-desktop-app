import { jsonRpcCall } from "src/services/network/networkService";
import type { Manifest } from "src/features/nft/services/xpectrum/types";
import {
  resolveCircleAsset,
  type CircleAssetReply,
} from "src/features/circles/services/circleAsset";

// oct://<circle_id>/<path>; circle_id is address-shaped but opaque.
export function parseOctUri(uri: string): { circleId: string; path: string } | null {
  if (!uri || !uri.toLowerCase().startsWith("oct://")) return null;
  const rest = uri.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return null;
  const si = rest.indexOf("/");
  if (si === -1) return { circleId: rest, path: "/" };
  const circleId = rest.slice(0, si);
  const path = rest.slice(si) || "/";
  return circleId ? { circleId, path } : null;
}

export { bytesToB64 } from "src/features/circles/services/circleAsset";

const assetCache = new Map<string, Promise<Uint8Array | null>>();
export function fetchCircleBytes(circleId: string, path: string): Promise<Uint8Array | null> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const key = `${circleId}|${p}`;
  const hit = assetCache.get(key);
  if (hit) return hit;
  const promise = (async () => {
    try {
      const asset = await resolveCircleAsset(
        (q) => jsonRpcCall<CircleAssetReply>("circle_asset", [circleId, q]),
        p,
      );
      return asset?.bytes.length ? asset.bytes : null;
    } catch {
      return null;
    }
  })();
  assetCache.set(key, promise);
  // A miss (a 429, a timeout) is not an answer: forget it, or every retry this session returns it.
  void promise.then((bytes) => {
    if (!bytes && assetCache.get(key) === promise) assetCache.delete(key);
  });
  return promise;
}

export async function fetchCircleJson<T = Record<string, unknown>>(
  circleId: string,
  path: string,
): Promise<T | null> {
  const bytes = await fetchCircleBytes(circleId, path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

// collection.json is found by path convention: no field carries it.
const manifestCache = new Map<string, Promise<Manifest | null>>();
export function getManifest(circleId: string): Promise<Manifest | null> {
  const hit = manifestCache.get(circleId);
  if (hit) return hit;
  const p = fetchCircleJson<Manifest>(circleId, "/collection.json");
  manifestCache.set(circleId, p);
  return p;
}

// Slug and layer path rules: Xpectrum metadata standard, section 4.
function slug(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-");
}

export function layerPath(traitName: string, value: unknown): string | null {
  if (value == null) return null;
  const t = slug(traitName);
  const v = slug(String(value));
  if (!t || !v) return null;
  return `/traits/${t}/${v}.png`;
}

// The stored content_type is unreliable.
export function sniffImageType(b: Uint8Array): string {
  if (!b || b.length < 4) return "application/octet-stream";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "image/*";
}
