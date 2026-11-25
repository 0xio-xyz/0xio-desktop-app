import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "src/i18n/core";
import { formatOCT } from "src/lib/format";
import { record, type Notice, type NoticeKind } from "src/services/notices/notifications";

type NativeGroup = "claims" | "pairs" | "results" | "incoming" | "security";

export const NATIVE_GROUPS: NativeGroup[] = ["claims", "pairs", "results", "incoming", "security"];

const GROUP: Partial<Record<NoticeKind, NativeGroup>> = {
  claim: "claims",
  pair: "pairs",
  result: "results",
  failed: "results",
  received: "incoming",
  touchId: "security",
  update: "security",
  keyHold: "security",
};

const KEY = "0xio_notice_native_v1";
const DEFAULTS: Record<NativeGroup, boolean> = {
  claims: true,
  pairs: true,
  results: false,
  incoming: false,
  security: true,
};

function load(): Record<NativeGroup, boolean> {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

let switches = load();
const listeners = new Set<() => void>();

export function setNative(group: NativeGroup, on: boolean): void {
  switches = { ...switches, [group]: on };
  try {
    localStorage.setItem(KEY, JSON.stringify(switches));
  } catch {}
  listeners.forEach((l) => l());
}

export function useNativeSwitches(): Record<NativeGroup, boolean> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => switches,
  );
}

export function noticeValues(v: Notice["values"]): Record<string, string | number> {
  if (!v) return {};
  const out: Record<string, string | number> = { ...v };
  if (typeof v.amount === "number") out.amount = formatOCT(v.amount);
  return out;
}

/** Rust shows the macOS notification only while the main window is not in front. */
export function announce(n: Omit<Notice, "read" | "at"> & { at?: number }): void {
  const isNew = record(n);
  const group = GROUP[n.kind];
  if (!isNew || !group || !switches[group]) return;
  const title = i18n.t(n.title, noticeValues(n.values)) || n.title;
  void invoke("notice_post", { title }).catch(() => {});
}
