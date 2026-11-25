import { describe, expect, it } from "vitest";
import {
  CIRCLE_CHUNK_FORMAT,
  CIRCLE_CHUNK_MANIFEST_TYPE,
  MAX_CIRCLE_ASSET_B64,
  bytesToB64,
  resolveCircleAsset,
  resolveCircleAssetReply,
  type CircleAssetReply,
} from "src/features/circles/services/circleAsset";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b))), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");

type Files = Record<string, Exclude<CircleAssetReply, null>>;

async function chunked(body: Uint8Array, parts: Uint8Array[], edit?: (m: any) => void) {
  const digest = await hex(body);
  const chunks = await Promise.all(
    parts.map(async (p, i) => ({
      path: `/.octra/chunks/${digest}/${String(i).padStart(4, "0")}`,
      sha256: await hex(p),
      size_bytes: String(p.length),
    })),
  );
  const manifest = {
    format: CIRCLE_CHUNK_FORMAT,
    content_type: "text/html",
    encoding: "identity",
    sha256: digest,
    size_bytes: String(body.length),
    chunks,
  };
  edit?.(manifest);
  const files: Files = {
    "/index.html": {
      content_type: CIRCLE_CHUNK_MANIFEST_TYPE,
      body_b64: bytesToB64(utf8(JSON.stringify(manifest))),
    },
  };
  chunks.forEach((c, i) => {
    files[c.path] = { content_type: "application/octet-stream", body_b64: bytesToB64(parts[i]) };
  });
  return files;
}

const reader = (files: Files) => async (p: string) => files[p] ?? null;

describe("resolveCircleAsset", () => {
  it("reads a plain file from body_b64", async () => {
    const out = await resolveCircleAsset(
      async () => ({ content_type: "text/html", body_b64: bytesToB64(utf8("<p>héllo</p>")) }),
      "/index.html",
    );
    expect(out?.contentType).toBe("text/html");
    expect(out?.chunked).toBeUndefined();
    expect(new TextDecoder().decode(out!.bytes)).toBe("<p>héllo</p>");
  });

  it("falls back to data_base64 from older nodes", async () => {
    const out = await resolveCircleAsset(
      async () => ({ content_type: "text/plain", data_base64: bytesToB64(utf8("hi")) }),
      "/a.txt",
    );
    expect(new TextDecoder().decode(out!.bytes)).toBe("hi");
  });

  it("refuses a plain file over 32 MiB", async () => {
    await expect(
      resolveCircleAsset(
        async () => ({ content_type: "image/png", body_b64: "A".repeat(MAX_CIRCLE_ASSET_B64 + 4) }),
        "/big.png",
      ),
    ).rejects.toThrow("Circle asset too large");
  });

  it("assembles and checks a chunked file in order", async () => {
    const body = utf8("<html>" + "x".repeat(50) + "</html>");
    const files = await chunked(body, [
      body.subarray(0, 20),
      body.subarray(20, 40),
      body.subarray(40),
    ]);
    const seen: string[] = [];
    const out = await resolveCircleAsset(async (p) => {
      seen.push(p);
      return files[p] ?? null;
    }, "/index.html");
    expect(out?.contentType).toBe("text/html");
    expect(await hex(out!.bytes)).toBe(await hex(body));
    expect(out?.chunked).toEqual({ count: 3, sha256: await hex(body) });
    expect(seen.slice(1).map((p) => p.slice(-4))).toEqual(["0000", "0001", "0002"]);
  });

  it("refuses a chunk that does not match its hash", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body.subarray(0, 5), body.subarray(5)]);
    const second = Object.keys(files)[2];
    files[second] = {
      content_type: "application/octet-stream",
      body_b64: bytesToB64(utf8("zzzzz")),
    };
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Circle chunk verification failed",
    );
  });

  it("refuses a chunk with a non-canonical encoding", async () => {
    const body = utf8("abcd");
    const files = await chunked(body, [body]);
    const path = Object.keys(files)[1];
    files[path] = { content_type: "application/octet-stream", body_b64: "YWJjZA" };
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Circle chunk verification failed",
    );
  });

  it("refuses a chunk served with the wrong content type", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body]);
    const path = Object.keys(files)[1];
    files[path] = { ...files[path], content_type: "text/html" };
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Circle chunk unavailable",
    );
  });

  it("refuses a chunk path outside the manifest prefix", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body], (m) => {
      m.chunks[0].path = "/secret.html";
    });
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Invalid circle chunk entry",
    );
  });

  it("refuses chunks listed out of order", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body.subarray(0, 5), body.subarray(5)], (m) => {
      m.chunks.reverse();
    });
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Invalid circle chunk entry",
    );
  });

  it("refuses chunks that overrun the declared size", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body.subarray(0, 5), body.subarray(5)], (m) => {
      m.size_bytes = "7";
    });
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Invalid circle chunk entry",
    );
  });

  it("refuses a whole-file hash mismatch", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body], (m) => {
      const fake = "0".repeat(64);
      m.chunks[0].path = m.chunks[0].path.replace(m.sha256, fake);
      m.sha256 = fake;
    });
    const path = Object.keys(files)[1];
    expect(path).toContain("0".repeat(64));
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Circle asset verification failed",
    );
  });

  it.each([
    ["an unknown format", (m: any) => (m.format = "v2")],
    ["a non identity encoding", (m: any) => (m.encoding = "gzip")],
    ["a numeric size", (m: any) => (m.size_bytes = 10)],
    ["a size over 32 MiB", (m: any) => (m.size_bytes = "33554433")],
    ["an uppercase hash", (m: any) => (m.sha256 = m.sha256.toUpperCase())],
    ["a control character in the type", (m: any) => (m.content_type = "text/html\n")],
    ["no chunks", (m: any) => (m.chunks = [])],
    ["more than 32 chunks", (m: any) => (m.chunks = Array(33).fill(m.chunks[0]))],
  ])("refuses a manifest with %s", async (_label, edit) => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body], edit);
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Invalid circle chunk manifest",
    );
  });

  it("refuses a manifest that is not JSON", async () => {
    const files: Files = {
      "/index.html": { content_type: CIRCLE_CHUNK_MANIFEST_TYPE, body_b64: bytesToB64(utf8("{")) },
    };
    await expect(resolveCircleAsset(reader(files), "/index.html")).rejects.toThrow(
      "Invalid circle chunk manifest",
    );
  });

  it("returns null when the file is missing", async () => {
    expect(await resolveCircleAsset(async () => null, "/index.html")).toBeNull();
  });
});

describe("resolveCircleAssetReply", () => {
  it("passes a plain reply through untouched", async () => {
    const reply = { content_type: "text/plain", body_b64: bytesToB64(utf8("hi")), extra: 1 };
    expect(await resolveCircleAssetReply(async () => reply, "/a.txt")).toBe(reply);
  });

  it("answers a chunked file with the assembled body", async () => {
    const body = utf8("abcdefghij");
    const files = await chunked(body, [body.subarray(0, 4), body.subarray(4)]);
    const out = await resolveCircleAssetReply(reader(files), "/index.html");
    expect(out).toMatchObject({
      content_type: "text/html",
      encoding: "identity",
      size_bytes: "10",
      blob_hash: await hex(body),
      body_b64: bytesToB64(body),
      chunked: true,
      chunks: 2,
    });
  });
});
