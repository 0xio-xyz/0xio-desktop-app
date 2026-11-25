import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useTheme } from "src/contexts/ThemeContext";
import { useWallet } from "src/contexts/useWallet";
import { LANGUAGES, setLanguage } from "src/i18n";
import { checkForUpdate } from "src/services/app/updater";
import TabLayout from "src/features/settings/components/TabLayout";
import {
  Group,
  PillAction,
  PillSelect,
  Row,
  Segmented,
  Value,
} from "src/features/settings/components/parts";
import GeneralPanel from "src/features/settings/panels/GeneralPanel";

type Theme = "dim" | "light" | "octra";

export default function GeneralSection() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { showMessage } = useWallet();
  const [checking, setChecking] = useState(false);

  const handleCheckUpdates = async () => {
    setChecking(true);
    try {
      await checkForUpdate(true);
    } catch {
      showMessage("error", t("settings.updateCheckFailed"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <TabLayout panel={<GeneralPanel checking={checking} />}>
      <Group caption={t("settings.preferences")}>
        <Row label={t("preferences.theme")}>
          <Segmented<Theme>
            label={t("preferences.theme")}
            value={theme as Theme}
            onChange={setTheme}
            options={[
              { value: "dim", label: t("preferences.dim") },
              { value: "light", label: t("preferences.light") },
              { value: "octra", label: t("preferences.octra") },
            ]}
          />
        </Row>
        <Row label={t("settings.language")}>
          <PillSelect
            label={t("settings.language")}
            value={i18n.language}
            onChange={(code) => void setLanguage(code)}
            options={LANGUAGES.map((l) => ({ value: l.code as string, label: l.label }))}
          />
        </Row>
        <Row label={t("settings.currency")}>
          <Value muted>USD</Value>
        </Row>
      </Group>
      <Group caption={t("settings.updates")}>
        <Row label="0xio Desktop" sub={t("settings.versionLine", { version: __APP_VERSION__ })}>
          <PillAction onClick={() => void handleCheckUpdates()} disabled={checking}>
            {t("settings.checkUpdates")}
          </PillAction>
        </Row>
      </Group>
    </TabLayout>
  );
}
