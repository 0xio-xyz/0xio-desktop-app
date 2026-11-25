import { useSyncExternalStore } from "react";

export type NoticeKind =
  | "received"
  | "claim"
  | "result"
  | "failed"
  | "site"
  | "pair"
  | "touchId"
  | "update"
  | "keyHold";

type NoticeAction =
  | { kind: "view"; hash: string; network: string }
  | { kind: "claim" }
  | { kind: "retry"; route: string; ref: string }
  | { kind: "site"; id: string }
  | { kind: "pair" }
  | { kind: "settings"; tab: string }
  | { kind: "privacy" }
  | { kind: "restart" };

export interface Notice {
  /** Stable per event, so a source can record it again without a duplicate. */
  id: string;
  kind: NoticeKind;
  /** `network:address`, or APP for what belongs to the whole app. */
  scope: string;
  at: number;
  title: string;
  values?: Record<string, string | number>;
  who?: string;
  action: NoticeAction;
  read: boolean;
}

export const APP = "app";
const KEY = "0xio_notices_v1";
const MAX = 200;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const NEEDS: ReadonlySet<NoticeKind> = new Set(["claim", "failed", "site", "pair", "update"]);

export const scopeOf = (networkId: string, address: string) => `${networkId}:${address}`;

function load(): Notice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as Notice[]) : [];
  } catch {
    return [];
  }
}

let notices: Notice[] = load();
const listeners = new Set<() => void>();

function commit(next: Notice[]): void {
  const cutoff = Date.now() - KEEP_MS;
  notices = next
    .filter((n) => n.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(notices));
  } catch {}
  listeners.forEach((l) => l());
}

function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotices(): Notice[] {
  return notices;
}

export function record(n: Omit<Notice, "read" | "at"> & { at?: number }): boolean {
  const old = notices.find((x) => x.id === n.id);
  const next: Notice = { ...n, at: n.at ?? old?.at ?? Date.now(), read: old?.read ?? false };
  commit([next, ...notices.filter((x) => x.id !== n.id)]);
  return !old;
}

export function resolve(id: string): void {
  if (notices.some((n) => n.id === id)) commit(notices.filter((n) => n.id !== id));
}

export function resolveMissing(
  kind: NoticeKind,
  scope: string,
  current: ReadonlySet<string>,
): void {
  const keep = notices.filter((n) => n.kind !== kind || n.scope !== scope || current.has(n.id));
  if (keep.length !== notices.length) commit(keep);
}

export function markRead(id: string): void {
  if (notices.some((n) => n.id === id && !n.read))
    commit(notices.map((n) => (n.id === id ? { ...n, read: true } : n)));
}

export function markAllRead(scope: string): void {
  if (notices.some((n) => inView(n, scope) && !n.read))
    commit(notices.map((n) => (inView(n, scope) ? { ...n, read: true } : n)));
}

const inView = (n: Notice, scope: string) => n.scope === scope || n.scope === APP;

function needsUser(n: Notice): boolean {
  return NEEDS.has(n.kind) && !n.read;
}

export interface NoticeView {
  list: Notice[];
  count: number;
  others: number;
}

export function viewOf(all: Notice[], scope: string): NoticeView {
  const list = all.filter((n) => inView(n, scope));
  const others = new Set(all.filter((n) => !inView(n, scope) && !n.read).map((n) => n.scope)).size;
  return { list, count: list.filter(needsUser).length, others };
}

export function useNotices(scope: string): NoticeView {
  const all = useSyncExternalStore(subscribeNotices, getNotices);
  return viewOf(all, scope);
}

export function resetNotices(): void {
  notices = [];
  try {
    localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((l) => l());
}
