// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "src/i18n";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  focus: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    m.listeners.set(name, cb);
    return () => m.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  UserAttentionType: { Critical: 1 },
  getCurrentWindow: () => ({
    unminimize: async () => {},
    setFocus: m.focus,
    requestUserAttention: async () => {},
  }),
}));

import PairingReview from "src/features/dapp/components/PairingReview";
import { PAIRED_MS } from "src/features/dapp/hooks/useWsPairing";

const EXT = {
  id: "p1",
  name: "0xio extension",
  code: "482 913",
  kind: "extension",
  origin: "chrome-extension://anknhjilldkeelailocijnfibefmepcc",
};
const APP = { id: "p2", name: "My bot", code: "105 772", kind: "app", origin: null };

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
let pending: unknown[] = [];

beforeEach(() => {
  m.invoke.mockReset();
  m.listeners.clear();
  pending = [];
  m.invoke.mockImplementation(async (cmd: string) => (cmd === "ws_pair_pending" ? pending : null));
});
afterEach(cleanup);

describe("pairing review", () => {
  it("shows nothing until a client asks", async () => {
    const { container } = render(<PairingReview />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it("shows the client name and code with Reject and Pair, and pairs only on Pair", async () => {
    pending = [EXT];
    render(<PairingReview />);
    await settle();
    expect(screen.getByText("Pairing request")).toBeTruthy();
    expect(screen.getByText("0xio extension")).toBeTruthy();
    expect(screen.getByText(EXT.origin)).toBeTruthy();
    expect(screen.getByTestId("pairing-code").textContent).toBe("482 913");
    expect(screen.queryByText("Can ask for")).toBeNull();
    expect(screen.queryByText(/started pairing in the 0xio extension in Firefox/)).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(m.invoke).not.toHaveBeenCalledWith("ws_pair_respond", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await settle();
    expect(m.invoke).toHaveBeenCalledWith("ws_pair_respond", { id: "p1", approve: true });
  });

  it("refuses on Reject, a click outside and Escape", async () => {
    pending = [APP];
    render(<PairingReview />);
    await settle();
    expect(screen.getByText("A program on this computer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await settle();
    expect(m.invoke).toHaveBeenCalledWith("ws_pair_respond", { id: "p2", approve: false });

    m.invoke.mockClear();
    await act(async () => m.listeners.get("ws-pair-request")?.({ payload: { ...APP, id: "p3" } }));
    fireEvent.click(screen.getByTestId("review-backdrop"));
    await settle();
    expect(m.invoke).toHaveBeenCalledWith("ws_pair_respond", { id: "p3", approve: false });

    m.invoke.mockClear();
    await act(async () => m.listeners.get("ws-pair-request")?.({ payload: { ...APP, id: "p4" } }));
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(m.invoke).toHaveBeenCalledWith("ws_pair_respond", { id: "p4", approve: false });
  });

  it("says a Firefox extension cannot be told apart by its address", async () => {
    pending = [
      {
        ...EXT,
        kind: "firefox",
        name: "Firefox extension",
        origin: "moz-extension://3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f",
      },
    ];
    render(<PairingReview />);
    await settle();
    expect(screen.getByText(/cannot tell which Firefox extension this is/)).toBeTruthy();
    expect(screen.getByText(/started pairing in the 0xio extension in Firefox/)).toBeTruthy();
  });

  it("waits for the extension after Pair, with Reject still open", async () => {
    pending = [EXT];
    m.invoke.mockImplementation(async (cmd: string) =>
      cmd === "ws_pair_pending" ? pending : cmd === "ws_pair_respond" ? "waiting" : null,
    );
    render(<PairingReview />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await settle();
    const wait = screen.getByRole("button", { name: /Waiting/ }) as HTMLButtonElement;
    expect(wait.disabled).toBe(true);
    expect(screen.getByRole("img", { name: "0xio" })).toBeTruthy();
    expect(screen.getByTestId("pairing-code").textContent).toBe("482 913");
    expect(screen.queryByText("Paired")).toBeNull();
    fireEvent.click(wait);
    await settle();
    expect(m.invoke.mock.calls.filter(([c]) => c === "ws_pair_respond")).toHaveLength(1);

    const rejectButton = screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(m.invoke).toHaveBeenLastCalledWith("ws_pair_respond", { id: "p1", approve: false });
  });

  it("shows Paired for a moment once the extension confirms", async () => {
    pending = [EXT];
    m.invoke.mockImplementation(async (cmd: string) =>
      cmd === "ws_pair_pending" ? pending : cmd === "ws_pair_respond" ? "waiting" : null,
    );
    render(<PairingReview />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await settle();
    await act(async () =>
      m.listeners.get("ws-pair-resolved")?.({ payload: { id: "p1", outcome: "paired" } }),
    );
    expect(screen.queryByText("Pairing request")).toBeNull();
    expect(screen.getByText("Paired")).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, PAIRED_MS + 50)));
    expect(screen.queryByText("Paired")).toBeNull();
  });

  it("closes without a word when the extension cancels", async () => {
    pending = [EXT];
    render(<PairingReview />);
    await settle();
    await act(async () =>
      m.listeners.get("ws-pair-resolved")?.({ payload: { id: "p1", outcome: "cancelled" } }),
    );
    expect(screen.queryByText("Pairing request")).toBeNull();
    expect(screen.queryByText("Paired")).toBeNull();
  });

  it("comes forward when a request arrives and leaves when Rust ends it", async () => {
    render(<PairingReview />);
    await settle();
    await act(async () => m.listeners.get("ws-pair-request")?.({ payload: APP }));
    expect(screen.getByText("My bot")).toBeTruthy();
    expect(m.focus).toHaveBeenCalled();
    await act(async () => m.listeners.get("ws-pair-resolved")?.({ payload: { id: "p2" } }));
    expect(screen.queryByText("My bot")).toBeNull();
  });
});
