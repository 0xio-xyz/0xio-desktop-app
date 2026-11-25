// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";

const m = vi.hoisted(() => ({
  files: new Map<string, Map<string, unknown>>(),
  calls: [] as { role: string; content: string }[][],
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (path: string) => {
    const pending = new Map(m.files.get(path) ?? []);
    return {
      get: async (k: string) => pending.get(k),
      set: async (k: string, v: unknown) => void pending.set(k, structuredClone(v)),
      delete: async (k: string) => pending.delete(k),
      save: async () => void m.files.set(path, new Map(pending)),
    };
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/ai/aiSuggestionService", () => {
  const config = { provider: "anthropic", model: "m", apiKey: "sk-test" };
  return {
    getConfig: () => config,
    useAiConfig: () => config,
    isAiReady: () => true,
    getProviderLabel: () => "Anthropic",
    saveConfig: vi.fn(),
    switchToProvider: vi.fn(),
  };
});
vi.mock("src/services/ai/modelCatalog", () => ({
  modelCatalog: { refreshAll: vi.fn(), refresh: vi.fn() },
  useModelCatalog: () => [],
}));
vi.mock("src/services/ai/aiChatService", () => ({
  extractCodeBlocks: () => [],
  chatWithAI: vi.fn(
    async (
      history: { role: string; content: string }[],
      _cfg: unknown,
      opts: { onDelta: (d: string) => void },
    ) => {
      m.calls.push(history.map((x) => ({ ...x })));
      opts.onDelta("answer");
      return "answer";
    },
  ),
}));

type Store = typeof import("src/services/ai/chatHistory");
type Panel = typeof import("src/features/contracts/components/AIChatPanel");
let store: Store;
let Panel: Panel["default"];

const q = (content: string) => ({ role: "user" as const, content });
const a = (content: string) => ({ role: "assistant" as const, content });
const DAY = 86_400_000;

beforeEach(async () => {
  m.files.clear();
  m.calls.length = 0;
  vi.resetModules();
  await import("src/i18n");
  store = await import("src/services/ai/chatHistory");
  Panel = (await import("src/features/contracts/components/AIChatPanel")).default;
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now - 10 * DAY);
  await store.saveChat("local", "old", [q("Is u128 enough for balances"), a("Yes.")]);
  vi.setSystemTime(now - DAY);
  await store.saveChat("local", "y", [q("Explain withdraw"), a("withdraw lowers the balance")]);
  vi.setSystemTime(now);
  await store.saveChat("local", "t", [q("Find bugs in vault.aml"), a("withdraw accepts zero")]);
  vi.useRealTimers();
});
afterEach(cleanup);

const mount = () => {
  const ref = createRef<import("src/features/contracts/components/AIChatPanel").AIChatHandle>();
  const view = render(
    <div className="cw">
      <Panel
        ref={ref}
        project="local"
        sourceCode="Program Vault {}"
        selection=""
        language="aml"
        fileName="vault.aml"
        firstFn="withdraw"
        onApply={() => () => {}}
        onManageKeys={() => {}}
      />
    </div>,
  );
  return { ref, view };
};

const list = () => document.querySelector<HTMLElement>("[data-t=hlist]")!;
const body = () => document.querySelector<HTMLElement>("[data-t=chatbody]")!;
const rows = () => Array.from(list().querySelectorAll<HTMLElement>(".hrow"));
const rowOf = (title: string) => rows().find((r) => r.textContent?.includes(title))!;
const open = () => fireEvent.click(screen.getByRole("button", { name: "Chats" }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 360)));

describe("assistant chat history", () => {
  it("opens the newest chat and lists every chat by day with the open one filled", () => {
    mount();
    expect(body().textContent).toContain("withdraw accepts zero");
    expect(list().className).not.toContain("on");
    open();
    expect(list().className).toContain("on");
    expect(document.querySelector(".cmain")!.className).toContain("back");
    const labels = Array.from(list().querySelectorAll(".hg")).map((n) => n.textContent);
    expect(labels).toEqual(["Today", "Yesterday", "Older"]);
    expect(rowOf("Find bugs").className).toContain("on");
    expect(
      within(rowOf("Find bugs"))
        .getByText("Find bugs in vault.aml")
        .closest("button")!
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(rowOf("Explain").className).not.toContain("on");
  });

  it("picking a row opens that chat and closes the list", () => {
    mount();
    open();
    fireEvent.click(within(rowOf("Explain withdraw")).getByText("Explain withdraw"));
    expect(list().className).not.toContain("on");
    expect(body().textContent).toContain("withdraw lowers the balance");
    expect(body().textContent).not.toContain("withdraw accepts zero");
  });

  it("Back and Escape close the list", () => {
    mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(list().className).not.toContain("on");
    open();
    fireEvent.keyDown(list(), { key: "Escape" });
    expect(list().className).not.toContain("on");
  });

  it("Escape from outside the panel closes the list through the handle", () => {
    const { ref } = mount();
    open();
    let handled = false;
    act(() => {
      handled = ref.current!.escape();
    });
    expect(handled).toBe(true);
    expect(list().className).not.toContain("on");
    expect(ref.current!.escape()).toBe(false);
  });

  it("delete leaves Deleted and Undo in the same row; Undo brings it back", async () => {
    mount();
    open();
    const count = rows().length;
    fireEvent.click(
      within(rowOf("Explain withdraw")).getByRole("button", { name: "Delete Explain withdraw" }),
    );
    expect(rows()).toHaveLength(count);
    const gone = rows()[1];
    expect(gone.className).toContain("gone");
    expect(gone.textContent).toBe("DeletedUndo");
    fireEvent.click(within(gone).getByRole("button", { name: "Undo" }));
    expect(rowOf("Explain withdraw").className).not.toContain("gone");
    fireEvent.keyDown(list(), { key: "Escape" });
    await settle();
    expect(store.peekChats("local")!.map((c) => c.id)).toContain("y");
  });

  it("a delete becomes final when the list closes", async () => {
    mount();
    open();
    fireEvent.click(
      within(rowOf("Explain withdraw")).getByRole("button", { name: "Delete Explain withdraw" }),
    );
    fireEvent.keyDown(list(), { key: "Escape" });
    expect(store.peekChats("local")!.map((c) => c.id)).toContain("y");
    await settle();
    expect(store.peekChats("local")!.map((c) => c.id)).toEqual(["t", "old"]);
    open();
    expect(list().textContent).not.toContain("Explain withdraw");
  });

  it("deleting the open chat clears the chat behind and Undo brings it back", () => {
    mount();
    open();
    fireEvent.click(
      within(rowOf("Find bugs")).getByRole("button", { name: "Delete Find bugs in vault.aml" }),
    );
    expect(body().textContent).not.toContain("withdraw accepts zero");
    expect(body().querySelector(".sugs")).not.toBeNull();
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Undo" }));
    expect(body().textContent).toContain("withdraw accepts zero");
    expect(rowOf("Find bugs").className).toContain("on");
  });

  it("new chat keeps the old one and appears at the top once its first question is sent", async () => {
    const { ref } = mount();
    fireEvent.click(document.querySelector("[data-t=new]")!);
    expect(body().textContent).not.toContain("withdraw accepts zero");
    open();
    expect(rows()).toHaveLength(3);
    expect(list().querySelector(".hrow.on")).toBeNull();
    fireEvent.keyDown(list(), { key: "Escape" });
    await act(async () => ref.current!.send("Write a view fn that returns total"));
    expect(m.calls[0]).toEqual([q("Write a view fn that returns total")]);
    open();
    expect(rows()[0].textContent).toContain("Write a view fn that returns total");
    expect(rows()[0].className).toContain("on");
    await vi.waitFor(() => expect(store.peekChats("local")).toHaveLength(4));
    expect(store.peekChats("local")![0].title).toBe("Write a view fn that returns total");
  });

  it("New chat in the list header and the handle start a fresh chat", async () => {
    const { ref } = mount();
    open();
    fireEvent.click(within(list()).getByRole("button", { name: "New chat" }));
    expect(list().className).not.toContain("on");
    expect(body().querySelector(".msg-u")).toBeNull();
    act(() => ref.current!.newChat());
    expect(store.peekChats("local")).toHaveLength(3);
  });

  it("sends only the open chat as history", async () => {
    const { ref } = mount();
    open();
    fireEvent.click(within(rowOf("Explain withdraw")).getByText("Explain withdraw"));
    await act(async () => ref.current!.send("And deposit?"));
    expect(m.calls[0]).toEqual([
      q("Explain withdraw"),
      a("withdraw lowers the balance"),
      q("And deposit?"),
    ]);
  });

  it("shows No chats for a project without chats", async () => {
    render(
      <div className="cw">
        <Panel
          project="disk:/empty"
          sourceCode=""
          selection=""
          language="aml"
          fileName="a.aml"
          firstFn=""
          onApply={() => () => {}}
          onManageKeys={() => {}}
        />
      </div>,
    );
    await act(async () => {
      await store.loadChats("disk:/empty");
    });
    open();
    expect(list().textContent).toContain("No chats");
    expect(rows()).toHaveLength(0);
  });
});
