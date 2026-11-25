// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "src/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("src/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ wallets: [] }) }));

import SecurityPanel from "src/features/settings/panels/SecurityPanel";
import type { PairedAppsState } from "src/features/dapp/hooks/usePairedApps";
import type { SecurityState } from "src/features/settings/hooks/useSecurityState";

afterEach(cleanup);

const pairing = (settings: PairedAppsState["settings"]): PairedAppsState => ({
  list: [],
  settings,
  permission: "granted",
  forget: vi.fn() as unknown as PairedAppsState["forget"],
  save: vi.fn() as unknown as PairedAppsState["save"],
  openNotifySettings: vi.fn(),
});

const show = (settings: PairedAppsState["settings"]) =>
  render(
    <SecurityPanel
      security={{ biometric: null, isHellMode: false } as unknown as SecurityState}
      autoLockLabel="5 min"
      pairing={pairing(settings)}
      siteCount={0}
      waiting={0}
    />,
  );

const valueOf = (label: string) =>
  screen.getByText(label).parentElement!.parentElement!.textContent;

describe("the Security status panel", () => {
  it("shows every connection setting as it stands", () => {
    show({ allow_legacy: true, forget_after_days: 30, notify_sites: true, direct_sites: true });
    expect(valueOf("Websites without the extension")).toContain("Allowed");
    expect(valueOf("Older extensions")).toContain("Allowed");
    expect(valueOf("Site notifications")).toContain("On");
    expect(valueOf("Forget unused pairings after")).toContain("30 days");
  });

  it("follows each switch when it is off", () => {
    show({ allow_legacy: false, forget_after_days: 0, notify_sites: false, direct_sites: false });
    expect(valueOf("Websites without the extension")).toContain("Not allowed");
    expect(valueOf("Older extensions")).toContain("Not allowed");
    expect(valueOf("Site notifications")).toContain("Off");
    expect(valueOf("Forget unused pairings after")).toContain("Never");
  });
});
