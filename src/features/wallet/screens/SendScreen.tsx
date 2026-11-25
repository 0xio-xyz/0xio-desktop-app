import React, { useEffect, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useLocation, useNavigate } from "src/lib/router";
import LookFrame from "src/shared/layout/LookFrame";
import WatchOnlyBanner from "src/shared/layout/WatchOnlyBanner";
import BigAmount from "src/shared/ui/BigAmount";
import FeePicker from "src/shared/ui/FeePicker";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import Who from "src/shared/ui/Who";
import {
  Amount,
  Btn,
  Caps,
  EASE,
  FOCUS,
  KV,
  NetName,
  Num,
  PillSwitch,
  Skel,
  clock,
} from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import RecipientPicker from "src/features/wallet/components/send/RecipientPicker";
import TokenPicker from "src/features/wallet/components/send/TokenPicker";
import BulkForm from "src/features/wallet/components/send/BulkForm";
import {
  BulkPanel,
  BulkProgressCard,
  BulkReviewCard,
} from "src/features/wallet/components/send/BulkCards";
import {
  MESSAGE_MAX,
  useSendForm,
  type SendForm,
  type SendMode,
  type SendTab,
} from "src/features/wallet/hooks/useSendForm";
import { useSendFlow, type SendFlow } from "src/features/wallet/hooks/useSendFlow";
import { useBulkFlow } from "src/features/wallet/hooks/useBulkFlow";
import { useRecipients, type Recipients } from "src/features/wallet/hooks/useRecipients";
import { usePrivacyEnv, type PrivacyEnv } from "src/features/privacy/hooks/usePrivacyEnv";
import {
  GateButton,
  GateNotice,
  hasGateButton,
  hasGateNotice,
} from "src/features/privacy/components/GateViews";
import KeyHoldCard from "src/features/privacy/components/KeyHoldCard";
import RefreshReview from "src/features/privacy/components/RefreshReview";
import TurnOnReview from "src/features/privacy/components/TurnOnReview";
import { STOPPED } from "src/features/privacy/services/proofJobs";
import { remove, retry, type ProofJob } from "src/features/privacy/services/proofQueue";
import { useNow, useWalletQueue } from "src/hooks/privacy/useProofQueue";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { showProgress } from "src/services/notices/activity";
import { NETWORKS } from "src/services/network/config";
import { formatOCT, formatTokenAmount, truncateAddress } from "src/lib/format";
import { feeText } from "src/services/transactions/feeText";

function reasonOf(form: SendForm, t: (k: string) => string): string | null {
  if (!form.validRecipient) return t("sendFlow.chooseRecipient");
  if (!form.amount || (form.isToken ? form.tokenRaw === "0" : form.amountMicro <= 0))
    return t("sendFlow.enterAmount");
  if (form.quote.status === "error") return t("fee.unavailableRetry");
  if (form.quote.status !== "ok") return "";
  if (form.spend.error) return feeText(form.spend.error);
  return form.spend.ok ? null : "";
}

function amountText(form: SendForm): string {
  return form.token
    ? formatTokenAmount(form.tokenRaw, form.token.decimals)
    : formatOCT(form.amountMicro);
}

function NetRight() {
  const { networkId } = useWallet();
  return <NetName name={(NETWORKS[networkId]?.name ?? networkId).replace(/^Octra\s+/i, "")} />;
}

function ToValue({
  address,
  name,
  recipients,
}: {
  address: string;
  name?: string | null;
  recipients: Recipients;
}) {
  const info = recipients.info(address);
  if (name) return <Who address={address} name={name} />;
  return (
    <>
      <WalletAvatar address={address} size={22} />
      {info.name ?? (
        <span className="font-mono text-[0.8125rem] font-normal">
          {truncateAddress(address, 12, 8)}
        </span>
      )}
    </>
  );
}

function Summary({
  form,
  recipients,
  locked,
}: {
  form: SendForm;
  recipients: Recipients;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const fee = form.fee;
  const amount = form.isToken ? 0 : form.amountMicro;
  const total =
    amount === 0 ? 0 : fee === null ? null : form.isPrivate || form.isToken ? amount : amount + fee;
  const pubAfter =
    form.publicKnown === null
      ? null
      : form.publicKnown - (fee ?? 0) - (form.isPrivate || form.isToken ? 0 : amount);
  const privAfter = form.privateBalance === null ? null : form.privateBalance - amount;
  const after = form.isPrivate ? privAfter : pubAfter;
  return (
    <div className="flex flex-col">
      <KV label={t("sendFlow.from")}>
        <WalletAvatar address={activeWallet?.address} size={22} />
        {activeWallet?.name}
      </KV>
      <KV label={t("sendFlow.to")}>
        {form.validRecipient ? (
          <ToValue address={form.recipient} name={form.recipientName} recipients={recipients} />
        ) : (
          <span className="font-normal text-content-muted">{t("sendFlow.notChosen")}</span>
        )}
      </KV>
      <KV label={t("proofs.network")}>
        <NetRight />
      </KV>
      <KV label={t("sendFlow.networkFee")}>
        <FeePicker quote={form.quote} ou={form.ou} onChange={form.setOU} disabled={locked} />
      </KV>
      <KV label={t("sendFlow.feePaidFrom")}>{t("sendFlow.publicBalance")}</KV>
      <KV label={t("sendFlow.onChain")}>
        {t(form.isPrivate ? "sendFlow.hiddenOnChain" : "sendFlow.visibleOnChain")}
      </KV>
      <KV label={t("sendFlow.total")}>
        {form.isToken ? (
          <Amount value={form.amount ? amountText(form) : "0"} unit={form.unit} />
        ) : total === null ? (
          <Skel w="w-24" />
        ) : (
          <Amount value={formatOCT(total)} />
        )}
      </KV>
      <KV label={t(form.isPrivate ? "proofs.privateAfter" : "proofs.publicAfter")}>
        {after === null ? <Skel w="w-24" /> : <Amount value={formatOCT(Math.max(0, after))} />}
      </KV>
    </div>
  );
}

function NameCard({ flow }: { flow: SendFlow }) {
  const { t } = useTranslation();
  const s = flow.snap!;
  const moved = flow.nameMoved;
  return (
    <div
      data-testid="name-card"
      data-state={moved ? "moved" : "set"}
      className="my-1.5 flex h-29 flex-col justify-center rounded-2xl bg-surface-highlight px-4 text-[0.84375rem]"
    >
      {moved ? (
        <div
          key="moved"
          role="alert"
          className="flex flex-col gap-1 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
        >
          <span className="font-semibold text-content">
            <span className="whitespace-nowrap">{s.name}</span> {t("ons.pointsToNew")}
          </span>
          <span className="flex items-baseline justify-between gap-4">
            <span className="text-content-muted">{t("ons.was")}</span>
            <span className="font-mono text-meta break-all text-content-muted">{moved.was}</span>
          </span>
          <span className="flex items-baseline justify-between gap-4">
            <span className="text-content-muted">{t("ons.now")}</span>
            <span className="font-mono text-meta break-all text-content">{moved.now}</span>
          </span>
          <button
            type="button"
            onClick={flow.acceptNewAddress}
            className={`cursor-pointer self-start rounded-md font-semibold text-content underline underline-offset-3 ${FOCUS}`}
          >
            {t("ons.useNewAddress")}
          </button>
        </div>
      ) : (
        <div
          key="set"
          className="flex items-center gap-3 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
        >
          <WalletAvatar address={s.recipient} size={36} />
          <span className="flex min-w-0 flex-col gap-0.75">
            <span>
              <span className="text-content-muted">{t("sendFlow.to")}</span>{" "}
              <span className="font-semibold whitespace-nowrap text-content">{s.name}</span>
            </span>
            <span className="font-mono text-meta leading-snug break-all text-content-secondary">
              {s.recipient}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function SendReview({
  form,
  flow,
  recipients,
}: {
  form: SendForm;
  flow: SendFlow;
  recipients: Recipients;
}) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const { getUsdValue } = useTokenPrice();
  const s = flow.snap;
  const open = flow.phase === "review" && !!s;
  const unit = s?.token?.symbol ?? "OCT";
  const amount = s
    ? s.token
      ? formatTokenAmount(s.tokenRaw, s.token.decimals)
      : formatOCT(s.amountMicro)
    : "";
  const usd = s ? getUsdValue(unit, s.token ? s.tokenAmount : s.amountMicro / 1_000_000) : null;
  const fee = form.fee;
  const total =
    !s || fee === null ? null : s.isPrivate || s.token ? s.amountMicro : s.amountMicro + fee;
  return (
    <ReviewPopup
      open={open}
      label={t(s?.isPrivate ? "sendFlow.reviewPrivate" : "sendFlow.review")}
      caption={t(s?.isPrivate ? "sendFlow.sendPrivately" : "sendFlow.send")}
      right={<NetRight />}
      hero={
        <div className="flex items-baseline gap-2.5">
          <Num value={amount} className="look-figure text-[3.25rem] text-content" />
          <span className="text-[1rem] text-content-muted">{unit}</span>
          <span className="flex-1" />
          <span className="text-body text-content-muted tabular-nums">{usd ?? ""}</span>
        </div>
      }
      verb={t("common.send")}
      onReject={flow.reject}
      onConfirm={() => void flow.confirm()}
      confirmDisabled={
        form.quote.status !== "ok" || fee === null || !form.spend.ok || !!flow.nameMoved
      }
      busy={form.recheck.checking || flow.nameChecking}
      error={flow.nameError || form.recheck.error || form.spend.error}
    >
      {s && (
        <>
          <KV label={t("sendFlow.from")}>
            <WalletAvatar address={activeWallet?.address} size={22} />
            {activeWallet?.name}
          </KV>
          {s.name ? (
            <NameCard flow={flow} />
          ) : (
            <>
              <KV label={t("sendFlow.to")}>
                <ToValue address={s.recipient} recipients={recipients} />
              </KV>
              <KV label={t("sendFlow.address")}>
                <span className="font-mono text-[0.8125rem] font-normal">
                  {truncateAddress(s.recipient, 14, 12)}
                </span>
              </KV>
            </>
          )}
          {s.isPrivate || s.token ? (
            <KV label={t("sendFlow.onChain")}>
              {t(s.isPrivate ? "sendFlow.hiddenOnChain" : "sendFlow.visibleOnChain")}
            </KV>
          ) : (
            <KV label={t("sendFlow.message")}>
              {s.message ? (
                <span className="max-w-60 truncate">{s.message}</span>
              ) : (
                <span className="font-normal text-content-muted">{t("sendFlow.none")}</span>
              )}
            </KV>
          )}
          <KV label={t("sendFlow.networkFee")}>
            <FeePicker
              quote={form.quote}
              ou={form.ou}
              onChange={form.setOU}
              disabled={form.recheck.checking}
            />
          </KV>
          <KV label={t("sendFlow.total")}>
            {s.token ? (
              <Amount value={amount} unit={unit} />
            ) : total === null ? (
              <Skel w="w-24" />
            ) : (
              <Amount value={formatOCT(total)} />
            )}
          </KV>
        </>
      )}
    </ReviewPopup>
  );
}

function ActionBar({
  form,
  flow,
  env,
  failedJob,
  onRetryJob,
  onTurnOn,
}: {
  form: SendForm;
  flow: SendFlow;
  env: PrivacyEnv;
  failedJob: ProofJob | null;
  onRetryJob: (id: string) => void;
  onTurnOn: () => void;
}) {
  const { t } = useTranslation();
  const sending = flow.phase === "sending";
  const now = useNow(sending);
  const gate = form.isPrivate ? env.gate : "ok";

  let line: React.ReactNode;
  let action: React.ReactNode;
  if (sending) {
    const since = flow.marks[0];
    line = (
      <span className="flex items-center gap-3 text-lead text-content">
        {t("activity.sendingAmount", { amount: amountText(form) || "", unit: form.unit })}
        {since && (
          <span className="text-content-muted tabular-nums">{clock((now - since) / 1000)}</span>
        )}
      </span>
    );
    action = (
      <Btn className="w-60" onClick={() => showProgress(flow.jobId ?? `send-${since}`)}>
        {t("activity.showProgress")}
      </Btn>
    );
  } else if (failedJob) {
    line = (
      <span className="text-lead text-danger">
        {t(STOPPED[failedJob.kind])}. {feeText(failedJob.error)}
      </span>
    );
    action = (
      <span className="flex gap-2.5">
        <Btn className="w-32" onClick={() => remove(failedJob.id)}>
          {t("proofs.remove")}
        </Btn>
        <Btn weight="primary" className="w-32" onClick={() => onRetryJob(failedJob.id)}>
          {t("activity.tryAgain")}
        </Btn>
      </span>
    );
  } else if (flow.phase === "failed") {
    line = <span className="text-lead text-danger">{feeText(flow.error)}</span>;
    action = (
      <span className="flex gap-2.5">
        <Btn className="w-32" onClick={flow.edit}>
          {t("sendFlow.edit")}
        </Btn>
        <Btn weight="primary" className="w-32" onClick={() => void flow.retryFailed()}>
          {t("activity.tryAgain")}
        </Btn>
      </span>
    );
  } else if (gate === "setup") {
    line = null;
    action = (
      <Btn weight="primary" className="w-60" onClick={onTurnOn}>
        {t("proofs.turnOn.title")}
      </Btn>
    );
  } else if (gate === "hold") {
    line = <span className="text-lead text-content-muted">{t("proofs.hold.title")}</span>;
    action = (
      <Btn weight="primary" className="w-60" onClick={env.hold.check} disabled={env.hold.checking}>
        {t("proofs.checkAgain")}
      </Btn>
    );
  } else if (hasGateButton(gate)) {
    line = <span className="text-lead text-content-muted">{t("sendFlow.privateWaits")}</span>;
    action = (
      <span className="w-60">
        <GateButton ctx={env.ctx} />
      </span>
    );
  } else {
    const reason = reasonOf(form, t);
    line =
      reason === null ? (
        <span className="text-lead text-content-muted">
          {t("sendFlow.total")}{" "}
          <span className="font-medium text-content">
            <Amount
              value={
                form.isToken
                  ? amountText(form)
                  : formatOCT(form.amountMicro + (form.isPrivate ? 0 : (form.fee ?? 0)))
              }
              unit={form.unit}
            />
          </span>
        </span>
      ) : (
        <span
          className={`text-lead ${form.amount && form.validRecipient && reason ? "text-danger" : "text-content-muted"}`}
        >
          {reason}
        </span>
      );
    action = (
      <Btn
        weight="primary"
        className="look-key w-60"
        onClick={flow.openReview}
        disabled={!form.ready || form.quote.status !== "ok"}
      >
        {t("sendFlow.reviewShort")}
      </Btn>
    );
  }
  return (
    <div className="look-raise absolute inset-x-0 bottom-0 flex h-21.5 items-center gap-4 rounded-[22px] bg-surface-card px-5">
      <div aria-live="polite" className="min-w-0 flex-1 truncate">
        {line}
      </div>
      {action}
    </div>
  );
}

function SingleSend({
  form,
  flow,
  recipients,
}: {
  form: SendForm;
  flow: SendFlow;
  recipients: Recipients;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { getUsdValue } = useTokenPrice();
  const env = usePrivacyEnv(form.isPrivate);
  const queue = useWalletQueue(env.scope);
  const auth = useTransactionAuth();
  const [turnOn, setTurnOn] = useState(false);
  const failedJob =
    queue.top?.status === "failed" && queue.top.kind === "send" && flow.phase !== "sending"
      ? queue.top
      : null;
  const locked = flow.phase !== "edit" && flow.phase !== "failed";

  const retryJob = async (id: string) => {
    if (!(await auth.requestAuth(t("proofs.retryTitle")))) return;
    retry(id);
    showProgress(id);
  };

  // Try again on a failed send's toast lands here with the work to run again.
  const retryRef = (location.state as { retry?: string } | null)?.retry;
  useEffect(() => {
    if (!retryRef) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
    if (retryRef === "public") void flow.retryFailed();
    else void retryJob(retryRef);
  }, [retryRef]);

  const balance = form.isToken
    ? formatTokenAmount(form.token!.balance, form.token!.decimals)
    : form.spendBalance === null
      ? null
      : formatOCT(form.spendBalance);
  const usd = getUsdValue(form.unit, form.isToken ? form.tokenAmount : form.amountMicro / 1e6);
  const publicOnly = form.isPrivate || form.isToken;
  const gate = form.isPrivate ? env.gate : "ok";
  const notice =
    gate === "hold" ? (
      <KeyHoldCard hold={env.hold} />
    ) : hasGateNotice(gate) ? (
      <GateNotice ctx={env.ctx} />
    ) : null;

  return (
    <div className="relative mt-5.5 min-h-0 flex-1">
      <div className="grid h-[calc(100%-110px)] grid-cols-[minmax(0,1fr)_340px] gap-12">
        <div
          aria-disabled={locked || undefined}
          {...(locked ? { inert: "" } : {})}
          className={`flex min-w-0 flex-col gap-8.5 transition-opacity duration-250 ease-out motion-reduce:transition-none ${locked ? "opacity-35" : ""}`}
        >
          <section>
            <Caps
              right={
                <span className="-my-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={form.maxUnits === null}
                    onClick={() =>
                      form.maxUnits !== null &&
                      form.setAmount(String(parseFloat(form.maxUnits.toFixed(6))))
                    }
                    className={`h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content hover:bg-surface-highlight disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
                  >
                    {t("sendFlow.max")}
                  </button>
                  <span className="inline-flex w-30 justify-end">
                    <TokenPicker
                      token={form.token}
                      tokens={form.tokens}
                      onPick={form.setToken}
                      octBalance={form.publicKnown}
                      locked={form.isPrivate}
                    />
                  </span>
                </span>
              }
            >
              {t("sendFlow.amount")}
            </Caps>
            <div className="mt-3.5 flex h-18 items-baseline gap-3.5">
              <BigAmount
                size="xl"
                value={form.amount}
                onChange={form.setAmount}
                label={t("sendFlow.amount")}
              />
              <span className="shrink-0 text-title text-content-muted">{form.unit}</span>
            </div>
            <div className="mt-2.5 h-4.5 text-body whitespace-nowrap text-content-muted tabular-nums">
              {balance === null ? (
                <Skel w="w-40" />
              ) : (
                <>
                  {form.amount && usd ? `${t("sendFlow.usdOf", { usd })} ` : ""}
                  {t(form.isPrivate ? "sendFlow.balancePrivate" : "sendFlow.balancePublic", {
                    balance,
                    unit: form.unit,
                  })}
                </>
              )}
            </div>
          </section>
          <section className="relative z-10">
            <Caps>{t("sendFlow.to")}</Caps>
            <div className="mt-3">
              <RecipientPicker
                value={form.recipient}
                name={form.recipientName}
                onChange={form.setRecipient}
                recipients={recipients}
                names
              />
            </div>
          </section>
          <section aria-hidden={publicOnly || undefined} className={publicOnly ? "invisible" : ""}>
            <Caps>{t("sendFlow.message")}</Caps>
            <div className="flex h-8.5 items-end">
              <input
                value={form.message}
                onChange={(e) => form.setMessage(e.target.value)}
                maxLength={MESSAGE_MAX}
                placeholder={t("sendFlow.messagePlaceholder")}
                aria-label={t("sendFlow.message")}
                disabled={publicOnly}
                className="w-full bg-transparent text-lead text-content outline-none placeholder:text-content-muted"
              />
            </div>
          </section>
        </div>
        <aside
          aria-label={t("sendFlow.livePanel")}
          className={`relative z-20 flex min-w-0 flex-col transition-opacity duration-250 ease-out motion-reduce:transition-none ${locked ? "opacity-35" : ""}`}
        >
          <Caps right={t("sendFlow.live")}>{t("sendFlow.summary")}</Caps>
          <div className="mt-2">
            {notice ?? <Summary form={form} recipients={recipients} locked={locked} />}
          </div>
        </aside>
      </div>
      <ActionBar
        form={form}
        flow={flow}
        env={env}
        failedJob={failedJob}
        onRetryJob={(id) => void retryJob(id)}
        onTurnOn={() => setTurnOn(true)}
      />
      <SendReview form={form} flow={flow} recipients={recipients} />
      {form.isPrivate && (
        <TurnOnReview
          open={turnOn && gate === "setup"}
          publicBalance={env.publicKnown}
          onReject={() => setTurnOn(false)}
        />
      )}
      {form.isPrivate && (
        <RefreshReview
          open={env.migrate.showPopup}
          mode={gate === "migrate" ? "migrate" : "refresh"}
          migrate={env.migrate}
          privateMicro={env.privateBalance}
          baseLayers={env.setup.baseLayers}
          then={
            form.amountMicro > 0
              ? { label: t("sendFlow.privateSend"), amount: formatOCT(form.amountMicro) }
              : null
          }
        />
      )}
      <TransactionAuthModal isOpen={auth.isOpen} onResult={auth.handleResult} title={auth.title} />
    </div>
  );
}

function BulkSend({ form, recipients }: { form: SendForm; recipients: Recipients }) {
  const { t } = useTranslation();
  const bulk = useBulkFlow(form);
  const locked = bulk.phase !== "edit";
  const n = bulk.pending.length;
  const action = (
    <Btn
      weight="primary"
      className="w-full"
      onClick={bulk.openReview}
      disabled={!bulk.ready || form.quote.status !== "ok"}
    >
      {n > 0 && bulk.spend.error ? t("sendFlow.notEnough") : t("sendFlow.reviewN", { count: n })}
    </Btn>
  );
  const right =
    bulk.phase === "review" && bulk.review ? (
      <BulkReviewCard form={form} bulk={bulk} recipients={recipients} />
    ) : bulk.phase !== "edit" && bulk.review ? (
      <BulkProgressCard bulk={bulk} recipients={recipients} />
    ) : (
      <BulkPanel form={form} bulk={bulk} />
    );
  return (
    <div className="mt-5.5 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-5">
      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto scrollbar-hide">
        <BulkForm form={form} bulk={bulk} recipients={recipients} locked={locked} action={action} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">{right}</div>
      <TransactionAuthModal
        isOpen={bulk.txAuth.isOpen}
        onResult={bulk.txAuth.handleResult}
        title={bulk.txAuth.title}
      />
    </div>
  );
}

export default function SendScreen() {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const form = useSendForm();
  const recipients = useRecipients();
  const flow = useSendFlow(form);

  if (activeWallet?.wallet_type === "watch") return <WatchOnlyBanner title={t("sendFlow.title")} />;

  const single = form.tab === "single";
  const locked = single && flow.phase !== "edit" && flow.phase !== "failed";

  return (
    <LookFrame
      title={t("sendFlow.title")}
      right={
        <div className="flex shrink-0 items-center gap-3">
          {form.privacyEnabled && (
            <PillSwitch<SendMode>
              label={t("sendFlow.kind")}
              value={form.isPrivate ? "private" : "standard"}
              onChange={(m) => !locked && form.setMode(m)}
              options={[
                { value: "standard", label: t("sendFlow.public") },
                { value: "private", label: t("sendFlow.private"), disabled: form.isToken },
              ]}
            />
          )}
          <PillSwitch<SendTab>
            label={t("sendFlow.howMany")}
            value={form.tab}
            onChange={(next) => !locked && form.setTab(next)}
            options={[
              { value: "single", label: t("sendFlow.single") },
              { value: "batch", label: t("sendFlow.bulk") },
            ]}
          />
        </div>
      }
    >
      {single ? (
        <SingleSend form={form} flow={flow} recipients={recipients} />
      ) : (
        <BulkSend form={form} recipients={recipients} />
      )}
      <TransactionAuthModal
        isOpen={flow.txAuth.isOpen}
        onResult={flow.txAuth.handleResult}
        title={flow.txAuth.title}
      />
    </LookFrame>
  );
}
