import React, { useRef } from "react";
import { useLocation } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { useIsFetching, useQueryClient } from "src/lib/query";
import "src/css/look-ext.css";
import TopBar from "src/shared/layout/TopBar";
import { FOCUS } from "src/features/settings/components/parts";
import {
  SETTINGS_TABS,
  useSettingsTab,
  type SettingsTab,
} from "src/features/settings/hooks/useSettingsTab";
import GeneralSection from "src/features/settings/screens/GeneralSection";
import AppearanceSection from "src/features/settings/screens/AppearanceSection";
import SecuritySection from "src/features/settings/screens/SecuritySection";
import NetworkSection from "src/features/settings/screens/NetworkSection";
import AdvancedSection from "src/features/settings/screens/AdvancedSection";

const TAB_LABEL: Record<SettingsTab, string> = {
  general: "settings.general",
  appearance: "preferences.appearance",
  security: "settings.securityPrivacy",
  network: "settings.network",
  advanced: "settings.advanced",
};

function SettingsTabs({
  value,
  onChange,
}: {
  value: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = SETTINGS_TABS.indexOf(value);
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    let next: SettingsTab | null = null;
    if (e.key in step) {
      next = SETTINGS_TABS[(at + step[e.key] + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    } else if (e.key === "Home") next = SETTINGS_TABS[0];
    else if (e.key === "End") next = SETTINGS_TABS[SETTINGS_TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t("settings.title")}
      onKeyDown={onKeyDown}
      className="look-raise inline-flex shrink-0 gap-0.5 rounded-[15px] bg-surface-card p-1"
    >
      {SETTINGS_TABS.map((tab) => {
        const on = tab === value;
        return (
          <button
            key={tab}
            ref={(el) => {
              refs.current[tab] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab)}
            className={`h-8 cursor-pointer rounded-[11px] px-3.75 text-[0.84375rem] font-medium whitespace-nowrap transition-colors duration-200 ease-out motion-reduce:transition-none ${FOCUS} ${
              on
                ? "bg-(--bg-3) text-content in-data-[theme=light]:bg-content in-data-[theme=light]:text-surface-card"
                : "text-content-muted hover:text-content"
            }`}
          >
            {t(TAB_LABEL[tab])}
          </button>
        );
      })}
    </div>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { search } = useLocation();
  const [tab, setTab] = useSettingsTab(
    new URLSearchParams(search).get("page") === "ai" ? "advanced" : undefined,
  );
  const queryClient = useQueryClient();
  const isLive = (q: { queryKey: readonly unknown[] }) =>
    String(q.queryKey[0]).startsWith("settings");
  const refreshing = useIsFetching({ predicate: isLive }) > 0;

  return (
    <div data-look="ext" className="h-full overflow-hidden bg-surface">
      <div className="mx-auto flex h-full max-w-310 flex-col px-7 pb-7 min-[1600px]:px-11">
        <div className="shrink-0 pt-6.5 pb-3">
          <TopBar
            refreshing={refreshing}
            onRefresh={() => void queryClient.invalidateQueries({ predicate: isLive })}
          />
        </div>
        <div className="mt-1 flex shrink-0 items-center justify-between gap-4">
          <h1 className="truncate text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-content">
            {t("settings.title")}
          </h1>
          <SettingsTabs value={tab} onChange={setTab} />
        </div>
        {tab === "general" && <GeneralSection />}
        {tab === "appearance" && <AppearanceSection />}
        {tab === "security" && <SecuritySection />}
        {tab === "network" && <NetworkSection />}
        {tab === "advanced" && <AdvancedSection />}
      </div>
    </div>
  );
}
