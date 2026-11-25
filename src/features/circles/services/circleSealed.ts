// Byte exact with webcli static/circles.js (circle-sealed-digest-vectors.json).

import {
  bytesFromB64,
  bytesToB64,
  MAX_CIRCLE_ASSET_B64,
} from "src/features/circles/services/circleAsset";

const MAGIC = "OCRS1";
const ROUNDS = 120000;
const HASH = /^[0-9a-f]{64}$/;

export type SealedAsset = {
  ciphertext_b64?: string;
  key_id?: string;
  plaintext_hash?: string;
  content_type?: string;
  [key: string]: unknown;
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", buf(b)));

function sealedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    Array.from(value).some((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    })
  ) {
    throw new Error("Invalid sealed text");
  }
  return value;
}

/** The reference escapes U+007F in the salt; an older writer did not. */
export function sealedDigestSalt(circleId: string, keyId: string, escapeDel = true): string {
  const salt = JSON.stringify([
    "octra:circle:sealed_digest",
    sealedText(circleId),
    sealedText(keyId),
  ]);
  return escapeDel ? salt.replace(/\u007f/g, "\\u007f") : salt;
}

const keys = new Map<string, Promise<CryptoKey>>();

async function derive(kind: "read" | "digest", salt: string, passphrase: string) {
  const id = await sha256Hex(utf8(JSON.stringify([kind, salt, sealedText(passphrase)])));
  let key = keys.get(id);
  if (!key) {
    if (keys.size >= 16) keys.clear();
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", utf8(passphrase), "PBKDF2", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: utf8(salt), iterations: ROUNDS, hash: "SHA-256" },
        material,
        kind === "read"
          ? { name: "AES-GCM", length: 256 }
          : { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        kind === "read" ? ["encrypt", "decrypt"] : ["sign"],
      );
    })();
    keys.set(id, key);
    key.catch(() => keys.delete(id));
  }
  return key;
}

const readKey = (circleId: string, keyId: string, passphrase: string) =>
  derive(
    "read",
    `octra:circle:sealed_read:v1:${sealedText(circleId)}:${sealedText(keyId)}`,
    passphrase,
  );

async function digestForSalt(salt: string, passphrase: string, plaintext: Uint8Array) {
  const key = await derive("digest", salt, passphrase);
  return hex(await crypto.subtle.sign("HMAC", key, buf(plaintext)));
}

export const sealedDigest = (
  circleId: string,
  keyId: string,
  passphrase: string,
  plaintext: Uint8Array,
) => digestForSalt(sealedDigestSalt(circleId, keyId), passphrase, plaintext);

export async function sealedHashMatches(
  circleId: string,
  keyId: string,
  passphrase: string,
  plaintext: Uint8Array,
  expected: unknown,
): Promise<boolean> {
  if (typeof expected !== "string" || !HASH.test(expected)) return false;
  if ((await sha256Hex(plaintext)) === expected) return true;
  if ((await sealedDigest(circleId, keyId, passphrase, plaintext)) === expected) return true;
  const bare = sealedDigestSalt(circleId, keyId, false);
  return (
    bare !== sealedDigestSalt(circleId, keyId) &&
    (await digestForSalt(bare, passphrase, plaintext)) === expected
  );
}

export async function sealBytes(
  circleId: string,
  keyId: string,
  passphrase: string,
  plain: Uint8Array,
): Promise<{ ciphertext_b64: string; plaintext_hash: string }> {
  const key = await readKey(circleId, keyId, passphrase);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const frame = new Uint8Array(Math.ceil((4 + plain.length) / 256) * 256);
  new DataView(frame.buffer).setUint32(0, plain.length);
  frame.set(plain, 4);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, frame),
  );
  const envelope = new Uint8Array(MAGIC.length + 12 + cipher.length);
  envelope.set(utf8(MAGIC));
  envelope.set(nonce, MAGIC.length);
  envelope.set(cipher, MAGIC.length + 12);
  return {
    ciphertext_b64: bytesToB64(envelope),
    plaintext_hash: await sealedDigest(circleId, keyId, passphrase, plain),
  };
}

export async function openSealedAsset(
  circleId: string,
  asset: SealedAsset | null | undefined,
  passphrase: string,
): Promise<Uint8Array> {
  const b64 = asset?.ciphertext_b64;
  if (typeof b64 !== "string" || !b64) throw new Error("Sealed asset not found");
  if (b64.length > MAX_CIRCLE_ASSET_B64) throw new Error("Circle asset too large");
  const keyId = asset?.key_id;
  if (!keyId || typeof keyId !== "string" || !HASH.test(String(asset?.plaintext_hash ?? "")))
    throw new Error("Sealed asset metadata incomplete");
  const envelope = bytesFromB64(b64);
  if (
    envelope.length < MAGIC.length + 12 + 16 ||
    new TextDecoder().decode(envelope.subarray(0, MAGIC.length)) !== MAGIC
  )
    throw new Error("Invalid sealed envelope");
  const key = await readKey(circleId, keyId, passphrase);
  const frame = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(envelope.subarray(MAGIC.length, MAGIC.length + 12)) },
      key,
      buf(envelope.subarray(MAGIC.length + 12)),
    ),
  );
  if (frame.length < 4) throw new Error("Invalid sealed payload");
  const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (size > frame.length - 4) throw new Error("Invalid sealed payload length");
  const plaintext = frame.subarray(4, 4 + size);
  if (!(await sealedHashMatches(circleId, keyId, passphrase, plaintext, asset?.plaintext_hash)))
    throw new Error("Sealed content failed integrity check");
  return plaintext;
}
