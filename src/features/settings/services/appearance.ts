import { NAV_LABEL_KEYS } from "src/shared/layout/navCatalog";

export interface NavGroup {
  id: string;
  title: string;
  paths: string[];
}

interface SidebarSizes {
  categoryPx: number;
  itemLabelPx: number;
  itemIconPx: number;
}

export type LockPriceRange = "24h" | "7d" | "30d";
const LOCK_PRICE_RANGES: LockPriceRange[] = ["24h", "7d", "30d"];

export type TrayTheme =
  | "auto"
  | "original"
  | "smoke"
  | "frost"
  | "octra"
  | "clear"
  | "phosphor"
  | "ember"
  | "cli";
export const TRAY_THEMES: TrayTheme[] = [
  "auto",
  "original",
  "smoke",
  "frost",
  "octra",
  "clear",
  "phosphor",
  "ember",
  "cli",
];

export interface AppearanceSettings {
  groups: NavGroup[];
  sizes: SidebarSizes;
  accentHex: string | null;
  lockPriceRange: LockPriceRange;
  trayTheme: TrayTheme;
  sidebarCollapsed: boolean;
}

export const SIZE_MIN = 8;
export const SIZE_MAX = 32;

export const DEFAULT_SIZES: SidebarSizes = {
  categoryPx: 11.5,
  itemLabelPx: 17,
  itemIconPx: 20,
};

/** Earlier defaults. Saved sizes equal to one of them were never changed by hand and follow the current default. */
const RETIRED_DEFAULT_SIZES: SidebarSizes[] = [
  { categoryPx: 11, itemLabelPx: 14, itemIconPx: 16 },
  { categoryPx: 10.5, itemLabelPx: 15, itemIconPx: 18 },
  { categoryPx: 11, itemLabelPx: 16, itemIconPx: 18 },
  { categoryPx: 11.5, itemLabelPx: 17, itemIconPx: 18 },
];

export const DEFAULT_GROUPS: NavGroup[] = [
  { id: "pinned", title: "Pinned", paths: ["/", "/send", "/privacy", "/history", "/receive"] },
  {
    id: "browse",
    title: "Browse",
    paths: ["/nfts", "/contracts", "/wallets", "/address-book", "/browser"],
  },
  {
    id: "advanced",
    title: "Advanced",
    paths: ["/circles", "/cipher-map", "/advanced"],
  },
];

export const APPEARANCE_KEY = "0xio_appearance_v1";
const KEY = APPEARANCE_KEY;
const LEGACY_COLLAPSED_KEY = "sidebar_collapsed";
export const APPEARANCE_EVENT = "0xio-appearance-changed";

export const ACCENT_PRESETS = ["#7aa2ff", "#0000db", "#5dd39e", "#ef6b6b"];

/** Dropped presets (no gold, no purple); a saved one falls back to the theme. */
const DROPPED_ACCENTS = new Set(["#e07b00", "#a78bfa"]);
const ACCENT_MIGRATED_KEY = "0xio_accent_presets_v2";

function clampSize(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
}

export function normalizeHex(input: string): string | null {
  const v = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  return null;
}

function legacyCollapsed(): boolean {
  try {
    return localStorage.getItem(LEGACY_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function savedSizes(saved: Partial<SidebarSizes> | undefined): SidebarSizes {
  const sizes = {
    categoryPx: clampSize(saved?.categoryPx, DEFAULT_SIZES.categoryPx),
    itemLabelPx: clampSize(saved?.itemLabelPx, DEFAULT_SIZES.itemLabelPx),
    itemIconPx: clampSize(saved?.itemIconPx, DEFAULT_SIZES.itemIconPx),
  };
  const untouched = RETIRED_DEFAULT_SIZES.some(
    (d) =>
      d.categoryPx === sizes.categoryPx &&
      d.itemLabelPx === sizes.itemLabelPx &&
      d.itemIconPx === sizes.itemIconPx,
  );
  return untouched ? DEFAULT_SIZES : sizes;
}

function dropRetiredAccent(parsed: Partial<AppearanceSettings>): Partial<AppearanceSettings> {
  try {
    if (localStorage.getItem(ACCENT_MIGRATED_KEY)) return parsed;
    localStorage.setItem(ACCENT_MIGRATED_KEY, "1");
    const hex = parsed.accentHex ? normalizeHex(parsed.accentHex) : null;
    if (!hex || !DROPPED_ACCENTS.has(hex)) return parsed;
    const next = { ...parsed, accentHex: null };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return parsed;
  }
}

export function loadAppearance(): AppearanceSettings {
  const fallback: AppearanceSettings = {
    groups: DEFAULT_GROUPS,
    sizes: DEFAULT_SIZES,
    accentHex: null,
    lockPriceRange: "24h",
    trayTheme: "auto",
    sidebarCollapsed: legacyCollapsed(),
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = dropRetiredAccent(JSON.parse(raw) as Partial<AppearanceSettings>);
    return {
      groups:
        Array.isArray(parsed.groups) && parsed.groups.length
          ? parsed.groups.map((g) => ({ ...g, paths: g.paths.filter((p) => p in NAV_LABEL_KEYS) }))
          : DEFAULT_GROUPS,
      sizes: savedSizes(parsed.sizes),
      accentHex: parsed.accentHex ? normalizeHex(parsed.accentHex) : null,
      lockPriceRange: LOCK_PRICE_RANGES.includes(parsed.lockPriceRange as LockPriceRange)
        ? (parsed.lockPriceRange as LockPriceRange)
        : "24h",
      trayTheme: TRAY_THEMES.includes(parsed.trayTheme as TrayTheme)
        ? (parsed.trayTheme as TrayTheme)
        : "auto",
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === "boolean"
          ? parsed.sidebarCollapsed
          : fallback.sidebarCollapsed,
    };
  } catch {
    return fallback;
  }
}

export function resolveTrayTheme(choice: TrayTheme, appTheme: string): Exclude<TrayTheme, "auto"> {
  if (choice !== "auto") return choice;
  return appTheme === "light" ? "frost" : appTheme === "octra" ? "octra" : "smoke";
}

export function saveAppearance(settings: AppearanceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
}

export function applyAccent(hex: string | null) {
  const root = document.documentElement;
  if (!hex) {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-hover");
    root.style.removeProperty("--border-active");
    return;
  }
  root.style.setProperty("--primary", hex);
  root.style.setProperty("--primary-hover", shade(hex, 12));
  root.style.setProperty("--border-active", hex);
}

function shade(hex: string, percent: number): string {
  const n = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 0xff) + amt);
  const b = clamp((n & 0xff) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
