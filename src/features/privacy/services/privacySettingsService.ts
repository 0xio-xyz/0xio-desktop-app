export interface PrivacyPreset {
  id: string;
  name: string;
  type: "encrypt" | "decrypt";
  amount: number; // micro-OCT
}

export interface ScheduledSend {
  id: string;
  to: string;
  amount: number; // micro-OCT
  isPrivate: boolean;
  intervalSeconds: number; // 0 = one-time at scheduledAt
  scheduledAt: number; // unix ms
  enabled: boolean;
  label: string;
  executionCount: number;
  lastExecutedAt: number | null;
  maxExecutions: number; // 0 = unlimited
  expiresAt: number | null; // unix ms, null = never
}

export interface PrivacySettings {
  autoEncryptEnabled: boolean;
  autoEncryptThreshold: number; // micro-OCT
  autoEncryptAmount: number; // micro-OCT, 0 = the full excess
  autoEncryptKeepMinPublic: number; // micro-OCT
  autoEncryptCooldownMinutes: number;
  autoEncryptMaxPerDay: number; // 0 = unlimited
  autoClaimEnabled: boolean;
  autoClaimInterval: number; // seconds
  autoClaimBehavior: "all" | "one";
  autoClaimMinAmount: number; // micro-OCT
  autoClaimMaxPerCycle: number; // 0 = all
  autoClaimChainAction: "none" | "encrypt" | "decrypt";
  autoDecryptEnabled: boolean;
  autoDecryptThreshold: number; // micro-OCT
  autoDecryptAmount: number; // micro-OCT, 0 = the full excess
  autoDecryptKeepMinEncrypted: number; // micro-OCT
  autoDecryptCooldownMinutes: number;
  autoDecryptMaxPerDay: number; // 0 = unlimited
  presets: PrivacyPreset[];
  scheduledSends: ScheduledSend[];
}

const STORAGE_KEY = (networkId: string) => `0xio_privacy_settings_${networkId}`;

const DEFAULTS: PrivacySettings = {
  autoEncryptEnabled: false,
  autoEncryptThreshold: 10_000_000,
  autoEncryptAmount: 0,
  autoEncryptKeepMinPublic: 1_000_000,
  autoEncryptCooldownMinutes: 5,
  autoEncryptMaxPerDay: 0,
  autoClaimEnabled: false,
  autoClaimInterval: 300,
  autoClaimBehavior: "all",
  autoClaimMinAmount: 0,
  autoClaimMaxPerCycle: 0,
  autoClaimChainAction: "none",
  autoDecryptEnabled: false,
  autoDecryptThreshold: 10_000_000,
  autoDecryptAmount: 0,
  autoDecryptKeepMinEncrypted: 0,
  autoDecryptCooldownMinutes: 5,
  autoDecryptMaxPerDay: 0,
  presets: [],
  scheduledSends: [],
};

const MAX_PRESETS = 5;

export function getSettings(networkId: string): PrivacySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(networkId));
    if (!raw) return { ...DEFAULTS, presets: [] };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, presets: Array.isArray(parsed.presets) ? parsed.presets : [] };
  } catch {
    return { ...DEFAULTS, presets: [] };
  }
}

function saveSettings(networkId: string, settings: PrivacySettings): void {
  localStorage.setItem(STORAGE_KEY(networkId), JSON.stringify(settings));
}

export function updateAutomation(
  networkId: string,
  patch: Partial<Omit<PrivacySettings, "presets" | "scheduledSends">>,
): PrivacySettings {
  const current = getSettings(networkId);
  const updated = { ...current, ...patch };
  saveSettings(networkId, updated);
  return updated;
}

/** @deprecated - use updateAutomation instead */
export function updateAutoEncrypt(
  networkId: string,
  patch: Partial<
    Pick<PrivacySettings, "autoEncryptEnabled" | "autoEncryptThreshold" | "autoEncryptAmount">
  >,
): PrivacySettings {
  const current = getSettings(networkId);
  const updated = { ...current, ...patch };
  saveSettings(networkId, updated);
  return updated;
}

export function addPreset(networkId: string, preset: Omit<PrivacyPreset, "id">): PrivacySettings {
  const current = getSettings(networkId);
  if (current.presets.length >= MAX_PRESETS) {
    throw new Error(`Maximum ${MAX_PRESETS} presets allowed`);
  }
  const newPreset: PrivacyPreset = { ...preset, id: crypto.randomUUID() };
  const updated = { ...current, presets: [...current.presets, newPreset] };
  saveSettings(networkId, updated);
  return updated;
}

export function removePreset(networkId: string, presetId: string): PrivacySettings {
  const current = getSettings(networkId);
  const updated = { ...current, presets: current.presets.filter((p) => p.id !== presetId) };
  saveSettings(networkId, updated);
  return updated;
}

export function addScheduledSend(
  networkId: string,
  send: Omit<ScheduledSend, "id">,
): PrivacySettings {
  const current = getSettings(networkId);
  const newSend: ScheduledSend = { ...send, id: crypto.randomUUID() };
  const updated = { ...current, scheduledSends: [...(current.scheduledSends || []), newSend] };
  saveSettings(networkId, updated);
  return updated;
}

export function removeScheduledSend(networkId: string, sendId: string): PrivacySettings {
  const current = getSettings(networkId);
  const updated = {
    ...current,
    scheduledSends: (current.scheduledSends || []).filter((s) => s.id !== sendId),
  };
  saveSettings(networkId, updated);
  return updated;
}

export function toggleScheduledSend(networkId: string, sendId: string): PrivacySettings {
  const current = getSettings(networkId);
  const updated = {
    ...current,
    scheduledSends: (current.scheduledSends || []).map((s) =>
      s.id === sendId ? { ...s, enabled: !s.enabled } : s,
    ),
  };
  saveSettings(networkId, updated);
  return updated;
}
