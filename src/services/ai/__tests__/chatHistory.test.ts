import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ files: new Map<string, Map<string, unknown>>(), saves: 0 }));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (path: string) => {
    const pending = new Map(m.files.get(path) ?? []);
    return {
      get: async (k: string) => pending.get(k),
      set: async (k: string, v: unknown) => void pending.set(k, structuredClone(v)),
      delete: async (k: string) => pending.delete(k),
      save: async () => {
        m.saves++;
        m.files.set(path, new Map(pending));
      },
    };
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Mod = typeof import("src/services/ai/chatHistory");
const fresh = async (): Promise<Mod> => {
  vi.resetModules();
  return import("src/services/ai/chatHistory");
};

const q = (content: string) => ({ role: "user" as const, content });
const a = (content: string, failed?: boolean) => ({
  role: "assistant" as const,
  content,
  ...(failed ? { failed } : {}),
});

const fileOf = async (project: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(project));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `ai-chats/${hex.slice(0, 32)}.json`;
};

beforeEach(() => {
  m.files.clear();
  m.saves = 0;
  vi.useRealTimers();
});

describe("saved chats", () => {
  it("restores saved chats after a restart, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const one = await fresh();
    await one.saveChat("disk:/p1", "a", [q("first"), a("1")]);
    vi.setSystemTime(2000);
    await one.saveChat("disk:/p1", "b", [q("second"), a("2")]);
    const two = await fresh();
    expect(two.peekChats("disk:/p1")).toBeUndefined();
    const chats = await two.loadChats("disk:/p1");
    expect(chats.map((c) => c.id)).toEqual(["b", "a"]);
    expect(chats[1]).toEqual({
      id: "a",
      title: "first",
      created: 1000,
      updated: 1000,
      messages: [q("first"), a("1")],
    });
    expect(two.peekChats("disk:/p1")).toBe(chats);
  });

  it("moves the moved-on chat to the top and keeps its title and creation time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const s = await fresh();
    await s.saveChat("local", "a", [q("  Find   bugs\nin vault  "), a("1")]);
    vi.setSystemTime(2000);
    await s.saveChat("local", "b", [q("other"), a("2")]);
    vi.setSystemTime(3000);
    await s.saveChat("local", "a", [q("Find bugs in vault"), a("1"), q("more"), a("3")]);
    const [top, next] = s.peekChats("local")!;
    expect(top).toMatchObject({
      id: "a",
      title: "Find bugs in vault",
      created: 1000,
      updated: 3000,
    });
    expect(top.messages).toHaveLength(4);
    expect(next.id).toBe("b");
  });

  it("keeps each project separate and does not name the file after the path", async () => {
    const s = await fresh();
    await s.saveChat("disk:/p1", "x", [q("one"), a("1")]);
    await s.saveChat("local", "y", [q("two"), a("2")]);
    const r = await fresh();
    expect((await r.loadChats("disk:/p1")).map((c) => c.title)).toEqual(["one"]);
    expect((await r.loadChats("local")).map((c) => c.title)).toEqual(["two"]);
    expect(await r.loadChats("disk:/other")).toEqual([]);
    expect(m.files.size).toBe(2);
    for (const path of m.files.keys()) expect(path).toMatch(/^ai-chats\/[0-9a-f]{32}\.json$/);
  });

  it("moves the single saved chat of an older version into the list without losing it", async () => {
    const path = await fileOf("local");
    const old = [q("old question"), a("old answer"), q("follow up"), a("more")];
    m.files.set(path, new Map<string, unknown>([["messages", old]]));
    const s = await fresh();
    const chats = await s.loadChats("local");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ title: "old question", messages: old });
    expect(typeof chats[0].id).toBe("string");
    await vi.waitFor(() => expect(m.files.get(path)!.has("messages")).toBe(false));
    expect(m.files.get(path)!.get("chats")).toEqual(chats);

    const r = await fresh();
    const again = await r.loadChats("local");
    expect(again).toEqual(chats);
  });

  it("ignores an empty or broken old chat", async () => {
    const path = await fileOf("local");
    m.files.set(path, new Map<string, unknown>([["messages", [{ role: "user" }, "x", a("")]]]));
    const s = await fresh();
    expect(await s.loadChats("local")).toEqual([]);
  });

  it("saving before the first load keeps what is on disk", async () => {
    const one = await fresh();
    await one.saveChat("local", "a", [q("kept"), a("1")]);
    const two = await fresh();
    await two.saveChat("local", "b", [q("new"), a("2")]);
    const r = await fresh();
    expect((await r.loadChats("local")).map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("a new chat keeps the old one", async () => {
    const s = await fresh();
    await s.saveChat("local", "a", [q("hi"), a("hello")]);
    await s.saveChat("local", "b", [q("again"), a("yes")]);
    const r = await fresh();
    expect((await r.loadChats("local")).map((c) => c.title).sort()).toEqual(["again", "hi"]);
  });

  it("deletes one chat and leaves the others", async () => {
    const s = await fresh();
    await s.saveChat("local", "a", [q("hi"), a("hello")]);
    await s.saveChat("local", "b", [q("again"), a("yes")]);
    await s.deleteChat("local", "a");
    expect(s.peekChats("local")!.map((c) => c.id)).toEqual(["b"]);
    const r = await fresh();
    expect((await r.loadChats("local")).map((c) => c.id)).toEqual(["b"]);
    await r.deleteChat("local", "b");
    const path = await fileOf("local");
    expect(m.files.get(path)!.has("chats")).toBe(false);
  });

  it("drops failed and empty replies with their question but keeps a stopped partial one", async () => {
    const s = await fresh();
    await s.saveChat("local", "a", [
      q("ok"),
      a("fine"),
      q("broken"),
      a("half\n\nanthropic API error: 500", true),
      q("stopped early"),
      a(""),
      q("stopped late"),
      a("partial answ"),
    ]);
    const r = await fresh();
    expect((await r.loadChats("local"))[0].messages).toEqual([
      q("ok"),
      a("fine"),
      q("stopped late"),
      a("partial answ"),
    ]);
  });

  it("does not store a chat whose only reply failed", async () => {
    const s = await fresh();
    await s.saveChat("local", "a", [q("broken"), a("error", true)]);
    expect(s.peekChats("local")).toEqual([]);
  });

  it("stores only role and content", async () => {
    const s = await fresh();
    await s.saveChat("local", "a", [
      { role: "system", content: "file" },
      { ...q("hi"), apiKey: "sk-test" } as never,
      a("hello"),
    ]);
    const stored = JSON.stringify([...m.files.values()].map((f) => [...f.entries()]));
    expect(stored).not.toContain("sk-test");
    expect(stored).not.toContain("file");
    const msgs = s.peekChats("local")![0].messages;
    for (const msg of msgs) expect(Object.keys(msg).sort()).toEqual(["content", "role"]);
  });

  it("caps each chat by count and size, dropping the oldest and starting on a question", async () => {
    const s = await fresh();
    const many = Array.from({ length: 80 }, (_, i) => [q(`q${i}`), a(`a${i}`)]).flat();
    await s.saveChat("local", "a", many);
    const kept = s.peekChats("local")![0].messages;
    expect(kept).toHaveLength(s.MAX_MESSAGES);
    expect(kept[0]).toEqual(q("q30"));
    expect(kept[kept.length - 1]).toEqual(a("a79"));

    const big = Array.from({ length: 12 }, (_, i) => [q(`q${i}`), a("x".repeat(50_000))]).flat();
    await s.saveChat("local", "b", big);
    const capped = s.peekChats("local")![0].messages;
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(s.MAX_CHARS);
    expect(capped[0].role).toBe("user");
    expect(capped[capped.length - 1]).toEqual(big[big.length - 1]);
  });

  it("caps the number of chats per project, dropping the least recently used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = await fresh();
    for (let i = 0; i < s.MAX_CHATS + 5; i++) {
      vi.setSystemTime(1000 + i);
      await s.saveChat("local", `c${i}`, [q(`q${i}`), a(`a${i}`)]);
    }
    const chats = s.peekChats("local")!;
    expect(chats).toHaveLength(s.MAX_CHATS);
    expect(chats[0].id).toBe(`c${s.MAX_CHATS + 4}`);
    expect(chats.some((c) => c.id === "c4")).toBe(false);
    expect(chats.some((c) => c.id === "c5")).toBe(true);
  });

  it("caps the total size per project and never drops the chat just saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = await fresh();
    const chunk = [q("big"), a("x".repeat(400_000))];
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(1000 + i);
      await s.saveChat("local", `c${i}`, chunk);
    }
    const chats = s.peekChats("local")!;
    expect(JSON.stringify(chats).length).toBeLessThanOrEqual(s.MAX_PROJECT_CHARS);
    expect(chats[0].id).toBe("c7");
    expect(chats.length).toBeLessThan(8);
  });

  it("writes in order so the last save wins", async () => {
    const s = await fresh();
    void s.saveChat("local", "a", [q("first"), a("1")]);
    await s.saveChat("local", "a", [q("first"), a("1"), q("second"), a("2")]);
    const r = await fresh();
    expect((await r.loadChats("local"))[0].messages).toHaveLength(4);
  });
});

describe("day groups", () => {
  const at = (d: number, h = 12) => new Date(2026, 10, d, h, 0).getTime();
  const now = at(25, 14);

  it("groups by calendar day: today, yesterday, previous 7 days, older", async () => {
    const s = await fresh();
    expect(s.dayGroup(at(25, 0), now)).toBe("today");
    expect(s.dayGroup(at(24, 23), now)).toBe("yesterday");
    expect(s.dayGroup(at(23, 1), now)).toBe("week");
    expect(s.dayGroup(at(19), now)).toBe("week");
    expect(s.dayGroup(at(18), now)).toBe("older");
    expect(s.dayGroup(now + 60_000, now)).toBe("today");
  });

  it("orders chats newest first and leaves out empty groups", async () => {
    const s = await fresh();
    const chats = [
      { id: "old", updated: at(2) },
      { id: "t1", updated: at(25, 9) },
      { id: "w", updated: at(21) },
      { id: "t2", updated: at(25, 13) },
    ];
    expect(s.groupByDay(chats, now).map((g) => [g.group, g.chats.map((c) => c.id)])).toEqual([
      ["today", ["t2", "t1"]],
      ["week", ["w"]],
      ["older", ["old"]],
    ]);
    expect(s.groupByDay([], now)).toEqual([]);
  });
});
