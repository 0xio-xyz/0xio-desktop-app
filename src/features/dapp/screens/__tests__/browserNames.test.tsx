// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";

const ORIGIN = "http://127.0.0.1:49731";
const CIRCLE = `oct${"C".repeat(44)}`;
const MOVED = `oct${"D".repeat(44)}`;
const OTHER = `oct${"E".repeat(44)}`;
const BAR = "Search or enter an address, or an oct:// circle";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  info: vi.fn(),
  asset: vi.fn(),
  sealed: vi.fn(),
  open: vi.fn(),
  name: vi.fn(),
  context: vi.fn(),
  network: { id: "devnet" },
  bridge: { pageOrigin: null as null | (() => string | null) },
  staged: [] as { cmd: string; args: Record<string, unknown>; url: string }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    networkId: m.network.id,
    setNetworkId: vi.fn(),
    activeWallet: { id: "w1", address: `oct${"A".repeat(44)}` },
  }),
}));
vi.mock("src/features/dapp/hooks/useDappBridge", () => ({
  useDappBridge: (_frame: unknown, options: { pageOrigin: () => string | null }) => {
    m.bridge.pageOrigin = options.pageOrigin;
    return {
      pendingApproval: null,
      approveRequest: vi.fn(),
      rejectRequest: vi.fn(),
      signalWalletReady: vi.fn(),
      auth: null,
    };
  },
}));
vi.mock("src/features/dapp/hooks/useDappSites", () => ({ useDappSites: () => [] }));
vi.mock("src/features/dapp/services/ecosystemService", () => ({ getDApps: async () => [] }));
vi.mock("src/features/dapp/components/SiteChip", () => ({
  default: ({ origin }: { origin: string | null }) => <span data-testid="chip">{origin}</span>,
}));
vi.mock("src/features/dapp/components/DappApprovalModal", () => ({ default: () => null }));
vi.mock("src/features/dapp/components/BrowserSettingsPopup", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/features/dapp/services/walletProviderScript", () => ({
  getDesktopProviderScript: () => "/*provider*/",
}));
vi.mock("src/features/dapp/services/circleBridgeService", () => ({
  createBridgeContext: m.context,
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
vi.mock("src/services/names/onsService", () => ({ openCircle: m.name }));

import "src/i18n";
import BrowserScreen from "src/features/dapp/screens/BrowserScreen";
import { cutId } from "src/features/circles/services/circleFormat";

const bytes = (text: string) => new TextEncoder().encode(text);
const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const bar = () => screen.getByLabelText(BAR) as HTMLInputElement;
const tag = () => screen.queryByTestId("circle-tag");
const points = (circleId: string) => ({ ok: true, name: "0xio", circleId, contract: "c" });
const refused = (reason: string) => ({ ok: false, reason });
const loaded = () => m.info.mock.calls.map((c) => c[1]);
const paths = () => m.asset.mock.calls.map((c) => c[1]);

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

function go(address: string) {
  fireEvent.change(bar(), { target: { value: address } });
  fireEvent.submit(bar().closest("form")!);
}

function follow(uri: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "octra-circle-bridge", token: "t", type: "octra.circle.navigate", uri },
      }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  m.network.id = "devnet";
  m.bridge.pageOrigin = null;
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
  m.name.mockReset().mockResolvedValue(points(CIRCLE));
  m.context.mockReset().mockImplementation((circle_id: string, path: string) => ({
    circle_id,
    path,
    bridge_token: "t",
  }));
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("a Circle opened by name", () => {
  it("opens the Circle the name points to, carries the path and keeps the name in the bar", async () => {
    show("oct://0XIO.oct/docs/intro.html");
    await staged();
    expect(m.name).toHaveBeenCalledWith("0XIO.oct", { networkId: "devnet", fresh: undefined });
    expect(loaded()).toEqual([CIRCLE]);
    expect(paths()).toEqual(["/docs/intro.html"]);
    expect(bar().value).toBe("oct://0xio.oct/docs/intro.html");
    expect(tag()!.textContent).toBe(cutId(CIRCLE));

    expect(screen.queryByText(CIRCLE)).toBeNull();
    fireEvent.click(tag()!);
    expect(screen.getByRole("dialog").textContent).toContain("0xio.oct");
    expect(screen.getByText("Opens Circle")).toBeTruthy();
    expect(screen.getByText(CIRCLE)).toBeTruthy();
    expect(screen.getByText("Copy Circle ID")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(CIRCLE)).toBeNull();
  });

  it("opens the index page when the address has no path", async () => {
    show("oct://0xio.oct");
    await staged();
    expect(paths()).toEqual(["/index.html"]);
    expect(bar().value).toBe("oct://0xio.oct");
  });

  it("leaves a Circle id address as it is, with no tag and no name lookup", async () => {
    show(`oct://${CIRCLE}/index.html`);
    await staged();
    expect(m.name).not.toHaveBeenCalled();
    expect(bar().value).toBe(`oct://${CIRCLE}/index.html`);
    expect(tag()).toBeNull();
  });

  it("follows a link inside the same Circle without reading the name, and keeps the name form", async () => {
    show("oct://0xio.oct/docs/intro.html");
    await staged();
    m.name.mockResolvedValue(refused("busy"));
    follow(`oct://${CIRCLE}/docs/next.html`);
    await staged(2);
    expect(m.name).toHaveBeenCalledTimes(1);
    expect(bar().value).toBe("oct://0xio.oct/docs/next.html");
    expect(loaded()).toEqual([CIRCLE, CIRCLE]);
    expect(paths()).toEqual(["/docs/intro.html", "/docs/next.html"]);
    expect(m.context).toHaveBeenLastCalledWith(CIRCLE, "/docs/next.html");
    expect(m.bridge.pageOrigin!()).toBe(`oct://${CIRCLE}`);
    expect(tag()!.textContent).toBe(cutId(CIRCLE));
    expect(screen.queryByText("The node is busy. Try again")).toBeNull();
  });

  it("shows a link to another Circle by its id, with no tag and no name read", async () => {
    show("oct://0xio.oct/docs/intro.html");
    await staged();
    follow(`oct://${OTHER}/index.html`);
    await staged(2);
    expect(bar().value).toBe(`oct://${OTHER}/index.html`);
    expect(m.name).toHaveBeenCalledTimes(1);
    expect(tag()).toBeNull();
    expect(m.bridge.pageOrigin!()).toBe(`oct://${OTHER}`);
  });

  const reasons: [string, string, boolean][] = [
    ["not_registered", "This name is not registered", false],
    ["expired", "This name has expired", false],
    ["reserved", "This name is reserved", false],
    ["invalid", "Not a valid name", false],
    ["points_to_wallet", "This name points to a wallet", false],
    ["not_set", "This name has no Circle set", false],
    ["circle_waiting", "This Circle is still waiting to be confirmed", false],
    ["busy", "The node is busy. Try again", true],
    ["unavailable", "The name could not be checked. Try again", true],
    ["bad_reply", "The name could not be read. Try again", true],
  ];
  for (const [reason, text, retry] of reasons) {
    it(`shows "${text}" and loads nothing`, async () => {
      m.name.mockResolvedValue(refused(reason));
      show("oct://0xio.oct/docs/intro.html");
      expect(await screen.findByText(text)).toBeTruthy();
      expect(frame()).toBeNull();
      expect(tag()).toBeNull();
      expect(m.info).not.toHaveBeenCalled();
      expect(m.asset).not.toHaveBeenCalled();
      expect(m.context).not.toHaveBeenCalled();
      expect(m.staged).toEqual([]);
      expect(m.bridge.pageOrigin!()).toBeNull();
      expect(bar().value).toBe("oct://0xio.oct/docs/intro.html");
      expect(screen.queryByText("Try again") !== null).toBe(retry);
    });
  }

  it("asks the name service again on Try again, and opens once it answers", async () => {
    m.name.mockResolvedValueOnce(refused("busy"));
    show("oct://0xio.oct/docs/intro.html");
    fireEvent.click(await screen.findByText("Try again"));
    await staged();
    expect(m.name).toHaveBeenLastCalledWith("0xio.oct", { networkId: "devnet", fresh: true });
    expect(screen.queryByText("The node is busy. Try again")).toBeNull();
    expect(bar().value).toBe("oct://0xio.oct/docs/intro.html");
  });

  it("says names are off on mainnet and never reads the name as a Circle id", async () => {
    m.network.id = "mainnet";
    m.name.mockResolvedValue(refused("not_available"));
    show("oct://0xio.oct");
    expect(await screen.findByText("Names are not available on this network")).toBeTruthy();
    expect(m.name).toHaveBeenCalledWith("0xio.oct", { networkId: "mainnet", fresh: undefined });
    expect(m.info).not.toHaveBeenCalled();
    expect(m.asset).not.toHaveBeenCalled();
    expect(frame()).toBeNull();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("takes the page off the screen when a name typed over it does not open", async () => {
    show(`oct://${CIRCLE}/index.html`);
    await staged();
    m.name.mockResolvedValue(refused("not_registered"));
    go("oct://0xio.oct");
    expect(await screen.findByText("This name is not registered")).toBeTruthy();
    expect(frame()).toBeNull();
    expect(m.bridge.pageOrigin!()).toBeNull();
    expect(screen.getByTestId("chip").textContent).toBe("");
  });

  it("opens a name typed after text that was not an address", async () => {
    show(`oct://${OTHER}/index.html`);
    await staged();
    go("hello there");
    expect(await screen.findByText("Search the web")).toBeTruthy();
    go("oct://0xio.oct");
    await staged(2);
    expect(screen.queryByText("Search the web")).toBeNull();
    expect(tag()!.textContent).toBe(cutId(CIRCLE));
  });

  it("binds the site to the Circle id, never to the name", async () => {
    show("oct://0xio.oct/docs/intro.html");
    const doc = await staged();
    expect(m.context).toHaveBeenCalledWith(CIRCLE, "/docs/intro.html");
    expect(m.bridge.pageOrigin!()).toBe(`oct://${CIRCLE}`);
    expect(screen.getByTestId("chip").textContent).toBe(`oct://${CIRCLE}`);
    fireEvent.click(screen.getByLabelText("Open in a window"));
    await waitFor(() =>
      expect(m.invoke.mock.calls.filter((c) => c[0] === "dapp_open_window")).toEqual([
        ["dapp_open_window", { url: doc.url, site: `oct://${CIRCLE}` }],
      ]),
    );
  });

  it("keeps the page on screen speaking as its own Circle while the next one loads", async () => {
    show(`oct://${OTHER}/index.html`);
    await staged();
    let answer!: (found: unknown) => void;
    m.name.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    go("oct://0xio.oct");
    await waitFor(() => expect(m.name).toHaveBeenCalled());
    expect(m.bridge.pageOrigin!()).toBe(`oct://${OTHER}`);
    expect(tag()).toBeNull();
    await act(async () => answer(points(CIRCLE)));
    await staged(2);
    expect(m.bridge.pageOrigin!()).toBe(`oct://${CIRCLE}`);
  });

  it("reload asks the name service again, and a moved name opens as a fresh site", async () => {
    show("oct://0xio.oct/docs/intro.html");
    await staged();
    const first = m.context.mock.results[0].value;
    m.name.mockResolvedValue(points(MOVED));
    fireEvent.click(screen.getByLabelText("Reload"));
    await staged(2);
    expect(m.name).toHaveBeenLastCalledWith("0xio.oct", { networkId: "devnet", fresh: true });
    expect(loaded()).toEqual([CIRCLE, MOVED]);
    expect(m.context).toHaveBeenLastCalledWith(MOVED, "/docs/intro.html");
    expect(m.context.mock.results[1].value).not.toBe(first);
    expect(m.bridge.pageOrigin!()).toBe(`oct://${MOVED}`);
    expect(screen.getByTestId("chip").textContent).toBe(`oct://${MOVED}`);
    expect(bar().value).toBe("oct://0xio.oct/docs/intro.html");
    expect(tag()!.textContent).toBe(cutId(MOVED));
    fireEvent.click(tag()!);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.queryByText(CIRCLE)).toBeNull();
  });

  it("asks for the passphrase of a sealed Circle, and again when the name moves to another", async () => {
    m.info.mockResolvedValue({ resource_mode: "sealed_read" });
    m.sealed.mockResolvedValue({ content_type: "text/html" });
    m.open.mockResolvedValue(bytes("<html><head></head><body>sealed</body></html>"));
    show("oct://0xio.oct");
    const field = await screen.findByLabelText("Passphrase", { exact: false });
    expect(m.staged.length).toBe(0);
    fireEvent.change(field, { target: { value: "open sesame" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await staged();
    expect(m.open).toHaveBeenCalledWith(CIRCLE, { content_type: "text/html" }, "open sesame");
    expect(bar().value).toBe("oct://0xio.oct");
    expect(m.bridge.pageOrigin!()).toBe(`oct://${CIRCLE}`);

    m.open.mockClear();
    m.name.mockResolvedValue(points(MOVED));
    fireEvent.click(screen.getByLabelText("Reload"));
    expect(await screen.findByLabelText("Passphrase", { exact: false })).toBeTruthy();
    expect(m.open).not.toHaveBeenCalled();
    expect(m.staged.length).toBe(1);
    expect(m.bridge.pageOrigin!()).toBe(`oct://${CIRCLE}`);
  });

  it("goes back and forward through name pages, asking the name service each time", async () => {
    show("oct://0xio.oct/one.html");
    await staged();
    follow(`oct://${CIRCLE}/two.html`);
    await staged(2);
    fireEvent.click(screen.getByLabelText("Back"));
    await staged(3);
    expect(bar().value).toBe("oct://0xio.oct/one.html");
    expect(paths()).toEqual(["/one.html", "/two.html", "/one.html"]);
    fireEvent.click(screen.getByLabelText("Forward"));
    await staged(4);
    expect(bar().value).toBe("oct://0xio.oct/two.html");
    expect(m.name).toHaveBeenCalledTimes(3);
    expect(tag()!.textContent).toBe(cutId(CIRCLE));
  });

  it("stores the name form in a bookmark and in history, and opens it by name again", async () => {
    show("oct://0xio.oct/docs/intro.html");
    await staged();
    fireEvent.click(screen.getByLabelText("Add bookmark"));
    fireEvent.click(screen.getByLabelText("System browser"));
    const saved =
      (localStorage.getItem("0xio_browser_bookmarks") ?? "") +
      (localStorage.getItem("0xio_browser_history") ?? "");
    expect(JSON.parse(localStorage.getItem("0xio_browser_bookmarks")!)[0].url).toBe(
      "oct://0xio.oct/docs/intro.html",
    );
    expect(JSON.parse(localStorage.getItem("0xio_browser_history")!)[0].url).toBe(
      "oct://0xio.oct/docs/intro.html",
    );
    expect(saved).not.toContain(CIRCLE);
    expect(saved).not.toContain("127.0.0.1");
    expect(m.invoke.mock.calls.filter((c) => c[0] === "plugin:shell|open")).toEqual([]);

    fireEvent.click(screen.getByLabelText("Home"));
    m.name.mockResolvedValue(points(MOVED));
    fireEvent.click(await screen.findByText("0xio.oct", { selector: "span.w-full" }));
    await staged(2);
    expect(m.name).toHaveBeenCalledTimes(2);
    expect(loaded()).toEqual([CIRCLE, MOVED]);
    expect(bar().value).toBe("oct://0xio.oct/docs/intro.html");
    expect(m.bridge.pageOrigin!()).toBe(`oct://${MOVED}`);
  });
});
