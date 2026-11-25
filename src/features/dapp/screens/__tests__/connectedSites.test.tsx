// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "src/lib/router";

const m = vi.hoisted(() => ({ wallet: {} as Record<string, unknown> }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { getPublicKey: vi.fn(async () => "pub") },
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => m.wallet }));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));

// jsdom's TextEncoder hands tweetnacl a Uint8Array from another realm; the picture is not under test.
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));

import "src/i18n";
import * as dappService from "src/features/dapp/services/dappService";
import { onDappEvent } from "src/features/dapp/services/dappEvents";
import ConnectedSitesScreen from "src/features/dapp/screens/ConnectedSitesScreen";
import ConnectedSiteScreen from "src/features/dapp/screens/ConnectedSiteScreen";
import SiteChip from "src/features/dapp/components/SiteChip";

const MAIN = { id: "w1", name: "Main", address: `oct${"A".repeat(44)}`, wallet_type: "mnemonic" };
const SPEND = {
  id: "w2",
  name: "Spending",
  address: `oct${"B".repeat(44)}`,
  wallet_type: "private_key",
};
const COLD = { id: "w3", name: "Cold", address: `oct${"C".repeat(44)}`, wallet_type: "watch" };
const SITE = "https://dapp.example";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/connected-sites" element={<ConnectedSitesScreen />} />
        <Route path="/connected-sites/site" element={<ConnectedSiteScreen />} />
        <Route path="/browser" element={<SiteChip origin={SITE} />} />
      </Routes>
    </MemoryRouter>,
  );
}
const sitePage = `/connected-sites/site?origin=${encodeURIComponent(SITE)}`;

beforeEach(() => {
  localStorage.clear();
  m.wallet = { activeWallet: MAIN, wallets: [MAIN, SPEND, COLD], networkId: "mainnet" };
});
afterEach(cleanup);

describe("connected sites pages", () => {
  it("lists each site with its wallet in use and how many more", () => {
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address);
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    renderAt("/connected-sites");
    expect(screen.getAllByText("dapp.example")).toHaveLength(2);
    expect(screen.getAllByText("Main").length).toBeGreaterThan(0);
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("shows the picked site beside the list and disconnects it after a confirm", async () => {
    const OTHER = "https://other.example";
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    dappService.connectWallet("mainnet", OTHER, MAIN, MAIN.address);
    renderAt("/connected-sites");
    // Both sites connect in the same moment, so either may lead the list: click its row.
    fireEvent.click(screen.getAllByText("other.example")[0]);
    expect(screen.getAllByText("other.example")).toHaveLength(2);
    fireEvent.click(screen.getByText("Disconnect"));
    expect(screen.getByText("Disconnect this site")).toBeTruthy();
    const buttons = screen.getAllByText("Disconnect");
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(dappService.getSite("mainnet", OTHER)).toBeNull());
  });

  it("says so when nothing is connected", () => {
    renderAt("/connected-sites");
    expect(screen.getByText("No connected sites")).toBeTruthy();
  });

  it("removes one wallet after a confirm, and the site keeps the other", () => {
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address);
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    renderAt(sitePage);
    fireEvent.click(screen.getAllByText("Remove")[0]);
    expect(screen.getByText("Remove from this site")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(Object.keys(dappService.getSite("mainnet", SITE)!.accounts)).toHaveLength(2);
    fireEvent.click(screen.getAllByText("Remove")[0]);
    fireEvent.click(screen.getAllByText("Remove").slice(-1)[0]);
    const site = dappService.getSite("mainnet", SITE)!;
    expect(Object.keys(site.accounts)).toEqual([SPEND.address]);
    expect(site.inUse).toBe(SPEND.address);
  });

  it("offers Remove only when the site has several wallets", () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    renderAt(sitePage);
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("disconnects after a confirm and tells only that site", () => {
    const heard: Array<[string, string[]]> = [];
    const off = onDappEvent((t, _d, o) => heard.push([t, o]));
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    dappService.connectWallet("mainnet", "https://other.example", MAIN, MAIN.address);
    renderAt(sitePage);
    fireEvent.click(screen.getByText("Disconnect"));
    expect(screen.getByText("Disconnect this site")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Disconnect").slice(-1)[0]);
    expect(dappService.isConnected("mainnet", SITE)).toBe(false);
    expect(dappService.isConnected("mainnet", "https://other.example")).toBe(true);
    expect(heard).toEqual([["disconnect", [SITE]]]);
    off();
  });

  it("an outside click on the confirm keeps the site", () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    renderAt(sitePage);
    fireEvent.click(screen.getByText("Disconnect"));
    fireEvent.click(screen.getByTestId("review-backdrop"));
    expect(screen.queryByText("Disconnect this site")).toBeNull();
    expect(dappService.isConnected("mainnet", SITE)).toBe(true);
  });

  it("connects another wallet that can sign, never a watch-only one", () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    renderAt(sitePage);
    fireEvent.click(screen.getByText("Connect another wallet"));
    expect(screen.queryByText("Cold")).toBeNull();
    fireEvent.click(screen.getByText("Connect"));
    const site = dappService.getSite("mainnet", SITE)!;
    expect(Object.keys(site.accounts).sort()).toEqual([MAIN.address, SPEND.address].sort());
    expect(site.inUse).toBe(SPEND.address);
  });
});

describe("site chip", () => {
  it("is plain Not connected for an unconnected site and opens the connect review", () => {
    renderAt("/browser");
    fireEvent.click(screen.getByText("Not connected"));
    expect(screen.getByText("Connect to this site")).toBeTruthy();
    fireEvent.click(screen.getByText("Connect"));
    expect(dappService.getSite("mainnet", SITE)!.inUse).toBe(MAIN.address);
  });

  it("shows the host when connected", () => {
    dappService.connectWallet("mainnet", SITE, SPEND, SPEND.address);
    renderAt("/browser");
    expect(screen.getByTestId("site-chip").textContent).toContain("dapp.example");
    expect(screen.getByTestId("site-chip").getAttribute("title")).toContain("Spending");
  });
});
