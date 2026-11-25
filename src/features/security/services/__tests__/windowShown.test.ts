// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  focus: null as null | (() => void),
  visible: true,
  minimized: false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: () => void) => {
      m.focus = handler;
      return () => {};
    },
    isVisible: async () => m.visible,
    isMinimized: async () => m.minimized,
  }),
}));
vi.mock("src/lib/logger", () => ({ logger: { info: vi.fn() } }));

import { isWindowShown, subscribeWindowShown } from "src/features/security/services/windowAway";

const seen: boolean[] = [];
subscribeWindowShown((shown) => seen.push(shown));

const setVisibility = (state: string) => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const focusChanged = async () => {
  m.focus?.();
  await settle();
};

beforeEach(async () => {
  m.visible = true;
  m.minimized = false;
  setVisibility("visible");
  await focusChanged();
  seen.length = 0;
});

describe("window shown", () => {
  it("stays shown when the window only loses focus", async () => {
    window.dispatchEvent(new Event("blur"));
    await focusChanged();
    expect(isWindowShown()).toBe(true);
    expect(seen).toEqual([]);
  });

  it("is hidden while the page is hidden and shown again after", async () => {
    setVisibility("hidden");
    expect(isWindowShown()).toBe(false);
    setVisibility("visible");
    await settle();
    expect(isWindowShown()).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it("is hidden while the main window is closed to the menu bar", async () => {
    m.visible = false;
    await focusChanged();
    expect(isWindowShown()).toBe(false);
    m.visible = true;
    await focusChanged();
    expect(seen).toEqual([false, true]);
  });

  it("is hidden while minimised, also when that lands after the blur", async () => {
    vi.useFakeTimers();
    m.focus?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(isWindowShown()).toBe(true);
    m.minimized = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isWindowShown()).toBe(false);
    vi.useRealTimers();
  });
});
