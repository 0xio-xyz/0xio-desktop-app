// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const ORIGIN = "http://127.0.0.1:49731";
const CIRCLE = `oct${"R".repeat(44)}`;

const m = vi.hoisted(() => ({ invoke: vi.fn(), asset: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCallOn: vi.fn(),
  rpcUrlFor: () => "https://devnet.octrascan.io",
}));
vi.mock("src/features/nft/services/euint/bridge", () => ({ handleLivingBridgeRequest: vi.fn() }));
vi.mock("src/features/circles/services/circleAsset", async (original) => ({
  ...(await original<typeof import("src/features/circles/services/circleAsset")>()),
  resolveCircleAsset: m.asset,
}));

import { LivingNftFrame } from "src/features/nft/services/euint/LivingNftFrame";
import { isStagedFrameUrl } from "src/services/sites/frameStage";

const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const staged = () => m.invoke.mock.calls.filter((c) => c[0] === "stage_frame_document");

beforeEach(() => {
  let n = 0;
  m.invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd !== "stage_frame_document") return undefined;
    n += 1;
    return `${ORIGIN}/${n.toString(16).padStart(64, "c")}`;
  });
  m.asset.mockReset().mockResolvedValue({
    bytes: new TextEncoder().encode("<html><head></head><body>art</body></html>"),
    contentType: "text/html",
  });
});
afterEach(cleanup);

describe("living NFT frame", () => {
  it("frames an offline program from the loopback listener with its query, scripts only", async () => {
    render(<LivingNftFrame uri={`oct://${CIRCLE}/index.html?seed=ab12`} networkId="devnet" />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(staged().length).toBe(1);
    expect(staged()[0][1]).toMatchObject({ kind: "nft", connect: null });
    const src = frame()!.getAttribute("src")!;
    expect(src).toBe(`${ORIGIN}/${"1".padStart(64, "c")}?seed=ab12`);
    expect(isStagedFrameUrl(src)).toBe(true);
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame()!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("stages a chain-state program with its network endpoint and keeps the whole query", async () => {
    const query = "?seed=ab&contract=octX&token=7&st=1,2:3";
    render(<LivingNftFrame uri={`oct://${CIRCLE}/live.html${query}`} networkId="devnet" />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(staged()[0][1]).toMatchObject({
      kind: "chain",
      connect: "https://devnet.octrascan.io/rpc",
    });
    const src = frame()!.getAttribute("src")!;
    expect(src.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(src.slice(src.indexOf("?"))).toBe(
      `${query}&rpc=${encodeURIComponent("https://devnet.octrascan.io/rpc")}`,
    );
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("takes a poster only from its own frame", async () => {
    const onSnapshot = vi.fn();
    render(
      <LivingNftFrame
        uri={`oct://${CIRCLE}/poster.html?seed=cd`}
        networkId="devnet"
        onSnapshot={onSnapshot}
      />,
    );
    await waitFor(() => expect(frame()).not.toBeNull());
    const data = { source: "octra-living", type: "snapshot", dataUrl: "data:image/webp;base64,AA" };
    window.dispatchEvent(new MessageEvent("message", { data, source: window, origin: "null" }));
    expect(onSnapshot).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", { data, source: frame()!.contentWindow, origin: "null" }),
    );
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith("data:image/webp;base64,AA"));
  });
});
