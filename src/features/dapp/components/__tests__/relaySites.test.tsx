// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "src/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ wallets: [{ id: "w1", name: "Spending", address: ADDR }] }),
}));

import {
  RelaySitesGroup,
  RemovingPanel,
  type RelayNetwork,
} from "src/features/dapp/components/RelaySites";
import PairedApps from "src/features/dapp/components/PairedApps";
import type { PairedAppsState } from "src/features/dapp/hooks/usePairedApps";
import {
  DIRECT,
  relayBook,
  relayEvent,
  relayScopeCurrent,
  setRelaySites,
  type RelayEffect,
  type RelayRecord,
} from "src/features/dapp/services/relaySites";

const ADDR = `oct${"A".repeat(44)}`;
const CHROME = "0123456789abcdef0123456789abcdef";
const FIREFOX = "fedcba9876543210fedcba9876543210";

const rec = (origin: string, network: string, client: string, over: Partial<RelayRecord> = {}) => ({
  origin,
  network,
  address: ADDR,
  client_id: client,
  browser: client === FIREFOX ? "firefox" : "chrome",
  wallet_id: "w1",
  wallet_name: "Old name",
  permissions: [],
  connected_at: 1,
  ...over,
});

const LIST: RelayRecord[] = [
  rec("https://vaulta.euints.com", "mainnet", CHROME, { connected_at: 3 }),
  rec("https://mint.circlesdrop.io", "mainnet", FIREFOX, { connected_at: 2 }),
  rec("http://localhost:5173", "devnet", CHROME),
];

afterEach(cleanup);

function Group({ onDisconnect = vi.fn(), network = "mainnet" as RelayNetwork }) {
  const onNetwork = vi.fn();
  const view = render(
    <RelaySitesGroup
      list={LIST}
      network={network}
      onNetwork={onNetwork}
      selected={null}
      onSelect={() => {}}
      onDisconnect={onDisconnect}
    />,
  );
  return { ...view, onNetwork, onDisconnect };
}

describe("Connected sites in Security and Privacy", () => {
  it("names a site that connected straight from the browser", () => {
    render(
      <RelaySitesGroup
        list={[rec("https://app.octradex.xyz", "mainnet", DIRECT, { browser: "web" })]}
        network="mainnet"
        onNetwork={() => {}}
        selected={null}
        onSelect={() => {}}
        onDisconnect={() => {}}
      />,
    );
    expect(screen.getByText("app.octradex.xyz")).toBeTruthy();
    expect(screen.getByText("Direct from browser")).toBeTruthy();
    expect(screen.queryByText(/via 0xio extension/)).toBeNull();
  });

  it("lists the sites of one network with the browser that relayed them and the wallet", () => {
    Group({});
    expect(screen.getByText("vaulta.euints.com")).toBeTruthy();
    expect(screen.getByText("via 0xio extension (Chrome)")).toBeTruthy();
    expect(screen.getByText("via 0xio extension (Firefox)")).toBeTruthy();
    expect(screen.queryByText("localhost:5173")).toBeNull();
    expect(screen.getAllByText("Spending").length).toBe(2);
  });

  it("switches between Mainnet and Devnet", () => {
    const { onNetwork } = Group({});
    fireEvent.click(screen.getByRole("button", { name: "Devnet" }));
    expect(onNetwork).toHaveBeenCalledWith("devnet");
    cleanup();
    Group({ network: "devnet" });
    expect(screen.getByText("localhost:5173")).toBeTruthy();
    expect(screen.queryByText("vaulta.euints.com")).toBeNull();
  });

  it("asks once more in place before it disconnects", () => {
    const onDisconnect = vi.fn();
    Group({ onDisconnect });
    const row = screen.getByText("vaulta.euints.com").closest("[role=button]") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));
    expect(onDisconnect).toHaveBeenCalledWith(LIST[0]);
  });
});

describe("removing a paired extension", () => {
  const pairing = (forget = vi.fn()): PairedAppsState => ({
    list: [
      {
        key: CHROME,
        name: "0xio extension",
        origin: "chrome-extension://anknhjilldkeelailocijnfibefmepcc",
        paired_at: 0,
        last_used: Date.now() / 1000,
      },
      {
        key: "bot1",
        name: "octra-cli",
        origin: "native://octra-cli-abc",
        paired_at: 0,
        last_used: 0,
      },
    ],
    settings: { allow_legacy: true, forget_after_days: 90, notify_sites: true, direct_sites: true },
    permission: "granted",
    forget: forget as unknown as PairedAppsState["forget"],
    save: vi.fn() as unknown as PairedAppsState["save"],
    openNotifySettings: vi.fn(),
  });
  const sitesOf = (key: string) => LIST.filter((r) => r.client_id === key);

  it("says how many sites it forgets before Remove", () => {
    const forget = vi.fn();
    const onRemoving = vi.fn();
    const { rerender } = render(
      <PairedApps
        pairing={pairing(forget)}
        sitesOf={sitesOf}
        removing={null}
        onRemoving={onRemoving}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(onRemoving).toHaveBeenCalledWith(CHROME);
    expect(forget).not.toHaveBeenCalled();
    rerender(
      <PairedApps
        pairing={pairing(forget)}
        sitesOf={sitesOf}
        removing={CHROME}
        onRemoving={onRemoving}
      />,
    );
    expect(screen.getByText("Forgets 2 sites")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(forget).toHaveBeenCalledWith(CHROME);
  });

  it("turns websites without the extension off and on", () => {
    const state = pairing();
    render(<PairedApps pairing={state} sitesOf={sitesOf} removing={null} onRemoving={vi.fn()} />);
    expect(screen.getByText("Websites can connect without the extension")).toBeTruthy();
    const toggle = screen.getByRole("switch", {
      name: "Websites can connect without the extension",
    });
    fireEvent.click(toggle);
    expect(state.save).toHaveBeenCalledWith({ directSites: false });
  });

  it("removes a program with no sites at once", () => {
    const forget = vi.fn();
    render(
      <PairedApps
        pairing={pairing(forget)}
        sitesOf={sitesOf}
        removing={null}
        onRemoving={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(buttons[1]);
    expect(forget).toHaveBeenCalledWith("bot1");
  });

  it("lists the sites it forgets in the panel", () => {
    render(<RemovingPanel name="0xio extension (Chrome)" sites={sitesOf(CHROME)} />);
    expect(screen.getByText("Removing 0xio extension (Chrome)")).toBeTruthy();
    expect(screen.getByText("vaulta.euints.com")).toBeTruthy();
    expect(screen.getByText("localhost:5173")).toBeTruthy();
  });
});

describe("the relayed site book", () => {
  const req = {
    id: "1",
    origin: "https://vaulta.euints.com",
    topOrigin: null,
    framed: false,
    browser: "chrome" as const,
    clientId: CHROME,
    network: "mainnet",
    method: "connect",
    params: {},
  };

  it("reads only the record of the extension that relayed the site", () => {
    setRelaySites(LIST);
    const effects: RelayEffect[] = [];
    const book = relayBook(req, effects);
    const usable = () => true;
    expect(book.resolveSite("mainnet", req.origin, null, usable).address).toBe(ADDR);
    expect(book.resolveSite("devnet", req.origin, null, usable).site).toBeNull();
    const other = relayBook({ ...req, clientId: FIREFOX }, []);
    expect(other.resolveSite("mainnet", req.origin, null, usable).site).toBeNull();
  });

  it("keeps a direct site apart from the same site relayed by an extension", () => {
    setRelaySites([...LIST, rec("https://a.direct.io", "mainnet", DIRECT, { browser: "web" })]);
    const usable = () => true;
    const direct = relayBook(
      { ...req, origin: "https://a.direct.io", browser: "web", clientId: DIRECT },
      [],
    );
    expect(direct.resolveSite("mainnet", "https://a.direct.io", null, usable).address).toBe(ADDR);
    expect(direct.resolveSite("mainnet", req.origin, null, usable).site).toBeNull();
    expect(direct.scopeFor(ADDR, "https://a.direct.io", "mainnet").relay).toBe(DIRECT);
    const relayed = relayBook(req, []);
    expect(relayed.resolveSite("mainnet", "https://a.direct.io", null, usable).site).toBeNull();
  });

  it("collects what the request changes for Rust", () => {
    const effects: RelayEffect[] = [];
    const book = relayBook(req, effects);
    book.connectWallet(
      "mainnet",
      req.origin,
      { id: "w1", address: ADDR, name: "Spending", wallet_type: "hd" },
      null,
      { permissions: ["accounts"] },
    );
    book.carrySite("mainnet", "devnet", req.origin);
    book.disconnectSite("mainnet", req.origin);
    expect(effects).toEqual([
      {
        type: "connect",
        address: ADDR,
        walletId: "w1",
        walletName: "Spending",
        permissions: ["accounts"],
      },
      { type: "switch", to: "devnet" },
      { type: "disconnect" },
    ]);
  });

  it("signs on the site's own network while its record still names the address", () => {
    setRelaySites(LIST);
    const scope = relayBook(req, []).scopeFor(ADDR, req.origin, "mainnet");
    expect(scope).toEqual({ networkId: "mainnet", address: ADDR, site: req.origin, relay: CHROME });
    expect(relayScopeCurrent(scope)).toBe(true);
    expect(relayScopeCurrent({ ...scope, networkId: "devnet" })).toBe(false);
    expect(relayScopeCurrent({ ...scope, address: `oct${"Z".repeat(44)}` })).toBe(false);
    setRelaySites([]);
    expect(relayScopeCurrent(scope)).toBe(false);
  });

  it("maps wallet events to relay events", () => {
    expect(relayEvent("transactionConfirmed", { txHash: "ab", status: "confirmed" })).toEqual({
      kind: "tx",
      data: { txHash: "ab", status: "confirmed", hash: "ab" },
    });
    expect(relayEvent("accountChanged", { address: ADDR, canSign: true })).toEqual({
      kind: "accountsChanged",
      data: { accounts: [ADDR], canSign: true },
    });
    expect(relayEvent("disconnect", {})).toEqual({
      kind: "accountsChanged",
      data: { accounts: [] },
    });
    expect(relayEvent("extensionLocked", {})).toEqual({ kind: "lock", data: {} });
    expect(relayEvent("balanceChanged", {})).toBeNull();
  });
});
