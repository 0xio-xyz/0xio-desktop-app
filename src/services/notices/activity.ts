import { useSyncExternalStore } from "react";
import {
  getQueue,
  subscribe as subscribeQueue,
  type ProofJob,
  type ProofKind,
} from "src/features/privacy/services/proofQueue";
import { announce } from "src/services/notices/noticeNative";
import { scopeOf } from "src/services/notices/notifications";

// A public send never enters the proof queue, so it reports its progress here itself.

export interface ToastView {
  id: number;
  title: string;
  text?: string;
  tone?: "success" | "error" | "warning" | "info" | "processing";
  values?: Record<string, string | number>;
  who?: string;
  failed?: boolean;
  view?: { hash: string; network: string };
  retry?: { route: string; ref: string };
  /** A result with a scope also enters the notification centre. */
  scope?: { networkId: string; address: string };
}

export interface PublicSend {
  id: string;
  amount: number;
  unit: string;
  to: string;
  steps: string[];
  marks: number[];
}

interface ActivityState {
  toasts: ToastView[];
  shown: string | null;
  sends: PublicSend[];
}

const MAX_TOASTS = 3;

let state: ActivityState = { toasts: [], shown: null, sends: [] };
const listeners = new Set<() => void>();
let seq = 0;

function emit(next: Partial<ActivityState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActivity(): ActivityState {
  return state;
}

export function useActivity(): ActivityState {
  return useSyncExternalStore(subscribe, getActivity);
}

export function toast(view: Omit<ToastView, "id">): number {
  const id = ++seq;
  if (view.scope && !view.text)
    announce({
      id: `result:${Date.now()}:${id}`,
      kind: view.failed ? "failed" : "result",
      scope: scopeOf(view.scope.networkId, view.scope.address),
      title: view.title,
      values: view.values,
      who: view.who,
      action: view.retry
        ? { kind: "retry", ...view.retry }
        : view.view
          ? { kind: "view", ...view.view }
          : { kind: "privacy" },
    });
  emit({ toasts: [{ ...view, id }, ...state.toasts].slice(0, MAX_TOASTS) });
  return id;
}

export function dismiss(id: number): void {
  emit({ toasts: state.toasts.filter((t) => t.id !== id) });
}

export function showProgress(ref: string | null): void {
  if (state.shown !== ref) emit({ shown: ref });
}

export function startSend(send: PublicSend): void {
  emit({ sends: [...state.sends.filter((s) => s.id !== send.id), send] });
}

export function stepSend(id: string, marks: number[]): void {
  emit({ sends: state.sends.map((s) => (s.id === id ? { ...s, marks } : s)) });
}

export function endSend(id: string): void {
  emit({
    sends: state.sends.filter((s) => s.id !== id),
    shown: state.shown === id ? null : state.shown,
  });
}

const DONE_TITLE: Record<ProofKind, string> = {
  encrypt: "activity.encrypted",
  decrypt: "activity.decrypted",
  claim: "activity.claimed",
  send: "activity.sentPrivately",
  bulk: "activity.sentPrivately",
  refresh: "activity.refreshed",
  migrate: "activity.migrated",
  setup: "activity.turnedOn",
};
const FAIL_TITLE: Record<ProofKind, string> = {
  encrypt: "activity.encryptFailed",
  decrypt: "activity.decryptFailed",
  claim: "activity.claimFailed",
  send: "activity.sendFailed",
  bulk: "activity.sendFailed",
  refresh: "activity.refreshFailed",
  migrate: "activity.migrateFailed",
  setup: "activity.turnOnFailed",
};

const batches = new Map<string, { ids: Set<string>; n: number; total: number }>();

export function claimBatch(jobIds: string[]): void {
  if (jobIds.length < 2) return;
  const key = jobIds.join("|");
  batches.set(key, { ids: new Set(jobIds), n: jobIds.length, total: 0 });
}

function batchOf(id: string) {
  for (const [key, b] of batches) if (b.ids.has(id)) return { key, b };
  return null;
}

function finished(job: ProofJob): void {
  const network = job.scope.networkId;
  const hash = job.result?.txHash;
  const batch = batchOf(job.id);
  if (batch) {
    batch.b.ids.delete(job.id);
    batch.b.total += job.amount;
    if (batch.b.ids.size === 0) {
      batches.delete(batch.key);
      toast({
        title: "activity.claimedN",
        values: { count: batch.b.n, amount: batch.b.total },
        view: hash ? { hash, network } : undefined,
        scope: job.scope,
      });
    }
    return;
  }
  toast({
    title: DONE_TITLE[job.kind],
    values: job.amount > 0 ? { amount: job.amount } : undefined,
    who: job.kind === "send" || job.kind === "claim" ? job.to : undefined,
    view: hash ? { hash, network } : undefined,
    scope: job.scope,
  });
}

function failed(job: ProofJob): void {
  const batch = batchOf(job.id);
  if (batch) batches.delete(batch.key);
  toast({
    title: FAIL_TITLE[job.kind],
    values: job.amount > 0 ? { amount: job.amount } : undefined,
    who: job.kind === "send" ? job.to : undefined,
    failed: true,
    retry: { route: job.kind === "send" ? "/send" : "/privacy", ref: job.id },
    scope: job.scope,
  });
}

let last = new Map<string, ProofJob["status"]>();

export function watchQueue(): () => void {
  last = new Map(getQueue().jobs.map((j) => [j.id, j.status]));
  return subscribeQueue(() => {
    const next = new Map<string, ProofJob["status"]>();
    for (const job of getQueue().jobs) {
      next.set(job.id, job.status);
      const before = last.get(job.id);
      if (before === job.status) continue;
      if (job.status === "done") {
        finished(job);
        if (state.shown === job.id) emit({ shown: null });
      } else if (job.status === "failed") {
        failed(job);
        if (state.shown === job.id) emit({ shown: null });
      }
    }
    last = next;
  });
}

export function resetActivity(): void {
  state = { toasts: [], shown: null, sends: [] };
  batches.clear();
  for (const l of listeners) l();
}
