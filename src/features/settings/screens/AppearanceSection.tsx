import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useTheme } from "src/contexts/ThemeContext";
import { useAppearance } from "src/features/settings/hooks/useAppearance";
import TabLayout from "src/features/settings/components/TabLayout";
import {
  FOCUS,
  Group,
  PillSelect,
  Row,
  Segmented,
  TextAction,
  Value,
} from "src/features/settings/components/parts";
import AppearancePanel, { TRAY_NAMES } from "src/features/settings/panels/AppearancePanel";
import SidebarLayoutPage from "src/features/settings/screens/SidebarLayoutPage";
import {
  ACCENT_PRESETS,
  DEFAULT_GROUPS,
  DEFAULT_SIZES,
  TRAY_THEMES,
  normalizeHex,
  type LockPriceRange,
  type TrayTheme,
} from "src/features/settings/services/appearance";

function Swatch({
  color,
  on,
  label,
  onClick,
}: {
  color: string;
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`grid size-7.5 cursor-pointer place-items-center rounded-[10px] transition-colors duration-200 ease-out ${FOCUS} ${on ? "bg-(--bg-3)" : "hover:bg-surface-highlight"}`}
    >
      <span className="block size-4.5 rounded-full" style={{ backgroundColor: color }} />
    </button>
  );
}

export default function AppearanceSection() {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const { settings, update } = useAppearance();
  const [page, setPage] = useState<"sidebar" | null>(null);
  const isCustom = !!settings.accentHex && !ACCENT_PRESETS.includes(settings.accentHex);
  const [customOpen, setCustomOpen] = useState(isCustom);
  const [hexInput, setHexInput] = useState(isCustom ? (settings.accentHex ?? "") : "");
  const [hexError, setHexError] = useState(false);

  const pick = (hex: string | null) => {
    setCustomOpen(false);
    setHexError(false);
    update({ ...settings, accentHex: hex });
  };

  const applyHex = (raw: string) => {
    setHexInput(raw);
    if (raw.trim() === "") {
      setHexError(false);
      return;
    }
    const hex = normalizeHex(raw);
    setHexError(!hex);
    if (hex) update({ ...settings, accentHex: hex });
  };

  const panel = <AppearancePanel settings={settings} theme={theme} />;

  if (page === "sidebar") {
    return (
      <TabLayout panel={panel}>
        <SidebarLayoutPage settings={settings} update={update} onBack={() => setPage(null)} />
      </TabLayout>
    );
  }

  const trayOptions = TRAY_THEMES.map((v: TrayTheme) => ({
    value: v,
    label:
      v === "auto"
        ? t("settings.matchApp")
        : v === "original"
          ? t("settings.trayOriginal")
          : TRAY_NAMES[v],
  }));

  return (
    <TabLayout panel={panel}>
      <Group caption={t("settings.colour")}>
        <Row label={t("settings.accentColour")}>
          <span className="flex items-center gap-0.5">
            <Swatch
              color="var(--accent)"
              on={!settings.accentHex && !customOpen}
              label={t("settings.themeDefault")}
              onClick={() => pick(null)}
            />
            {ACCENT_PRESETS.map((hex) => (
              <Swatch
                key={hex}
                color={hex}
                on={settings.accentHex === hex && !customOpen}
                label={hex}
                onClick={() => pick(hex)}
              />
            ))}
          </span>
          <span
            className={`rounded-full ${customOpen || isCustom ? "bg-(--bg-3) [&>button]:text-content" : ""}`}
          >
            <TextAction onClick={() => setCustomOpen(true)}>{t("settings.custom")}</TextAction>
          </span>
        </Row>
        {(customOpen || isCustom) && (
          <Row
            label={t("settings.customColour")}
            sub={hexError ? <span className="text-danger">{t("settings.notHex")}</span> : undefined}
          >
            <span
              aria-hidden="true"
              className="size-4.5 rounded-full"
              style={{ backgroundColor: settings.accentHex ?? "var(--accent)" }}
            />
            <input
              autoFocus={customOpen && !isCustom}
              value={hexInput}
              onChange={(e) => applyHex(e.target.value)}
              placeholder="#7aa2ff"
              spellCheck={false}
              aria-label={t("settings.customColour")}
              aria-invalid={hexError}
              className="h-7.5 w-28 rounded-full bg-surface-highlight px-3 font-mono text-[0.8125rem] text-content outline-none placeholder:text-content-muted focus-visible:ring-2 focus-visible:ring-accent"
            />
          </Row>
        )}
      </Group>

      <Group caption={t("settings.menuBarAndLock")}>
        <Row label={t("settings.menuBarTheme")}>
          <PillSelect<TrayTheme>
            label={t("settings.menuBarTheme")}
            value={settings.trayTheme}
            onChange={(trayTheme) => update({ ...settings, trayTheme })}
            options={trayOptions}
          />
        </Row>
        <Row label={t("settings.lockChart")}>
          <Segmented<LockPriceRange>
            label={t("settings.lockChart")}
            value={settings.lockPriceRange}
            onChange={(lockPriceRange) => update({ ...settings, lockPriceRange })}
            options={[
              { value: "24h", label: t("settings.daily") },
              { value: "7d", label: t("settings.weekly") },
              { value: "30d", label: t("settings.monthly") },
            ]}
          />
        </Row>
      </Group>

      <Group caption={t("settings.sidebar")}>
        <Row label={t("settings.sidebarLayout")} onClick={() => setPage("sidebar")}>
          <Value chevron>{t("settings.groupsCount", { count: settings.groups.length })}</Value>
        </Row>
        <Row label={t("settings.resetAppearance")}>
          <TextAction
            onClick={() => {
              setHexInput("");
              setCustomOpen(false);
              update({
                groups: DEFAULT_GROUPS,
                sizes: DEFAULT_SIZES,
                accentHex: null,
                lockPriceRange: "24h",
                trayTheme: "auto",
                sidebarCollapsed: false,
              });
            }}
          >
            {t("settings.reset")}
          </TextAction>
        </Row>
      </Group>
    </TabLayout>
  );
}
