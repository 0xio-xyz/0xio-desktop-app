import { useTranslation } from "src/i18n/react";
import { useNavigate } from "src/lib/router";
import Mascot from "src/shared/ui/Mascot";
import ReviewCard from "src/shared/ui/ReviewCard";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import {
  Amount,
  Btn,
  Caps,
  Card,
  ErrorLine,
  Hero,
  KV,
  Lines,
  NetName,
  Pair,
  Skel,
  Small,
} from "src/shared/ui/look";
import FeeValue from "src/features/wallet/components/FeeValue";
import { RowState } from "src/features/wallet/components/send/BulkForm";
import type { BulkFlow } from "src/features/wallet/hooks/useBulkFlow";
import type { Recipients } from "src/features/wallet/hooks/useRecipients";
import type { SendForm } from "src/features/wallet/hooks/useSendForm";
import { useWallet } from "src/contexts/useWallet";
import { FINANCE, NETWORKS } from "src/services/network/config";
import { formatOCT, truncateAddress } from "src/lib/format";
import { feeText } from "src/services/transactions/feeText";

function units(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function NetRight() {
  const { networkId } = useWallet();
  return <NetName name={(NETWORKS[networkId]?.name ?? networkId).replace(/^Octra\s+/i, "")} />;
}

export function BulkPanel({ form, bulk }: { form: SendForm; bulk: BulkFlow }) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const n = bulk.pending.length;
  const fees = form.fee === null ? null : form.fee * n;
  const totalMicro = Math.round(bulk.total * FINANCE.MICRO_OCT_MULTIPLIER);
  const bal = form.spendBalance;
  const left =
    bal === null || fees === null
      ? null
      : form.isToken
        ? form.tokenBalance - bulk.total
        : form.isPrivate
          ? (bal - totalMicro) / FINANCE.MICRO_OCT_MULTIPLIER
          : (bal - totalMicro - fees) / FINANCE.MICRO_OCT_MULTIPLIER;
  const note =
    bulk.spend.error && n > 0
      ? feeText(bulk.spend.error)
      : bulk.duplicates.size > 0
        ? t("sendFlow.duplicates", { count: bulk.duplicates.size })
        : null;
  return (
    <Card className="h-full" label={t("sendFlow.livePanel")}>
      <Caps right={t("sendFlow.live")}>
        <NetRight />
      </Caps>
      <KV label={t("sendFlow.from")} className="mt-2.5">
        <WalletAvatar address={activeWallet?.address} size={22} />
        {activeWallet?.name}
      </KV>
      <KV label={t("sendFlow.feeEach")}>
        <FeeValue quote={form.quote} ou={form.ou} onOUChange={form.setOU} />
      </KV>
      <Caps className="mt-3.5">{t("sendFlow.thisBulk")}</Caps>
      <KV label={t("sendFlow.recipientsLabel")}>{bulk.batch.rows.length}</KV>
      <KV label={t("sendFlow.waitingLabel")}>{n}</KV>
      <KV label={t("sendFlow.total")}>
        <Amount value={units(bulk.total)} unit={form.unit} />
      </KV>
      <KV label={t("sendFlow.feesTotal")}>
        {fees === null ? <Skel /> : <Amount value={formatOCT(fees)} />}
      </KV>
      <KV
        label={
          form.isToken
            ? t("sendFlow.tokenAfter", { symbol: form.unit })
            : t(form.isPrivate ? "proofs.privateAfter" : "proofs.publicAfter")
        }
      >
        {left === null ? (
          <Skel w="w-24" />
        ) : (
          <Amount value={units(Math.max(0, left))} unit={form.unit} />
        )}
      </KV>
      <div className="flex-1" />
      <p className="min-h-5 text-[0.8125rem] leading-snug text-content-secondary">{note ?? ""}</p>
    </Card>
  );
}

function SendList({
  bulk,
  recipients,
  unit,
}: {
  bulk: BulkFlow;
  recipients: Recipients;
  unit: string;
}) {
  const rows = bulk.review?.rows ?? [];
  const live = new Map(bulk.batch.rows.map((r) => [r.id, r]));
  return (
    <ol className="max-h-56 min-h-0 overflow-y-auto scrollbar-hide">
      {rows.map((r, i) => {
        const who = recipients.info(r.address);
        const row = live.get(r.id);
        return (
          <li key={r.id} className="flex min-h-10 items-center gap-3 text-body">
            <span className="w-5 text-[0.75rem] text-content-muted tabular-nums">{i + 1}</span>
            <WalletAvatar address={r.address} size={20} />
            <span className="min-w-0 flex-1 truncate text-content">
              {who.name ?? (
                <span className="font-mono text-[0.8125rem]">
                  {truncateAddress(r.address, 10, 8)}
                </span>
              )}
            </span>
            <Amount value={r.amount} unit={unit} />
            {row && bulk.phase !== "review" && (
              <span className="grid w-14 place-items-end">
                <RowState row={row} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function BulkReviewCard({
  form,
  bulk,
  recipients,
}: {
  form: SendForm;
  bulk: BulkFlow;
  recipients: Recipients;
}) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const s = bulk.review!;
  const unit = s.token?.symbol ?? "OCT";
  const n = s.rows.length;
  const fee = Number(s.ou);
  return (
    <ReviewCard
      caption={t(s.isPrivate ? "sendFlow.reviewBulkPrivate" : "sendFlow.reviewBulk")}
      right={<NetRight />}
      hero={<Hero value={units(s.total)} unit={unit} />}
      sub={t("sendFlow.toN", { count: n })}
      verb={t("sendFlow.sendN", { count: n })}
      onReject={bulk.reject}
      onConfirm={() => void bulk.confirm()}
      confirmDisabled={form.quote.status !== "ok"}
      busy={form.recheck.checking}
      error={bulk.error ?? form.recheck.error}
    >
      <KV label={t("sendFlow.from")} tall>
        <WalletAvatar address={activeWallet?.address} size={22} />
        <Lines>
          <span>{activeWallet?.name}</span>
          <Small>{t(s.isPrivate ? "sendFlow.privateBalance" : "sendFlow.publicBalance")}</Small>
        </Lines>
      </KV>
      <SendList bulk={bulk} recipients={recipients} unit={unit} />
      <KV label={t("sendFlow.feeEach")}>
        <Amount value={formatOCT(fee)} />
      </KV>
      <KV label={t("sendFlow.feesTotal")} tall>
        <Lines>
          <Amount value={formatOCT(fee * n)} />
          <Small>{t("sendFlow.paidFromPublic")}</Small>
        </Lines>
      </KV>
    </ReviewCard>
  );
}

export function BulkProgressCard({ bulk, recipients }: { bulk: BulkFlow; recipients: Recipients }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const s = bulk.review!;
  const unit = s.token?.symbol ?? "OCT";
  const done = bulk.phase === "done";
  const stats = bulk.batch.stats;
  const title = done
    ? stats.failed > 0 || bulk.error
      ? t("sendFlow.stopped")
      : t("sendFlow.sent")
    : t(s.isPrivate ? "sendFlow.sendingPrivately" : "sendFlow.sending");
  return (
    <Card className="h-full" label={title}>
      <Caps right={<NetRight />}>{t(s.isPrivate ? "sendFlow.privateBulk" : "sendFlow.bulk")}</Caps>
      <div className="mt-5.5 mb-3 flex items-center gap-4.5">
        <Mascot id="bulk-card" phase={done ? "ok" : s.isPrivate ? "en" : "ld"} size={80} />
        <div className="min-w-0">
          <div
            aria-live="polite"
            className="text-[1.5rem] font-semibold tracking-[-0.01em] text-content"
          >
            {title}
          </div>
          <div className="mt-1.5 text-body text-content-secondary">
            {t("sendFlow.xOfN", { x: stats.success, n: s.rows.length })}
          </div>
        </div>
      </div>
      <SendList bulk={bulk} recipients={recipients} unit={unit} />
      <KV label={t("sendFlow.total")}>
        <Amount value={units(s.total)} unit={unit} />
      </KV>
      <div className="flex-1" />
      <ErrorLine
        text={
          bulk.error
            ? feeText(bulk.error)
            : bulk.result && bulk.result.capped > 0
              ? t("sendFlow.capped", { count: bulk.result.capped })
              : null
        }
      />
      {done ? (
        <Pair
          className="mt-2.5"
          left={
            stats.failed > 0 ? (
              <Btn className="w-full" onClick={bulk.retryFailed}>
                {t("send.retryFailed", { count: stats.failed })}
              </Btn>
            ) : (
              <Btn className="w-full" onClick={() => navigate("/history")}>
                {t("sendFlow.viewHistory")}
              </Btn>
            )
          }
          right={
            <Btn weight="primary" className="w-full" onClick={bulk.newSend}>
              {t("sendFlow.newSend")}
            </Btn>
          }
        />
      ) : (
        <Btn className="mt-2.5 w-full" onClick={bulk.stop}>
          {t("sendFlow.stop")}
        </Btn>
      )}
    </Card>
  );
}
