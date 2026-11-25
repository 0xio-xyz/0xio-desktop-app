import { useCallback, useState } from "react";
import { SETTINGS_TAB_KEY } from "src/features/settings/services/caches";

export const SETTINGS_TABS = ["general", "appearance", "security", "network", "advanced"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

function savedTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY);
    return SETTINGS_TABS.find((t) => t === saved) ?? "general";
  } catch {
    return "general";
  }
}

export function useSettingsTab(open?: SettingsTab) {
  const [tab, setTab] = useState<SettingsTab>(() => open ?? savedTab());
  const choose = useCallback((next: SettingsTab) => {
    setTab(next);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, next);
    } catch {}
  }, []);
  return [tab, choose] as const;
}
