import { describe, it, expect } from "vitest";
import {
  assertUploadSize,
  canonicalAssetPath,
  CIRCLE_ASSET_MAX_RAW,
  CIRCLE_DIRECT_MAX_RAW,
  circleContentType,
  prepareCircleUpload,
  uploadAssetPath,
} from "src/features/circles/services/circleUpload";
import { bytesFromB64, MAX_CIRCLE_ASSET_B64 } from "src/features/circles/services/circleAsset";
import { openSealedAsset, sealedDigest } from "src/features/circles/services/circleSealed";
import vectors from "src/test/fixtures/circle-asset-path-vectors.json";

const CIRCLE = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const text = (s: string) => new TextEncoder().encode(s);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("circle asset path against the reference vectors", () => {
  it("canonicalises or refuses every vector the way the reference does", () => {
    expect(vectors.vectors.length).toBeGreaterThan(50);
    for (const v of vectors.vectors as { input: string; path?: string; error?: string }[]) {
      if (v.error === undefined) {
        expect(canonicalAssetPath(v.input), JSON.stringify(v.input)).toBe(v.path);
      } else {
        let message = "";
        try {
          canonicalAssetPath(v.input);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(lowerFirst(message), JSON.stringify(v.input)).toBe(v.error);
      }
    }
  });

  it("covers each refusal the reference has", () => {
    const errors = new Set(vectors.vectors.map((v) => (v as { error?: string }).error));
    for (const e of [
      "invalid percent escape",
      "path is not valid utf-8",
      "path traversal is not allowed",
      "path exceeds max length",
    ])
      expect(errors.has(e)).toBe(true);
  });

  it("gives an upload a real file path outside the chunk store", () => {
    expect(uploadAssetPath("")).toBe("/index.html");
    expect(uploadAssetPath("   ")).toBe("/index.html");
    expect(uploadAssetPath(" app.js ")).toBe("/app.js");
    expect(uploadAssetPath("/a/./b//c.css")).toBe("/a/b/c.css");
    expect(uploadAssetPath("/my%20file.png")).toBe("/my file.png");
    expect(() => uploadAssetPath("/")).toThrow("Invalid circle asset path");
    expect(() => uploadAssetPath("/./")).toThrow("Invalid circle asset path");
    expect(() => uploadAssetPath("/a/../b")).toThrow("Path traversal is not allowed");
    expect(() => uploadAssetPath("/%2e%2e/x")).toThrow("Path traversal is not allowed");
    expect(() => uploadAssetPath("/.octra/chunks/ab/0000")).toThrow("reserved");
    expect(() => uploadAssetPath(".octra/x")).toThrow("reserved");
    expect(() => uploadAssetPath("/%2Eoctra/x")).toThrow("reserved");
    expect(uploadAssetPath("/.octrax/y")).toBe("/.octrax/y");
    expect(() => uploadAssetPath("/" + "a".repeat(1024))).toThrow("Path exceeds max length");
  });
});

describe("content type", () => {
  it("keeps the system type and guesses by name like the reference upload", () => {
    expect(circleContentType("index.html", "text/html")).toBe("text/html");
    expect(circleContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(circleContentType("STYLE.CSS", "")).toBe("text/css; charset=utf-8");
    expect(circleContentType("app.js")).toBe("application/javascript; charset=utf-8");
    expect(circleContentType("data.json")).toBe("application/json; charset=utf-8");
    expect(circleContentType("pic.webp")).toBe("image/webp");
    expect(circleContentType("pic.svg")).toBe("image/svg+xml");
    expect(circleContentType("pic.png")).toBe("image/png");
    expect(circleContentType("blob")).toBe("application/octet-stream");
    expect(circleContentType("x.unknown")).toBe("application/octet-stream");
  });
});

describe("upload limits", () => {
  it("refuses over 32 MiB, and a public file over the single-transaction limit", () => {
    expect(CIRCLE_ASSET_MAX_RAW).toBe(33554432);
    expect(CIRCLE_DIRECT_MAX_RAW).toBe(2097152);
    expect(MAX_CIRCLE_ASSET_B64).toBe(44739244);
    expect(() => assertUploadSize(CIRCLE_ASSET_MAX_RAW + 1, true)).toThrow("32 MiB");
    expect(() => assertUploadSize(CIRCLE_ASSET_MAX_RAW + 1, false)).toThrow("32 MiB");
    expect(() => assertUploadSize(CIRCLE_DIRECT_MAX_RAW + 1, false)).toThrow("over 2 MiB");
    expect(() => assertUploadSize(0, false)).toThrow("File is empty");
    expect(() => assertUploadSize(CIRCLE_DIRECT_MAX_RAW, false)).not.toThrow();
    expect(() => assertUploadSize(CIRCLE_DIRECT_MAX_RAW + 1, true)).not.toThrow();
    expect(() => assertUploadSize(0, true)).not.toThrow();
  });

  it("refuses before any encoding", async () => {
    const base = { circleId: CIRCLE, path: "/a.bin", contentType: "x/y", passphrase: "p" };
    await expect(
      prepareCircleUpload({
        ...base,
        bytes: new Uint8Array(CIRCLE_DIRECT_MAX_RAW + 1),
        sealed: false,
      }),
    ).rejects.toThrow("over 2 MiB");
    await expect(
      prepareCircleUpload({ ...base, bytes: text("x"), sealed: true, passphrase: "" }),
    ).rejects.toThrow("Passphrase required");
    await expect(
      prepareCircleUpload({ ...base, path: "/../x", bytes: text("x"), sealed: false }),
    ).rejects.toThrow("Path traversal is not allowed");
  });
});

describe("what an upload signs", () => {
  it("public: the file as base64 and the canonical path, at the full 2 MiB", async () => {
    const bytes = new Uint8Array(CIRCLE_DIRECT_MAX_RAW);
    for (let i = 0; i < bytes.length; i += 4099) bytes[i] = i & 0xff;
    const up = await prepareCircleUpload({
      circleId: CIRCLE,
      path: "assets//./big.bin",
      bytes,
      contentType: "application/octet-stream",
      sealed: false,
      passphrase: "",
    });
    expect(up.opType).toBe("circle_asset_put");
    expect(up.path).toBe("/assets/big.bin");
    expect(up.message).toBe('{"path":"/assets/big.bin","content_type":"application/octet-stream"}');
    expect(up.encData.length).toBe(Math.ceil(bytes.length / 3) * 4);
    const back = bytesFromB64(up.encData);
    expect(back.length).toBe(bytes.length);
    expect(back[4099 * 3]).toBe(bytes[4099 * 3]);
  });

  it("sealed: the envelope and the keyed digest under key id default", async () => {
    const bytes = text("<!doctype html><p>héllo</p>");
    const up = await prepareCircleUpload({
      circleId: CIRCLE,
      path: "/page.html",
      bytes,
      contentType: "text/html; charset=utf-8",
      sealed: true,
      passphrase: "pass",
    });
    expect(up.opType).toBe("circle_asset_put_encrypted");
    const message = JSON.parse(up.message);
    expect(Object.keys(message)).toEqual([
      "path",
      "content_type",
      "key_id",
      "plaintext_hash",
      "encoding",
    ]);
    expect(message).toMatchObject({
      path: "/page.html",
      content_type: "text/html; charset=utf-8",
      key_id: "default",
      encoding: "identity",
    });
    expect(message.plaintext_hash).toBe(await sealedDigest(CIRCLE, "default", "pass", bytes));
    const back = await openSealedAsset(
      CIRCLE,
      {
        ciphertext_b64: up.encData,
        key_id: message.key_id,
        plaintext_hash: message.plaintext_hash,
      },
      "pass",
    );
    expect(new TextDecoder().decode(back)).toBe("<!doctype html><p>héllo</p>");
  });

  it("keeps a non-ASCII path whole in the message", async () => {
    const up = await prepareCircleUpload({
      circleId: CIRCLE,
      path: "/caf%C3%A9/日本語.html",
      bytes: text("x"),
      contentType: "text/html",
      sealed: false,
      passphrase: "",
    });
    expect(JSON.parse(up.message).path).toBe("/café/日本語.html");
  });
});

describe("the checks a batch row runs without the file's bytes", () => {
  it("returns the canonical path and refuses what the upload itself would refuse", async () => {
    const { checkCircleUpload } = await import("src/features/circles/services/circleUpload");
    const row = { path: " site//./a%20b.html ", size: 10, contentType: "text/html", sealed: false };
    expect(checkCircleUpload(row)).toBe("/site/a b.html");
    expect(() => checkCircleUpload({ ...row, size: 33554433 })).toThrow("32 MiB");
    expect(() => checkCircleUpload({ ...row, size: 2097153 })).toThrow("2 MiB");
    expect(checkCircleUpload({ ...row, size: 2097153, sealed: true })).toBe("/site/a b.html");
    expect(() => checkCircleUpload({ ...row, path: "/a/../b" })).toThrow("traversal");
    expect(() => checkCircleUpload({ ...row, path: "/.octra/x" })).toThrow("reserved");
    expect(() => checkCircleUpload({ ...row, contentType: "x".repeat(9000) })).toThrow(
      "Upload details are too long",
    );
  });
});
