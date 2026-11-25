import { useCallback, useEffect, useState } from "react";
import {
  APPEARANCE_EVENT,
  APPEARANCE_KEY,
  applyAccent,
  loadAppearance,
  saveAppearance,
  type AppearanceSettings,
} from "src/features/settings/services/appearance";

export function useAppearance() {
  const [settings, setSettings] = useState<AppearanceSettings>(loadAppearance);

  useEffect(() => {
    const sync = () => setSettings(loadAppearance());
    const fromOtherWindow = (e: StorageEvent) => {
      if (e.key === APPEARANCE_KEY) sync();
    };
    window.addEventListener(APPEARANCE_EVENT, sync);
    window.addEventListener("storage", fromOtherWindow);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener("storage", fromOtherWindow);
    };
  }, []);

  // Re-applied on mount too, so a reload restores the accent rather than flashing the theme's.
  useEffect(() => {
    applyAccent(settings.accentHex);
  }, [settings.accentHex]);

  const update = useCallback((next: AppearanceSettings) => {
    saveAppearance(next);
    setSettings(next);
  }, []);

  return { settings, update };
}
