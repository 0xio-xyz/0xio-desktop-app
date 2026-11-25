// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { cmd: string; args?: Record<string, unknown> }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    sent.push({ cmd, args });
    return null;
  }),
}));

const { afterFirstScreen, firstScreenShown, rememberVault } =
  await import("src/services/app/startup");

afterEach(() => {
  vi.useRealTimers();
});

describe("startup", () => {
  it("holds deferred work until the first screen, drops the skeleton and logs one line", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="boot"></div>';
    const task = vi.fn();
    afterFirstScreen(task);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).not.toHaveBeenCalled();

    firstScreenShown("lock");
    expect(document.getElementById("boot")).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);
    const logs = sent.filter((s) => s.cmd === "frontend_log");
    expect(logs).toHaveLength(1);
    expect(String(logs[0].args?.message)).toMatch(
      /^\[boot\] script \d+ ms, vault \d+ ms, lock \d+ ms$/,
    );

    firstScreenShown("home");
    expect(sent.filter((s) => s.cmd === "frontend_log")).toHaveLength(1);

    const later = vi.fn();
    afterFirstScreen(later);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("leaves the vault hint for the next launch's first frame", () => {
    rememberVault(true);
    expect(localStorage.getItem("0xio_boot_vault")).toBe("1");
    rememberVault(false);
    expect(localStorage.getItem("0xio_boot_vault")).toBe("0");
  });
});
