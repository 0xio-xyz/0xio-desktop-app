import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import { PageTitle, Screen } from "src/shared/ui/flat";

export default function WatchOnlyBanner({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <Screen>
      <PageTitle title={title} />
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <Mascot id="watch-only" phase="zz" size={72} />
        <span className="text-title font-semibold text-content">{t("wallet.kindWatch")}</span>
      </div>
    </Screen>
  );
}
