import {
  Fragment,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "src/i18n/react";
import { chatWithAI, extractCodeBlocks, type AssistantMode } from "src/services/ai/aiChatService";
import type { StreamStatus } from "src/services/ai/providerClient";
import {
  chatTitle,
  deleteChat,
  groupByDay,
  loadChats,
  newChatId,
  peekChats,
  saveChat,
  type DayGroup,
  type SavedChat,
  type SavedMessage,
} from "src/services/ai/chatHistory";
import {
  getConfig,
  getProviderLabel,
  isAiReady,
  saveConfig,
  switchToProvider,
  useAiConfig,
  type ProviderType,
} from "src/services/ai/aiSuggestionService";
import { modelCatalog, useModelCatalog } from "src/services/ai/modelCatalog";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { ChatHistory, ChevronDown, ChevronLeft, Plus, Search, Trash2 } from "src/shared/ui/icons";
import { Line } from "src/features/contracts/components/workspace/Tokens";

export interface AIChatHandle {
  send(text: string): void;
  focus(): void;
  newChat(): void;
  escape(): boolean;
}

interface Props {
  project: string;
  sourceCode: string;
  selection: string;
  language: string;
  fileName: string;
  firstFn: string;
  onApply: (code: string) => () => void;
  onManageKeys: () => void;
}

const MODE_KEY = "ai_chat_mode";
const MODES: AssistantMode[] = ["auto", "manual", "plan"];

// Old stored values from the Chat/Agent naming keep working.
function loadMode(): AssistantMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === "chat") return "manual";
  if (stored === "agent") return "auto";
  return stored === "auto" || stored === "manual" || stored === "plan" ? stored : "manual";
}

type Part = { code: false; text: string } | { code: true; text: string; index: number };

function splitReply(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let index = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1].replace(/\n$/, ""), index: index++ });
    last = re.lastIndex;
    if (m[0].length === 0) break;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

/** Model output is never parsed as HTML. */
function Prose({ text }: { text: string }) {
  const nodes = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((s, i) => {
    if (s.startsWith("`") && s.endsWith("`") && s.length > 1)
      return <code key={i}>{s.slice(1, -1)}</code>;
    if (s.startsWith("**") && s.endsWith("**") && s.length > 3)
      return <strong key={i}>{s.slice(2, -2)}</strong>;
    return s;
  });
  return <div className="txt">{nodes}</div>;
}

const Dots = ({ label }: { label: string }) => (
  <span className="ld" role="img" aria-label={label}>
    <b />
    <b />
    <b />
  </span>
);

function ThinkingFor({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);
  useMountEffect(() => {
    const id = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(id);
  });
  return (
    <span className="think">
      {label} {seconds}s
    </span>
  );
}

function ModelPicker({ onClose, onManageKeys }: { onClose: () => void; onManageKeys: () => void }) {
  const { t } = useTranslation();
  const config = useAiConfig();
  const catalog = useModelCatalog();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const total = catalog.reduce((n, e) => n + e.models.length, 0);
  const groups = catalog
    .filter((e) => e.status !== "none")
    .map((e) => {
      const name = getProviderLabel(e.provider);
      const models = e.models.filter(
        (m) =>
          !query ||
          m.label.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query) ||
          name.toLowerCase().includes(query),
      );
      return { e, name, models };
    })
    .filter(({ e, models }) => !query || models.length > 0 || e.status === "loading");

  const pick = (provider: ProviderType, id: string) => {
    saveConfig(switchToProvider(getConfig(), provider, id));
    onClose();
  };

  return (
    <>
      <button
        type="button"
        className="catch"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div className="picker" role="dialog" aria-label={t("contracts.ws.models")} data-t="picker">
        {total > 8 && (
          <div className="psearch">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("contracts.ws.searchModels")}
              aria-label={t("contracts.ws.searchModels")}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
            />
          </div>
        )}
        <div className="plist" role="listbox" aria-label={t("contracts.ws.detectedModels")}>
          {groups.map(({ e, name, models }) => (
            <div key={e.provider}>
              <div className="pg">
                <span className="caps">{name}</span>
                <span className="cnt mono">
                  {[
                    e.provider === "ollama" || e.provider === "lmstudio" || e.provider === "custom"
                      ? e.source
                      : "",
                    e.models.length ? String(e.models.length) : "",
                  ]
                    .filter(Boolean)
                    .join("  ")}
                </span>
              </div>
              {e.status === "loading" && e.models.length === 0 && (
                <div className="pstat">
                  <Dots label={t("contracts.ws.loading")} />
                </div>
              )}
              {e.status === "error" && (
                <div className="pstat">
                  <span>{t("contracts.ws.couldNotReach")}</span>
                  <button
                    type="button"
                    className="ghost press"
                    onClick={() => modelCatalog.refresh(e.provider)}
                  >
                    {t("contracts.ws.retry")}
                  </button>
                </div>
              )}
              {models.map((m) => {
                const on = config.provider === e.provider && config.model === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`mrow${on ? " on" : ""}`}
                    onClick={() => pick(e.provider, m.id)}
                    title={m.id}
                  >
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {groups.every(
            (g) => g.models.length === 0 && g.e.status !== "loading" && g.e.status !== "error",
          ) && (
            <div className="pstat">
              {query ? t("contracts.ws.noMatch") : t("contracts.ws.noModels")}
            </div>
          )}
        </div>
        <div className="pfoot">
          <button type="button" className="mi" onClick={onManageKeys} data-t="managekeys">
            {t("contracts.ws.manageKeys")}
          </button>
        </div>
      </div>
    </>
  );
}

const GROUP_KEY: Record<DayGroup, string> = {
  today: "contracts.ws.today",
  yesterday: "contracts.ws.yesterday",
  week: "contracts.ws.previous7",
  older: "contracts.ws.older",
};

// The list shows a chat from its first question on, before the reply is saved.
function upsert(
  list: SavedChat[],
  id: string,
  messages: SavedMessage[],
  updated?: number,
): SavedChat[] {
  const old = list.find((c) => c.id === id);
  if (old)
    return list.map((c) => (c.id === id ? { ...c, messages, updated: updated ?? c.updated } : c));
  const now = updated ?? Date.now();
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  return [{ id, title: chatTitle(first), created: now, updated: now, messages }, ...list];
}

const AIChatPanel = forwardRef<AIChatHandle, Props>(function AIChatPanel(
  { project, sourceCode, selection, language, fileName, firstFn, onApply, onManageKeys },
  ref,
) {
  const { t } = useTranslation();
  const config = useAiConfig();
  const catalog = useModelCatalog();
  const ready = isAiReady(config);
  const [chats, setChats] = useState<SavedChat[]>(() => peekChats(project) ?? []);
  const [cur, setCur] = useState<string | null>(() => peekChats(project)?.[0]?.id ?? null);
  const [messages, setMessages] = useState<SavedMessage[]>(
    () => peekChats(project)?.[0]?.messages ?? [],
  );
  const [restored, setRestored] = useState(() => peekChats(project) !== undefined);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [mode, setMode] = useState<AssistantMode>(loadMode);
  const [applied, setApplied] = useState<Record<string, () => void>>({});
  const [copied, setCopied] = useState("");
  const [picker, setPicker] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [gone, setGone] = useState<{ ids: string[]; open: string | null }>({
    ids: [],
    open: null,
  });
  const [swap, setSwap] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const histRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const curRef = useRef(cur);
  const listOpenRef = useRef(false);
  const goneRef = useRef<string[]>([]);
  const deletedRef = useRef(new Set<string>());

  const closePicker = useCallback(() => setPicker(false), []);

  useMountEffect(() => {
    modelCatalog.refreshAll(false);
    if (!restored)
      void loadChats(project).then((saved) => {
        setChats(saved);
        if (curRef.current === null && saved[0]) {
          curRef.current = saved[0].id;
          setCur(saved[0].id);
          setMessages(saved[0].messages);
        }
        setRestored(true);
        scrollDown();
      });
    return () => {
      abortRef.current?.abort();
      for (const id of goneRef.current) void deleteChat(project, id);
      goneRef.current = [];
    };
  });

  const entry = catalog.find((e) => e.provider === config.provider);
  const modelLabel = ready
    ? (entry?.models.find((m) => m.id === config.model)?.label ?? config.model ?? "")
    : t("contracts.ws.noModel");

  const scrollDown = () =>
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });

  const selectMode = (m: AssistantMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  };

  const apply = (key: string, code: string) => {
    const undo = onApply(code);
    setApplied((prev) => ({ ...prev, [key]: undo }));
  };

  const undoApply = (key: string) => {
    applied[key]?.();
    setApplied((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const show = (id: string | null, next: SavedMessage[]) => {
    curRef.current = id;
    setCur(id);
    setMessages(next);
    setApplied({});
    setSwap((n) => n + 1);
    scrollDown();
  };

  // Stops a running reply (what arrived is kept) and keeps the open chat in the list as shown.
  const leave = () => {
    stop();
    const id = curRef.current;
    if (id) setChats((list) => upsert(list, id, messages));
  };

  const finalize = () => {
    const ids = goneRef.current;
    if (!ids.length) return;
    goneRef.current = [];
    for (const id of ids) {
      deletedRef.current.add(id);
      void deleteChat(project, id);
    }
    setChats((list) => list.filter((c) => !ids.includes(c.id)));
    setGone({ ids: [], open: null });
  };

  const openList = () => {
    listOpenRef.current = true;
    setListOpen(true);
    setPicker(false);
    requestAnimationFrame(() => backRef.current?.focus({ preventScroll: true }));
  };

  const closeList = () => {
    if (!listOpenRef.current) return;
    listOpenRef.current = false;
    setListOpen(false);
    if (listRef.current?.contains(document.activeElement))
      histRef.current?.focus({ preventScroll: true });
    setTimeout(() => {
      if (!listOpenRef.current) finalize();
    }, 320);
  };

  const newChat = () => {
    if (curRef.current !== null || messages.length) {
      leave();
      show(null, []);
      setInput("");
    }
    closeList();
  };

  const openChat = (id: string) => {
    const chat = chats.find((c) => c.id === id);
    if (chat && id !== curRef.current) {
      leave();
      show(id, chat.messages);
      setInput("");
    }
    closeList();
  };

  const removeChat = (id: string) => {
    goneRef.current = [...goneRef.current, id];
    const open = id === curRef.current;
    if (open) {
      leave();
      show(null, []);
    }
    setGone((g) => ({ ids: [...g.ids, id], open: open ? id : g.open }));
  };

  const undoRemove = (id: string) => {
    goneRef.current = goneRef.current.filter((x) => x !== id);
    setGone((g) => ({ ids: g.ids.filter((x) => x !== id), open: g.open === id ? null : g.open }));
    const chat = chats.find((c) => c.id === id);
    if (gone.open === id && curRef.current === null && !messages.length && chat)
      show(id, chat.messages);
  };

  const escape = () => {
    if (picker) {
      closePicker();
      return true;
    }
    if (listOpenRef.current) {
      closeList();
      return true;
    }
    return false;
  };

  const send = async (text: string) => {
    if (!text.trim() || loading || !restored) return;
    const cfg = getConfig();
    if (!isAiReady(cfg)) return;
    const history: SavedMessage[] = [...messages, { role: "user", content: text }];
    const chat = curRef.current ?? newChatId();
    let reply = "";
    if (curRef.current === null) {
      curRef.current = chat;
      setCur(chat);
    }
    setChats((list) => upsert(list, chat, history, Date.now()));
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);
    scrollDown();
    const controller = new AbortController();
    abortRef.current = controller;
    const appendDelta = (d: string, failed?: boolean) => {
      if (curRef.current !== chat) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = {
          ...last,
          content: last.content + d,
          ...(failed ? { failed } : {}),
        };
        return next;
      });
      scrollDown();
    };
    const keep = (content: string) => {
      if (deletedRef.current.has(chat)) return;
      const done: SavedMessage[] = [...history, { role: "assistant", content }];
      void saveChat(project, chat, done);
      setChats((list) => upsert(list, chat, done));
    };
    try {
      const full = await chatWithAI(history, cfg, {
        sourceCode,
        selection,
        language,
        mode,
        signal: controller.signal,
        onDelta: (d) => {
          reply += d;
          appendDelta(d);
        },
        onStatus: setStatus,
      });
      keep(full);
      // Auto mode drives the editor: the reply carries the complete updated file.
      if (mode === "auto") {
        const blocks = extractCodeBlocks(full);
        if (blocks.length > 0) {
          // The complete file is the longest block - a stray snippet must never win.
          const longest = blocks.reduce((a, b) => (b.length > a.length ? b : a));
          apply(`${history.length}:${blocks.indexOf(longest)}`, longest);
        }
      }
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === "AbortError" || /cancel/i.test(err.message)));
      if (aborted) keep(reply);
      else appendDelta(`\n\n${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      abortRef.current = null;
      setStatus(null);
      setLoading(false);
    }
  };

  useImperativeHandle(ref, () => ({
    send: (text: string) => {
      closeList();
      void send(text);
    },
    focus: () => {
      closeList();
      inputRef.current?.focus();
    },
    newChat,
    escape,
  }));

  const suggestions = useMemo(() => {
    const asm = language === "assembly";
    const name = fileName.split("/").pop() || fileName;
    const list = [
      {
        label: t("contracts.ws.sugBugs", { name }),
        prompt: `Find bugs in ${name}: ${asm ? "stack underflows, unchecked jumps" : "access control, reentrancy, missing checks"} and edge cases. Point at the lines.`,
      },
      {
        label: t("contracts.ws.sugExplain", { name: firstFn || name }),
        prompt: firstFn
          ? `Explain what ${firstFn} does, step by step.`
          : `Explain what ${name} does.`,
      },
      {
        label: t("contracts.ws.sugOptimize", { name }),
        prompt: `Suggest optimizations for ${name}: ${asm ? "stack usage, instruction count and jumps" : "register usage, gas and code quality"}.`,
      },
    ];
    if (!asm)
      list.push({
        label: t("contracts.ws.sugPrivacy"),
        prompt:
          "Add FHE privacy features to this contract using the available builtins (fhe_load_pk, fhe_deser, fhe_ser, fhe_add, fhe_sub, fhe_scale, fhe_add_const, fhe_verify_zero).",
      });
    return list;
  }, [language, fileName, firstFn, t]);

  return (
    <div
      className="chat"
      onKeyDown={(e) => {
        if (e.key === "Escape" && escape()) e.preventDefault();
      }}
    >
      <div className={`cmain${listOpen ? " back" : ""}`}>
        <div className="chath">
          <button
            type="button"
            className="mbtn press"
            onClick={() => {
              if (!picker) modelCatalog.refreshAll(false);
              setPicker((v) => !v);
            }}
            aria-haspopup="listbox"
            aria-expanded={picker}
            data-t="model"
          >
            <span className="nm">{modelLabel}</span>
            {ready && <span className="pv">{getProviderLabel(config.provider)}</span>}
            <ChevronDown size={10} aria-hidden="true" className="chev" />
          </button>
          <div className="flex-1" />
          <button
            ref={histRef}
            type="button"
            className="ibtn press"
            onClick={openList}
            aria-label={t("contracts.ws.chats")}
            title={t("contracts.ws.chats")}
            aria-expanded={listOpen}
            data-t="chats"
          >
            <ChatHistory size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ibtn press"
            onClick={newChat}
            aria-label={t("contracts.ws.newChat")}
            title={t("contracts.ws.newChat")}
            data-t="new"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>

        <div
          className={`chatb ${swap % 2 ? "swapA" : "swapB"}`}
          ref={boxRef}
          aria-live="polite"
          data-t="chatbody"
        >
          {restored &&
            messages.length === 0 &&
            (ready ? (
              <div className="sugs">
                {suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="sug press"
                    onClick={() => void send(s.prompt)}
                    disabled={!sourceCode.trim()}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="sugs">
                <div className="quiet">{t("contracts.ws.noModels")}</div>
                <button type="button" className="sug press" onClick={onManageKeys}>
                  {t("contracts.ws.manageKeys")}
                </button>
              </div>
            ))}
          {messages.map((m, idx) => {
            if (m.role === "user")
              return (
                <div key={idx} className="msg-u">
                  {m.content}
                </div>
              );
            const streaming = loading && idx === messages.length - 1;
            const parts = splitReply(m.content);
            return (
              <div key={idx} className="msg-b">
                {streaming && !m.content && (
                  <span className="typing" role="img" aria-label={t("contracts.ws.thinking")}>
                    <b />
                    <b />
                    <b />
                    {status === "thinking" && <ThinkingFor label={t("contracts.ws.thinking")} />}
                  </span>
                )}
                {parts.map((p, i) =>
                  !p.code ? (
                    p.text.trim() && <Prose key={i} text={p.text.trim()} />
                  ) : (
                    <div key={i} className="flex flex-col gap-2.5">
                      <pre className="codeb mono">
                        {p.text.split("\n").map((l, j) => (
                          <div key={j}>{l ? <Line text={l} /> : " "}</div>
                        ))}
                      </pre>
                      {!streaming && (
                        <div className="acts">
                          {applied[`${idx}:${p.index}`] ? (
                            <>
                              <span className="word">{t("contracts.ws.applied")}</span>
                              <button
                                type="button"
                                className="ghost press"
                                onClick={() => undoApply(`${idx}:${p.index}`)}
                              >
                                {t("contracts.ws.undo")}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="key press"
                              onClick={() => apply(`${idx}:${p.index}`, p.text)}
                              data-t="apply"
                            >
                              {t("contracts.ws.apply")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="ghost press"
                            onClick={() => {
                              void navigator.clipboard?.writeText(p.text).catch(() => {});
                              setCopied(`${idx}:${p.index}`);
                              setTimeout(() => setCopied(""), 1400);
                            }}
                          >
                            {copied === `${idx}:${p.index}`
                              ? t("common.copied")
                              : t("contracts.ws.copy")}
                          </button>
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </div>

        <div className="comp">
          <div className="compb">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={
                selection.trim()
                  ? t("contracts.ws.askSelection")
                  : t("contracts.ws.ask", { name: fileName.split("/").pop() || fileName })
              }
              aria-label={t("contracts.ws.message")}
              disabled={!ready}
              data-t="composer"
            />
            <div className="compr">
              <div className="seg sm" role="tablist" aria-label={t("contracts.ws.mode")}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    className={`press${mode === m ? " on" : ""}`}
                    onClick={() => selectMode(m)}
                  >
                    {t(`contracts.ws.mode_${m}`)}
                  </button>
                ))}
              </div>
              <span className="grow" />
              {loading ? (
                <button type="button" className="ghost press w-16" onClick={stop}>
                  {t("contracts.compile.stop")}
                </button>
              ) : (
                <button
                  type="button"
                  className="key press w-16"
                  onClick={() => void send(input)}
                  disabled={!input.trim() || !ready}
                  data-t="send"
                >
                  {t("contracts.ws.send")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        ref={listRef}
        className={`hl${listOpen ? " on" : ""}`}
        role="region"
        aria-label={t("contracts.ws.chats")}
        data-t="hlist"
      >
        <div className="chath hhead">
          <button
            ref={backRef}
            type="button"
            className="ghost press hback"
            onClick={closeList}
            data-t="back"
          >
            <ChevronLeft size={10} aria-hidden="true" />
            {t("contracts.ws.chat")}
          </button>
          <div className="flex-1" />
          <button type="button" className="ghost press" onClick={newChat} data-t="lnew">
            {t("contracts.ws.newChat")}
          </button>
        </div>
        <div className="hscroll" data-t="hscroll">
          {groupByDay(chats).map((g) => (
            <Fragment key={g.group}>
              <div className="caps hg">{t(GROUP_KEY[g.group])}</div>
              {g.chats.map((c) => {
                const removed = gone.ids.includes(c.id);
                const on = c.id === cur && !removed;
                return (
                  <div key={c.id} className={`hrow${on ? " on" : ""}${removed ? " gone" : ""}`}>
                    {removed ? (
                      <>
                        <span className="ht hgone">{t("contracts.ws.deleted")}</span>
                        <button
                          type="button"
                          className="ghost press hundo"
                          onClick={() => undoRemove(c.id)}
                          data-t="undo"
                        >
                          {t("contracts.ws.undo")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="hopen press"
                          onClick={() => openChat(c.id)}
                          aria-current={on ? "true" : undefined}
                          title={c.title}
                          data-t="row"
                        >
                          <span className="ht">{c.title}</span>
                        </button>
                        <button
                          type="button"
                          className="ibtn hdel press"
                          onClick={() => removeChat(c.id)}
                          aria-label={t("contracts.ws.deleteChat", { name: c.title })}
                          data-t="del"
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
          {chats.length === 0 && (
            <div className="quiet hempty" data-t="empty">
              {t("contracts.ws.noChats")}
            </div>
          )}
        </div>
      </div>

      {picker && (
        <ModelPicker
          onClose={closePicker}
          onManageKeys={() => {
            setPicker(false);
            onManageKeys();
          }}
        />
      )}
    </div>
  );
});

export default AIChatPanel;
