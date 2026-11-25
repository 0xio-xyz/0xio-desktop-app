import { useMemo } from "react";
import { useTranslation } from "src/i18n/react";
import { Caps } from "src/shared/ui/look";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { formatOCT, timeAgo } from "src/lib/format";
import { NETWORKS } from "src/services/network/config";

const msOf = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-lead font-semibold text-content tabular-nums">{value}</span>
      <span className="text-meta text-content-muted">{label}</span>
    </div>
  );
}

export default function ActivityMetricsCard({ networkId }: { networkId: string }) {
  const { t } = useTranslation();
  const { transactions } = useTransactionHistory();

  const metrics = useMemo(() => {
    let enc = 0,
      dec = 0,
      claim = 0,
      stealth = 0;
    let totalEnc = 0,
      totalDec = 0,
      lastOp = 0;
    for (const tx of transactions) {
      if (tx.status !== "confirmed") continue;
      if (tx.type === "encrypt") {
        enc++;
        totalEnc += tx.amount;
      } else if (tx.type === "decrypt") {
        dec++;
        totalDec += tx.amount;
      } else if (tx.type === "claim") {
        claim++;
      } else if (tx.type === "stealth_send") {
        stealth++;
      } else continue;
      if (tx.timestamp > lastOp) lastOp = tx.timestamp;
    }
    const ops = enc + dec + claim + stealth;
    return {
      enc,
      dec,
      claim,
      stealth,
      totalEnc,
      totalDec,
      lastOp,
      ratio: transactions.length > 0 ? Math.round((ops / transactions.length) * 100) : 0,
    };
  }, [transactions]);

  return (
    <section className="look-raise rounded-[22px] bg-surface-card px-5.5 py-5">
      <Caps right={NETWORKS[networkId]?.name ?? networkId}>{t("auto.activity.title")}</Caps>
      <div className="mt-4 grid grid-cols-4 gap-x-6 gap-y-4 @4xl:grid-cols-8">
        <Stat value={`${metrics.ratio}%`} label={t("auto.activity.private")} />
        <Stat value={`${formatOCT(metrics.totalEnc)} OCT`} label={t("auto.activity.encrypted")} />
        <Stat value={`${formatOCT(metrics.totalDec)} OCT`} label={t("auto.activity.decrypted")} />
        <Stat value={metrics.enc} label={t("auto.activity.encrypts")} />
        <Stat value={metrics.dec} label={t("auto.activity.decrypts")} />
        <Stat value={metrics.claim} label={t("auto.activity.claims")} />
        <Stat value={metrics.stealth} label={t("auto.activity.stealth")} />
        <Stat
          value={metrics.lastOp > 0 ? timeAgo(msOf(metrics.lastOp)) : t("auto.never")}
          label={t("auto.activity.last")}
        />
      </div>
    </section>
  );
}
