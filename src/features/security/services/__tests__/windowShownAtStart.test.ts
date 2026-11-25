// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ visible: false, minimized: false }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    isVisible: async () => m.visible,
    isMinimized: async () => m.minimized,
  }),
}));
vi.mock("src/lib/logger", () => ({ logger: { info: vi.fn() } }));

import { isWindowShown, subscribeWindowShown } from "src/features/security/services/windowAway";

describe("a window hidden from the start", () => {
  it("reads as hidden without waiting for a focus or visibility event", async () => {
    expect(document.visibilityState).toBe("visible");
    const seen: boolean[] = [];
    subscribeWindowShown((shown) => seen.push(shown));
    await new Promise((r) => setTimeout(r, 0));
    expect(isWindowShown()).toBe(false);
    expect(seen).toEqual([false]);
  });
});
