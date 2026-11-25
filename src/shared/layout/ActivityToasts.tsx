import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "src/i18n/react";
import { useLocation, useNavigate } from "src/lib/router";
import Mascot, { type MascotPhase } from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn, EASE, FOCUS, StepDots, clock } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { useAddressName } from "src/hooks/wallet/useAddressName";
import { stepSeconds, useNow } from "src/hooks/privacy/useProofQueue";
import {
  dismiss,
  showProgress,
  useActivity,
  watchQueue,
  type PublicSend,
  type ToastView,
} from "src/services/notices/activity";
import { RUNNING } from "src/features/privacy/services/proofJobs";
import {
  getQueue,
  subscribe,
  type ProofJob,
  type ProofKind,
} from "src/features/privacy/services/proofQueue";
import { formatOCT, truncateAddress } from "src/lib/format";
import { noticeValues } from "src/services/notices/noticeNative";

const MOOD: Record<ProofKind, MascotPhase> = {
  encrypt: "en",
  claim: "en",
  send: "en",
  bulk: "en",
  decrypt: "de",
  refresh: "ld",
  migrate: "ld",
  setup: "ld",
};

const LIFE_MS = 5000;

const TONE: Record<NonNullable<ToastView["tone"]>, MascotPhase> = {
  success: "ok",
  error: "up",
  warning: "op",
  info: "op",
  processing: "ld",
};

function Person({ address }: { address: string }) {
  const nameOf = useAddressName();
  const who = nameOf(address);
  return (
    <span className="inline-flex items-center gap-1.75">
      <WalletAvatar address={address} size={18} />
      {who ? (
        <span className="font-medium text-content-secondary">{who.name}</span>
      ) : (
        <span className="font-mono text-[0.75rem]">{truncateAddress(address, 10, 6)}</span>
      )}
    </span>
  );
}

function Toast({ view }: { view: ToastView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const [dx, setDx] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const left = useRef(LIFE_MS);
  const started = useRef(0);
  const drag = useRef<number | null>(null);

  const close = useCallback(() => {
    setLeaving(true);
    setTimeout(() => dismiss(view.id), 200);
  }, [view.id]);
  const run = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (view.tone === "processing") return;
    started.current = Date.now();
    timer.current = setTimeout(close, left.current);
  }, [close, view.tone]);
  const hold = () => {
    if (timer.current) clearTimeout(timer.current);
    left.current = Math.max(800, left.current - (Date.now() - started.current));
  };
  useMountEffect(() => {
    run();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  });

  const act = view.view
    ? {
        label: t("activity.view"),
        go: () => navigate(`/history?hash=${view.view!.hash}&net=${view.view!.network}`),
      }
    : view.retry
      ? {
          label: t("activity.tryAgain"),
          go: () => navigate(view.retry!.route, { state: { retry: view.retry!.ref } }),
        }
      : null;

  return (
    <div
      role="status"
      onMouseEnter={hold}
      onMouseLeave={run}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = e.clientX;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current !== null) setDx(Math.max(0, e.clientX - drag.current));
      }}
      onPointerUp={() => {
        if (drag.current === null) return;
        drag.current = null;
        if (dx > 70) close();
        else setDx(0);
      }}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - dx / 200) } : {}}
      className={`pointer-events-auto flex touch-pan-y items-center gap-3 rounded-2xl bg-surface-highlight py-3 pr-3 pl-3.5 shadow-[0_24px_50px_-18px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] select-none animate-in fade-in-0 slide-in-from-bottom-2 duration-250 ease-out motion-reduce:animate-none ${dx ? "" : "transition-[opacity,transform] duration-200 ease-out"} ${leaving ? "translate-x-12 opacity-0" : ""}`}
    >
      <Mascot id={`toast-${view.id}`} phase={view.tone ? TONE[view.tone] : "ok"} size={32} />
      <div className="min-w-0 flex-1">
        <div
          className={`text-body font-semibold ${view.text ? "line-clamp-3 text-pretty" : "truncate"} ${view.failed || view.tone === "error" ? "text-danger" : "text-content"}`}
        >
          {view.text ?? t(view.title, noticeValues(view.values))}
        </div>
        {view.who && (
          <div className="mt-1 flex items-center text-meta text-content-muted">
            <Person address={view.who} />
          </div>
        )}
      </div>
      {act && (
        <button
          type="button"
          onClick={() => {
            close();
            act.go();
          }}
          className={`h-7.5 shrink-0 cursor-pointer rounded-full bg-(--bg-3) px-3 text-[0.8125rem] font-medium text-content ${EASE} ${FOCUS}`}
        >
          {act.label}
        </button>
      )}
    </div>
  );
}

function ProgressToast({
  id,
  title,
  phase,
  steps,
  step,
  since,
  more,
}: {
  id: string;
  title: string;
  phase: MascotPhase;
  steps: string[];
  step: number;
  since: number | null;
  more: number;
}) {
  const { t } = useTranslation();
  const now = useNow(true);
  return (
    <button
      type="button"
      onClick={() => showProgress(id)}
      className={`pointer-events-auto flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-surface-highlight px-3.5 py-2.5 text-left shadow-[0_24px_50px_-18px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] animate-in fade-in-0 slide-in-from-bottom-2 duration-250 ease-out motion-reduce:animate-none ${FOCUS}`}
    >
      <Mascot id={`pill-${id}`} phase={phase} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.84375rem] font-semibold text-content">{title}</span>
        <span className="mt-1 flex items-center gap-2 text-meta text-content-muted">
          <span aria-hidden="true" className="inline-flex gap-1">
            {steps.map((s, i) => (
              <span
                key={s}
                className={`size-1.75 rounded-full ${i <= step ? "bg-content-secondary" : "bg-(--bg-3)"}`}
              />
            ))}
          </span>
          <span className="truncate">
            {step >= 0 ? t(steps[Math.min(step, steps.length - 1)]) : t("activity.waitingTurn")}
          </span>
          {more > 0 && <span className="shrink-0">{t("activity.andMore", { count: more })}</span>}
        </span>
      </span>
      <span className="w-10 shrink-0 text-right text-meta text-content-muted tabular-nums">
        {since ? clock((now - since) / 1000) : ""}
      </span>
    </button>
  );
}

function jobTitle(t: (k: string, o?: Record<string, unknown>) => string, job: ProofJob): string {
  const verb = t(RUNNING[job.kind]);
  return job.amount > 0 ? `${verb} ${formatOCT(job.amount)} OCT` : verb;
}

function ProgressPopup({ job, send }: { job: ProofJob | null; send: PublicSend | null }) {
  const { t } = useTranslation();
  const now = useNow(true);
  const hide = useCallback(() => showProgress(null), []);
  useEscapeKey(true, hide);
  let title: string;
  let phase: MascotPhase;
  let steps: { label: string; sec: number | null }[];
  let current: number;
  let to: string | undefined;
  let note: string;
  if (job) {
    const secs = stepSeconds(job, now);
    title = jobTitle(t, job);
    phase = MOOD[job.kind];
    steps = job.steps.map((s, i) => ({ label: t(s), sec: secs[i] }));
    current = Math.max(0, job.step);
    to = job.kind === "send" || job.kind === "claim" ? job.to : undefined;
    note = job.status === "queued" ? t("activity.waitsBefore") : "";
  } else {
    const s = send!;
    title = t("activity.sendingAmount", { amount: formatOCT(s.amount), unit: s.unit });
    phase = "ld";
    steps = s.steps.map((label, i) => {
      const start = s.marks[i];
      const end = s.marks[i + 1] ?? now;
      return { label: t(label), sec: start == null ? null : (end - start) / 1000 };
    });
    current = Math.max(0, s.marks.length - 1);
    to = s.to;
    note = "";
  }
  return (
    <PopupShell open still label={title} onScrim={hide}>
      <div className="flex items-center gap-4.5">
        <Mascot id="progress-popup" phase={phase} size={64} />
        <div className="min-w-0">
          <div className="truncate text-[1.375rem] font-semibold text-content">{title}</div>
          <div className="mt-1.5 flex h-5 items-center text-[0.8125rem] text-content-muted">
            {to ? <Person address={to} /> : note}
          </div>
        </div>
      </div>
      <div className="mt-5.5 h-44.5">
        <StepDots steps={steps} current={job?.status === "queued" ? -1 : current} />
      </div>
      <div className="mt-2.5 flex justify-end">
        <Btn weight="text" size="sm" onClick={hide}>
          {t("activity.hide")}
        </Btn>
      </div>
    </PopupShell>
  );
}

export default function ActivityToasts({ unlocked }: { unlocked: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  const activity = useActivity();
  const queue = useSyncExternalStore(subscribe, getQueue);
  useMountEffect(() => watchQueue());

  const live = queue.jobs.filter((j) => j.status === "running" || j.status === "queued");
  const running = live.find((j) => j.status === "running") ?? live[0] ?? null;
  const shownJob = queue.jobs.find((j) => j.id === activity.shown) ?? null;
  const shownSend = activity.sends.find((s) => s.id === activity.shown) ?? null;

  const pills = [
    ...activity.sends
      .filter((s) => s.id !== activity.shown)
      .map((s) => (
        <ProgressToast
          key={s.id}
          id={s.id}
          title={t("activity.sendingAmount", { amount: formatOCT(s.amount), unit: s.unit })}
          phase="ld"
          steps={s.steps}
          step={Math.max(0, s.marks.length - 1)}
          since={s.marks[0] ?? null}
          more={0}
        />
      )),
    ...(running && running.id !== activity.shown
      ? [
          <ProgressToast
            key={running.id}
            id={running.id}
            title={jobTitle(t, running)}
            phase={MOOD[running.kind]}
            steps={running.steps}
            step={running.status === "running" ? running.step : -1}
            since={running.marks[0] ?? null}
            more={live.length - 1}
          />,
        ]
      : []),
  ];

  return (
    <>
      <div
        data-look="ext"
        aria-live="polite"
        className={`pointer-events-none fixed right-6 z-45 flex w-87.5 flex-col gap-2.5 transition-[bottom] duration-250 ease-out ${location.pathname === "/send" ? "bottom-30" : "bottom-6"}`}
      >
        {activity.toasts.map((v) => (
          <Toast key={v.id} view={v} />
        ))}
        {unlocked && pills}
      </div>
      {unlocked && ((shownJob && shownJob.status !== "done") || shownSend) ? (
        <ProgressPopup job={shownJob} send={shownSend} />
      ) : null}
    </>
  );
}
