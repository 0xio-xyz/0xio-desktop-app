import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getQueue,
  keyOf,
  subscribe,
  type DoneEntry,
  type ProofJob,
} from "src/features/privacy/services/proofQueue";

export interface WalletQueue {
  /** The job at the top: running, or failed and waiting for Retry or Remove. */
  top: ProofJob | null;
  next: ProofJob[];
  /** This wallet's queue is held by a key update the network has not applied. */
  held: boolean;
  /** A job ahead of the waiting ones failed, so they wait for Retry or Remove. */
  paused: boolean;
  done: DoneEntry[];
  busy: boolean;
}

export function useWalletQueue(scope: { networkId: string; address: string } | null): WalletQueue {
  const state = useSyncExternalStore(subscribe, getQueue);
  const key = scope ? keyOf(scope) : "";
  const mine = state.jobs.filter((j) => j.status !== "done" && keyOf(j.scope) === key);
  const top = mine.find((j) => j.status === "running" || j.status === "failed") ?? null;
  const next = mine.filter((j) => j.status === "queued");
  return {
    top,
    next,
    held: state.holds.includes(key),
    paused: top?.status === "failed",
    done: state.done[key] ?? [],
    busy: mine.length > 0,
  };
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Seconds each reached step took, the running one up to now. */
export function stepSeconds(job: ProofJob, now: number): (number | null)[] {
  return job.steps.map((_, i) => {
    const start = job.marks[i];
    if (start == null) return null;
    const end = job.marks[i + 1] ?? job.endedAt ?? now;
    return (end - start) / 1000;
  });
}
