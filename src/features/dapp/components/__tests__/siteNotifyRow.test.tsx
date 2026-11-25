// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "src/i18n";

const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
let saved = { allow_legacy: true, forget_after_days: 90, notify_sites: true };
let permission = "granted";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "ws_paired_list") return [];
    if (cmd === "ws_pair_settings") return saved;
    if (cmd === "site_notify_permission") return permission;
    if (cmd === "ws_pair_set_settings") {
      if (typeof args?.notifySites === "boolean")
        saved = { ...saved, notify_sites: args.notifySites };
      return saved;
    }
    return null;
  }),
}));

import PairedApps from "src/features/dapp/components/PairedApps";
import { usePairedApps } from "src/features/dapp/hooks/usePairedApps";

function Harness() {
  const pairing = usePairedApps();
  return <PairedApps pairing={pairing} sitesOf={() => []} removing={null} onRemoving={vi.fn()} />;
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  saved = { allow_legacy: true, forget_after_days: 90, notify_sites: true };
  permission = "granted";
});

describe("Notify me about site requests", () => {
  it("is on by default and the switch is saved with the pairing settings", async () => {
    render(<Harness />);
    const toggle = await screen.findByRole("switch", { name: "Notify me about site requests" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(calls).toContainEqual({ cmd: "ws_pair_set_settings", args: { notifySites: false } });
    expect(saved.notify_sites).toBe(false);
  });

  it("shows Off in macOS settings with Open settings when macOS denied it", async () => {
    permission = "denied";
    render(<Harness />);
    expect(await screen.findByText("Off in macOS settings")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Notify me about site requests" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(calls.some((c) => c.cmd === "site_notify_open_settings")).toBe(true);
  });

  it("reads the permission again when the window comes back", async () => {
    permission = "denied";
    render(<Harness />);
    await screen.findByText("Off in macOS settings");
    permission = "granted";
    fireEvent.focus(window);
    expect(
      await screen.findByRole("switch", { name: "Notify me about site requests" }),
    ).toBeTruthy();
  });
});
