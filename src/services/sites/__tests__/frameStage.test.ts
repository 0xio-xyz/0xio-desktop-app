import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));

const ORIGIN = "http://127.0.0.1:49731";
const url = (n: number) => `${ORIGIN}/${n.toString(16).padStart(64, "e")}`;

async function load() {
  vi.resetModules();
  return import("src/services/sites/frameStage");
}

beforeEach(() => {
  m.invoke.mockReset();
});

describe("frame staging", () => {
  it("returns the listener's URL untouched for documents and assets", async () => {
    const stage = await load();
    m.invoke.mockResolvedValueOnce(url(1)).mockResolvedValueOnce(url(2));
    expect(await stage.stageFrameDocument("<p>", "page")).toBe(url(1));
    expect(m.invoke).toHaveBeenLastCalledWith("stage_frame_document", {
      html: "<p>",
      kind: "page",
      connect: null,
    });
    expect(await stage.stageFrameAsset("AAAA", "image/png")).toBe(url(2));
    expect(m.invoke).toHaveBeenLastCalledWith("stage_frame_asset", {
      base64: "AAAA",
      contentType: "image/png",
    });
  });

  it("re-serves a data: URL's payload, base64 or percent-encoded", async () => {
    const stage = await load();
    m.invoke.mockResolvedValue(url(3));
    await stage.stageDataUrl("data:image/png;base64,QUJD");
    expect(m.invoke).toHaveBeenLastCalledWith("stage_frame_asset", {
      base64: "QUJD",
      contentType: "image/png",
    });
    await stage.stageDataUrl("data:text/plain,a%20b");
    expect(m.invoke).toHaveBeenLastCalledWith("stage_frame_asset", {
      base64: btoa("a b"),
      contentType: "text/plain",
    });
  });

  it("knows every URL at the staged origin and nothing else", async () => {
    const stage = await load();
    expect(stage.isStagedFrameUrl(url(4))).toBe(false);
    m.invoke.mockResolvedValue(url(4));
    await stage.stageFrameDocument("<p>", "nft");
    for (const ours of [url(4), `${url(4)}?seed=1`, url(9), `${ORIGIN}/`]) {
      expect(stage.isStagedFrameUrl(ours), ours).toBe(true);
    }
    for (const other of [
      "http://127.0.0.1:1420/",
      "http://127.0.0.1/",
      "http://localhost:49731/",
      "https://127.0.0.1:49731/",
      "http://127.0.0.1:49731.example/",
      "https://dapp.example/?next=http://127.0.0.1:49731/",
      `oxioframe://localhost/${"e".repeat(64)}`,
      "http://oxioframe.localhost/abc",
      "oct://circle/index.html",
      "",
      "not a url",
    ]) {
      expect(stage.isStagedFrameUrl(other), other).toBe(false);
    }
  });

  it("passes a refusal on instead of a URL", async () => {
    const stage = await load();
    m.invoke.mockRejectedValue("Framed content is unavailable");
    await expect(stage.stageFrameDocument("<p>", "page")).rejects.toBe(
      "Framed content is unavailable",
    );
  });
});
