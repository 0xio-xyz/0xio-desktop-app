// Path rules are webcli main.cpp circle_asset_path (circle-asset-path-vectors.json).

import { bytesToB64, MAX_CIRCLE_ASSET_B64 } from "src/features/circles/services/circleAsset";
import { sealBytes } from "src/features/circles/services/circleSealed";

export const CIRCLE_ASSET_MAX_RAW = 33554432;
export const CIRCLE_DIRECT_MAX_RAW = 2097152;
const CIRCLE_ASSET_MESSAGE_MAX = 8192;
const CIRCLE_PATH_MAX = 1024;
const SEALED_KEY_ID = "default";

export type CircleUploadOp = "circle_asset_put" | "circle_asset_put_encrypted";
type CircleUpload = {
  path: string;
  opType: CircleUploadOp;
  encData: string;
  message: string;
};

const utf8 = (s: string) => new TextEncoder().encode(s);

const hexValue = (c: number) =>
  c >= 0x30 && c <= 0x39
    ? c - 0x30
    : c >= 0x61 && c <= 0x66
      ? c - 0x57
      : c >= 0x41 && c <= 0x46
        ? c - 0x37
        : -1;

export function canonicalAssetPath(raw: string): string {
  const src = utf8(raw || "/");
  const out = new Uint8Array(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== 0x25) {
      out[n++] = src[i];
      continue;
    }
    const hi = i + 2 < src.length ? hexValue(src[i + 1]) : -1;
    const lo = i + 2 < src.length ? hexValue(src[i + 2]) : -1;
    if (hi < 0 || lo < 0) throw new Error("Invalid percent escape");
    out[n++] = (hi << 4) | lo;
    i += 2;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out.subarray(0, n));
  } catch {
    throw new Error("Path is not valid utf-8");
  }
  const segments = decoded.split("/").filter((s) => s && s !== ".");
  if (segments.includes("..")) throw new Error("Path traversal is not allowed");
  const path = `/${segments.join("/")}`;
  if (utf8(path).length > CIRCLE_PATH_MAX) throw new Error("Path exceeds max length");
  return path;
}

export function uploadAssetPath(raw: string): string {
  const path = canonicalAssetPath((raw || "").trim() || "/index.html");
  if (path === "/") throw new Error("Invalid circle asset path");
  if (path.startsWith("/.octra/")) throw new Error("Paths under /.octra/ are reserved");
  return path;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
};

export const circleContentType = (name: string, type?: string): string =>
  type || TYPES[name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";

export function assertUploadSize(size: number, sealed: boolean): void {
  if (size > CIRCLE_ASSET_MAX_RAW) throw new Error("File exceeds the 32 MiB circle limit");
  if (!sealed && size === 0) throw new Error("File is empty");
  if (!sealed && size > CIRCLE_DIRECT_MAX_RAW)
    throw new Error("Public files over 2 MiB cannot be uploaded yet");
}

const messageOf = (path: string, contentType: string, plaintextHash: string | null) =>
  JSON.stringify(
    plaintextHash === null
      ? { path, content_type: contentType }
      : {
          path,
          content_type: contentType,
          key_id: SEALED_KEY_ID,
          plaintext_hash: plaintextHash,
          encoding: "identity",
        },
  );

export function checkCircleUpload(p: {
  path: string;
  size: number;
  contentType: string;
  sealed: boolean;
}): string {
  assertUploadSize(p.size, p.sealed);
  const path = uploadAssetPath(p.path);
  const message = messageOf(path, p.contentType, p.sealed ? "0".repeat(64) : null);
  if (utf8(message).length > CIRCLE_ASSET_MESSAGE_MAX)
    throw new Error("Upload details are too long");
  return path;
}

export async function prepareCircleUpload(p: {
  circleId: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
  sealed: boolean;
  passphrase: string;
}): Promise<CircleUpload> {
  assertUploadSize(p.bytes.length, p.sealed);
  const path = uploadAssetPath(p.path);
  let upload: CircleUpload;
  if (p.sealed) {
    if (!p.passphrase) throw new Error("Passphrase required");
    const sealed = await sealBytes(p.circleId, SEALED_KEY_ID, p.passphrase, p.bytes);
    if (sealed.ciphertext_b64.length > MAX_CIRCLE_ASSET_B64)
      throw new Error("Sealed file exceeds the 32 MiB circle limit");
    upload = {
      path,
      opType: "circle_asset_put_encrypted",
      encData: sealed.ciphertext_b64,
      message: messageOf(path, p.contentType, sealed.plaintext_hash),
    };
  } else {
    upload = {
      path,
      opType: "circle_asset_put",
      encData: bytesToB64(p.bytes),
      message: messageOf(path, p.contentType, null),
    };
  }
  if (utf8(upload.message).length > CIRCLE_ASSET_MESSAGE_MAX)
    throw new Error("Upload details are too long");
  return upload;
}
