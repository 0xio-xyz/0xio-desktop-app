// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act as flush, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FeeRead, TrayAction, TraySendProgress, TraySnapshot, TrayState } from "../protocol";
import { FEE_CHANGED, FEE_UNAVAILABLE, SCOPE_CHANGED } from "src/services/transactions/feeCopy";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(event, cb);
    return () => tauri.handlers.delete(event);
  }),
}));

import Cli from "../Cli";
import TrayApp from "../TrayApp";
import { TRAY_THEME_EVENT } from "../useTrayState";

const ok = (ou: number): FeeRead => ({ state: "ok", ou });
const addr = (c: string) => `oct${c.repeat(44)}`;
const snap = (over: Partial<TraySnapshot> = {}): TraySnapshot => ({
  locked: false,
  hasPassword: true,
  biometric: true,
  wallets: [
    { id: "w1", name: "Main", address: addr("A") },
    { id: "w2", name: "Spare", address: addr("S") },
  ],
  activeId: "w1",
  network: "devnet",
  networks: [
    { id: "devnet", name: "Devnet" },
    { id: "mainnet", name: "Mainnet" },
  ],
  privacy: true,
  canSign: true,
  privateReadiness: { state: "ok" },
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
  ...over,
});
const tray = (s: TraySnapshot | null = snap()): TrayState => ({
  snapshot: s,
  clients: 0,
  computing: false,
  computingExtension: false,
  openAtLogin: false,
});

function mount(s: TraySnapshot = snap(), progress: TraySendProgress | null = null) {
  const actions: TrayAction[] = [];
  const act = vi.fn(async (a: TrayAction) => {
    actions.push(a);
    return { ok: true };
  });
  const props = { act, clearProgress: vi.fn() };
  const view = render(<Cli state={tray(s)} progress={progress} {...props} />);
  const input = () => screen.getByRole("textbox", { hidden: true }) as HTMLInputElement;
  const field = () => view.container.querySelector(".cli-in input") as HTMLInputElement;
  const type = async (text: string) => {
    fireEvent.change(field(), { target: { value: text } });
    await flush(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
  };
  const text = () => view.container.querySelector(".cli-scroll")?.textContent ?? "";
  const rerender = (next: TraySnapshot, p: TraySendProgress | null = progress) =>
    view.rerender(<Cli state={tray(next)} progress={p} {...props} />);
  return { ...view, actions, act, type, text, field, input, rerender };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async () => null);
  localStorage.setItem(
    "0xio_address_book_devnet",
    JSON.stringify([{ id: "c1", label: "Bob", address: addr("B"), tags: [], createdAt: 1 }]),
  );
});
afterEach(cleanup);

const sends = (a: TrayAction[]) => a.filter((x) => x.type === "send");

describe("passwords", () => {
  it("never echoes a password cancelled with ctrl+c", async () => {
    const v = mount(snap({ locked: true, wallets: [], activeId: null }));
    await v.type("unlock");
    fireEvent.change(v.field(), { target: { value: "hunter2" } });
    fireEvent.keyDown(v.field(), { key: "c", ctrlKey: true });
    expect(v.text()).not.toContain("hunter2");
  });

  it("does not send an empty password to the rate-limited unlock", async () => {
    const v = mount(snap({ locked: true, wallets: [], activeId: null }));
    await v.type("unlock");
    await v.type("");
    expect(tauri.invoke).not.toHaveBeenCalledWith("tray_unlock", expect.anything());
    expect(v.field().type).toBe("password");
    await v.type("right");
    expect(tauri.invoke).toHaveBeenCalledWith("tray_unlock", { password: "right" });
    expect(v.text()).not.toContain("right");
  });

  it("does not send an empty password to approve a send", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("y");
    const id = (sends(v.actions)[0] as { requestId: string }).requestId;
    v.rerender(snap(), { requestId: id, stage: "needPassword" });
    await v.type("");
    expect(tauri.invoke).not.toHaveBeenCalled();
    await v.type("pw");
    expect(tauri.invoke).toHaveBeenCalledWith("tray_approve_send", {
      requestId: id,
      password: "pw",
    });
  });

  it("does not ask for the approval password while the wallet is locked", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("y");
    const id = (sends(v.actions)[0] as { requestId: string }).requestId;
    v.rerender(snap({ locked: true, wallets: [], activeId: null }), {
      requestId: id,
      stage: "needPassword",
    });
    expect(v.field().type).toBe("text");
    await v.type("hunter2");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("labels the field for what it asks", async () => {
    const v = mount(snap({ locked: true, wallets: [], activeId: null }));
    expect(screen.getByLabelText("Command")).toBeTruthy();
    await v.type("unlock");
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(v.container.querySelector("[role=log]")).not.toBeNull();
  });

  it("offers only the password when Touch ID is off", async () => {
    const v = mount(snap({ locked: true, biometric: false, wallets: [], activeId: null }));
    await v.type("balance");
    expect(v.text()).not.toContain("touchid");
  });
});

describe("review", () => {
  it("signs on yes as well as y", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("yes");
    expect(sends(v.actions)).toHaveLength(1);
  });

  it("lapses when the wallet changes before the answer", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    v.rerender(snap({ activeId: "w2" }));
    await v.type("y");
    expect(sends(v.actions)).toHaveLength(0);
    expect(v.text()).toContain(SCOPE_CHANGED);
  });

  it("lapses when the wallet locks before the answer", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    v.rerender(snap({ locked: true, wallets: [], activeId: null }));
    await v.type("y");
    expect(sends(v.actions)).toHaveLength(0);
  });

  it("lapses when the fee changes before the answer", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    v.rerender(snap({ fees: { ...snap().fees, public: ok(2_000) } }));
    await v.type("y");
    expect(sends(v.actions)).toHaveLength(0);
    expect(v.text()).toContain(FEE_CHANGED);
  });

  it("blocks on a failed fee read with the standard copy and asks again", async () => {
    const v = mount(snap({ fees: { ...snap().fees, public: { state: "error" } } }));
    await v.type("send 1 to bob");
    expect(v.text()).toContain(FEE_UNAVAILABLE);
    expect(v.actions).toContainEqual({ type: "retryReads" });
    expect(sends(v.actions)).toHaveLength(0);
  });

  it("shows the reviewed fee and signs with it", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    expect(v.text()).toContain("1,000 OU");
    await v.type("y");
    expect(sends(v.actions)[0]).toMatchObject({ feeOu: 1_000, walletId: "w1", network: "devnet" });
  });

  it("keeps the full address in its own column", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    const rows = [...v.container.querySelectorAll(".cli-kv.in")].map((r) => r.textContent);
    expect(rows).toContain(`to${"Bob"}`);
    expect(rows).toContain(addr("B"));
  });
});

describe("a fee read again between the review and the answer", () => {
  const read = (ou: number, floor: number): FeeRead => ({ state: "ok", ou, floor });
  const fees = (over: Partial<TraySnapshot["fees"]>) => ({ ...snap().fees, ...over });
  const privates = (a: TrayAction[]) => a.filter((x) => x.type === "private");

  it.each([
    ["the same", read(24_987, 3_000)],
    ["lower", read(23_061, 3_000)],
    ["higher", read(30_047, 3_000)],
  ])("signs the reviewed fee when the recommendation is %s", async (_, now) => {
    const v = mount(snap({ fees: fees({ encrypt: read(24_987, 3_000) }) }));
    await v.type("encrypt 1");
    v.rerender(snap({ fees: fees({ encrypt: now }) }));
    await v.type("y");
    expect(privates(v.actions)).toEqual([expect.objectContaining({ feeOu: 24_987 })]);
    expect(v.text()).not.toContain(FEE_CHANGED);
  });

  it("does not lapse while the fee is loading or failed again", async () => {
    for (const now of [{ state: "loading" }, { state: "error" }] as FeeRead[]) {
      cleanup();
      const v = mount();
      await v.type("send 1 to bob");
      v.rerender(snap({ fees: fees({ public: now }) }));
      await v.type("y");
      expect(sends(v.actions)).toEqual([expect.objectContaining({ feeOu: 1_000 })]);
    }
  });

  it("shows the review again with the new fee when the node needs more, then signs on y", async () => {
    const v = mount(snap({ fees: fees({ encrypt: read(24_987, 3_000) }) }));
    await v.type("encrypt 1");
    v.rerender(snap({ fees: fees({ encrypt: read(40_000, 30_000) }) }));
    await v.type("y");
    expect(privates(v.actions)).toHaveLength(0);
    expect(v.text()).toContain(FEE_CHANGED);
    expect(v.text()).toContain("40,000 OU");
    await v.type("y");
    expect(privates(v.actions)).toEqual([expect.objectContaining({ feeOu: 40_000 })]);
  });

  it("checks each part of a summed fee against its own read", async () => {
    const due = { privateReadiness: { state: "needsRefresh" } } as const;
    const first = fees({ encrypt: read(24_987, 3_000), refresh: read(42_099, 3_000) });
    const v = mount(snap({ ...due, fees: first }));
    await v.type("encrypt 1");
    expect(v.text()).toContain("67,086 OU (2 transactions)");
    v.rerender(snap({ ...due, fees: { ...first, encrypt: read(49_107, 3_000) } }));
    await v.type("y");
    expect(privates(v.actions)).toEqual([
      expect.objectContaining({ refresh: true, feeOu: 24_987, refreshFeeOu: 42_099 }),
    ]);
  });

  it("lapses a summed fee when one part's floor rose above it", async () => {
    const due = { privateReadiness: { state: "needsRefresh" } } as const;
    const first = fees({ encrypt: read(24_987, 3_000), refresh: read(42_099, 3_000) });
    const v = mount(snap({ ...due, fees: first }));
    await v.type("encrypt 1");
    v.rerender(snap({ ...due, fees: { ...first, refresh: read(60_000, 50_000) } }));
    await v.type("y");
    expect(privates(v.actions)).toHaveLength(0);
    expect(v.text()).toContain("84,987 OU (2 transactions)");
  });

  it("lapses an encrypt when the planned refresh is no longer due", async () => {
    const v = mount(snap({ privateReadiness: { state: "needsRefresh" } }));
    await v.type("encrypt 1");
    v.rerender(snap());
    await v.type("y");
    expect(privates(v.actions)).toHaveLength(0);
    expect(v.text()).toContain("ready. type migrate or private");
  });
});

describe("private send gating", () => {
  const due = { state: "needsRefresh" } as const;
  it.each([
    [due, "a refresh is due (migrate)"],
    [
      { state: "keyUpdate", mode: "key_bound_migration", amountMicro: 1, fee: ok(1) },
      "needs to move to your current encryption key (migrate)",
    ],
    [{ state: "noKey", setup: { state: "offer", feeOu: 1_000 } }, "off (migrate turns it on)"],
    [{ state: "waiting", reason: "refreshPending" }, "refresh waiting for the network"],
    [
      { state: "blocked", reason: "keyBlocked", detail: "Held by the network" },
      "Held by the network",
    ],
    [{ state: "stuck", reason: "pastCap", detail: "Past the layer limit" }, "Past the layer limit"],
    [{ state: "checking" }, "checking"],
  ] as [TraySnapshot["privateReadiness"], string][])(
    "refuses a private send before the review when %j",
    async (readiness, copy) => {
      const v = mount(snap({ privateReadiness: readiness }));
      await v.type("send 1 to bob privately");
      expect(v.text()).toContain(`${copy}. type migrate or private`);
      expect(v.text()).not.toContain("review");
      await v.type("y");
      expect(sends(v.actions)).toHaveLength(0);
    },
  );

  it("reviews a private send while the balance is ready", async () => {
    const v = mount();
    await v.type("send 1 to bob privately");
    await v.type("y");
    expect(sends(v.actions)[0]).toMatchObject({ mode: "private", feeOu: 1_000_000 });
  });

  it("lapses a reviewed private send when a migration becomes due", async () => {
    const v = mount();
    await v.type("send 1 to bob privately");
    v.rerender(snap({ privateReadiness: due }));
    await v.type("y");
    expect(sends(v.actions)).toHaveLength(0);
    expect(v.text()).toContain("a refresh is due (migrate). type migrate or private");
  });

  it("leaves public sends alone", async () => {
    const v = mount(snap({ privateReadiness: due }));
    await v.type("send 1 to bob");
    await v.type("y");
    expect(sends(v.actions)[0]).toMatchObject({ mode: "public" });
  });
});

describe("jobs", () => {
  it("does not claim a cancel once the transaction is sending", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("y");
    const id = (sends(v.actions)[0] as { requestId: string }).requestId;
    v.rerender(snap(), { requestId: id, stage: "sending", steps: ["Signing", "Sending"] });
    fireEvent.keyDown(v.field(), { key: "c", ctrlKey: true });
    expect(v.actions.some((a) => a.type === "cancelSend")).toBe(false);
    expect(v.text()).not.toContain("send 1 OCT: cancelled");
    v.rerender(snap(), { requestId: id, stage: "sent" });
    await v.type("balance");
    expect(v.text()).toContain("sent 1 OCT to Bob");
  });

  it("cancels while the approval is still waiting", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("y");
    const id = (sends(v.actions)[0] as { requestId: string }).requestId;
    v.rerender(snap(), { requestId: id, stage: "approving" });
    fireEvent.keyDown(v.field(), { key: "c", ctrlKey: true });
    expect(v.actions).toContainEqual({ type: "cancelSend", requestId: id });
  });

  it("refuses a second signing command while one runs, and keeps the first", async () => {
    const v = mount();
    await v.type("send 1 to bob");
    await v.type("y");
    await v.type("send 2 to bob");
    await v.type("use 2");
    expect(sends(v.actions)).toHaveLength(1);
    expect(v.actions.some((a) => a.type === "switchWallet")).toBe(false);
    expect(v.text()).toContain("still running");
    expect(v.container.querySelector(".cli-job")).not.toBeNull();
    await v.type("balance");
    expect(v.text()).toContain("total");
  });
});

describe("input", () => {
  it("names the unknown command after the 0xio prefix", async () => {
    const v = mount();
    await v.type("0xio foo");
    expect(v.text()).toContain("command not found: foo");
  });

  it("keeps a typed line when down is pressed at the bottom of the history", async () => {
    const v = mount();
    await v.type("balance");
    fireEvent.change(v.field(), { target: { value: "send 1" } });
    fireEvent.keyDown(v.field(), { key: "ArrowDown" });
    expect(v.field().value).toBe("send 1");
    fireEvent.keyDown(v.field(), { key: "ArrowUp" });
    expect(v.field().value).toBe("balance");
    fireEvent.keyDown(v.field(), { key: "ArrowDown" });
    expect(v.field().value).toBe("");
  });

  it("says no wallet rather than watch-only when there is none", async () => {
    const v = mount(snap({ wallets: [], activeId: null }));
    await v.type("send 1 to bob");
    expect(v.text()).not.toContain("watch-only");
  });
});

describe("the panel around the CLI", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-tray", "cli");
    tauri.invoke.mockImplementation(async (cmd: string) =>
      cmd === "tray_get_state" ? tray() : { ok: true },
    );
  });
  const app = async () => {
    const view = render(<TrayApp />);
    await flush(async () => {});
    const field = () => view.container.querySelector(".cli-in input") as HTMLInputElement;
    const type = async (text: string) => {
      fireEvent.change(field(), { target: { value: text } });
      await flush(async () => {
        fireEvent.keyDown(field(), { key: "Enter" });
      });
    };
    const actions = () =>
      tauri.invoke.mock.calls
        .filter(([c]) => c === "tray_action")
        .map(([, a]) => (a as { action: TrayAction }).action);
    return { ...view, field, type, actions };
  };

  it("clears on ctrl+l without locking the wallet", async () => {
    const v = await app();
    fireEvent.keyDown(v.field(), { key: "l", ctrlKey: true });
    expect(v.actions()).not.toContainEqual({ type: "lock" });
  });

  it("keeps the history and a running job when the panel opens again", async () => {
    const v = await app();
    await v.type("send 1 to bob");
    await v.type("y");
    const id = (v.actions().find((a) => a.type === "send") as { requestId: string }).requestId;
    await v.type("send 2 to bob");
    await flush(async () => tauri.handlers.get("tray-opened")?.({ payload: null }));
    expect(v.container.querySelector(".cli-job")).not.toBeNull();
    await flush(async () =>
      tauri.handlers.get("tray-progress")?.({ payload: { requestId: id, stage: "needPassword" } }),
    );
    expect(v.field().type).toBe("password");
    fireEvent.keyDown(v.field(), { key: "c", ctrlKey: true });
    fireEvent.keyDown(v.field(), { key: "ArrowUp" });
    expect(v.field().value).toBe("send 2 to bob");
  });

  it("keeps the scrollback through a theme switch and back", async () => {
    const v = await app();
    await v.type("theme smoke");
    const set = (t: string) =>
      flush(async () => {
        document.documentElement.setAttribute("data-tray", t);
        window.dispatchEvent(new Event(TRAY_THEME_EVENT));
      });
    await set("smoke");
    expect(v.container.querySelector(".cli")).toBeNull();
    await set("cli");
    expect(v.container.querySelector(".cli-scroll")?.textContent).toContain("theme smoke");
  });

  it("drops an unanswered review when the panel opens again", async () => {
    const v = await app();
    await v.type("send 1 to bob");
    await flush(async () => tauri.handlers.get("tray-opened")?.({ payload: null }));
    await v.type("y");
    expect(v.actions().some((a) => a.type === "send")).toBe(false);
  });
});
