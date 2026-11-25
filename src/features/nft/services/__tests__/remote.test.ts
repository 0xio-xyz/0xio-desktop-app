import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { WINDOW_HOSTS, appFetch, readByApp } from "src/features/nft/services/remote";

const policy = (
  JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    app: { security: { csp: string } };
  }
).app.security.csp;

const hosts = (directive: string) =>
  (policy.split(";").find((part) => part.trim().startsWith(`${directive} `)) ?? "")
    .trim()
    .split(/\s+/)
    .filter((source) => source.startsWith("https://"))
    .map((source) => source.slice("https://".length));

describe("what the page loads itself and what the app reads", () => {
  it("lists exactly the https hosts the window policy allows for both images and requests", () => {
    const images = hosts("img-src");
    const both = images.filter((host) => hosts("connect-src").includes(host));
    expect(images.length).toBeGreaterThan(0);
    expect([...WINDOW_HOSTS].sort()).toEqual(both.sort());
    expect(policy).not.toMatch(/(img|connect)-src[^;]*\shttps:(\s|;|$)/);
  });

  it("leaves the hosts of the window policy to the page", () => {
    for (const address of [
      "https://cdn.jsdelivr.net/gh/a/b.png",
      "https://gateway.pinata.cloud/ipfs/Qm",
      "https://dweb.link/ipfs/Qm",
      "https://bafy.ipfs.io/a.png",
      "data:image/png;base64,AAAA",
      "oct://circle/a.png",
      "ipfs://Qm",
      "http://names.example/a.png",
      "<svg/>",
      "",
    ])
      expect(readByApp(address), address).toBe(false);
  });

  it("hands every other https address to the app", () => {
    for (const address of [
      "https://names.example/meta/0.json",
      "https://ipfs.io/ipfs/Qm",
      "https://evil-ipfs.io/a.png",
      "https://dweb.link.example/a.png",
      "https://cdn.jsdelivr.net:8443/a.png",
      "https://127.0.0.1/a.png",
    ])
      expect(readByApp(address), address).toBe(true);
  });

  it("asks the app with the address and the kind, and nothing else", async () => {
    invoke.mockResolvedValue("{}");
    expect(await appFetch("https://names.example/meta/0.json", "metadata")).toBe("{}");
    expect(invoke.mock.calls).toEqual([
      ["nft_fetch", { url: "https://names.example/meta/0.json", kind: "metadata" }],
    ]);
  });
});

describe("a host that fails now and then", () => {
  it("asks once more after a not found or a server error, and returns the second answer", async () => {
    vi.useFakeTimers();
    for (const first of ["HTTP 404", "HTTP 503", "HTTP 429"]) {
      invoke.mockReset().mockRejectedValueOnce(first).mockResolvedValueOnce("{}");
      const read = appFetch("https://names.example/meta/0.json", "metadata");
      await vi.advanceTimersByTimeAsync(1200);
      expect(await read).toBe("{}");
      expect(invoke).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });

  it("does not ask again after a refusal, and gives up after the second failure", async () => {
    vi.useFakeTimers();
    for (const refusal of ["Too large", "Address not allowed", "Timed out", "HTTP 403"]) {
      invoke.mockReset().mockRejectedValueOnce(refusal);
      await expect(appFetch("https://names.example/a.png", "image")).rejects.toBe(refusal);
      expect(invoke).toHaveBeenCalledTimes(1);
    }
    invoke.mockReset().mockRejectedValue("HTTP 404");
    const read = appFetch("https://names.example/a.png", "image");
    const settled = expect(read).rejects.toBe("HTTP 404");
    await vi.advanceTimersByTimeAsync(1200);
    await settled;
    expect(invoke).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
