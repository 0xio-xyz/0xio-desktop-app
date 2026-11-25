import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn, PillSwitch } from "src/shared/ui/look";
import { Row, Toggle, Value } from "src/features/settings/components/parts";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import type { BrowserSecuritySettings } from "src/features/dapp/services/browserSecurity";

type Tab = "sites" | "data" | "security";

export default function BrowserSettingsPopup({
  open,
  onClose,
  historyCount,
  bookmarkCount,
  onClearHistory,
  onClearBookmarks,
  security,
  onSecurity,
  onOpenConnectedSites,
}: {
  open: boolean;
  onClose: () => void;
  historyCount: number;
  bookmarkCount: number;
  onClearHistory: () => void;
  onClearBookmarks: () => void;
  security: BrowserSecuritySettings;
  onSecurity: (next: BrowserSecuritySettings) => void;
  onOpenConnectedSites: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("sites");
  useEscapeKey(open, onClose);
  return (
    <PopupShell open={open} label={t("browser.settings")} onScrim={onClose}>
      <div className="flex items-center justify-between gap-4">
        <div className="text-title font-semibold text-content">{t("browser.settings")}</div>
        <PillSwitch
          label={t("browser.settings")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "sites", label: t("browser.sites") },
            { value: "data", label: t("browser.data") },
            { value: "security", label: t("browser.security") },
          ]}
        />
      </div>
      <div className="mt-4.5 h-44">
        {tab === "sites" && (
          <Row label={t("connectedSites.title")} onClick={onOpenConnectedSites}>
            <Value chevron />
          </Row>
        )}
        {tab === "data" && (
          <>
            <Row label={t("nav.history")}>
              <Value muted>{historyCount}</Value>
              <Btn size="sm" onClick={onClearHistory} disabled={historyCount === 0}>
                {t("browser.clear")}
              </Btn>
            </Row>
            <Row label={t("browser.bookmarks")}>
              <Value muted>{bookmarkCount}</Value>
              <Btn size="sm" onClick={onClearBookmarks} disabled={bookmarkCount === 0}>
                {t("browser.clear")}
              </Btn>
            </Row>
          </>
        )}
        {tab === "security" && (
          <>
            <Row label={t("browser.blockInsecure")}>
              <Toggle
                on={security.blockInsecureSites}
                label={t("browser.blockInsecure")}
                onChange={(on) => onSecurity({ ...security, blockInsecureSites: on })}
              />
            </Row>
            <Row label={t("browser.blockDangerous")}>
              <Value muted>{t("browser.alwaysOn")}</Value>
            </Row>
            <Row label={t("browser.approveEvery")}>
              <Value muted>{t("browser.alwaysOn")}</Value>
            </Row>
          </>
        )}
      </div>
    </PopupShell>
  );
}
