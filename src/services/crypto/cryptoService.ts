import nacl from "tweetnacl";

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i]);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = "1" + s;
  return s;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(hash);
}

export async function deriveAddressFromPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await sha256(publicKey);
  return "oct" + bytesToBase58(hash);
}

/** Stored addresses carry the base58 part left-padded with "1" to 44 chars (wallet import). */
export function canonicalAddress(address: string): string {
  if (!address.startsWith("oct") || address.length >= 47) return address;
  return "oct" + address.slice(3).padStart(44, "1");
}

// Stealth send primitives: byte exact with the extension's src/services/crypto/PrivateCrypto.ts.

const STEALTH_TAG_DOMAIN = "OCTRA_STEALTH_TAG_V1";
const CLAIM_SECRET_DOMAIN = "OCTRA_CLAIM_SECRET_V1";
const CLAIM_BIND_DOMAIN = "OCTRA_CLAIM_BIND_V1";

function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function uint64LE(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
}

/** ECDH shared secret: SHA-256(X25519(sk, pub)). */
export async function ecdhSharedSecret(
  ourSk: Uint8Array,
  theirPub: Uint8Array,
): Promise<Uint8Array> {
  const raw = nacl.scalarMult(ourSk, theirPub);
  if (raw.every((b) => b === 0)) throw new Error("x25519 low-order public key rejected");
  return sha256(raw);
}

export function generateEphemeralKeypair(): { ephSk: Uint8Array; ephPub: Uint8Array } {
  const ephSk = nacl.randomBytes(32);
  ephSk[0] &= 248;
  ephSk[31] &= 127;
  ephSk[31] |= 64;
  const ephPub = nacl.scalarMult.base(ephSk);
  return { ephSk, ephPub };
}

/** Stealth tag: first 16 bytes of SHA-256(shared || domain). */
export async function computeStealthTag(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const data = concat(sharedSecret, strToBytes(STEALTH_TAG_DOMAIN));
  const hash = await sha256(data);
  return hash.slice(0, 16);
}

/** Claim secret: SHA-256(shared || domain). */
export async function computeClaimSecret(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const data = concat(sharedSecret, strToBytes(CLAIM_SECRET_DOMAIN));
  return sha256(data);
}

/** Claim pub: SHA-256(claimSecret || recipientAddr || domain). */
export async function computeClaimPub(
  claimSecret: Uint8Array,
  recipientAddr: string,
): Promise<Uint8Array> {
  const data = concat(claimSecret, strToBytes(recipientAddr), strToBytes(CLAIM_BIND_DOMAIN));
  return sha256(data);
}

/** AES-GCM encrypt amount + blinding with shared secret. */
export async function encryptStealthAmount(
  sharedSecret: Uint8Array,
  amountRaw: number,
  blinding: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    sharedSecret.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = concat(uint64LE(amountRaw), blinding);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    plaintext as BufferSource,
  );
  const result = concat(nonce, new Uint8Array(ciphertext));
  return bytesToBase64(result);
}

export async function decryptStealthAmount(
  sharedSecret: Uint8Array,
  encB64: string,
): Promise<{ amount: number; blinding: Uint8Array } | null> {
  try {
    const raw = base64ToBytes(encB64);
    if (raw.length !== 68) return null; // 12 nonce + 40 ct + 16 tag
    const nonce = raw.slice(0, 12);
    const ciphertextWithTag = raw.slice(12); // 56 bytes
    const key = await crypto.subtle.importKey(
      "raw",
      sharedSecret.slice(0, 32),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertextWithTag),
    );
    // First 8 bytes: uint64 LE amount
    let amount = 0;
    for (let i = 7; i >= 0; i--) amount = amount * 256 + plaintext[i];
    // Next 32 bytes: blinding
    return { amount, blinding: plaintext.slice(8, 40) };
  } catch {
    return null; // Auth tag failure = not our output
  }
}

export { bytesToBase64, base64ToBytes, bytesToHex, hexToBytes, sha256 };
