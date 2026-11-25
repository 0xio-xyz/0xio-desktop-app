import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TrayAction, TraySendProgress, TrayState } from "./protocol";

const EMPTY: TrayState = {
  snapshot: null,
  clients: 0,
  computing: false,
  computingExtension: false,
  openAtLogin: false,
};

export function useTrayState() {
  const [state, setState] = useState<TrayState>(EMPTY);
  const [progress, setProgress] = useState<TraySendProgress | null>(null);
  const [opened, setOpened] = useState(0);

  // Syncs with Rust: initial state, then every published change.
  useEffect(() => {
    let alive = true;
    void invoke<TrayState>("tray_get_state")
      .then((s) => alive && setState(s))
      .catch(() => {});
    const offs = [
      listen<TrayState["snapshot"]>("tray-state", ({ payload }) =>
        setState((s) => ({ ...s, snapshot: payload })),
      ),
      listen<number>("ws-clients-changed", ({ payload }) =>
        setState((s) => ({ ...s, clients: payload })),
      ),
      listen<boolean>("ws-computing-changed", ({ payload }) =>
        setState((s) => ({ ...s, computing: payload })),
      ),
      listen<boolean>("ext-computing-changed", ({ payload }) =>
        setState((s) => ({ ...s, computingExtension: payload })),
      ),
      listen<TraySendProgress>("tray-progress", ({ payload }) => setProgress(payload)),
      listen("tray-opened", () => {
        setOpened((n) => n + 1);
        void invoke<TrayState>("tray_get_state")
          .then((s) => alive && setState(s))
          .catch(() => {});
      }),
    ];
    return () => {
      alive = false;
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, []);

  const act = useCallback(async (action: TrayAction) => {
    const res = await invoke<{ openAtLogin?: boolean }>("tray_action", { action });
    if (typeof res?.openAtLogin === "boolean")
      setState((s) => ({ ...s, openAtLogin: res.openAtLogin! }));
    return res;
  }, []);

  return { state, progress, setProgress, opened, act };
}

export const hidePanel = () => invoke("tray_hide").catch(() => {});

export function usePanelKeys(act: (a: TrayAction) => Promise<unknown>) {
  // Syncs with the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") void hidePanel();
      else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void act({ type: "openApp" });
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void act({ type: "lock" });
      } else if (mod && e.key.toLowerCase() === "q") {
        e.preventDefault();
        void act({ type: "quit" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);
}

export const TRAY_THEME_EVENT = "0xio-tray-theme";

export function useTrayTheme(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(TRAY_THEME_EVENT, onChange);
      return () => window.removeEventListener(TRAY_THEME_EVENT, onChange);
    },
    () => document.documentElement.getAttribute("data-tray") ?? "smoke",
  );
}
