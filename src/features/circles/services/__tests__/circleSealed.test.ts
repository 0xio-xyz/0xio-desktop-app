import { describe, it, expect } from "vitest";
import {
  openSealedAsset,
  sealBytes,
  sealedDigest,
  sealedDigestSalt,
  sealedHashMatches,
} from "src/features/circles/services/circleSealed";
import { bytesFromB64 } from "src/features/circles/services/circleAsset";
import vectors from "src/test/fixtures/circle-sealed-digest-vectors.json";

const CIRCLE = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const PASS = "correct horse battery staple";
const text = (s: string) => new TextEncoder().encode(s);
const sha256 = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

describe("sealed digest against the reference vectors", () => {
  it("covers empty, non-ASCII and U+007F cases", () => {
    expect(vectors.digests.some((v) => v.plaintext_b64 === "")).toBe(true);
    expect(vectors.digests.some((v) => /[^\x00-\x7f]/.test(v.key_id + v.passphrase))).toBe(true);
    expect(vectors.digests.filter((v) => v.keyed_unescaped_salt).length).toBeGreaterThan(1);
  });

  it("builds the salt and the keyed digest byte for byte", async () => {
    for (const v of vectors.digests) {
      const plain = bytesFromB64(v.plaintext_b64);
      expect(sealedDigestSalt(v.circle_id, v.key_id)).toBe(v.salt);
      expect(await sealedDigest(v.circle_id, v.key_id, v.passphrase, plain)).toBe(v.keyed);
      expect(await sha256(plain)).toBe(v.sha256);
    }
  });

  it("accepts exactly the three reference forms", async () => {
    for (const v of vectors.digests) {
      const plain = bytesFromB64(v.plaintext_b64);
      const ok = (h: unknown) => sealedHashMatches(v.circle_id, v.key_id, v.passphrase, plain, h);
      expect(await ok(v.sha256)).toBe(true);
      expect(await ok(v.keyed)).toBe(true);
      if (v.keyed_unescaped_salt) expect(await ok(v.keyed_unescaped_salt)).toBe(true);
      expect(await ok(v.keyed.toUpperCase())).toBe(/[a-f]/.test(v.keyed) ? false : true);
      expect(await ok(v.keyed.slice(0, 62) + (v.keyed.endsWith("00") ? "11" : "00"))).toBe(false);
      expect(await ok("")).toBe(false);
      expect(await ok(undefined)).toBe(false);
      expect(await ok(v.keyed + "00")).toBe(false);
    }
  });

  it("ties the keyed digest to the circle, the key id and the passphrase", async () => {
    const v = vectors.digests[1];
    const plain = bytesFromB64(v.plaintext_b64);
    const other = vectors.digests.find((x) => x.circle_id !== v.circle_id)!.circle_id;
    expect(await sealedHashMatches(other, v.key_id, v.passphrase, plain, v.keyed)).toBe(false);
    expect(await sealedHashMatches(v.circle_id, "k2", v.passphrase, plain, v.keyed)).toBe(false);
    expect(await sealedHashMatches(v.circle_id, v.key_id, "wrong", plain, v.keyed)).toBe(false);
    expect(await sealedHashMatches(v.circle_id, v.key_id, v.passphrase, text("x"), v.keyed)).toBe(
      false,
    );
  });

  it("refuses a lone surrogate like the reference", async () => {
    expect(() => sealedDigestSalt(CIRCLE, "\ud800")).toThrow("Invalid sealed text");
    await expect(sealedDigest(CIRCLE, "default", "\udc00", text("a"))).rejects.toThrow(
      "Invalid sealed text",
    );
  });
});

describe("reading sealed assets", () => {
  it("opens what the reference wrote, keyed or plain hash, padded or not", async () => {
    expect(vectors.envelopes.map((e) => e.digest_mode)).toEqual(
      expect.arrayContaining(["keyed", "compatible"]),
    );
    for (const e of vectors.envelopes) {
      const plain = await openSealedAsset(e.circle_id, e, e.passphrase);
      expect(Array.from(plain)).toEqual(Array.from(bytesFromB64(e.plaintext_b64)));
    }
  });

  it("opens an asset whose hash used the unescaped salt", async () => {
    const d = vectors.digests.find((v) => v.keyed_unescaped_salt)!;
    const sealed = await sealBytes(
      d.circle_id,
      d.key_id,
      d.passphrase,
      bytesFromB64(d.plaintext_b64),
    );
    const asset = { ...sealed, key_id: d.key_id, plaintext_hash: d.keyed_unescaped_salt! };
    expect(await openSealedAsset(d.circle_id, asset, d.passphrase)).toHaveLength(
      bytesFromB64(d.plaintext_b64).length,
    );
  });

  it("refuses a wrong, malformed or missing hash and a missing key id", async () => {
    const e = vectors.envelopes[0];
    const open = (patch: Record<string, unknown>) =>
      openSealedAsset(e.circle_id, { ...e, ...patch }, e.passphrase);
    await expect(open({ plaintext_hash: "0".repeat(64) })).rejects.toThrow(
      "Sealed content failed integrity check",
    );
    await expect(open({ plaintext_hash: undefined })).rejects.toThrow("metadata incomplete");
    await expect(open({ plaintext_hash: "" })).rejects.toThrow("metadata incomplete");
    await expect(open({ plaintext_hash: e.plaintext_hash.toUpperCase() })).rejects.toThrow();
    await expect(open({ key_id: undefined })).rejects.toThrow("metadata incomplete");
    await expect(open({ ciphertext_b64: undefined })).rejects.toThrow("Sealed asset not found");
    await expect(open({ ciphertext_b64: btoa("OCRS1short") })).rejects.toThrow(
      "Invalid sealed envelope",
    );
    await expect(open({ ciphertext_b64: btoa("X".repeat(64)) })).rejects.toThrow(
      "Invalid sealed envelope",
    );
  });

  it("fails on a wrong passphrase and takes the right one afterwards", async () => {
    const e = vectors.envelopes[0];
    await expect(openSealedAsset(e.circle_id, e, "wrong")).rejects.toThrow();
    expect(await openSealedAsset(e.circle_id, e, e.passphrase)).toBeInstanceOf(Uint8Array);
  });
});

describe("writing sealed assets", () => {
  it("publishes the keyed digest, never a plain fingerprint", async () => {
    for (const body of [new Uint8Array(0), text("<h1>hi</h1>"), text("日本語 😀")]) {
      const sealed = await sealBytes(CIRCLE, "default", PASS, body);
      expect(sealed.plaintext_hash).toBe(await sealedDigest(CIRCLE, "default", PASS, body));
      expect(sealed.plaintext_hash).not.toBe(await sha256(body));
      const back = await openSealedAsset(CIRCLE, { ...sealed, key_id: "default" }, PASS);
      expect(Array.from(back)).toEqual(Array.from(body));
    }
  });

  it("matches the reference digest for the same input", async () => {
    const v = vectors.digests.find((x) => x.name === "non-ascii")!;
    const sealed = await sealBytes(
      v.circle_id,
      v.key_id,
      v.passphrase,
      bytesFromB64(v.plaintext_b64),
    );
    expect(sealed.plaintext_hash).toBe(v.keyed);
  });

  it("seals a large file without overflowing the stack", async () => {
    const body = new Uint8Array(3 * 1024 * 1024).fill(7);
    const sealed = await sealBytes(CIRCLE, "default", PASS, body);
    const back = await openSealedAsset(CIRCLE, { ...sealed, key_id: "default" }, PASS);
    expect(back.length).toBe(body.length);
    expect(back[back.length - 1]).toBe(7);
  });
});
