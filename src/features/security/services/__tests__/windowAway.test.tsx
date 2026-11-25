// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";

const m = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: boolean }) => void),
  unlisten: vi.fn(),
  broken: false,
  late: null as null | (() => void),
  endReveal: vi.fn(async () => {}),
  locked: false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (m.broken) throw new Error("not in the app");
    return {
      onFocusChanged: (handler: (e: { payload: boolean }) => void) => {
        m.handler = handler;
        return new Promise<() => void>((resolve) => {
          if (m.late) m.late = () => resolve(() => m.unlisten());
          else resolve(() => m.unlisten());
        });
      },
    };
  },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { endReveal: () => m.endReveal() },
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ isLocked: m.locked }) }));

import { watchWindowAway } from "src/features/security/services/windowAway";
import { useSecretReveal } from "src/features/security/components/PhraseReveal";

const setVisibility = (state: string) =>
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.handler = null;
  m.unlisten.mockReset();
  m.endReveal.mockClear();
  m.broken = false;
  m.late = null;
  m.locked = false;
  setVisibility("visible");
});
afterEach(cleanup);

describe("window away watch", () => {
  it("fires on blur, on leaving the page, on a hidden page and on the window losing focus", async () => {
    const away = vi.fn();
    const stop = watchWindowAway(away);
    await tick();
    fireEvent.blur(window);
    fireEvent(window, new Event("pagehide"));
    expect(away).toHaveBeenCalledTimes(2);

    fireEvent(document, new Event("visibilitychange"));
    expect(away).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(away).toHaveBeenCalledTimes(3);

    m.handler?.({ payload: true });
    expect(away).toHaveBeenCalledTimes(3);
    m.handler?.({ payload: false });
    expect(away).toHaveBeenCalledTimes(4);

    stop();
    expect(m.unlisten).toHaveBeenCalledTimes(1);
    fireEvent.blur(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(away).toHaveBeenCalledTimes(4);
  });

  it("lets go of a window listener that arrives after it stopped", async () => {
    m.late = () => {};
    const stop = watchWindowAway(vi.fn());
    stop();
    expect(m.unlisten).not.toHaveBeenCalled();
    m.late();
    await tick();
    expect(m.unlisten).toHaveBeenCalledTimes(1);
  });

  it("still watches the page when the window cannot be reached", () => {
    m.broken = true;
    const away = vi.fn();
    const stop = watchWindowAway(away);
    fireEvent.blur(window);
    expect(away).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("secret reveal", () => {
  it("keeps a loaded secret through a blur while authentication is pending, then watches again", () => {
    const { result } = renderHook(() => useSecretReveal<string>());
    act(() => result.current.take("secret", true));
    act(() => result.current.beginAuth());
    act(() => {
      fireEvent.blur(window);
      m.handler?.({ payload: false });
    });
    expect(result.current.secret).toBe("secret");
    expect(result.current.shown).toBe(true);
    expect(m.endReveal).not.toHaveBeenCalled();

    act(() => result.current.endAuth());
    expect(result.current.secret).toBe("secret");
    act(() => m.handler?.({ payload: false }));
    expect(result.current.secret).toBeNull();
    expect(result.current.shown).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("drops what was loaded when authentication ends on a hidden page", () => {
    const { result } = renderHook(() => useSecretReveal<string>());
    act(() => result.current.beginAuth());
    setVisibility("hidden");
    act(() => {
      result.current.take("secret", true);
      result.current.endAuth();
    });
    expect(result.current.secret).toBeNull();
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("counts a secret as seen only once it was shown", () => {
    const { result } = renderHook(() => useSecretReveal<string>());
    act(() => result.current.take("secret"));
    expect(result.current.shown).toBe(false);
    expect(result.current.seen).toBe(false);
    act(() => result.current.show());
    expect(result.current.seen).toBe(true);
    act(() => result.current.drop());
    expect(result.current.seen).toBe(true);
    expect(result.current.secret).toBeNull();
  });

  it("drops the secret on lock and ends the reveal on unmount", () => {
    const view = renderHook(() => useSecretReveal<string>());
    act(() => view.result.current.take("secret", true));
    m.locked = true;
    view.rerender();
    expect(view.result.current.secret).toBeNull();
    view.unmount();
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });
});
