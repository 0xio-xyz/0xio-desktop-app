import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: {} }));
vi.mock("src/services/network/networkService", () => ({}));
vi.mock("src/features/privacy/services/proofPolicy", () => ({
  ProofPolicyError: class extends Error {
    detail = "";
  },
  proofPolicyFor: vi.fn(),
  checkProofPolicy: vi.fn(),
}));

import nacl from "tweetnacl";
import vectors from "src/test/fixtures/circle-verifier-vectors.json";
import { canonicalAddress, deriveAddressFromPublicKey } from "src/services/crypto/cryptoService";
import {
  assertVerifierInputs,
  ciphertextSizeAllowed,
  commitmentSizeAllowed,
  proofSizeAllowed,
  VerifierLane,
} from "src/features/dapp/services/circleVerifierPolicy";
import {
  ciphertextHash,
  commitmentHash,
  ed25519PublicKeySafe,
  jsonDump,
  policyHash,
  receiptSubject,
  receiptSubjectV1,
  verifyReceiptJson,
  webcliBase64Decode,
  type ReceiptContext,
} from "src/features/dapp/services/circleReceipt";
import {
  circleVerify,
  modeAllows,
  type VerifierCaller,
  type VerifierDeps,
} from "src/features/dapp/services/circleVerifier";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const CTX = vectors.context as ReceiptContext;
const CIRCLE = CTX.circle_id;
const ADDR = vectors.addr;
const OWNER = `oct${"8".repeat(44)}`;

describe("webcli parity vectors (generated from lib/circle_hfhe_receipt.hpp)", () => {
  it("decodes base64 the way webcli does, quirks included", () => {
    for (const v of vectors.base64) expect(hex(webcliBase64Decode(v.in)), v.in).toBe(v.hex);
  });

  it("dumps and hashes a policy like nlohmann", async () => {
    expect(jsonDump(vectors.policy)).toBe(vectors.policy_dump);
    expect(await policyHash(vectors.policy)).toBe(vectors.policy_hash);
  });

  it("hashes the ciphertext and the commitment", async () => {
    expect(await ciphertextHash(vectors.ciphertext_b64)).toBe(CTX.ciphertext_hash);
    expect(await commitmentHash(vectors.amount_commitment_b64)).toBe(CTX.amount_commitment_hash);
    await expect(ciphertextHash("abc")).rejects.toThrow("invalid base64 payload");
    await expect(commitmentHash("AAAA")).rejects.toThrow("invalid amount commitment");
  });

  it("frames both receipt subjects", () => {
    expect(receiptSubject(CTX)).toBe(vectors.subject_v2);
    expect(receiptSubjectV1(CTX)).toBe(vectors.subject_v1);
  });

  it("refuses the keys webcli refuses", () => {
    for (const k of vectors.key_safe)
      expect(ed25519PublicKeySafe(fromHex(k.pub_hex)), k.pub_hex).toBe(k.safe);
  });

  it("accepts the v1 and v2 receipts webcli made and refuses any change", async () => {
    await expect(verifyReceiptJson(vectors.receipt_v2, CTX)).resolves.toBeUndefined();
    await expect(verifyReceiptJson(vectors.receipt_v1, CTX)).resolves.toBeUndefined();
    await expect(verifyReceiptJson([], CTX)).rejects.toThrow("proof_receipt must be an object");
    await expect(verifyReceiptJson({ ...vectors.receipt_v2, version: "v3" }, CTX)).rejects.toThrow(
      "invalid proof receipt version",
    );
    await expect(
      verifyReceiptJson({ ...vectors.receipt_v2, key_id: "other" }, CTX),
    ).rejects.toThrow("proof receipt context mismatch");
    await expect(
      verifyReceiptJson({ ...vectors.receipt_v2, signer_addr: OWNER }, CTX),
    ).rejects.toThrow("proof receipt signer binding invalid");
    const sig = vectors.receipt_v2.signature;
    await expect(
      verifyReceiptJson(
        { ...vectors.receipt_v2, signature: (sig[0] === "A" ? "B" : "A") + sig.slice(1) },
        CTX,
      ),
    ).rejects.toThrow("proof receipt signature verification failed");
    await expect(verifyReceiptJson({ ...vectors.receipt_v2, key_id: 7 }, CTX)).rejects.toThrow(
      "invalid JSON field type",
    );
    const piped = { ...CTX, key_id: "a|b" };
    await expect(
      verifyReceiptJson({ ...vectors.receipt_v1, key_id: "a|b" }, piped),
    ).rejects.toThrow("legacy proof receipt context is ambiguous");
  });
});

describe("resource policy", () => {
  it("caps the encoded sizes in UTF-8 bytes", () => {
    expect(ciphertextSizeAllowed("A".repeat(96 * 1024))).toBe(true);
    expect(ciphertextSizeAllowed("A".repeat(96 * 1024 + 1))).toBe(false);
    expect(ciphertextSizeAllowed("é".repeat(48 * 1024 + 1))).toBe(false);
    expect(ciphertextSizeAllowed("")).toBe(false);
    expect(proofSizeAllowed("A".repeat(64 * 1024))).toBe(true);
    expect(proofSizeAllowed("A".repeat(64 * 1024 + 1))).toBe(false);
    expect(commitmentSizeAllowed("A".repeat(64))).toBe(true);
    expect(commitmentSizeAllowed("A".repeat(65))).toBe(false);
    expect(() => assertVerifierInputs({ ciphertext: "A", proof: 5 })).toThrow(
      "circle verifier input exceeds resource policy",
    );
    expect(() => assertVerifierInputs({ ciphertext: "A", proof: "B", commitment: "" })).toThrow(
      "circle verifier input exceeds resource policy",
    );
    expect(() => assertVerifierInputs({ ciphertext: "A", proof: "B" })).not.toThrow();
  });

  it("the lane refuses while one runs and frees on release", () => {
    const lane = new VerifierLane();
    const release = lane.tryAcquire()!;
    expect(lane.tryAcquire()).toBeNull();
    release();
    release();
    expect(lane.tryAcquire()).not.toBeNull();
  });

  it("matches webcli's policy modes", () => {
    expect(modeAllows("deny", OWNER, OWNER, OWNER, [])).toBe(false);
    expect(modeAllows("owner_only", OWNER, ADDR, ADDR, [])).toBe(false);
    expect(modeAllows("owner_only", OWNER, OWNER, ADDR, [])).toBe(true);
    expect(modeAllows("caller_self", OWNER, ADDR, ADDR, [])).toBe(true);
    expect(modeAllows("any_registered", OWNER, "", "", [])).toBe(false);
    expect(modeAllows("active_relay", OWNER, ADDR, ADDR, [ADDR])).toBe(true);
    expect(modeAllows("owner_or_active_relay", OWNER, ADDR, ADDR, [])).toBe(false);
    expect(modeAllows("unknown", OWNER, OWNER, OWNER, [OWNER])).toBe(false);
  });
});

describe("circleVerify", () => {
  let policy: Record<string, unknown>;
  let reads: Record<string, unknown>;
  let deps: VerifierDeps;
  let current: boolean;
  const caller = (): VerifierCaller => ({
    walletId: "w1",
    address: ADDR,
    networkId: "devnet",
    current: () => current,
    authRead: vi.fn(async (rpcMethod: string) => {
      const r = reads[rpcMethod];
      if (r instanceof Error) throw r;
      return r;
    }),
  });
  const ZERO = { ciphertext: "Y2lwaGVy", zero_proof: "zkzp_v2|AAAA", key_id: "key-1" };

  beforeEach(() => {
    current = true;
    policy = { verify_zero_mode: "caller_self", verify_bound_mode: "caller_self" };
    reads = {
      octra_circleInfoAuth: { owner: OWNER },
      octra_circleKeyPolicyAuth: { live: true },
    };
    Object.defineProperty(reads, "octra_circleHfhePolicyAuth", {
      get: () => ({ policy }),
      enumerable: true,
    });
    deps = {
      ensurePvac: vi.fn(async () => {}),
      registeredPubkey: vi.fn(async () => "PVACPUB"),
      proofPolicy: vi.fn(async () => 3 as const),
      checkProofPolicy: vi.fn(async () => {}),
      verify: vi.fn(async () => {}),
      lane: new VerifierLane(),
    };
  });

  it("verifies through Rust with the registered key and the network policy", async () => {
    expect(await circleVerify("zero", CIRCLE, ZERO, caller(), deps)).toEqual({ ok: true });
    expect(deps.verify).toHaveBeenCalledWith(
      "zero",
      { ciphertext: ZERO.ciphertext, zero_proof: ZERO.zero_proof, pubkey: "PVACPUB", policy: 3 },
      expect.anything(),
    );
    expect(deps.checkProofPolicy).toHaveBeenCalledWith(expect.anything(), 3);
    await circleVerify(
      "bound",
      CIRCLE,
      { ...ZERO, amount_commitment: vectors.amount_commitment_b64 },
      caller(),
      deps,
    );
    expect(vi.mocked(deps.verify).mock.calls[1][1]).toMatchObject({
      amount_commitment: vectors.amount_commitment_b64,
    });
  });

  it("answers missing and oversized inputs with webcli's messages, before any read", async () => {
    const c = caller();
    await expect(circleVerify("zero", CIRCLE, { ciphertext: "A" }, c, deps)).rejects.toThrow(
      "circle_id, ciphertext and zero_proof required",
    );
    await expect(circleVerify("bound", CIRCLE, ZERO, c, deps)).rejects.toThrow(
      "circle_id, ciphertext, zero_proof and amount_commitment required",
    );
    await expect(
      circleVerify("zero", CIRCLE, { ...ZERO, ciphertext: "A".repeat(96 * 1024 + 1) }, c, deps),
    ).rejects.toThrow("circle verifier input exceeds resource policy");
    await expect(
      circleVerify("zero", CIRCLE, { ...ZERO, zero_proof: null }, c, deps),
    ).rejects.toThrow("circle verifier input exceeds resource policy");
    await expect(
      circleVerify("bound", CIRCLE, { ...ZERO, amount_commitment: "A".repeat(65) }, c, deps),
    ).rejects.toThrow("circle verifier input exceeds resource policy");
    expect(c.authRead).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("reports pvac not available when the engine cannot start", async () => {
    deps.ensurePvac = vi.fn(async () => {
      throw new Error("no seed");
    });
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "pvac not available",
    );
  });

  it("applies the circle's hfhe policy", async () => {
    policy = {};
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle hfhe policy denied this operation",
    );
    policy = { verify_zero_mode: "caller_self" };
    await expect(
      circleVerify("zero", CIRCLE, { ...ZERO, key_id: undefined }, caller(), deps),
    ).rejects.toThrow("key_id required by circle hfhe policy");
    reads.octra_circleKeyPolicyAuth = { live: false };
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle key policy is not live",
    );
    reads.octra_circleKeyPolicyAuth = {};
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle key policy live status unavailable",
    );
    policy = { verify_zero_mode: "active_relay", require_live_key_policy: false };
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "intent_id required by circle hfhe relay-scoped policy",
    );
    reads.octra_circleOutboxStatusAuth = { status: "open" };
    await expect(
      circleVerify("zero", CIRCLE, { ...ZERO, intent_id: "i" }, caller(), deps),
    ).rejects.toThrow("circle outbox intent is not actively claimed");
    reads.octra_circleOutboxStatusAuth = {
      status: "claimed",
      claim_ready: true,
      active_claims: [{ relay_id: ADDR }],
    };
    await expect(
      circleVerify("zero", CIRCLE, { ...ZERO, intent_id: "i" }, caller(), deps),
    ).resolves.toEqual({ ok: true });
    reads.octra_circleInfoAuth = new Error("down");
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle owner read failed",
    );
    expect(deps.verify).toHaveBeenCalledTimes(1);
  });

  const signReceipt = (ctx: ReceiptContext, seedHex = vectors.seed_hex) => {
    const kp = nacl.sign.keyPair.fromSeed(fromHex(seedHex));
    const pub = btoa(String.fromCharCode(...kp.publicKey));
    return {
      version: "octra_circle_hfhe_receipt_v2",
      ...ctx,
      signer_addr: seedHex === vectors.seed_hex ? ADDR : "",
      signer_pubkey: pub,
      signature: btoa(
        String.fromCharCode(
          ...nacl.sign.detached(new TextEncoder().encode(receiptSubject(ctx)), kp.secretKey),
        ),
      ),
    };
  };

  it("requires and checks the proof receipt when the policy names one", async () => {
    policy = vectors.policy;
    const input = { ...ZERO, ciphertext: vectors.ciphertext_b64 };
    await expect(circleVerify("zero", CIRCLE, input, caller(), deps)).rejects.toThrow(
      "proof_receipt required by circle hfhe policy",
    );
    const ctx: ReceiptContext = {
      ...CTX,
      proof_kind: "zero_receipt_v1",
      amount_commitment_hash: "",
    };
    expect(await policyHash(policy)).toBe(ctx.policy_hash);
    await expect(
      circleVerify("zero", CIRCLE, { ...input, proof_receipt: signReceipt(ctx) }, caller(), deps),
    ).resolves.toEqual({ ok: true });
    await expect(
      circleVerify("zero", CIRCLE, { ...input, proof_receipt: vectors.receipt_v2 }, caller(), deps),
    ).rejects.toThrow("proof receipt context mismatch");

    const other = signReceipt(ctx, "11".repeat(32));
    const kp = nacl.sign.keyPair.fromSeed(fromHex("11".repeat(32)));
    other.signer_addr = canonicalAddress(await deriveAddressFromPublicKey(kp.publicKey));
    await expect(
      circleVerify("zero", CIRCLE, { ...input, proof_receipt: other }, caller(), deps),
    ).rejects.toThrow("circle hfhe receipt signer is not allowed by policy");
    policy = { ...vectors.policy, proof_receipt_signer_mode: "any_registered" };
    const anyCtx = { ...ctx, policy_hash: await policyHash(policy) };
    const anySigner = signReceipt(anyCtx, "11".repeat(32));
    anySigner.signer_addr = other.signer_addr;
    await expect(
      circleVerify("zero", CIRCLE, { ...input, proof_receipt: anySigner }, caller(), deps),
    ).resolves.toEqual({ ok: true });
    expect(deps.verify).toHaveBeenCalledTimes(2);
  });

  it("refuses a second verification while one runs, not queued", async () => {
    let finish!: () => void;
    deps.verify = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = circleVerify("zero", CIRCLE, ZERO, caller(), deps);
    await vi.waitFor(() => expect(deps.verify).toHaveBeenCalledTimes(1));
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle verifier busy",
    );
    expect(deps.verify).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toEqual({ ok: true });
    deps.verify = vi.fn(async () => {});
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).resolves.toEqual({ ok: true });
  });

  it("refuses when the wallet moved on during the verification", async () => {
    deps.verify = vi.fn(async () => {
      current = false;
    });
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "wallet changed during circle verification",
    );
    current = false;
    deps.verify = vi.fn(async () => {});
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "wallet changed during circle authorization",
    );
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.lane.tryAcquire()).not.toBeNull();
  });

  it("passes Rust's refusal through and needs a registered key", async () => {
    deps.verify = vi.fn(async () => {
      throw new Error("circle verifier ciphertext exceeds resource policy");
    });
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "circle verifier ciphertext exceeds resource policy",
    );
    deps.registeredPubkey = vi.fn(async () => null);
    await expect(circleVerify("zero", CIRCLE, ZERO, caller(), deps)).rejects.toThrow(
      "registered pvac key is unavailable",
    );
  });
});
