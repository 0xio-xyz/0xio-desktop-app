import { load, type Store } from "@tauri-apps/plugin-store";
import { logger } from "src/lib/logger";
import type { ChatMessage } from "src/services/ai/providerClient";

export interface SavedMessage extends ChatMessage {
  role: "user" | "assistant";
  failed?: boolean;
}

export interface SavedChat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: SavedMessage[];
}

export const MAX_MESSAGES = 100;
export const MAX_CHARS = 500_000;
export const MAX_CHATS = 50;
export const MAX_PROJECT_CHARS = 2_000_000;
export const MAX_TITLE = 120;
const KEY = "chats";
const LEGACY_KEY = "messages";

const memory = new Map<string, SavedChat[]>();
const loading = new Map<string, Promise<SavedChat[]>>();
const stores = new Map<string, Promise<Store>>();
const writes = new Map<string, Promise<void>>();

async function fileFor(project: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(project));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `ai-chats/${hex.slice(0, 32)}.json`;
}

function storeFor(project: string): Promise<Store> {
  let s = stores.get(project);
  if (!s) {
    s = fileFor(project).then((path) => load(path, { defaults: {}, autoSave: false }));
    s.catch(() => stores.delete(project));
    stores.set(project, s);
  }
  return s;
}

const isMessage = (m: unknown): m is SavedMessage =>
  !!m &&
  typeof m === "object" &&
  ((m as SavedMessage).role === "user" || (m as SavedMessage).role === "assistant") &&
  typeof (m as SavedMessage).content === "string";

// A failed or empty reply goes with the question that led to it, so the saved chat never holds
// an unanswered turn.
export function persistable(messages: ChatMessage[]): SavedMessage[] {
  const out: SavedMessage[] = [];
  for (const m of messages) {
    if (!isMessage(m)) continue;
    if (m.role === "assistant" && (m.failed || !m.content.trim())) {
      if (out[out.length - 1]?.role === "user") out.pop();
      continue;
    }
    if (m.role === "user" && out[out.length - 1]?.role === "user") out.pop();
    out.push({ role: m.role, content: m.content });
  }
  if (out[out.length - 1]?.role === "user") out.pop();
  return out;
}

export function capChat(messages: SavedMessage[]): SavedMessage[] {
  let start = Math.max(0, messages.length - MAX_MESSAGES);
  let size = messages.slice(start).reduce((n, m) => n + JSON.stringify(m).length + 1, 0);
  while (start < messages.length && (size > MAX_CHARS || messages[start].role !== "user")) {
    size -= JSON.stringify(messages[start]).length + 1;
    start++;
  }
  return messages.slice(start);
}

export function chatTitle(question: string): string {
  return question.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE);
}

export const newChatId = (): string => crypto.randomUUID();

const byUpdated = (a: SavedChat, b: SavedChat) => b.updated - a.updated;

// Newest first; the oldest chats go once there are too many or the project file grows too big.
function capChats(chats: SavedChat[]): SavedChat[] {
  const out = chats.slice().sort(byUpdated).slice(0, MAX_CHATS);
  let size = out.reduce((n, c) => n + JSON.stringify(c).length + 1, 0);
  while (out.length > 1 && size > MAX_PROJECT_CHARS) size -= JSON.stringify(out.pop()).length + 1;
  return out;
}

function readChat(raw: unknown): SavedChat | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<SavedChat>;
  if (typeof c.id !== "string" || !c.id || !Array.isArray(c.messages)) return null;
  const messages = capChat(persistable(c.messages.filter(isMessage)));
  if (!messages.length) return null;
  const updated = Number.isFinite(c.updated) ? Number(c.updated) : 0;
  return {
    id: c.id,
    title: typeof c.title === "string" && c.title.trim() ? c.title : chatTitle(messages[0].content),
    created: Number.isFinite(c.created) ? Number(c.created) : updated,
    updated,
    messages,
  };
}

function persist(project: string): Promise<void> {
  const prev = writes.get(project) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const store = await storeFor(project);
      const chats = memory.get(project) ?? [];
      if (chats.length) await store.set(KEY, chats);
      else await store.delete(KEY);
      await store.delete(LEGACY_KEY);
      await store.save();
    } catch (err) {
      logger.warn("ai", "chat save failed:", err);
    }
  });
  writes.set(project, next);
  return next;
}

async function readChats(project: string): Promise<SavedChat[]> {
  let chats: SavedChat[] = [];
  let migrated = false;
  try {
    const store = await storeFor(project);
    const raw = await store.get<unknown>(KEY);
    if (Array.isArray(raw)) {
      const seen = new Set<string>();
      for (const item of raw) {
        const c = readChat(item);
        if (c && !seen.has(c.id)) {
          seen.add(c.id);
          chats.push(c);
        }
      }
    } else {
      // Before many chats per project the file held one chat under "messages".
      const legacy = await store.get<unknown>(LEGACY_KEY);
      if (Array.isArray(legacy)) {
        const messages = capChat(persistable(legacy.filter(isMessage)));
        if (messages.length) {
          const now = Date.now();
          chats = [
            {
              id: newChatId(),
              title: chatTitle(messages[0].content),
              created: now,
              updated: now,
              messages,
            },
          ];
          migrated = true;
        }
      }
    }
  } catch (err) {
    logger.warn("ai", "chat restore failed:", err);
  }
  chats = capChats(chats);
  if (!memory.has(project)) {
    memory.set(project, chats);
    if (migrated) void persist(project);
  }
  return memory.get(project)!;
}

export function peekChats(project: string): SavedChat[] | undefined {
  return memory.get(project);
}

export function loadChats(project: string): Promise<SavedChat[]> {
  const known = memory.get(project);
  if (known) return Promise.resolve(known);
  let p = loading.get(project);
  if (!p) {
    p = readChats(project).finally(() => loading.delete(project));
    loading.set(project, p);
  }
  return p;
}

function update(project: string, change: (chats: SavedChat[]) => SavedChat[]): Promise<void> {
  const known = memory.get(project);
  if (known) {
    memory.set(project, capChats(change(known)));
    return persist(project);
  }
  return loadChats(project).then(() => {
    memory.set(project, capChats(change(memory.get(project)!)));
    return persist(project);
  });
}

// Saves the open chat under its id; a chat with nothing worth keeping is not stored.
export function saveChat(project: string, id: string, messages: ChatMessage[]): Promise<void> {
  const kept = capChat(persistable(messages));
  const now = Date.now();
  return update(project, (chats) => {
    const old = chats.find((c) => c.id === id);
    const rest = chats.filter((c) => c.id !== id);
    if (!kept.length) return rest;
    return [
      {
        id,
        title: old?.title ?? chatTitle(kept[0].content),
        created: old?.created ?? now,
        updated: now,
        messages: kept,
      },
      ...rest,
    ];
  });
}

export function deleteChat(project: string, id: string): Promise<void> {
  return update(project, (chats) => chats.filter((c) => c.id !== id));
}

export type DayGroup = "today" | "yesterday" | "week" | "older";

const dayStart = (t: number) => new Date(t).setHours(0, 0, 0, 0);

export function dayGroup(t: number, now = Date.now()): DayGroup {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "week" : "older";
}

export function groupByDay<T extends { updated: number }>(
  chats: T[],
  now = Date.now(),
): { group: DayGroup; chats: T[] }[] {
  const out: { group: DayGroup; chats: T[] }[] = [];
  for (const c of chats.slice().sort((a, b) => b.updated - a.updated)) {
    const group = dayGroup(c.updated, now);
    const last = out[out.length - 1];
    if (last?.group === group) last.chats.push(c);
    else out.push({ group, chats: [c] });
  }
  return out;
}
