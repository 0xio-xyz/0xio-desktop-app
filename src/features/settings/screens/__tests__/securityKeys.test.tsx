// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "src/i18n";

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  active: {} as Record<string, unknown>,
  hell: false,
}));
vi.mock("src/lib/router", () => ({ useNavigate: () => m.navigate }));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: m.active,
    wallets: [m.active],
    networkId: "mainnet",
    showMessage: vi.fn(),
  }),
}));
vi.mock("src/features/settings/hooks/useSecurityState", () => ({
  biometricName: () => "Touch ID",
  useSecurityState: () => ({ hasPassword: true, isHellMode: m.hell, biometric: null }),
}));
vi.mock("src/features/dapp/hooks/usePairedApps", () => ({
  usePairedApps: () => ({ list: [] }),
}));
vi.mock("src/features/dapp/hooks/useDappSites", () => ({ useDappSites: () => [] }));
vi.mock("src/features/dapp/hooks/useRelaySites", () => ({
  recordKey: () => "",
  useRelaySites: () => ({ list: [] }),
  useWaitingSiteRequests: () => 0,
}));
vi.mock("src/features/dapp/components/PairedApps", () => ({ default: () => null }));
vi.mock("src/features/dapp/components/RelaySites", () => ({
  RELAY_NETWORKS: ["mainnet"],
  RelaySitePanel: () => null,
  RelaySitesGroup: () => null,
  RemovingPanel: () => null,
  browserLabel: () => "",
}));
vi.mock("src/features/settings/panels/SecurityPanel", () => ({ default: () => null }));
vi.mock("src/features/settings/screens/SecurityDialogs", () => ({
  HellModeDialog: () => null,
  PasswordDialog: () => null,
}));
vi.mock("src/features/wallet/components/PasswordPrompt", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/services/wallet/walletBridge", () => ({ walletBridge: {} }));
vi.mock("src/services/wallet/biometricService", () => ({ biometricService: {} }));

import SecuritySection from "src/features/settings/screens/SecuritySection";

const wallet = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  name: "Spending",
  address: `oct${"A".repeat(44)}`,
  wallet_type: "hd",
  source: "mnemonic",
  ...over,
});
const row = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  m.navigate.mockReset();
  m.active = wallet();
  m.hell = false;
});
afterEach(cleanup);

describe("Settings keys", () => {
  it("names the two entries Recovery phrase and Private key and opens the one surface", () => {
    const { container } = render(<SecuritySection />);
    fireEvent.click(row("Recovery phrase")!);
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=w1&kind=phrase");
    fireEvent.click(row("Private key")!);
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=w1&kind=key");
    expect(container.textContent).not.toMatch(/Key info|Export/);
  });

  it("marks the entry that still needs its backup", () => {
    m.active = wallet({ needs_backup: true });
    render(<SecuritySection />);
    expect(row("Recovery phrase")?.textContent).toContain("Not backed up");
    expect(row("Private key")?.textContent).not.toContain("Not backed up");
  });

  it("shows only Private key for a wallet imported by key", () => {
    m.active = wallet({ source: "private_key", needs_backup: true });
    render(<SecuritySection />);
    expect(row("Recovery phrase")).toBeNull();
    expect(row("Private key")?.textContent).toContain("Not backed up");
  });

  it("shows neither for a watch only wallet or under the seal", () => {
    m.active = wallet({ wallet_type: "watch", source: "address" });
    const view = render(<SecuritySection />);
    expect(row("Recovery phrase")).toBeNull();
    expect(row("Private key")).toBeNull();
    view.unmount();

    m.active = wallet();
    m.hell = true;
    render(<SecuritySection />);
    expect(row("Recovery phrase")).toBeNull();
    expect(row("Private key")).toBeNull();
  });
});
