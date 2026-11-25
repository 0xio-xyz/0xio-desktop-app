// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  APP,
  getNotices,
  markAllRead,
  markRead,
  record,
  resetNotices,
  resolve,
  resolveMissing,
  scopeOf,
  viewOf,
  type Notice,
} from "src/services/notices/notifications";
import { announce, setNative } from "src/services/notices/noticeNative";
import { getActivity, resetActivity, toast } from "src/services/notices/activity";
import { claimNotice, receivedNotice, siteNotice } from "src/hooks/app/useNoticeSources";
import { ageText } from "src/shared/layout/NoticePanel";
import type { Transaction } from "src/types/transaction";

const A = `oct${"A".repeat(44)}`;
const B = `oct${"B".repeat(44)}`;
const MINE = scopeOf("mainnet", A);
const OTHER = scopeOf("mainnet", B);
const DEV = scopeOf("devnet", A);

const base = (id: string, scope: string, kind: Notice["kind"] = "result") => ({
  id,
  kind,
  scope,
  title: "notices.received",
  action: { kind: "privacy" as const },
});

beforeEach(() => {
  resetNotices();
  resetActivity();
  invoke.mockClear();
  localStorage.clear();
  for (const g of ["claims", "pairs", "results", "incoming", "security"] as const)
    setNative(g, false);
});
afterEach(() => vi.useRealTimers());

describe("the store", () => {
  it("shows the open wallet and network and app notices, and counts the others", () => {
    record(base("a", MINE));
    record(base("b", OTHER));
    record(base("c", DEV));
    record(base("d", APP, "update"));
    const v = viewOf(getNotices(), MINE);
    expect(v.list.map((n) => n.id).sort()).toEqual(["a", "d"]);
    expect(v.others).toBe(2);
  });

  it("records an event once and keeps its read state when it comes again", () => {
    expect(record(base("a", MINE))).toBe(true);
    markRead("a");
    expect(record(base("a", MINE))).toBe(false);
    expect(getNotices()).toHaveLength(1);
    expect(getNotices()[0].read).toBe(true);
  });

  it("Mark all read covers this wallet and network and the app, not the others", () => {
    record(base("a", MINE));
    record(base("b", OTHER));
    record(base("d", APP, "update"));
    markAllRead(MINE);
    const read = Object.fromEntries(getNotices().map((n) => [n.id, n.read]));
    expect(read).toEqual({ a: true, b: false, d: true });
  });

  it("keeps the newest 200 and drops what is older than 90 days", () => {
    const now = Date.now();
    record({ ...base("old", MINE), at: now - 91 * 24 * 60 * 60 * 1000 });
    for (let i = 0; i < 205; i++) record({ ...base(`n${i}`, MINE), at: now - i });
    expect(getNotices()).toHaveLength(200);
    expect(getNotices().some((n) => n.id === "old")).toBe(false);
    expect(getNotices()[0].id).toBe("n0");
  });

  it("resolves notices whose cause went away", () => {
    record(base("claim:1", MINE, "claim"));
    record(base("claim:2", MINE, "claim"));
    record(base("claim:3", OTHER, "claim"));
    resolveMissing("claim", MINE, new Set(["claim:2"]));
    expect(
      getNotices()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["claim:2", "claim:3"]);
    resolve("claim:2");
    expect(getNotices().map((n) => n.id)).toEqual(["claim:3"]);
  });
});

describe("the bell count", () => {
  it("counts only unread notices that need the user", () => {
    for (const k of ["claim", "failed", "site", "pair", "update"] as const)
      record(base(k, MINE, k));
    for (const k of ["received", "result", "touchId", "keyHold"] as const) record(base(k, MINE, k));
    expect(viewOf(getNotices(), MINE).count).toBe(5);
    markRead("claim");
    expect(viewOf(getNotices(), MINE).count).toBe(4);
    markAllRead(MINE);
    expect(viewOf(getNotices(), MINE).count).toBe(0);
  });
});

describe("macOS notifications", () => {
  it("posts a new notice once when its group is on", () => {
    setNative("claims", true);
    announce(base("c1", MINE, "claim"));
    announce(base("c1", MINE, "claim"));
    announce(base("r1", MINE, "received"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "notice_post",
      expect.objectContaining({ title: expect.any(String) }),
    );
  });
});

describe("sources", () => {
  const tx = (over: Partial<Transaction>): Transaction => ({
    hash: "h1",
    type: "receive",
    amount: 42_500_000,
    fee: 0,
    from: B,
    to: A,
    timestamp: 2_000,
    status: "confirmed",
    ...over,
  });

  it("an incoming transfer after watching began, with View", () => {
    const n = receivedNotice(tx({}), MINE, "mainnet", 1_000_000)!;
    expect(n).toMatchObject({
      id: `received:${MINE}:h1`,
      kind: "received",
      who: B,
      values: { amount: 42_500_000 },
      action: { kind: "view", hash: "h1", network: "mainnet" },
    });
    expect(receivedNotice(tx({ timestamp: 900 }), MINE, "mainnet", 1_000_000)).toBeNull();
    expect(receivedNotice(tx({ type: "send" }), MINE, "mainnet", 0)).toBeNull();
    expect(receivedNotice(tx({ status: "pending" }), MINE, "mainnet", 0)).toBeNull();
  });

  it("a private transfer waiting, with Claim", () => {
    expect(claimNotice({ id: 9, amount: 250_000_000, sender: B }, MINE)).toMatchObject({
      id: `claim:${MINE}:9`,
      kind: "claim",
      who: B,
      action: { kind: "claim" },
    });
  });

  it("a site request waiting, app wide, with Review", () => {
    expect(siteNotice({ id: "r1", origin: "https://dex.0xio.xyz", createdAt: 5 })).toMatchObject({
      id: "site:r1",
      kind: "site",
      scope: APP,
      at: 5,
      values: { site: "dex.0xio.xyz" },
      action: { kind: "site", id: "r1" },
    });
  });

  it("a result toast with a wallet and network becomes a notice; a plain message does not", () => {
    toast({
      title: "activity.sent",
      values: { amount: 1 },
      who: B,
      view: { hash: "h2", network: "mainnet" },
      scope: { networkId: "mainnet", address: A },
    });
    toast({
      title: "activity.sendFailed",
      failed: true,
      retry: { route: "/send", ref: "public" },
      scope: { networkId: "mainnet", address: A },
    });
    toast({ title: "", text: "Copied", tone: "success" });
    const list = viewOf(getNotices(), MINE).list;
    expect(list.map((n) => [n.kind, n.action.kind]).sort()).toEqual([
      ["failed", "retry"],
      ["result", "view"],
    ]);
    expect(getActivity().toasts).toHaveLength(3);
  });
});

describe("ageText", () => {
  const t = (k: string, o?: Record<string, unknown>) => (o?.count != null ? `${k}:${o.count}` : k);
  it("reads in the coarsest unit", () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime();
    expect(ageText(t, now - 20_000, now)).toBe("notices.now");
    expect(ageText(t, now - 5 * 60_000, now)).toBe("notices.minutes:5");
    expect(ageText(t, now - 3 * 3600_000, now)).toBe("notices.hours:3");
    expect(ageText(t, new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe("notices.yesterday");
  });
});
