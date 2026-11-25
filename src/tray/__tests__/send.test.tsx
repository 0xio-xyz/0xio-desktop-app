// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act as flush, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FeeRead, TrayAction, TraySnapshot, TrayState } from "../protocol";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import TrayApp from "../TrayApp";

const ok = (ou: number): FeeRead => ({ state: "ok", ou });
const addr = (c: string) => `oct${c.repeat(44)}`;
const snap = (readiness: TraySnapshot["privateReadiness"]): TraySnapshot => ({
  locked: false,
  hasPassword: true,
  biometric: true,
  wallets: [{ id: "w1", name: "Main", address: addr("A") }],
  activeId: "w1",
  network: "devnet",
  networks: [{ id: "devnet", name: "Devnet" }],
  privacy: true,
  canSign: true,
  privateReadiness: readiness,
  publicMicro: 500_000_000,
  privateMicro: 3_000_000,
  claims: 0,
  fees: {
    public: ok(1_000),
    private: ok(1_000_000),
    encrypt: ok(1_000_000),
    decrypt: ok(1_000_000),
    refresh: ok(2_000_000),
  },
});

async function openSend(readiness: TraySnapshot["privateReadiness"]) {
  const state: TrayState = {
    snapshot: snap(readiness),
    clients: 0,
    computing: false,
    computingExtension: false,
    openAtLogin: false,
  };
  tauri.invoke.mockImplementation(async (cmd: string) =>
    cmd === "tray_get_state" ? state : { ok: true },
  );
  const view = render(<TrayApp />);
  await flush(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  fireEvent.change(view.container.querySelector("#tp-to")!, { target: { value: addr("B") } });
  fireEvent.change(view.container.querySelector("#tp-amount")!, { target: { value: "1" } });
  const review = () => screen.getByRole("button", { name: "Review" }) as HTMLButtonElement;
  const slot = () => view.container.querySelector(".tp-msg")?.textContent ?? "";
  const actions = () =>
    tauri.invoke.mock.calls
      .filter(([c]) => c === "tray_action")
      .map(([, a]) => (a as { action: TrayAction }).action);
  return { ...view, review, slot, actions };
}

beforeEach(() => {
  document.documentElement.setAttribute("data-tray", "smoke");
  tauri.invoke.mockReset();
});
afterEach(cleanup);

describe("private send in the panel", () => {
  it("reviews while the private balance is ready", async () => {
    const v = await openSend({ state: "ok" });
    expect(v.review().disabled).toBe(false);
    expect(v.slot()).toBe("");
  });

  it.each([
    [{ state: "needsRefresh" }, "Your private balance is due for a migration", "Migrate"],
    [
      { state: "keyUpdate", mode: "key_bound_migration", amountMicro: 1, fee: ok(1) },
      "Your private balance needs to move to your current encryption key",
      "Migrate",
    ],
    [
      { state: "keyUpdate", mode: "legacy_zero_reset", amountMicro: 0, fee: ok(1) },
      "This wallet's encryption key needs an update on the network",
      "Update",
    ],
    [
      { state: "noKey", setup: { state: "offer", feeOu: 1_000 } },
      "Your private balance is off",
      "Turn on",
    ],
    [
      { state: "noKey", setup: { state: "unavailable", reason: "check" } },
      "Could not check your private balance. Try again.",
      "Retry",
    ],
    [{ state: "waiting", reason: "refreshPending" }, "Migrating, waiting for the network", null],
    [
      { state: "blocked", reason: "keyBlocked", detail: "Held by the network" },
      "Held by the network",
      null,
    ],
    [
      { state: "stuck", reason: "pastCap", detail: "Past the layer limit" },
      "Past the layer limit",
      null,
    ],
    [{ state: "checking" }, "", null],
  ] as [TraySnapshot["privateReadiness"], string, string | null][])(
    "refuses %j in the message slot with the fix",
    async (readiness, line, fix) => {
      const v = await openSend(readiness);
      expect(v.review().disabled).toBe(true);
      expect(v.slot()).toBe(`${line}${fix ?? ""}`);
    },
  );

  it("opens the migration review from the message slot", async () => {
    const v = await openSend({ state: "needsRefresh" });
    fireEvent.click(screen.getByRole("button", { name: "Migrate" }));
    expect(screen.getByText("Migrate balance")).toBeTruthy();
    expect(screen.getByText(/Rebuilds your private balance/)).toBeTruthy();
    expect(v.actions().some((a) => a.type === "send")).toBe(false);
  });

  it("opens the key update review from the message slot", async () => {
    await openSend({ state: "keyUpdate", mode: "legacy_zero_reset", amountMicro: 0, fee: ok(1) });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText("Update encryption key")).toBeTruthy();
  });

  it("refuses a .oct name: no review and nothing sent", async () => {
    const v = await openSend({ state: "ok" });
    fireEvent.change(v.container.querySelector("#tp-to")!, { target: { value: "0xio.oct" } });
    expect(v.review().disabled).toBe(true);
    expect(v.container.querySelector(".tp-hint")?.textContent).toMatch(
      /ons\.trayRefused|\.oct name/,
    );
    expect(v.actions().some((a) => a.type === "send")).toBe(false);
  });

  it("leaves public sends alone", async () => {
    const v = await openSend({ state: "needsRefresh" });
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    expect(v.review().disabled).toBe(false);
    expect(v.slot()).toBe("");
  });
});
