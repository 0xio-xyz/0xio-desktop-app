import { useState, useCallback } from "react";
import * as privacySettingsService from "src/features/privacy/services/privacySettingsService";
import type {
  PrivacySettings,
  PrivacyPreset,
  ScheduledSend,
} from "src/features/privacy/services/privacySettingsService";

export function usePrivacySettings(networkId: string) {
  const [settings, setSettings] = useState<PrivacySettings>(() =>
    privacySettingsService.getSettings(networkId),
  );

  const updateAutomation = useCallback(
    (patch: Partial<Omit<PrivacySettings, "presets" | "scheduledSends">>) => {
      const updated = privacySettingsService.updateAutomation(networkId, patch);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  const addPreset = useCallback(
    (preset: Omit<PrivacyPreset, "id">) => {
      const updated = privacySettingsService.addPreset(networkId, preset);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  const removePreset = useCallback(
    (presetId: string) => {
      const updated = privacySettingsService.removePreset(networkId, presetId);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  const addScheduledSend = useCallback(
    (send: Omit<ScheduledSend, "id">) => {
      const updated = privacySettingsService.addScheduledSend(networkId, send);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  const removeScheduledSend = useCallback(
    (sendId: string) => {
      const updated = privacySettingsService.removeScheduledSend(networkId, sendId);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  const toggleScheduledSend = useCallback(
    (sendId: string) => {
      const updated = privacySettingsService.toggleScheduledSend(networkId, sendId);
      setSettings(updated);
      return updated;
    },
    [networkId],
  );

  return {
    settings,
    updateAutomation,
    addPreset,
    removePreset,
    addScheduledSend,
    removeScheduledSend,
    toggleScheduledSend,
  };
}
