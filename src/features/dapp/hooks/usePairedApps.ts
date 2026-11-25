import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { logger } from "src/lib/logger";

interface PairedApp {
  key: string;
  name: string;
  origin: string;
  paired_at: number;
  last_used: number;
}

interface PairSettings {
  allow_legacy: boolean;
  forget_after_days: number;
  notify_sites: boolean;
  direct_sites: boolean;
}

/** Whether macOS lets 0xio Desktop post notifications; "unknown" outside the app bundle. */
type NotifyPermission = "granted" | "denied" | "notDetermined" | "unknown";

export function usePairedApps() {
  const [list, setList] = useState<PairedApp[] | null>(null);
  const [settings, setSettings] = useState<PairSettings | null>(null);
  const [permission, setPermission] = useState<NotifyPermission | null>(null);

  // The macOS permission is re-read each time the window comes back: it may have changed in
  // System Settings.
  useMountEffect(() => {
    let alive = true;
    invoke<PairedApp[]>("ws_paired_list")
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    invoke<PairSettings>("ws_pair_settings")
      .then((s) => alive && setSettings(s))
      .catch((err) => logger.warn("pairing", "could not read the pairing settings", err));
    const readPermission = () =>
      void invoke<NotifyPermission>("site_notify_permission")
        .then((p) => alive && setPermission(p))
        .catch(() => alive && setPermission("unknown"));
    readPermission();
    window.addEventListener("focus", readPermission);
    return () => {
      alive = false;
      window.removeEventListener("focus", readPermission);
    };
  });

  const forget = async (key: string) => {
    try {
      setList(await invoke<PairedApp[]>("ws_pair_forget", { key }));
    } catch (err) {
      logger.warn("pairing", "could not remove the paired app", err);
    }
  };

  const save = async (change: {
    allowLegacy?: boolean;
    forgetAfterDays?: number;
    notifySites?: boolean;
    directSites?: boolean;
  }) => {
    try {
      setSettings(await invoke<PairSettings>("ws_pair_set_settings", change));
      setList(await invoke<PairedApp[]>("ws_paired_list"));
    } catch (err) {
      logger.warn("pairing", "could not save the pairing settings", err);
    }
  };

  const openNotifySettings = () =>
    void invoke("site_notify_open_settings").catch((err) =>
      logger.warn("pairing", "could not open the notification settings", err),
    );

  return { list, settings, permission, forget, save, openNotifySettings };
}

export type PairedAppsState = ReturnType<typeof usePairedApps>;
