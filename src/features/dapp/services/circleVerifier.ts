// fhe.verify_zero and fhe.verify_bound for circles, in the order webcli main.cpp serves
// /api/circle/fhe/verify_zero and /api/circle/fhe/verify_bound. Read-only: nothing is signed but
// the fixed circle read frames, and the PVAC check runs in Rust under the wallet's registered key.

import { pvacBridge } from "src/services/pvac/pvacBridge";
import * as networkService from "src/services/network/networkService";
import {
  checkProofPolicy,
  proofPolicyFor,
  ProofPolicyError,
  type ProofPolicy,
} from "src/features/privacy/services/proofPolicy";
import {
  assertVerifierInputs,
  circleVerifierLane,
  VERIFIER_BUSY,
  type VerifierLane,
} from "src/features/dapp/services/circleVerifierPolicy";
import {
  ciphertextHash,
  commitmentHash,
  isRecord,
  policyHash,
  valueOf,
  verifyReceiptJson,
} from "src/features/dapp/services/circleReceipt";

export type VerifierKind = "zero" | "bound";

export interface VerifierCaller {
  walletId: string;
  address: string;
  networkId: string;
  /** False once the open wallet, the network or the circle's grant moved on. */
  current: () => boolean;
  /** A signed circle read (octra_circle_auth_v2) as this wallet. */
  authRead: (
    rpcMethod: string,
    op: string,
    params: unknown[],
    subject?: string,
  ) => Promise<unknown>;
}

export interface VerifierInput {
  ciphertext: string;
  zero_proof: string;
  amount_commitment?: string;
  pubkey: string;
  policy: ProofPolicy;
}

export interface VerifierDeps {
  ensurePvac: (caller: VerifierCaller) => Promise<void>;
  registeredPubkey: (caller: VerifierCaller) => Promise<string | null>;
  proofPolicy: (caller: VerifierCaller) => Promise<ProofPolicy>;
  checkProofPolicy: (caller: VerifierCaller, prepared: ProofPolicy) => Promise<void>;
  verify: (kind: VerifierKind, input: VerifierInput, caller: VerifierCaller) => Promise<void>;
  lane: VerifierLane;
}

const asError = (e: unknown) =>
  e instanceof ProofPolicyError
    ? new Error(e.detail)
    : e instanceof Error
      ? e
      : new Error(String(e));

export const defaultVerifierDeps: VerifierDeps = {
  ensurePvac: (c) => pvacBridge.ensureInit(c.walletId, c.address),
  registeredPubkey: (c) => networkService.getPvacPubkey(c.address, c.networkId),
  proofPolicy: (c) => proofPolicyFor(c.address, c.networkId),
  checkProofPolicy: (c, prepared) => checkProofPolicy(c.address, c.networkId, prepared),
  verify: async (kind, input, c) => {
    const ctx = pvacBridge.requireContext(c.address);
    try {
      if (kind === "zero") await pvacBridge.circleVerifyZero(input, ctx);
      else await pvacBridge.circleVerifyBound(input, ctx);
    } catch (e) {
      throw asError(e);
    }
  },
  lane: circleVerifierLane,
};

const MODE_KEY: Record<VerifierKind, string> = {
  zero: "verify_zero_mode",
  bound: "verify_bound_mode",
};
const RECEIPT_PROOF: Record<VerifierKind, string> = {
  zero: "zero_receipt_v1",
  bound: "bound_zero_receipt_v1",
};
const REQUIRED: Record<VerifierKind, string> = {
  zero: "circle_id, ciphertext and zero_proof required",
  bound: "circle_id, ciphertext, zero_proof and amount_commitment required",
};

const readError = (e: unknown, fallback: string) =>
  new Error((e instanceof Error && e.message) || fallback);

async function circleOwner(circleId: string, caller: VerifierCaller): Promise<string> {
  const info = await caller
    .authRead("octra_circleInfoAuth", "octra_circle_info", [circleId])
    .catch(() => null);
  if (!isRecord(info) || typeof info.owner !== "string" || !info.owner)
    throw new Error("circle owner read failed");
  return info.owner;
}

async function hfhePolicy(circleId: string, caller: VerifierCaller) {
  const r = await caller
    .authRead("octra_circleHfhePolicyAuth", "octra_circle_hfhe_policy", [circleId])
    .catch(() => null);
  if (!isRecord(r) || !isRecord(r.policy)) throw new Error("circle hfhe policy read failed");
  return r.policy;
}

async function activeRelays(
  circleId: string,
  intentId: string,
  caller: VerifierCaller,
): Promise<string[]> {
  let status: unknown;
  try {
    status = await caller.authRead(
      "octra_circleOutboxStatusAuth",
      "octra_circle_outbox_status",
      [circleId, intentId],
      intentId,
    );
  } catch (e) {
    throw readError(e, "circle outbox status read failed");
  }
  if (valueOf(status, "status", "") !== "claimed")
    throw new Error("circle outbox intent is not actively claimed");
  if (!valueOf(status, "claim_ready", false))
    throw new Error("circle outbox intent relay quorum is not ready");
  const claims =
    isRecord(status) && Array.isArray(status.active_claims) ? status.active_claims : [];
  const relays = claims
    .filter(isRecord)
    .map((c) => valueOf(c, "relay_id", ""))
    .filter(Boolean);
  if (!relays.length) throw new Error("circle outbox active relays are unavailable");
  return relays;
}

/** webcli circle_hfhe_mode_allows. */
export function modeAllows(
  mode: string,
  owner: string,
  caller: string,
  subject: string,
  relays: string[],
): boolean {
  switch (mode) {
    case "owner_only":
      return caller === owner;
    case "caller_self":
      return caller === subject;
    case "owner_or_caller":
      return caller === owner || caller === subject;
    case "any_registered":
      return !!caller;
    case "active_relay":
      return relays.includes(caller);
    case "owner_or_active_relay":
      return caller === owner || relays.includes(caller);
    default:
      return false;
  }
}

/** webcli circle_hfhe_authorize for the verify modes. */
async function authorize(
  circleId: string,
  modeKey: string,
  caller: VerifierCaller,
  keyId: string,
  intentId: string,
): Promise<void> {
  const owner = await circleOwner(circleId, caller);
  const policy = await hfhePolicy(circleId, caller);
  const mode = valueOf(policy, modeKey, "owner_only");
  let relays: string[] = [];
  if (mode === "active_relay" || mode === "owner_or_active_relay") {
    if (!intentId) throw new Error("intent_id required by circle hfhe relay-scoped policy");
    relays = await activeRelays(circleId, intentId, caller);
  }
  if (!modeAllows(mode, owner, caller.address, caller.address, relays))
    throw new Error("circle hfhe policy denied this operation");
  if (!valueOf(policy, "require_live_key_policy", true)) return;
  if (!keyId) throw new Error("key_id required by circle hfhe policy");
  let r: unknown;
  try {
    r = await caller.authRead(
      "octra_circleKeyPolicyAuth",
      "octra_circle_key_policy",
      [circleId, keyId],
      keyId,
    );
  } catch (e) {
    throw readError(e, "circle key policy read failed");
  }
  if (!isRecord(r) || typeof r.live !== "boolean")
    throw new Error("circle key policy live status unavailable");
  if (!r.live) throw new Error("circle key policy is not live");
}

function receiptClass(policy: Record<string, unknown>): string {
  const named = valueOf(policy, "proof_receipt_class", "");
  if (named) return named;
  return valueOf(policy, "require_receipt_transport_binding", false)
    ? "transport_bound"
    : "detached";
}

/** webcli circle_verify_proof_receipt with verb "encrypt". */
async function verifyProofReceipt(
  circleId: string,
  caller: VerifierCaller,
  keyId: string,
  intentId: string,
  proofKind: string,
  policy: Record<string, unknown>,
  ciphertext: string,
  commitment: string,
  receipt: unknown,
): Promise<void> {
  const cls = receiptClass(policy);
  if ((cls === "transport_bound" || cls === "relay_witnessed") && !intentId)
    throw new Error("intent_id required by circle hfhe receipt binding policy");
  const ctx = {
    circle_id: circleId,
    caller_addr: caller.address,
    key_id: keyId,
    intent_id: intentId,
    verb: "encrypt",
    proof_kind: proofKind,
    policy_hash: await policyHash(policy),
    ciphertext_hash: await ciphertextHash(ciphertext),
    amount_commitment_hash: commitment ? await commitmentHash(commitment) : "",
  };
  await verifyReceiptJson(receipt, ctx);

  const owner = await circleOwner(circleId, caller);
  const mode = valueOf(policy, "proof_receipt_signer_mode", "caller_self");
  const signer = valueOf(receipt, "signer_addr", "");
  let relays: string[] = [];
  if (mode === "active_relay" || mode === "owner_or_active_relay" || cls === "relay_witnessed") {
    if (!intentId) throw new Error("intent_id required by circle hfhe receipt signer policy");
    relays = await activeRelays(circleId, intentId, caller);
  }
  if (cls === "relay_witnessed" && !relays.includes(signer))
    throw new Error("circle hfhe receipt signer must be an active relay");
  if (!modeAllows(mode, owner, signer, caller.address, relays))
    throw new Error("circle hfhe receipt signer is not allowed by policy");
}

const present = (payload: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;

export async function circleVerify(
  kind: VerifierKind,
  circleId: string,
  payload: Record<string, unknown>,
  caller: VerifierCaller,
  deps: VerifierDeps = defaultVerifierDeps,
): Promise<{ ok: boolean }> {
  try {
    await deps.ensurePvac(caller);
  } catch {
    throw new Error("pvac not available");
  }
  const fields =
    kind === "zero"
      ? ["ciphertext", "zero_proof"]
      : ["ciphertext", "zero_proof", "amount_commitment"];
  if (!fields.every((f) => present(payload, f))) throw new Error(REQUIRED[kind]);
  assertVerifierInputs({
    ciphertext: payload.ciphertext,
    proof: payload.zero_proof,
    ...(kind === "bound" ? { commitment: payload.amount_commitment } : {}),
  });
  const ciphertext = payload.ciphertext as string;
  const zeroProof = payload.zero_proof as string;
  const commitment = kind === "bound" ? (payload.amount_commitment as string) : "";
  const keyId = valueOf(payload, "key_id", "");
  const intentId = valueOf(payload, "intent_id", "");

  await authorize(circleId, MODE_KEY[kind], caller, keyId, intentId);
  const policy = await hfhePolicy(circleId, caller);
  const encryptProof = valueOf(policy, "encrypt_proof", "bound_zero_v1");
  if (encryptProof === RECEIPT_PROOF[kind]) {
    if (!present(payload, "proof_receipt"))
      throw new Error("proof_receipt required by circle hfhe policy");
    await verifyProofReceipt(
      circleId,
      caller,
      keyId,
      intentId,
      encryptProof,
      policy,
      ciphertext,
      commitment,
      payload.proof_receipt,
    );
  }

  const pubkey = await deps.registeredPubkey(caller).catch(() => null);
  if (!pubkey) throw new Error("registered pvac key is unavailable");
  const proofPolicy = await deps.proofPolicy(caller).catch((e) => {
    throw asError(e);
  });
  const release = deps.lane.tryAcquire();
  if (!release) throw new Error(VERIFIER_BUSY);
  try {
    if (!caller.current()) throw new Error("wallet changed during circle authorization");
    await deps.verify(
      kind,
      {
        ciphertext,
        zero_proof: zeroProof,
        ...(kind === "bound" ? { amount_commitment: commitment } : {}),
        pubkey,
        policy: proofPolicy,
      },
      caller,
    );
    if (!caller.current()) throw new Error("wallet changed during circle verification");
  } finally {
    release();
  }
  await deps.checkProofPolicy(caller, proofPolicy).catch((e) => {
    throw asError(e);
  });
  return { ok: true };
}
