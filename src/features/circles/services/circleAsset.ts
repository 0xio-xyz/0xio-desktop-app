// circle_asset reads, with chunked files assembled and checked exactly like webcli
// lib/circle_asset_chunks.hpp. A file over 2 MiB is stored as a manifest at its own path plus
// numbered chunks under /.octra/chunks/<sha256>/, so every reader must go through here.

export const CIRCLE_CHUNK_FORMAT = "octra.circle.asset.chunks.v1";
export const CIRCLE_CHUNK_MANIFEST_TYPE = "application/vnd.octra.circle.chunks+json";
const CHUNK_TYPE = "application/octet-stream";
const MAX_RAW = 33554432;
const CHUNK_RAW = 2097152;
const CHUNK_COUNT_MAX = 32;
const MANIFEST_B64_MAX = 131072;
export const MAX_CIRCLE_ASSET_B64 = Math.ceil(MAX_RAW / 3) * 4;

export type CircleAssetReply = {
  content_type?: string;
  body_b64?: string;
  data_base64?: string;
  [key: string]: unknown;
} | null;

type CircleAssetFetch = (path: string) => Promise<CircleAssetReply>;

export type CircleAsset = {
  contentType: string;
  bytes: Uint8Array;
  chunked?: { count: number; sha256: string };
};

export function bytesFromB64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const sizeOf = (v: unknown): number | null =>
  typeof v === "string" && /^\d+$/.test(v) && Number(v) <= Number.MAX_SAFE_INTEGER
    ? Number(v)
    : null;

// The reference re-encodes and compares, so a body with padding tricks or stray characters fails.
function canonicalBody(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string") return null;
  try {
    const bytes = bytesFromB64(b64);
    return bytesToB64(bytes) === b64 ? bytes : null;
  } catch {
    return null;
  }
}

const chunkIndex = (i: number) => String(i).padStart(4, "0");

export async function resolveCircleAsset(
  fetchAsset: CircleAssetFetch,
  path: string,
): Promise<CircleAsset | null> {
  const root = await fetchAsset(path);
  if (!root) return null;
  const b64 = root.body_b64 ?? root.data_base64;
  if (typeof b64 !== "string") return null;
  if (root.content_type !== CIRCLE_CHUNK_MANIFEST_TYPE) {
    if (b64.length > MAX_CIRCLE_ASSET_B64) throw new Error("Circle asset too large");
    return {
      contentType: root.content_type || "application/octet-stream",
      bytes: bytesFromB64(b64),
    };
  }

  if (!b64 || b64.length > MANIFEST_B64_MAX) throw new Error("Invalid circle chunk manifest");
  const manifestBytes = canonicalBody(b64);
  if (!manifestBytes) throw new Error("Invalid circle chunk manifest");
  let manifest: any;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("Invalid circle chunk manifest");
  }
  const total = sizeOf(manifest?.size_bytes);
  const contentType = manifest?.content_type;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.format !== CIRCLE_CHUNK_FORMAT ||
    typeof contentType !== "string" ||
    !/^[\x20-\x7e]{1,256}$/.test(contentType) ||
    manifest.encoding !== "identity" ||
    !isHash(manifest.sha256) ||
    total === null ||
    total > MAX_RAW ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0 ||
    manifest.chunks.length > CHUNK_COUNT_MAX
  ) {
    throw new Error("Invalid circle chunk manifest");
  }

  const prefix = `/.octra/chunks/${manifest.sha256}/`;
  const body = new Uint8Array(total);
  let filled = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const item = manifest.chunks[i];
    const size = sizeOf(item?.size_bytes);
    if (
      !item ||
      typeof item !== "object" ||
      item.path !== prefix + chunkIndex(i) ||
      !isHash(item.sha256) ||
      size === null ||
      size === 0 ||
      size > CHUNK_RAW ||
      size > total - filled
    ) {
      throw new Error("Invalid circle chunk entry");
    }
    const part = await fetchAsset(item.path);
    if (!part || part.content_type !== CHUNK_TYPE) throw new Error("Circle chunk unavailable");
    const chunk = canonicalBody(part.body_b64 ?? part.data_base64);
    if (!chunk || chunk.length !== size || (await sha256Hex(chunk)) !== item.sha256) {
      throw new Error("Circle chunk verification failed");
    }
    body.set(chunk, filled);
    filled += size;
  }
  if (filled !== total || (await sha256Hex(body)) !== manifest.sha256) {
    throw new Error("Circle asset verification failed");
  }
  return {
    contentType,
    bytes: body,
    chunked: { count: manifest.chunks.length, sha256: manifest.sha256 },
  };
}

/**
 * The circle_asset reply a program expects, with a chunked file answered the way webcli's
 * /api/circle/asset answers it: the assembled body plus chunked, chunks, blob_hash.
 */
export async function resolveCircleAssetReply(
  fetchAsset: CircleAssetFetch,
  path: string,
): Promise<CircleAssetReply> {
  let root: CircleAssetReply | undefined;
  const asset = await resolveCircleAsset(async (p) => {
    const reply = await fetchAsset(p);
    if (root === undefined) root = reply;
    return reply;
  }, path);
  if (!asset?.chunked) return root ?? null;
  return {
    ...root,
    content_type: asset.contentType,
    encoding: "identity",
    size_bytes: String(asset.bytes.length),
    blob_hash: asset.chunked.sha256,
    body_b64: bytesToB64(asset.bytes),
    chunked: true,
    chunks: asset.chunked.count,
  };
}
