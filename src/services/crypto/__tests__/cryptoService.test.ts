import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import vectors from "src/test/fixtures/stealth-scan-vectors.json";
import {
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  sha256,
  deriveAddressFromPublicKey,
  ecdhSharedSecret,
  generateEphemeralKeypair,
  computeStealthTag,
  computeClaimSecret,
  computeClaimPub,
  encryptStealthAmount,
  decryptStealthAmount,
} from "src/services/crypto/cryptoService";

const TEST_SEED_32 = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_SEED_32[i] = i;

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips empty array", () => {
    const empty = new Uint8Array(0);
    const b64 = bytesToBase64(empty);
    expect(b64).toBe("");
    const back = base64ToBytes(b64);
    expect(back.length).toBe(0);
  });

  it("round-trips a single byte", () => {
    const one = new Uint8Array([0xff]);
    const b64 = bytesToBase64(one);
    const back = base64ToBytes(b64);
    expect(back).toEqual(one);
  });

  it("round-trips arbitrary data", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const b64 = bytesToBase64(data);
    const back = base64ToBytes(b64);
    expect(back).toEqual(data);
  });

  it("produces correct base64 for known input", () => {
    const hello = new TextEncoder().encode("Hello");
    expect(bytesToBase64(hello)).toBe("SGVsbG8=");
  });

  it("decodes known base64 correctly", () => {
    const bytes = base64ToBytes("SGVsbG8=");
    expect(new TextDecoder().decode(bytes)).toBe("Hello");
  });

  it("throws on invalid base64", () => {
    expect(() => base64ToBytes("not!valid!base64!!!")).toThrow();
  });
});

describe("bytesToHex / hexToBytes", () => {
  it("round-trips empty array", () => {
    const empty = new Uint8Array(0);
    expect(bytesToHex(empty)).toBe("");
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("converts known bytes to hex", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 255]))).toBe("00010fff");
  });

  it("round-trips arbitrary data", () => {
    const data = new Uint8Array(32);
    for (let i = 0; i < 32; i++) data[i] = i * 8;
    expect(hexToBytes(bytesToHex(data))).toEqual(data);
  });
});

describe("sha256", () => {
  it("hashes empty input to known digest", async () => {
    const hash = await sha256(new Uint8Array(0));
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(bytesToHex(hash)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to known digest", async () => {
    const hash = await sha256(new TextEncoder().encode("abc"));
    expect(bytesToHex(hash)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("deriveAddressFromPublicKey", () => {
  it("returns oct-prefixed base58 address", async () => {
    const keyPair = nacl.sign.keyPair.fromSeed(TEST_SEED_32);
    const address = await deriveAddressFromPublicKey(keyPair.publicKey);
    expect(address.startsWith("oct")).toBe(true);
    expect(address.slice(3)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("different public keys produce different addresses", async () => {
    const kp1 = nacl.sign.keyPair.fromSeed(TEST_SEED_32);
    const altSeed = new Uint8Array(32).fill(0xab);
    const kp2 = nacl.sign.keyPair.fromSeed(altSeed);
    const addr1 = await deriveAddressFromPublicKey(kp1.publicKey);
    const addr2 = await deriveAddressFromPublicKey(kp2.publicKey);
    expect(addr1).not.toBe(addr2);
  });
});

describe("ecdhSharedSecret", () => {
  it("produces a 32-byte shared secret", async () => {
    const kp1 = generateEphemeralKeypair();
    const kp2 = generateEphemeralKeypair();
    const shared = await ecdhSharedSecret(kp1.ephSk, kp2.ephPub);
    expect(shared.length).toBe(32);
  });

  it("is symmetric (both sides compute the same secret)", async () => {
    const kp1 = generateEphemeralKeypair();
    const kp2 = generateEphemeralKeypair();
    const s1 = await ecdhSharedSecret(kp1.ephSk, kp2.ephPub);
    const s2 = await ecdhSharedSecret(kp2.ephSk, kp1.ephPub);
    expect(s1).toEqual(s2);
  });

  it("refuses every low-order public key of the shared vectors", async () => {
    const lowOrder = vectors.wallets
      .flatMap((w) => w.outputs)
      .filter((o) => /low-order ephemeral point( \(|$)/.test(o.case));
    expect(lowOrder).toHaveLength(9);
    for (const o of lowOrder) {
      for (const sk of [generateEphemeralKeypair().ephSk, generateEphemeralKeypair().ephSk]) {
        await expect(ecdhSharedSecret(sk, base64ToBytes(o.eph_pub))).rejects.toThrow(
          "x25519 low-order public key rejected",
        );
      }
    }
  });
});

describe("generateEphemeralKeypair", () => {
  it("returns clamped 32-byte keys", () => {
    const { ephSk, ephPub } = generateEphemeralKeypair();
    expect(ephSk.length).toBe(32);
    expect(ephPub.length).toBe(32);
    // Clamped
    expect(ephSk[0] & 7).toBe(0);
    expect(ephSk[31] & 128).toBe(0);
    expect(ephSk[31] & 64).toBe(64);
  });

  it("produces different keys each time", () => {
    const kp1 = generateEphemeralKeypair();
    const kp2 = generateEphemeralKeypair();
    expect(bytesToHex(kp1.ephSk)).not.toBe(bytesToHex(kp2.ephSk));
  });
});

describe("stealth tag / claim secret / claim pub", () => {
  it("computeStealthTag returns 16 bytes", async () => {
    const shared = new Uint8Array(32).fill(0xaa);
    const tag = await computeStealthTag(shared);
    expect(tag.length).toBe(16);
  });

  it("computeStealthTag is deterministic", async () => {
    const shared = new Uint8Array(32).fill(0xbb);
    const t1 = await computeStealthTag(shared);
    const t2 = await computeStealthTag(shared);
    expect(t1).toEqual(t2);
  });

  it("computeClaimSecret returns 32 bytes", async () => {
    const shared = new Uint8Array(32).fill(0xcc);
    const secret = await computeClaimSecret(shared);
    expect(secret.length).toBe(32);
  });

  it("computeClaimPub returns 32 bytes", async () => {
    const secret = new Uint8Array(32).fill(0xdd);
    const pub = await computeClaimPub(secret, "octTestAddress123");
    expect(pub.length).toBe(32);
  });

  it("different addresses produce different claimPubs", async () => {
    const secret = new Uint8Array(32).fill(0xdd);
    const pub1 = await computeClaimPub(secret, "octAlice");
    const pub2 = await computeClaimPub(secret, "octBob");
    expect(bytesToHex(pub1)).not.toBe(bytesToHex(pub2));
  });
});

describe("encryptStealthAmount / decryptStealthAmount", () => {
  it("round-trips amount and blinding", async () => {
    const sharedSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) sharedSecret[i] = i;
    const blinding = new Uint8Array(32);
    for (let i = 0; i < 32; i++) blinding[i] = 0xff - i;
    const amount = 42_000_000;

    const encrypted = await encryptStealthAmount(sharedSecret, amount, blinding);
    expect(typeof encrypted).toBe("string");
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await decryptStealthAmount(sharedSecret, encrypted);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.amount).toBe(amount);
    expect(decrypted!.blinding).toEqual(blinding);
  });

  it("returns null for wrong shared secret", async () => {
    const secret1 = new Uint8Array(32).fill(0x01);
    const secret2 = new Uint8Array(32).fill(0x02);
    const blinding = new Uint8Array(32).fill(0xab);

    const encrypted = await encryptStealthAmount(secret1, 100, blinding);
    const result = await decryptStealthAmount(secret2, encrypted);
    expect(result).toBeNull();
  });

  it("returns null for malformed base64", async () => {
    const secret = new Uint8Array(32).fill(0x01);
    // Too short to be valid (needs 68 bytes raw)
    const result = await decryptStealthAmount(secret, bytesToBase64(new Uint8Array(10)));
    expect(result).toBeNull();
  });

  it("handles zero amount", async () => {
    const secret = new Uint8Array(32).fill(0x55);
    const blinding = new Uint8Array(32).fill(0x00);
    const encrypted = await encryptStealthAmount(secret, 0, blinding);
    const decrypted = await decryptStealthAmount(secret, encrypted);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.amount).toBe(0);
  });
});
