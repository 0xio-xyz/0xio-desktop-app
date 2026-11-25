import { useTranslation } from "src/i18n/react";
import { KV, Skel, Small } from "src/shared/ui/look";
import { NoticeCard } from "src/shared/ui/FormParts";
import type { KeyHold } from "src/features/privacy/hooks/useKeyHold";
import { truncateAddress } from "src/lib/format";

function when(at: number, today: string): { day: string; time: string } {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date().toDateString() === d.toDateString();
  return {
    day: sameDay ? today : d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    time,
  };
}

export default function KeyHoldCard({ hold }: { hold: KeyHold }) {
  const { t } = useTranslation();
  if (!hold.hold) return null;
  const sent = when(hold.hold.submittedAt, t("proofs.hold.today"));
  const checked = hold.checkedAt ? when(hold.checkedAt, t("proofs.hold.today")).time : null;
  return (
    <NoticeCard title={t("proofs.hold.title")}>
      <KV label={t("proofs.hold.submitted")}>
        {sent.day} <Small>{sent.time}</Small>
      </KV>
      <KV label={t("proofs.hold.transaction")}>
        <span className="font-mono text-[0.8125rem] font-normal">
          {truncateAddress(hold.hold.txHash, 10, 8)}
        </span>
      </KV>
      <KV label={t("proofs.hold.lastChecked")}>{checked ?? <Skel w="w-10" />}</KV>
    </NoticeCard>
  );
}
