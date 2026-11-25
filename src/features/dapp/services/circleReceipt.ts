// Circle hfhe proof receipts, ported from webcli lib/circle_hfhe_receipt.hpp and the receipt
// helpers in main.cpp. Signatures are checked with tweetnacl, the library webcli links.

import nacl from "tweetnacl";
import { canonicalAddress, deriveAddressFromPublicKey } from "src/services/crypto/cryptoService";

export interface ReceiptContext {
  circle_id: string;
  caller_addr: string;
  key_id: string;
  intent_id: string;
  verb: string;
  proof_kind: string;
  policy_hash: string;
  ciphertext_hash: string;
  amount_commitment_hash: string;
}

const FIELDS = [
  "verb",
  "proof_kind",
  "circle_id",
  "caller_addr",
  "key_id",
  "intent_id",
  "policy_hash",
  "ciphertext_hash",
  "amount_commitment_hash",
] as const;

export const JSON_TYPE_ERROR = "invalid JSON field type";

const utf8 = new TextEncoder();

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** nlohmann json::value(key, default): absent gives the default, a wrong type throws. */
export function valueOf(obj: unknown, key: string, fallback: string): string;
export function valueOf(obj: unknown, key: string, fallback: boolean): boolean;
export function valueOf(obj: unknown, key: string, fallback: string | boolean): string | boolean {
  const v = isRecord(obj) ? obj[key] : undefined;
  if (v === undefined || !Object.prototype.hasOwnProperty.call(obj, key)) return fallback;
  if (typeof v !== typeof fallback) throw new Error(JSON_TYPE_ERROR);
  return v as string | boolean;
}

/** webcli crypto_utils.hpp base64_decode, byte for byte (no alphabet or padding checks). */
export function webcliBase64Decode(s: string): Uint8Array {
  const D = new Int32Array(256).fill(-1);
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < T.length; i++) D[T.charCodeAt(i)] = i;
  D[61] = 0;
  const b = utf8.encode(s);
  const out: number[] = [];
  for (let i = 0; i + 3 < b.length; i += 4) {
    const n = (D[b[i]] << 18) | (D[b[i + 1]] << 12) | (D[b[i + 2]] << 6) | D[b[i + 3]];
    out.push((n >> 16) & 0xff);
    if (b[i + 2] !== 61) out.push((n >> 8) & 0xff);
    if (b[i + 3] !== 61) out.push(n & 0xff);
  }
  return new Uint8Array(out);
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

const byteOrder = (a: string, b: string) => {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

/** nlohmann json::dump(): compact, object keys in byte order, non-ASCII left as UTF-8. */
export function jsonDump(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonDump).join(",")}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort(byteOrder)
      .map((k) => `${JSON.stringify(k)}:${jsonDump(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export const policyHash = (policy: unknown) => sha256Hex(utf8.encode(jsonDump(policy)));

export async function ciphertextHash(ciphertextB64: string): Promise<string> {
  const raw = webcliBase64Decode(ciphertextB64);
  if (!raw.length) throw new Error("invalid base64 payload");
  return sha256Hex(raw);
}

export async function commitmentHash(commitmentB64: string): Promise<string> {
  const raw = webcliBase64Decode(commitmentB64);
  if (raw.length !== 32) throw new Error("invalid amount commitment");
  return sha256Hex(raw);
}

export function receiptSubject(ctx: ReceiptContext): string {
  return FIELDS.reduce(
    (out, f) => `${out}|${utf8.encode(ctx[f]).length}:${ctx[f]}`,
    "octra_circle_hfhe_receipt_v2",
  );
}

export function receiptSubjectV1(ctx: ReceiptContext): string {
  return ["octra_circle_hfhe_receipt_v1", ...FIELDS.map((f) => ctx[f])].join("|");
}

const P = (1n << 255n) - 19n;

function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = base % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}

/** webcli ed25519_public_key_safe: the Montgomery form times 9 must not vanish. */
export function ed25519PublicKeySafe(pub: Uint8Array): boolean {
  if (pub.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? pub[i] & 0x7f : pub[i]);
  if (y >= P) return false;
  const oneMinusY = (((1n - y) % P) + P) % P;
  if (oneMinusY === 0n) return false;
  const u = (((1n + y) % P) * modPow(oneMinusY, P - 2n)) % P;
  if (u === 0n) return false;
  const x = new Uint8Array(32);
  for (let i = 0, n = u; i < 32; i++, n >>= 8n) x[i] = Number(n & 0xffn);
  const probe = new Uint8Array(32);
  probe[0] = 9;
  return nacl.scalarMult(probe, x).some((b) => b !== 0);
}

function ed25519VerifyDetached(message: string, sigB64: string, pubB64: string): boolean {
  const sig = webcliBase64Decode(sigB64);
  const pub = webcliBase64Decode(pubB64);
  if (sig.length !== 64 || pub.length !== 32) return false;
  if (!ed25519PublicKeySafe(pub)) return false;
  return nacl.sign.detached.verify(utf8.encode(message), sig, pub);
}

async function addressOfPubkey(pubB64: string): Promise<string> {
  const raw = webcliBase64Decode(pubB64);
  if (raw.length !== 32) return "";
  return canonicalAddress(await deriveAddressFromPublicKey(raw));
}

/** webcli verify_circle_hfhe_receipt_json. */
export async function verifyReceiptJson(receipt: unknown, ctx: ReceiptContext): Promise<void> {
  if (!isRecord(receipt)) throw new Error("proof_receipt must be an object");
  const read = (k: string) => valueOf(receipt, k, "");
  const version = read("version");
  const got = Object.fromEntries(FIELDS.map((f) => [f, read(f)]));
  const signerAddr = read("signer_addr");
  const signerPubkey = read("signer_pubkey");
  const signature = read("signature");
  if (version !== "octra_circle_hfhe_receipt_v1" && version !== "octra_circle_hfhe_receipt_v2")
    throw new Error("invalid proof receipt version");
  if (FIELDS.some((f) => got[f] !== ctx[f])) throw new Error("proof receipt context mismatch");
  const derived = await addressOfPubkey(signerPubkey);
  if (!derived || derived !== signerAddr) throw new Error("proof receipt signer binding invalid");
  const legacy = version === "octra_circle_hfhe_receipt_v1";
  if (legacy && FIELDS.some((f) => ctx[f].includes("|")))
    throw new Error("legacy proof receipt context is ambiguous");
  const subject = legacy ? receiptSubjectV1(ctx) : receiptSubject(ctx);
  if (!ed25519VerifyDetached(subject, signature, signerPubkey))
    throw new Error("proof receipt signature verification failed");
}
