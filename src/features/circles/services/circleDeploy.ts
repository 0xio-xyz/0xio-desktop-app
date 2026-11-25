import { buildHfheTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import * as networkService from "src/services/network/networkService";
import type { TxScope } from "src/services/network/networkService";
import type { SignedTransaction } from "src/types/transaction";
import { UnclearSubmitError } from "src/services/network/submitErrors";

export const utf8 = (s: string) => new TextEncoder().encode(s);

function u32be(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function u64be(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n));
  return buf;
}

// Domain-separated framed hash, byte-identical to the node and webcli:
//   SHA256( tag ++ 0x00 ++ [u32be(part.length) ++ part]... )
// The 0x00 separator and per-part big-endian length prefixes are REQUIRED;
// a plain concatenation produces a different digest and a circle_id_mismatch.
async function sha256raw(tag: string, parts: Uint8Array[]): Promise<Uint8Array> {
  const tagBytes = utf8(tag);
  const total = tagBytes.length + 1 + parts.reduce((s, p) => s + 4 + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  buf.set(tagBytes, off);
  off += tagBytes.length;
  buf[off++] = 0;
  for (const p of parts) {
    buf.set(u32be(p.length), off);
    off += 4;
    buf.set(p, off);
    off += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function sha256hex(tag: string, parts: Uint8Array[]): Promise<string> {
  return Array.from(await sha256raw(tag, parts))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base58Encode(bytes: Uint8Array): string {
  const alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let v = 0n;
  bytes.forEach((b) => {
    v = (v << 8n) + BigInt(b);
  });
  let s = "";
  while (v > 0n) {
    s = alpha[Number(v % 58n)] + s;
    v /= 58n;
  }
  // Leading zero bytes stay as '1' (as the node and webcli do); the bigint
  // conversion above drops them, which would shift the derived circle id.
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = "1" + s;
  return s;
}

export async function circleIdOfDeploy(
  deployer: string,
  nonce: number,
  payload: Record<string, unknown>,
): Promise<string> {
  const ph = await sha256hex("octra:circle_deploy_payload:v1", [utf8(JSON.stringify(payload))]);
  const seed = await sha256raw("octra:circle_deploy_id:v1", [
    utf8(deployer),
    u64be(nonce),
    utf8(ph),
  ]);
  const b58 = base58Encode(seed);
  return `oct${b58.length >= 44 ? b58.slice(0, 44) : (b58 + b58.repeat(Math.ceil(44 / b58.length))).slice(0, 44)}`;
}

// Field set AND order must match the node's canonical deploy payload exactly: the circle id is
// hash(JSON.stringify(payload)) and the node re-derives it from the 9-field struct, nulls included.
// Mode strings are webcli's deployPayload (circle_bridge_policy.js); the node rejects any other.
export function circleDeployPayload(sealed: boolean): Record<string, unknown> {
  return {
    runtime: "octb",
    privacy_class: sealed ? "sealed" : "public",
    browser_mode: "native_sealed",
    resource_mode: sealed ? "sealed_read" : "public_resources",
    code_b64: null,
    policy_hash: null,
    members_root: null,
    export_policy: null,
    limits: {
      max_stable_bytes: "33554432",
      max_assets_bytes: "33554432",
      max_inline_value: "65536",
      max_wasm_bytes: "33554432",
    },
  };
}

/** The circle id commits to the deploy nonce, so the id and the signed tx share one reservation. */
export async function deployCircle(params: {
  walletId: string;
  scope: TxScope;
  sealed: boolean;
  ou: string;
}): Promise<{ circleId: string; hash: string }> {
  const { walletId, scope } = params;
  networkService.assertScope(scope);
  const payload = circleDeployPayload(params.sealed);
  const nonce = await networkService.getNextNonce(scope.address, scope.networkId);
  let tx: SignedTransaction;
  try {
    const circleId = await circleIdOfDeploy(scope.address, nonce, payload);
    tx = await buildHfheTx({
      from: scope.address,
      to: circleId,
      amount: "0",
      opType: "deploy_circle",
      encryptedData: "",
      walletId,
      ou: params.ou,
      message: JSON.stringify(payload),
      nonce,
      scope,
    });
  } catch (e) {
    networkService.releaseNonce(scope.address, nonce, scope.networkId);
    throw e;
  }
  try {
    return { circleId: tx.to_, hash: await broadcastSignedTx(tx, scope) };
  } catch (e) {
    if (e instanceof UnclearSubmitError) e.contractAddress = tx.to_;
    throw e;
  }
}

export async function confirmCircleTx(
  hash: string,
  networkId: string,
  timeoutMs = 90_000,
  intervalMs = 3000,
): Promise<{ status: "confirmed" | "rejected" | "pending"; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tx = await networkService.getTransactionDetails(hash, networkId).catch(() => null);
    const status = (tx?.status ?? "pending").toLowerCase();
    if (status === "confirmed" || status === "accepted") return { status: "confirmed" };
    if (status === "rejected" || status === "failed" || status === "dropped")
      return { status: "rejected", reason: tx?.reject_reason || status };
  }
  return { status: "pending" };
}

/** Base64 length of an encoded circle asset, which the node prices an upload by. A sealed asset is
 *  "OCRS1", a 12-byte nonce, the length-framed plaintext padded to 256 bytes, and the GCM tag. */
export function circleAssetB64Len(size: number, sealed: boolean): number {
  const bytes = sealed ? 5 + 12 + Math.ceil((4 + size) / 256) * 256 + 16 : size;
  return Math.ceil(bytes / 3) * 4;
}
