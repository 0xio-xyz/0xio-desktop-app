// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";

const ORIGIN = "http://127.0.0.1:49731";
const SANDBOXED = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
const CIRCLE = `oct${"C".repeat(44)}`;

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  info: vi.fn(),
  asset: vi.fn(),
  sealed: vi.fn(),
  open: vi.fn(),
  staged: [] as { cmd: string; args: Record<string, unknown>; url: string }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    networkId: "mainnet",
    setNetworkId: vi.fn(),
    activeWallet: { id: "w1", address: `oct${"A".repeat(44)}` },
  }),
}));
vi.mock("src/features/dapp/hooks/useDappBridge", () => ({
  useDappBridge: () => ({
    pendingApproval: null,
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
    signalWalletReady: vi.fn(),
    auth: null,
  }),
}));
vi.mock("src/features/dapp/hooks/useDappSites", () => ({ useDappSites: () => [] }));
vi.mock("src/features/dapp/services/ecosystemService", () => ({ getDApps: async () => [] }));
vi.mock("src/features/dapp/components/SiteChip", () => ({ default: () => null }));
vi.mock("src/features/dapp/components/DappApprovalModal", () => ({ default: () => null }));
vi.mock("src/features/dapp/components/BrowserSettingsPopup", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/features/dapp/services/walletProviderScript", () => ({
  getDesktopProviderScript: () => "/*provider*/",
}));
vi.mock("src/features/dapp/services/circleBridgeService", () => ({
  createBridgeContext: (circle_id: string, path: string) => ({
    circle_id,
    path,
    bridge_token: "t",
  }),
  getCircleBridgePrelude: () => "/*prelude*/",
  handleBridgeMethod: vi.fn(),
  BRIDGE_NEEDS_APPROVAL: "__bridge_needs_approval__",
}));
vi.mock("src/features/dapp/services/circleRead", () => ({
  circleRpc: vi.fn(),
  fetchCircleInfo: m.info,
  fetchSealedAsset: m.sealed,
}));
vi.mock("src/features/circles/services/circleSealed", () => ({ openSealedAsset: m.open }));
vi.mock("src/features/circles/services/circleAsset", async (original) => ({
  ...(await original<typeof import("src/features/circles/services/circleAsset")>()),
  resolveCircleAsset: m.asset,
}));

import "src/i18n";
import BrowserScreen from "src/features/dapp/screens/BrowserScreen";

const bytes = (text: string) => new TextEncoder().encode(text);
const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const calls = (cmd: string) => m.invoke.mock.calls.filter((c) => c[0] === cmd);

function show(address: string) {
  window.location.hash = `#/browser?url=${encodeURIComponent(address)}`;
  return render(
    <MemoryRouter>
      <BrowserScreen />
    </MemoryRouter>,
  );
}

async function staged(count = 1) {
  await waitFor(() => expect(m.staged.length).toBe(count));
  const last = m.staged[count - 1];
  await waitFor(() => expect(frame()?.getAttribute("src")).toBe(last.url));
  return last;
}

beforeEach(() => {
  localStorage.clear();
  m.staged.length = 0;
  m.invoke.mockReset();
  m.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "stage_frame_document" && cmd !== "stage_frame_asset") return undefined;
    const id = (m.staged.length + 1).toString(16).padStart(64, "a");
    const url = `${ORIGIN}/${id}`;
    m.staged.push({ cmd, args, url });
    return url;
  });
  m.info.mockReset().mockResolvedValue({ resource_mode: "public" });
  m.asset.mockReset().mockResolvedValue({
    bytes: bytes("<html><head></head><body>hi</body></html>"),
    contentType: "text/html",
  });
  m.sealed.mockReset();
  m.open.mockReset();
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("browser frames", () => {
  it("frames a circle page from the loopback listener, sandboxed with no origin of its own", async () => {
    show(`oct://${CIRCLE}/index.html`);
    const doc = await staged();
    expect(doc.cmd).toBe("stage_frame_document");
    expect(doc.args.kind).toBe("page");
    expect(String(doc.args.html)).toContain("/*provider*/");
    expect(doc.url.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(frame()!.getAttribute("sandbox")).toBe(SANDBOXED);
  });

  it("frames a circle file that is not a page as an asset", async () => {
    m.asset.mockResolvedValue({ bytes: bytes("plain"), contentType: "text/plain" });
    show(`oct://${CIRCLE}/notes.txt`);
    const doc = await staged();
    expect(doc.cmd).toBe("stage_frame_asset");
    expect(doc.args).toEqual({ base64: btoa("plain"), contentType: "text/plain" });
    expect(frame()!.getAttribute("sandbox")).toBe(SANDBOXED);
  });

  it("frames a sealed circle the same way once its passphrase opens it", async () => {
    m.info.mockResolvedValue({ resource_mode: "sealed_read" });
    m.sealed.mockResolvedValue({ content_type: "text/html" });
    m.open.mockResolvedValue(bytes("<html><head></head><body>sealed</body></html>"));
    show(`oct://${CIRCLE}/index.html`);
    const field = await screen.findByLabelText("Passphrase", { exact: false });
    expect(m.staged.length).toBe(0);
    fireEvent.change(field, { target: { value: "open sesame" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const doc = await staged();
    expect(m.open).toHaveBeenCalledWith(CIRCLE, { content_type: "text/html" }, "open sesame");
    expect(doc.args.kind).toBe("page");
    expect(String(doc.args.html)).toContain("sealed");
    expect(frame()!.getAttribute("sandbox")).toBe(SANDBOXED);
  });

  it("opens the page in a window as its circle, and never hands the staged URL to the system", async () => {
    show(`oct://${CIRCLE}/index.html`);
    const doc = await staged();
    fireEvent.click(screen.getByLabelText("Open in a window"));
    await waitFor(() => expect(calls("dapp_open_window").length).toBe(1));
    expect(calls("dapp_open_window")[0][1]).toEqual({ url: doc.url, site: `oct://${CIRCLE}` });

    fireEvent.click(screen.getByLabelText("System browser"));
    fireEvent.click(screen.getByLabelText("Add bookmark"));
    expect(calls("plugin:shell|open")).toEqual([]);
    const saved = localStorage.getItem("0xio_browser_bookmarks") ?? "";
    expect(saved).toContain(`oct://${CIRCLE}/index.html`);
    expect(saved + (localStorage.getItem("0xio_browser_history") ?? "")).not.toContain("127.0.0.1");
  });

  it("keeps a web page's own origin, and never one at the staged origin", async () => {
    show("https://dapp.example/");
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe("https://dapp.example/"));
    expect(frame()!.getAttribute("sandbox")).toContain("allow-same-origin");
    cleanup();

    show(`oct://${CIRCLE}/index.html`);
    const doc = await staged();
    cleanup();

    show(`${ORIGIN}/${"b".repeat(64)}`);
    await waitFor(() => expect(frame()?.getAttribute("src")).toContain(ORIGIN));
    expect(frame()!.getAttribute("sandbox")).toBe(SANDBOXED);
    expect(doc.url).not.toBe(frame()!.getAttribute("src"));
  });
});
