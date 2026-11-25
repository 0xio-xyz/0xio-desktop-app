// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act as flush, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "src/i18n";
import type { FeeRead, TraySnapshot, TrayState } from "../protocol";

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
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));

import TrayApp from "../TrayApp";
import {
  closesPanel,
  groupBySite,
  initialView,
  kindOf,
  nextView,
  noticeKey,
  verbKey,
  type SiteItem,
} from "../siteQueue";

const ADDR = `oct${"A".repeat(44)}`;
const ok = (ou: number): FeeRead => ({ state: "ok", ou });
const snap = (locked = false): TraySnapshot => ({
  locked,
  hasPassword: true,
  biometric: true,
  wallets: [{ id: "w1", name: "Spending", address: ADDR }],
  activeId: "w1",
  network: "mainnet",
  networks: [{ id: "mainnet", name: "Mainnet" }],
  privacy: false,
  canSign: true,
  privateReadiness: { state: "ok" },
  publicMicro: 1,
  privateMicro: 0,
  claims: 0,
  fees: { public: ok(1), private: ok(1), encrypt: ok(1), decrypt: ok(1), refresh: ok(1) },
});
const tray = (locked = false): TrayState => ({
  snapshot: snap(locked),
  clients: 1,
  computing: false,
  computingExtension: false,
  openAtLogin: false,
});

let at = 1_000;
const item = (id: string, origin: string, over: Partial<SiteItem> = {}): SiteItem => ({
  id,
  origin,
  topOrigin: null,
  framed: false,
  browser: "chrome",
  clientId: "c1",
  network: "mainnet",
  method: "connect",
  createdAt: at++,
  stage: "review",
  review: { type: "connect", wallet: { name: "Spending", address: ADDR } },
  tabs: 1,
  ...over,
});
const send = (id: string, origin: string, over: Partial<SiteItem> = {}) =>
  item(id, origin, {
    method: "send_transaction",
    review: {
      type: "transaction",
      wallet: { name: "Spending", address: ADDR },
      to: `oct${"B".repeat(44)}`,
      amount: "12.5 OCT",
      ou: "1000",
    },
    ...over,
  });

async function open(items: SiteItem[], locked = false) {
  tauri.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "tray_get_state") return tray(locked);
    if (cmd === "site_queue") return { items };
    return null;
  });
  const view = render(<TrayApp />);
  await flush(async () => {});
  return view;
}

const queue = (items: SiteItem[]) =>
  flush(async () => tauri.handlers.get("site-queue")?.({ payload: { items } }));
const calls = (cmd: string) => tauri.invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.handlers.clear();
});
afterEach(cleanup);

describe("the site queue", () => {
  it("groups by site in arrival order", () => {
    const a1 = item("1", "https://a.com");
    const b1 = item("2", "https://b.com");
    const a2 = send("3", "https://a.com");
    const groups = groupBySite([a2, b1, a1]);
    expect(groups.map((g) => g.origin)).toEqual(["https://a.com", "https://b.com"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("opens on the request it was opened for, the only one, or the list", () => {
    const a = item("1", "https://a.com");
    const b = item("2", "https://b.com");
    expect(initialView([a], null)).toEqual({ kind: "review", id: "1" });
    expect(initialView([a, b], "2")).toEqual({ kind: "review", id: "2" });
    expect(initialView([a, b], null)).toEqual({ kind: "list" });
    expect(nextView({ kind: "review", id: "1" }, [a, b])).toEqual({ kind: "review", id: "1" });
    expect(nextView({ kind: "review", id: "1" }, [b])).toEqual({ kind: "list" });
    expect(closesPanel([], true, false)).toBe(true);
    expect(closesPanel([], false, false)).toBe(false);
    expect(closesPanel([], true, true)).toBe(false);
    expect(closesPanel([b], true, false)).toBe(false);
  });

  it("names the verb of each request, never a slide", () => {
    expect(verbKey(item("1", "https://a.com"))).toBe("relay.verbConnect");
    expect(verbKey(send("1", "https://a.com"))).toBe("relay.verbSend");
    expect(kindOf({ method: "signMessage", review: null })).toBe("sign");
    expect(
      kindOf({
        method: "switch_network",
        review: { type: "network", wallet: null, fromName: "Mainnet", toName: "Devnet" },
      }),
    ).toBe("switch");
    expect(
      kindOf({
        method: "claim_private_transfer",
        review: { type: "transaction", wallet: null, method: "claim_private" },
      }),
    ).toBe("claim");
  });

  it("writes the notification line with the full origin and the request type", () => {
    const origin = "https://app.octradex.xyz";
    const line = (item: Parameters<typeof noticeKey>[0]) => i18n.t(noticeKey(item), { origin });
    expect(
      line({
        method: "sign_transaction",
        review: { type: "transaction", wallet: null, method: "sign_only" },
      }),
    ).toBe("https://app.octradex.xyz wants you to sign a transaction");
    expect(line({ method: "connect", review: null })).toBe(
      "https://app.octradex.xyz wants to connect",
    );
    expect(line({ method: "switch_network", review: null })).toBe(
      "https://app.octradex.xyz wants to switch network",
    );
  });
});

describe("site requests in the panel", () => {
  it("shows the first request on its review with the full origin, the wallet and the extension", async () => {
    await open([item("1", "https://vaulta.euints.com")]);
    expect(screen.getByText("Connect to this site")).toBeTruthy();
    expect(screen.getByText("https://vaulta.euints.com")).toBeTruthy();
    expect(screen.getByText("0xio extension (Chrome)")).toBeTruthy();
    expect(screen.getAllByText("Spending").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush(async () => {});
    expect(calls("site_answer")).toEqual([{ id: "1" }]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await flush(async () => {});
    expect(calls("site_reject")).toEqual([{ ids: ["1"] }]);
  });

  it("names a site that connected straight from the browser in place of the extension", async () => {
    await open([item("1", "https://app.octradex.xyz", { browser: "web", clientId: "direct" })]);
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Direct from browser")).toBeTruthy();
    expect(screen.queryByText(/0xio extension/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("groups a direct site apart and names it in the list", async () => {
    await open([
      item("1", "https://a.com", { browser: "web", clientId: "direct" }),
      send("2", "https://a.com"),
    ]);
    expect(
      groupBySite([item("1", "https://a.com", { browser: "web" }), send("2", "https://a.com")])
        .length,
    ).toBe(2);
    expect(screen.getByText("Direct from browser")).toBeTruthy();
    expect(screen.getByText("Chrome")).toBeTruthy();
  });

  it("shows the page a framed site sits in", async () => {
    await open([
      send("1", "https://checkout.octpay.xyz", {
        framed: true,
        topOrigin: "https://vaulta.euints.com",
      }),
    ]);
    expect(screen.getByText("On page")).toBeTruthy();
    expect(screen.getByText("https://vaulta.euints.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("a later request only adds to the queue; the open review stays", async () => {
    const first = item("1", "https://a.com");
    await open([first]);
    await queue([first, send("2", "https://b.com")]);
    expect(screen.getByText("Connect to this site")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Requests/ })).toBeTruthy();
  });

  it("lists two or more by site, merges connects, and rejects all of one site", async () => {
    await open([
      item("1", "https://vaulta.euints.com", { tabs: 2 }),
      send("2", "https://vaulta.euints.com"),
      item("3", "https://app.octradex.xyz", {
        method: "signMessage",
        review: { type: "sign", wallet: null, message: "hi" },
      }),
    ]);
    expect(screen.getByText("Requests")).toBeTruthy();
    const vaulta = screen.getByRole("region", { name: "vaulta.euints.com" });
    expect(within(vaulta).getByText("2 tabs")).toBeTruthy();
    expect(within(vaulta).getByText("12.5 OCT")).toBeTruthy();
    expect(within(vaulta).getAllByText("Chrome").length).toBe(1);
    fireEvent.click(within(vaulta).getByRole("button", { name: "Reject all" }));
    await flush(async () => {});
    expect(calls("site_reject")).toEqual([{ ids: ["1", "2"] }]);
  });

  it("opens on the clicked site's review, or brings its group into view", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("aria-label") ?? "");
    };
    const items = [
      item("1", "https://a.com"),
      send("2", "https://b.com"),
      send("3", "https://b.com"),
    ];
    await open(items);
    const click = (id: string | null, origin: string) =>
      flush(async () => {
        tauri.handlers.get("site-focus")?.({ payload: { id, origin } });
        tauri.handlers.get("tray-opened")?.({ payload: null });
      });
    await click(null, "https://b.com");
    expect(screen.getByText("Requests")).toBeTruthy();
    expect(scrolled).toEqual(["b.com"]);
    await click("1", "https://a.com");
    expect(screen.getByText("Connect to this site")).toBeTruthy();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("a review opened from the list goes back to it, and lands there when answered", async () => {
    const a = item("1", "https://a.com");
    const b = send("2", "https://b.com");
    await open([a, b]);
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(screen.getByText("12.5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Requests/ }));
    expect(screen.getByText("Requests")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await queue([a]);
    expect(screen.getByText("Requests")).toBeTruthy();
  });

  it("closes the panel when the last answer is given here", async () => {
    const a = item("1", "https://a.com");
    await open([a]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await flush(async () => {});
    await queue([]);
    expect(calls("tray_hide")).toHaveLength(1);
  });

  it("asks to unlock first and shows the waiting site", async () => {
    await open([item("1", "https://vaulta.euints.com", { stage: "unlock", review: null })], true);
    expect(screen.getByText("0xio is locked")).toBeTruthy();
    expect(screen.getByText("vaulta.euints.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });
});

describe("a site review shows what is signed or granted, in full", () => {
  const C1 = `oct${"C".repeat(44)}`;
  const C2 = `oct${"D".repeat(44)}`;
  const args = `["${ADDR}","5",7,"${"q".repeat(300)}"]`;

  it("a sequence lists every step with its contract, method, amount and exact args", async () => {
    await open([
      item("1", "https://dex.example", {
        method: "send_contract_transaction_sequence",
        review: {
          type: "transaction",
          wallet: { name: "Spending", address: ADDR },
          amount: "1.5 OCT",
          ou: "2000",
          steps: [
            { contract: C1, method: "approve", args, amount: "1 OCT" },
            { contract: C2, method: "swap", args: "[true]", amount: "0.5 OCT" },
          ],
        },
      }),
    ]);
    expect(screen.getByText("Run contract calls")).toBeTruthy();
    expect(screen.getByText("1.5")).toBeTruthy();
    const one = screen.getByRole("region", { name: "Step 1" });
    expect(within(one).getByText("approve")).toBeTruthy();
    expect(within(one).getByText("1 OCT")).toBeTruthy();
    expect(within(one).getByText(args)).toBeTruthy();
    const two = screen.getByRole("region", { name: "Step 2" });
    expect(within(two).getByText("swap")).toBeTruthy();
    expect(within(two).getByText("0.5 OCT")).toBeTruthy();
    expect(within(two).getByText("[true]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("a contract call shows its exact args", async () => {
    await open([
      item("1", "https://dex.example", {
        method: "call_contract",
        review: {
          type: "transaction",
          wallet: { name: "Spending", address: ADDR },
          to: C1,
          contract: C1,
          method: "transfer",
          amount: "0 OCT",
          args,
          ou: "1000",
        },
      }),
    ]);
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText(args)).toBeTruthy();
  });

  it("a signed transaction shows its memo", async () => {
    await open([
      item("1", "https://dex.example", {
        method: "sign_transaction",
        review: {
          type: "transaction",
          wallet: { name: "Spending", address: ADDR },
          to: C1,
          amount: "1 OCT",
          method: "sign_only",
          message: "invoice 42",
          ou: "1000",
        },
      }),
    ]);
    expect(screen.getByText("Memo")).toBeTruthy();
    expect(screen.getByText("invoice 42")).toBeTruthy();
  });

  it("a connect lists each scope it grants, private ones too", async () => {
    await open([
      item("1", "https://dex.example", {
        review: {
          type: "connect",
          wallet: { name: "Spending", address: ADDR },
          scopes: ["accounts", "private_transfers", "private_balance_read"],
        },
      }),
    ]);
    expect(screen.getByText("Access")).toBeTruthy();
    expect(screen.getByText("Address and balance")).toBeTruthy();
    expect(screen.getByText("Private transfers")).toBeTruthy();
    expect(screen.getByText("Private balance")).toBeTruthy();
  });
});
