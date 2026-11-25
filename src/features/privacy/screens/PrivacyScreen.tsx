import React, { useEffect, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useLocation, useNavigate } from "src/lib/router";
import Frame from "src/shared/layout/LookFrame";
import WatchOnlyBanner from "src/shared/layout/WatchOnlyBanner";
import BigAmount from "src/shared/ui/BigAmount";
import FeePicker from "src/shared/ui/FeePicker";
import Mascot from "src/shared/ui/Mascot";
import OutlineTag from "src/shared/ui/OutlineTag";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import {
  Amount,
  Btn,
  Caps,
  EASE,
  FOCUS,
  KV,
  LayerDots,
  NetName,
  Num,
  PillSwitch,
  Skel,
  clock,
} from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import { FINANCE, NETWORKS } from "src/services/network/config";
import { useAutoEncrypt } from "src/hooks/privacy/useAutoEncrypt";
import { useAddressName } from "src/hooks/wallet/useAddressName";
import { usePrivateOp, type PrivateOp } from "src/hooks/privacy/usePrivateOp";
import { useNow, useWalletQueue, type WalletQueue } from "src/hooks/privacy/useProofQueue";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { useCanonicalAdvisory } from "src/features/privacy/hooks/useCanonicalAdvisory";
import { useClaims, type Claims } from "src/features/privacy/hooks/useClaims";
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
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { DONE, NEXT, RUNNING, STOPPED } from "src/features/privacy/services/proofJobs";
import { claimCap } from "src/features/privacy/services/pvacUpgradePolicy";
import { remove, retry, type ProofJob } from "src/features/privacy/services/proofQueue";
import type { ClaimableOutput } from "src/features/privacy/services/privacyService";
import { showProgress } from "src/services/notices/activity";
import { formatOCT, truncateAddress } from "src/lib/format";
import { feeText } from "src/services/transactions/feeText";

const CLAIM_LAYERS = 2;

type Dir = "encrypt" | "decrypt";

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function balancesAfter(op: PrivateOp, dir: Dir, env: PrivacyEnv) {
  const amt = op.amountMicro;
  if (amt <= 0 || !op.spend.ok || op.fee === null || op.amountError) return null;
  const enc = dir === "encrypt";
  const pub = env.publicKnown;
  const priv = env.privateBalance;
  return {
    pub: pub === null ? null : Math.max(0, enc ? pub - amt - op.fee : pub + amt - op.fee),
    priv: priv === null ? null : Math.max(0, enc ? priv + amt : priv - amt),
  };
}

function WaitingRow({
  address,
  amount,
  right,
  dim,
}: {
  address?: string;
  amount: number;
  right: React.ReactNode;
  dim?: boolean;
}) {
  const { t } = useTranslation();
  const nameOf = useAddressName();
  const who = address ? nameOf(address) : null;
  return (
    <div
      className={`grid min-h-14.5 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[14px] px-3 ${dim ? "opacity-45" : ""}`}
    >
      {address ? (
        <WalletAvatar address={address} size={30} />
      ) : (
        <span className="size-7.5 rounded-lg bg-surface-highlight" />
      )}
      <div className="min-w-0 truncate text-[0.90625rem] font-medium text-content">
        {who
          ? who.name
          : address
            ? truncateAddress(address, 10, 6)
            : t("proofs.claim.unknownSender")}
      </div>
      <div className="flex items-center gap-3.5">
        <span className="text-[0.90625rem] font-medium text-positive tabular-nums">
          +<Num value={formatOCT(amount)} />{" "}
          <span className="font-normal text-content-muted">OCT</span>
        </span>
        <span className="flex w-24 justify-end">{right}</span>
      </div>
    </div>
  );
}

function ClaimDots({ job }: { job: ProofJob }) {
  const now = useNow(true);
  const since = job.marks[0];
  return (
    <span className="inline-flex items-center gap-2.5 text-[0.8125rem] text-content-secondary">
      <span aria-hidden="true" className="inline-flex gap-1">
        {job.steps.map((s, i) => (
          <span
            key={s}
            className={`size-1.75 rounded-full ${i <= job.step ? "bg-content-secondary" : "bg-(--bg-3)"}`}
          />
        ))}
      </span>
      {since ? <span className="tabular-nums">{clock((now - since) / 1000)}</span> : null}
    </span>
  );
}

function StepDots({ job }: { job: ProofJob }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-1">
      {job.steps.map((s, i) => (
        <span
          key={s}
          className={`size-1.75 rounded-full ${job.status === "running" && i <= job.step ? "bg-content-secondary" : "bg-(--bg-3)"}`}
        />
      ))}
    </span>
  );
}

function Lists({
  claims,
  queue,
  blocked,
  blockedWhy,
  cap,
}: {
  claims: Claims;
  queue: WalletQueue;
  blocked: boolean;
  blockedWhy: string;
  cap: number;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"waiting" | "recent">("waiting");
  const jobs = [queue.top, ...queue.next].filter(
    (j): j is ProofJob => !!j && j.kind === "claim" && j.status !== "failed",
  );
  const all = claims.outputs;
  const canAll = !blocked && all.length > 1 && cap > 1;
  const waiting = tab === "waiting";
  const tabClass = (on: boolean) =>
    `tab-caps h-5.5 cursor-pointer ${on ? "text-content" : "text-content-muted hover:text-content"} ${EASE} ${FOCUS}`;
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Caps
        right={
          waiting && (
            <span className="-my-2 flex items-center gap-2">
              {!blocked && all.length > cap && cap > 0 && (
                <span className="text-content-muted">{t("proofs.atATime", { count: cap })}</span>
              )}
              <button
                type="button"
                disabled={!canAll}
                onClick={() => claims.open(all.slice(0, cap))}
                className={`h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content hover:bg-surface-highlight disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
              >
                {t("proofs.claimAll")}
              </button>
            </span>
          )
        }
      >
        <span className="flex gap-3.5">
          <button
            type="button"
            aria-pressed={waiting}
            onClick={() => setTab("waiting")}
            className={tabClass(waiting)}
          >
            {t("proofs.waitingForYou")}
          </button>
          <button
            type="button"
            aria-pressed={!waiting}
            onClick={() => setTab("recent")}
            className={tabClass(!waiting)}
          >
            {t("proofs.recent")}
          </button>
        </span>
      </Caps>
      <div className="-mx-3 mt-2 min-h-29 flex-1 overflow-y-auto scrollbar-hide">
        {waiting ? (
          claims.loading ? (
            <div className="flex min-h-14.5 items-center gap-4 px-3">
              <Skel w="w-7" />
              <Skel w="w-40" />
            </div>
          ) : jobs.length === 0 && all.length === 0 ? (
            <div className="flex min-h-14.5 items-center px-3 text-body text-content-muted">
              {t("proofs.nothingWaiting")}
            </div>
          ) : (
            <>
              {jobs.map((j) => (
                <WaitingRow
                  key={j.id}
                  address={j.to}
                  amount={j.amount}
                  right={
                    j.status === "running" ? (
                      <ClaimDots job={j} />
                    ) : (
                      <span className="text-[0.8125rem] text-content-muted">
                        {t("proofs.upNext")}
                      </span>
                    )
                  }
                />
              ))}
              {all.map((o: ClaimableOutput) => (
                <WaitingRow
                  key={o.id}
                  address={o.sender}
                  amount={o.amount}
                  dim={blocked}
                  right={
                    <Btn
                      weight="text"
                      size="sm"
                      disabled={blocked}
                      onClick={() => claims.open([o])}
                      className="-mr-2"
                    >
                      {t("claim.claim")}
                    </Btn>
                  }
                />
              ))}
            </>
          )
        ) : queue.done.length === 0 ? (
          <div className="flex min-h-14.5 items-center px-3 text-body text-content-muted">
            {t("proofs.nothingToday")}
          </div>
        ) : (
          queue.done.map((d) => (
            <div
              key={`${d.at}-${d.kind}`}
              className="flex min-h-14.5 items-center justify-between gap-4 px-3"
            >
              <span className="min-w-0">
                <span className="block text-[0.90625rem] font-medium text-content">
                  {t(DONE[d.kind])}
                </span>
                <span className="mt-0.75 block text-meta text-content-muted">
                  {t("proofs.hold.today")} {hhmm(d.at)}
                </span>
              </span>
              {d.amount > 0 && (
                <span className="text-[0.90625rem] font-medium text-content">
                  <Amount value={formatOCT(d.amount)} />
                </span>
              )}
            </div>
          ))
        )}
      </div>
      <div className="mt-1.5 h-4.5 text-meta text-content-muted">
        {waiting && blocked ? blockedWhy : ""}
      </div>
    </section>
  );
}

function ProofsStrip({ queue }: { queue: WalletQueue }) {
  const { t } = useTranslation();
  const now = useNow(queue.busy);
  const top = queue.top;
  const jobs = [top, ...queue.next].filter((j): j is ProofJob => !!j);
  let body: React.ReactNode = null;
  if (top?.status === "failed") {
    body = (
      <>
        <Caps>{t("proofs.title")}</Caps>
        <span className="inline-flex h-8 shrink-0 items-center rounded-full bg-surface-card px-3.5 text-[0.8125rem] whitespace-nowrap text-danger">
          {t(STOPPED[top.kind])}
        </span>
      </>
    );
  } else if (jobs.length >= 2) {
    body = (
      <>
        <Caps>{t("proofs.title")}</Caps>
        {jobs.map((j) => (
          <span
            key={j.id}
            className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-surface-card px-3.5 text-[0.8125rem] whitespace-nowrap"
          >
            <span className="text-content-muted">
              {t(j.status === "running" ? "proofs.runningChip" : "proofs.nextChip")}
            </span>
            <span className="font-medium text-content">
              {t(NEXT[j.kind])}
              {j.amount > 0 ? ` ${formatOCT(j.amount)} OCT` : ""}
            </span>
            {j.status === "running" && j.marks[0] ? (
              <span className="text-content-muted tabular-nums">
                {clock((now - j.marks[0]) / 1000)}
              </span>
            ) : null}
          </span>
        ))}
      </>
    );
  }
  return (
    <div className="flex h-9 shrink-0 items-center gap-2.5 overflow-hidden" aria-live="polite">
      {body}
    </div>
  );
}

function Summary({
  op,
  dir,
  env,
  locked,
  moving,
}: {
  op: PrivateOp;
  dir: Dir;
  env: PrivacyEnv;
  locked: boolean;
  moving: boolean;
}) {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const enc = dir === "encrypt";
  const off = env.gate === "setup";
  const after = moving || env.gate !== "ok" ? null : balancesAfter(op, dir, env);
  const pub = after?.pub ?? env.publicKnown;
  const priv = after?.priv ?? env.privateBalance;
  const tag = !off && <OutlineTag label={t("proofs.encrypted")} />;
  return (
    <div className="flex flex-col">
      <KV label={t("proofs.wallet")}>
        <WalletAvatar address={activeWallet?.address} size={22} />
        {activeWallet?.name}
      </KV>
      <KV label={t("sendFlow.from")}>
        {t(enc ? "sendFlow.publicBalance" : "sendFlow.privateBalance")}
        {!enc && tag}
      </KV>
      <KV label={t("sendFlow.to")}>
        {t(enc ? "sendFlow.privateBalance" : "sendFlow.publicBalance")}
        {enc && tag}
      </KV>
      <KV label={t("proofs.network")}>
        <NetName name={(NETWORKS[networkId]?.name ?? networkId).replace(/^Octra\s+/i, "")} />
      </KV>
      <KV label={t("sendFlow.networkFee")}>
        <FeePicker quote={op.quote} ou={op.ou} onChange={op.setOU} disabled={locked} />
      </KV>
      <KV label={t("sendFlow.feePaidFrom")}>{t("sendFlow.publicBalance")}</KV>
      <KV label={t("proofs.publicAfter")}>
        {pub === null ? <Skel w="w-24" /> : <Amount value={formatOCT(pub)} />}
      </KV>
      <KV label={t("proofs.privateAfter")}>
        {off ? (
          <span className="font-normal text-content-muted">{t("proofs.off")}</span>
        ) : priv === null ? (
          <Skel w="w-24" />
        ) : (
          <Amount value={formatOCT(priv)} />
        )}
      </KV>
    </div>
  );
}

function ActionBar({
  op,
  dir,
  env,
  queue,
  moving,
  fixing,
  onRetryJob,
  onTurnOn,
}: {
  op: PrivateOp;
  dir: Dir;
  env: PrivacyEnv;
  queue: WalletQueue;
  moving: ProofJob | null;
  fixing: ProofJob | null;
  onRetryJob: (id: string) => void;
  onTurnOn: () => void;
}) {
  const { t } = useTranslation();
  const busy = moving ?? fixing;
  const now = useNow(!!busy);
  const gate = env.gate;
  const failed = queue.top?.status === "failed" ? queue.top : null;

  let line: React.ReactNode;
  let action: React.ReactNode;
  if (busy) {
    const since = busy.marks[0];
    const running = busy.status === "running";
    line = (
      <span className="flex items-center gap-3 text-lead text-content">
        {!running && moving ? (
          <span className="text-content-muted">{t("proofs.startsAfter")}</span>
        ) : (
          <>
            <span>{t(RUNNING[busy.kind])}</span>
            {busy.amount > 0 && <Amount value={formatOCT(busy.amount)} />}
            {fixing && !moving ? (
              <span className="text-content-muted">
                {running && busy.step >= 0
                  ? t(busy.steps[Math.min(busy.step, busy.steps.length - 1)])
                  : t("activity.waitingTurn")}
              </span>
            ) : (
              <StepDots job={busy} />
            )}
          </>
        )}
        {since && (
          <span className="text-content-muted tabular-nums">{clock((now - since) / 1000)}</span>
        )}
      </span>
    );
    action = (
      <Btn className="w-60" onClick={() => showProgress(busy.id)}>
        {t("activity.showProgress")}
      </Btn>
    );
  } else if (failed) {
    line = (
      <span className="text-lead text-danger">
        {t(STOPPED[failed.kind])}. {feeText(failed.error)}
      </span>
    );
    action = (
      <span className="flex gap-2.5">
        <Btn className="w-32" onClick={() => remove(failed.id)}>
          {t("proofs.remove")}
        </Btn>
        <Btn weight="primary" className="w-32" onClick={() => onRetryJob(failed.id)}>
          {t("activity.tryAgain")}
        </Btn>
      </span>
    );
  } else if (gate === "setup") {
    line = null;
    action = (
      <Btn weight="primary" className="look-key w-60" onClick={onTurnOn}>
        {t("proofs.turnOn.title")}
      </Btn>
    );
  } else if (gate === "hold") {
    line = <span className="text-lead text-content-muted">{t("proofs.hold.title")}</span>;
    action = (
      <span className="flex gap-2.5">
        <Btn onClick={env.hold.clearAndUpdate}>{t("proofs.hold.clear")}</Btn>
        <Btn
          weight="primary"
          className="w-32"
          onClick={env.hold.check}
          disabled={env.hold.checking}
        >
          {t("proofs.checkAgain")}
        </Btn>
      </span>
    );
  } else if (hasGateButton(gate)) {
    line = null;
    action = (
      <span className="w-60">
        <GateButton ctx={env.ctx} />
      </span>
    );
  } else {
    const amt = op.amountMicro;
    const ready = amt > 0 && op.spend.ok && op.fee !== null && !op.amountError;
    const reason = !op.amount
      ? t("sendFlow.enterAmount")
      : op.quote.status === "error"
        ? t("fee.unavailableRetry")
        : op.amountError
          ? op.amountError
          : "";
    const danger = !!op.amount && (op.quote.status === "error" || !!op.amountError);
    line =
      ready && op.quote.status === "ok" ? (
        <span className="text-lead text-content-muted">
          {t("sendFlow.total")}{" "}
          <span className="font-medium text-content">
            <Amount value={formatOCT(dir === "encrypt" ? amt + (op.fee ?? 0) : amt)} />
          </span>
        </span>
      ) : (
        <span className={`text-lead ${danger ? "text-danger" : "text-content-muted"}`}>
          {reason}
        </span>
      );
    action = (
      <Btn
        weight="primary"
        className="look-key w-60"
        onClick={op.openReview}
        disabled={!ready || op.quote.status !== "ok"}
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

export default function PrivacyScreen() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { networkId, activeWallet } = useWallet();
  const { getUsdValue } = useTokenPrice();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  useAutoEncrypt();
  useCanonicalAdvisory();
  const [dir, setDir] = useState<Dir>("encrypt");
  const [turnOn, setTurnOn] = useState(false);
  const enc = usePrivateOp("encrypt");
  const dec = usePrivateOp("decrypt");
  const op = dir === "encrypt" ? enc : dec;
  const env = usePrivacyEnv();
  const claims = useClaims();
  const queue = useWalletQueue(env.scope);
  const auth = useTransactionAuth();

  const retryJob = async (id: string) => {
    if (!(await auth.requestAuth(t("proofs.retryTitle")))) return;
    retry(id);
    showProgress(id);
  };

  const retryRef = (location.state as { retry?: string } | null)?.retry;
  useEffect(() => {
    if (!retryRef) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
    void retryJob(retryRef);
  }, [retryRef]);

  if (activeWallet?.wallet_type === "watch")
    return <WatchOnlyBanner title={t("proofs.screenTitle")} />;

  if (!privacyEnabled)
    return (
      <Frame title={t("encrypt.privacyNotAvailable")}>
        <div className="flex flex-1 items-center justify-center">
          <Mascot id="privacy-unavailable" phase="zz" size={72} />
        </div>
      </Frame>
    );

  const gate = env.gate;
  const off = gate === "setup";
  const jobs = [queue.top, ...queue.next];
  const moving =
    jobs.find(
      (j): j is ProofJob =>
        !!j && (j.kind === "encrypt" || j.kind === "decrypt") && j.status !== "failed",
    ) ?? null;
  const fixing =
    jobs.find(
      (j): j is ProofJob =>
        !!j &&
        (j.kind === "migrate" || j.kind === "refresh" || j.kind === "setup") &&
        j.status !== "failed",
    ) ?? null;
  const blocked = gate !== "ok";
  const locked = !!moving || (gate !== "ok" && gate !== "checking");
  const blockedWhy =
    gate === "hold"
      ? t("proofs.claimsPaused")
      : off
        ? t("proofs.turnOnToClaim")
        : t("proofs.claimsWait");
  const pick = (next: Dir) => {
    if (next === dir || locked) return;
    (next === "encrypt" ? enc : dec).setAmount(op.amount);
    setDir(next);
  };
  const max = dir === "encrypt" ? op.spend.max : env.privateBalance;
  const from = dir === "encrypt" ? env.publicKnown : env.privateBalance;
  const usd = getUsdValue("OCT", op.amountMicro / 1e6);
  const notice =
    gate === "hold" ? (
      <KeyHoldCard hold={env.hold} />
    ) : hasGateNotice(gate) ? (
      <GateNotice ctx={env.ctx} />
    ) : null;

  return (
    <Frame
      title={t("proofs.screenTitle")}
      right={
        <PillSwitch<Dir>
          label={t("proofs.direction")}
          value={dir}
          onChange={pick}
          options={[
            { value: "encrypt", label: t("proofs.encrypt"), disabled: locked && dir !== "encrypt" },
            {
              value: "decrypt",
              label: t("proofs.decrypt"),
              disabled: off || (locked && dir !== "decrypt"),
            },
          ]}
        />
      }
    >
      <div className="relative mt-5.5 min-h-0 flex-1">
        <div className="grid h-[calc(100%-110px)] grid-cols-[minmax(0,1fr)_340px] gap-12">
          <div className="flex min-h-0 min-w-0 flex-col gap-8">
            <section
              aria-disabled={locked || undefined}
              {...(locked ? { inert: "" } : {})}
              className={`transition-opacity duration-250 ease-out motion-reduce:transition-none ${locked ? "opacity-35" : ""}`}
            >
              <Caps
                right={
                  <button
                    type="button"
                    disabled={max === null}
                    onClick={() =>
                      max !== null && op.setAmount(String(max / FINANCE.MICRO_OCT_MULTIPLIER))
                    }
                    className={`-my-2 h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content hover:bg-surface-highlight disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
                  >
                    {t("sendFlow.max")}
                  </button>
                }
              >
                {t("sendFlow.amount")}
              </Caps>
              <div className="mt-3.5 flex h-18 items-baseline gap-3.5">
                <BigAmount
                  size="xl"
                  value={moving ? formatOCT(moving.amount).replace(/,/g, "") : op.amount}
                  onChange={op.setAmount}
                  label={t(dir === "encrypt" ? "proofs.encrypt" : "proofs.decrypt")}
                  disabled={locked}
                />
                <span className="shrink-0 text-title text-content-muted">OCT</span>
              </div>
              <div className="mt-2.5 h-4.5 text-body whitespace-nowrap text-content-muted tabular-nums">
                {from === null ? (
                  <Skel w="w-40" />
                ) : (
                  <>
                    {op.amount && usd ? `${t("sendFlow.usdOf", { usd })} ` : ""}
                    {t(dir === "encrypt" ? "sendFlow.balancePublic" : "sendFlow.balancePrivate", {
                      balance: formatOCT(from),
                      unit: "OCT",
                    })}
                  </>
                )}
              </div>
            </section>
            <Lists
              claims={claims}
              queue={queue}
              blocked={blocked}
              blockedWhy={blockedWhy}
              cap={claimCap(env.setup.baseLayers)}
            />
            <ProofsStrip queue={queue} />
          </div>
          <aside
            aria-label={t("sendFlow.livePanel")}
            className={`relative z-20 flex min-w-0 flex-col transition-opacity duration-250 ease-out motion-reduce:transition-none ${moving ? "opacity-35" : ""}`}
          >
            <Caps right={t("sendFlow.live")}>{t("sendFlow.summary")}</Caps>
            <div className="mt-2">
              {notice ?? <Summary op={op} dir={dir} env={env} locked={locked} moving={!!moving} />}
            </div>
          </aside>
        </div>
        <ActionBar
          op={op}
          dir={dir}
          env={env}
          queue={queue}
          moving={moving}
          fixing={fixing}
          onRetryJob={(id) => void retryJob(id)}
          onTurnOn={() => setTurnOn(true)}
        />
      </div>
      <MoveReview op={op} env={env} />
      <ClaimReview claims={claims} baseLayers={env.setup.baseLayers} />
      <TurnOnReview
        open={turnOn && off}
        publicBalance={env.publicKnown}
        onReject={() => setTurnOn(false)}
      />
      <RefreshReview
        open={env.migrate.showPopup}
        mode={gate === "migrate" ? "migrate" : "refresh"}
        migrate={env.migrate}
        privateMicro={env.privateBalance}
        baseLayers={env.setup.baseLayers}
        then={
          dir === "decrypt" && op.amountMicro > 0
            ? { label: t("proofs.decrypt"), amount: formatOCT(op.amountMicro) }
            : null
        }
      />
      <TransactionAuthModal
        isOpen={enc.txAuth.isOpen}
        onResult={enc.txAuth.handleResult}
        title={enc.txAuth.title}
      />
      <TransactionAuthModal
        isOpen={dec.txAuth.isOpen}
        onResult={dec.txAuth.handleResult}
        title={dec.txAuth.title}
      />
      <TransactionAuthModal
        isOpen={claims.txAuth.isOpen}
        onResult={claims.txAuth.handleResult}
        title={claims.txAuth.title}
      />
      <TransactionAuthModal isOpen={auth.isOpen} onResult={auth.handleResult} title={auth.title} />
    </Frame>
  );
}

function MoveReview({ op, env }: { op: PrivateOp; env: PrivacyEnv }) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const { getUsdValue } = useTokenPrice();
  const encrypt = op.kind === "encrypt";
  const amount = op.review?.amount ?? 0;
  const pub = env.publicKnown;
  const priv = env.privateBalance;
  const sign = encrypt ? -1 : 1;
  const pubAfter = pub === null || op.fee === null ? null : pub + sign * amount - op.fee;
  const privAfter = priv === null ? null : priv - sign * amount;
  return (
    <ReviewPopup
      open={!!op.review}
      label={t(encrypt ? "proofs.review.encrypt" : "proofs.review.decrypt")}
      caption={t(encrypt ? "proofs.encrypt" : "proofs.decrypt")}
      hero={
        <div className="flex items-baseline gap-2.5">
          <Num value={formatOCT(amount)} className="look-figure text-[3.25rem] text-content" />
          <span className="text-[1rem] text-content-muted">OCT</span>
          <span className="flex-1" />
          <span className="text-body text-content-muted tabular-nums">
            {getUsdValue("OCT", amount / 1e6) ?? ""}
          </span>
        </div>
      }
      verb={t(encrypt ? "proofs.encrypt" : "proofs.decrypt")}
      onReject={op.reject}
      onConfirm={() => void op.confirm()}
      confirmDisabled={op.quote.status !== "ok" || !op.spend.ok || op.recheck.checking}
      busy={op.recheck.checking}
      error={op.recheck.error || op.spend.error}
    >
      <KV label={t("proofs.wallet")}>
        <WalletAvatar address={activeWallet?.address} size={22} />
        {activeWallet?.name}
      </KV>
      <KV label={t("sendFlow.from")}>
        {t(encrypt ? "sendFlow.publicBalance" : "sendFlow.privateBalance")}
      </KV>
      <KV label={t("sendFlow.to")}>
        {t(encrypt ? "sendFlow.privateBalance" : "sendFlow.publicBalance")}
      </KV>
      <KV label={t("sendFlow.networkFee")}>
        <FeePicker quote={op.quote} ou={op.ou} onChange={op.setOU} disabled={op.recheck.checking} />
      </KV>
      <KV label={t("proofs.publicAfter")}>
        {pubAfter === null ? (
          <Skel w="w-28" />
        ) : (
          <Amount value={formatOCT(Math.max(0, pubAfter))} />
        )}
      </KV>
      <KV label={t("proofs.privateAfter")}>
        {privAfter === null ? (
          <Skel w="w-24" />
        ) : (
          <Amount value={formatOCT(Math.max(0, privAfter))} />
        )}
      </KV>
    </ReviewPopup>
  );
}

function ClaimReview({ claims, baseLayers }: { claims: Claims; baseLayers: number }) {
  const { t } = useTranslation();
  const nameOf = useAddressName();
  const list = claims.review?.outputs ?? [];
  const many = list.length > 1;
  const total = list.reduce((s, o) => s + o.amount, 0);
  const one = list[0];
  const who = one?.sender ? nameOf(one.sender) : null;
  const priv = claims.privateBalance;
  const fee = claims.fee;
  return (
    <ReviewPopup
      open={!!claims.review}
      label={t(many ? "proofs.claimAll" : "proofs.claim.review")}
      caption={t(many ? "proofs.claimAll" : "claim.claim")}
      hero={
        <div className="flex items-center gap-3.5">
          {many ? (
            <span className="flex">
              {list.slice(0, 4).map((o, i) => (
                <span key={o.id} className={i ? "-ml-2.5" : ""}>
                  <WalletAvatar address={o.sender} size={36} />
                </span>
              ))}
            </span>
          ) : one?.sender ? (
            <WalletAvatar address={one.sender} size={40} />
          ) : null}
          <div className="min-w-0">
            <div className="truncate text-[1.0625rem] font-semibold text-content">
              {many
                ? t("proofs.transfersN", { count: list.length })
                : who
                  ? who.name
                  : one?.sender
                    ? truncateAddress(one.sender, 10, 6)
                    : t("proofs.claim.unknownSender")}
            </div>
          </div>
          <span className="flex-1" />
          <Num value={`+${formatOCT(total)}`} className="look-figure text-[2.5rem] text-content" />
        </div>
      }
      verb={t(many ? "proofs.claimAll" : "claim.claim")}
      onReject={claims.reject}
      onConfirm={() => void claims.confirm()}
      confirmDisabled={claims.confirmDisabled}
      busy={claims.recheck.checking}
      error={claims.error}
    >
      <KV label={t("proofs.goesTo")}>{t("proofs.privateBalance")}</KV>
      <KV label={many ? t("proofs.claim.feeEach") : t("sendFlow.networkFee")}>
        <FeePicker
          quote={claims.quote}
          ou={claims.ou}
          onChange={claims.setOU}
          disabled={claims.recheck.checking}
        />
      </KV>
      {many && (
        <KV label={t("proofs.feesInAll")}>
          {fee === null ? <Skel w="w-20" /> : <Amount value={formatOCT(fee * list.length)} />}
        </KV>
      )}
      <KV label={t("proofs.privateAfter")}>
        {priv === null ? <Skel /> : <Amount value={formatOCT(priv + total)} />}
      </KV>
      <KV label={t("proofs.layersAfter")}>
        <LayerDots n={baseLayers + CLAIM_LAYERS * list.length} />
      </KV>
    </ReviewPopup>
  );
}
