import { useTranslation } from "src/i18n/react";
import FeePicker from "src/shared/ui/FeePicker";
import Mascot from "src/shared/ui/Mascot";
import ReviewPopup, { PopupShell } from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Amount, Btn, EASE, KV, Pair, StepDots, clock } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import { useNow } from "src/hooks/privacy/useProofQueue";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { formatOCT } from "src/lib/format";
import { feeText } from "src/services/transactions/feeText";
import type { useCircleBatchFee } from "src/features/circles/hooks/useCircleBatchFee";
import { cutId, fileSize } from "src/features/circles/services/circleFormat";
import type {
  BatchRun,
  DeployRun,
  RunFile,
  StagedRow,
} from "src/features/circles/services/circleRun";

export function ReplaceTag({ replace }: { replace: boolean }) {
  const { t } = useTranslation();
  return replace ? (
    <span className="inline-flex h-4.75 items-center rounded-[10px] bg-(--bg-3) px-1.75 text-micro font-medium text-content-secondary">
      {t("circles.replace")}
    </span>
  ) : (
    <span className="text-[0.8125rem] text-content-secondary">{t("circles.new")}</span>
  );
}

function CircleName({ title, id }: { title: string; id: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {title && <span className="truncate">{title}</span>}
      <span className="font-mono text-meta font-normal text-content-muted">{cutId(id)}</span>
    </span>
  );
}

function Total({ ou }: { ou: string }) {
  const { getUsdValue } = useTokenPrice();
  const micro = Number(ou) || 0;
  return <Amount value={formatOCT(micro)} after={getUsdValue("OCT", micro / 1_000_000) ?? ""} />;
}

export function UploadReview({
  open,
  network,
  wallet,
  circleId,
  title,
  sealed,
  rows,
  fee,
  onReject,
  onConfirm,
}: {
  open: boolean;
  network: string;
  wallet: { name: string; address: string };
  circleId: string;
  title: string;
  sealed: boolean;
  rows: StagedRow[];
  fee: ReturnType<typeof useCircleBatchFee>;
  onReject: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const ok = fee.quote.status === "ok" && fee.parts.length === rows.length && rows.length > 0;
  return (
    <ReviewPopup
      open={open}
      label={t("circles.reviewUpload")}
      caption={t("circles.upload")}
      right={network}
      hero={
        <div className="flex items-baseline justify-between gap-2.5">
          <span className="text-[1.875rem] leading-[1.1] font-light tracking-[-0.03em]">
            {t("circles.files", { count: rows.length })}
          </span>
          <span className="text-body text-content-muted tabular-nums">
            {fileSize(rows.reduce((n, r) => n + r.size, 0))}
          </span>
        </div>
      }
      verb={t("circles.upload")}
      onReject={() => !fee.recheck.checking && onReject()}
      onConfirm={onConfirm}
      confirmDisabled={!ok}
      busy={fee.recheck.checking}
      error={fee.recheck.error}
    >
      <KV label={t("sendFlow.from")}>
        <WalletAvatar address={wallet.address} size={22} />
        {wallet.name}
      </KV>
      <KV label={t("circles.circle")}>
        <CircleName title={title} id={circleId} />
      </KV>
      <KV label={t("circlesPage.visibility")}>
        {t(sealed ? "circlesPage.encrypted" : "circlesPage.public")}
      </KV>
      <ul
        aria-label={t("circles.transactions")}
        className="my-1.5 max-h-43 overflow-y-auto rounded-[14px] bg-surface-highlight p-1.5 scrollbar-hide"
      >
        {rows.map((r, i) => (
          <li
            key={r.key}
            className="grid min-h-8.5 grid-cols-[minmax(0,1fr)_4.5rem_4rem_6.5rem] items-center gap-x-3 px-2.5 text-[0.84375rem]"
          >
            <span className="truncate font-mono text-[0.8125rem]">{r.path}</span>
            <span>
              <ReplaceTag replace={r.replace} />
            </span>
            <span className="text-right whitespace-nowrap text-content-secondary tabular-nums">
              {fileSize(r.size)}
            </span>
            <span className="text-right text-meta whitespace-nowrap tabular-nums">
              {ok ? <Amount value={formatOCT(Number(fee.parts[i]) || 0)} /> : ""}
            </span>
          </li>
        ))}
      </ul>
      <KV label={t("circles.transactions")}>
        <span className="tabular-nums">{rows.length}</span>
      </KV>
      <KV label={t("sendFlow.networkFee")}>
        <FeePicker
          quote={fee.quote}
          ou={fee.ou}
          onChange={fee.setOU}
          disabled={fee.recheck.checking}
        />
      </KV>
      <KV label={t("sendFlow.total")}>{ok ? <Total ou={fee.ou} /> : ""}</KV>
    </ReviewPopup>
  );
}

const DOT: Record<RunFile["state"], string> = {
  waiting: "bg-(--bg-3)",
  unsent: "bg-(--bg-3)",
  sending: "bg-content shadow-[0_0_0_4px_var(--bg-3)] motion-safe:animate-pulse",
  confirmed: "bg-content-secondary",
  pending: "bg-content-muted",
  rejected: "bg-danger",
  refused: "bg-danger",
};

export function RunMark({ file, now }: { file: RunFile; now: number }) {
  const { t } = useTranslation();
  const bad = file.state === "rejected" || file.state === "refused";
  return (
    <span
      className={`inline-flex items-center gap-2 text-meta whitespace-nowrap tabular-nums ${bad ? "text-danger" : "text-content-muted"}`}
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[file.state]}`} />
      {file.state === "sending"
        ? clock((now - (file.since ?? now)) / 1000)
        : t(`circles.state.${file.state}`)}
    </span>
  );
}

export function BatchSheet({
  batch,
  title,
  onHide,
  onBack,
  onReviewRest,
  onCheck,
}: {
  batch: BatchRun;
  title: string;
  onHide: () => void;
  onBack: () => void;
  onReviewRest: () => void;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const running = batch.status === "running";
  const now = useNow(running);
  useEscapeKey(true, running ? onHide : onBack);
  const done = batch.files.filter((f) => f.state === "confirmed").length;
  const unclear = batch.files.some((f) => f.state === "pending");
  const rest = batch.files.filter((f) => ["refused", "rejected", "unsent"].includes(f.state));
  const reason = batch.files.find((f) => f.reason)?.reason;
  const head = running
    ? t("circles.uploadingN", { count: batch.files.length })
    : t("circles.uploadedOf", { done, count: batch.files.length });
  return (
    <PopupShell open still label={head} onScrim={running ? onHide : onBack}>
      <div className="flex items-center gap-4.5">
        <Mascot id="circle-batch" phase={running ? "ld" : "up"} size={64} />
        <div className="min-w-0">
          <div className="truncate text-[1.375rem] font-semibold text-content">{head}</div>
          <div className="mt-1.5 flex h-5 items-center text-[0.8125rem] text-content-muted">
            <CircleName title={title} id={batch.circleId} />
          </div>
        </div>
      </div>
      <ol className="mt-5.5 flex h-44.5 flex-col gap-0.5 overflow-y-auto scrollbar-hide">
        {batch.files.map((f) => (
          <li
            key={f.key}
            aria-current={f.state === "sending" ? "step" : undefined}
            className={`flex h-8.5 shrink-0 items-center justify-between gap-3 ${EASE} ${
              f.state === "sending"
                ? "font-medium text-content"
                : f.state === "waiting" || f.state === "unsent"
                  ? "text-content-muted"
                  : "text-content-secondary"
            }`}
          >
            <span className="truncate font-mono text-[0.8125rem]">{f.path}</span>
            <RunMark file={f} now={now} />
          </li>
        ))}
      </ol>
      <p
        role={reason ? "alert" : undefined}
        className="mt-4 line-clamp-2 min-h-10 text-[0.8125rem] leading-snug break-words text-danger"
      >
        {feeText(reason) ?? ""}
      </p>
      {running ? (
        <div className="mt-2.5 flex h-11.5 items-center justify-end">
          <Btn weight="text" size="sm" onClick={onHide}>
            {t("activity.hide")}
          </Btn>
        </div>
      ) : unclear ? (
        <Pair
          className="mt-2.5"
          left={<Btn onClick={onBack}>{t("activity.hide")}</Btn>}
          right={
            <Btn data-autofocus onClick={onCheck}>
              {t("circles.checkAgain")}
            </Btn>
          }
        />
      ) : (
        <Pair
          className="mt-2.5"
          left={<Btn onClick={onBack}>{t("circles.backToFiles")}</Btn>}
          right={
            <Btn weight="primary" data-autofocus className="look-key" onClick={onReviewRest}>
              {t("circles.reviewRemaining", { count: rest.length })}
            </Btn>
          }
        />
      )}
    </PopupShell>
  );
}

export function DeploySheet({
  deploy,
  onHide,
  onBack,
}: {
  deploy: DeployRun;
  onHide: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const running = deploy.status === "running";
  const now = useNow(running);
  useEscapeKey(true, running ? onHide : onBack);
  const head = t(
    running
      ? "circles.deploying"
      : deploy.status === "rejected"
        ? "circles.deployRejected"
        : "circles.deployFailed",
  );
  const steps = ["circles.stepSend", "circles.stepConfirm"].map((key, i) => {
    const start = deploy.marks[i];
    const end = deploy.marks[i + 1] ?? now;
    return { label: t(key), sec: start == null || !running ? null : (end - start) / 1000 };
  });
  return (
    <PopupShell open still label={head} onScrim={running ? onHide : onBack}>
      <div className="flex items-center gap-4.5">
        <Mascot id="circle-deploy" phase={running ? "ld" : "up"} size={64} />
        <div className="min-w-0">
          <div className="truncate text-[1.375rem] font-semibold text-content">{head}</div>
          <div className="mt-1.5 flex h-5 items-center text-[0.8125rem] text-content-muted">
            {t(deploy.sealed ? "circles.encryptedCircle" : "circles.publicCircle")}
          </div>
        </div>
      </div>
      <div className="mt-5.5 h-18">
        <StepDots steps={steps} current={deploy.marks.length - 1} stopped={!running} />
      </div>
      <p
        role={deploy.reason ? "alert" : undefined}
        className="mt-4 line-clamp-2 min-h-10 text-[0.8125rem] leading-snug break-words text-danger"
      >
        {feeText(deploy.reason) ?? ""}
      </p>
      <div className="mt-2.5 flex h-11.5 items-center justify-end">
        {running ? (
          <Btn weight="text" size="sm" onClick={onHide}>
            {t("activity.hide")}
          </Btn>
        ) : (
          <Btn data-autofocus onClick={onBack}>
            {t("common.back")}
          </Btn>
        )}
      </div>
    </PopupShell>
  );
}
