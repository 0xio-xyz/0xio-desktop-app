import { subscribeWork, workInFlight } from "src/services/app/workInFlight";

export const WORK_HOLD_MAX_MS = 30 * 60_000;
const CHECK_EVERY_MS = 30_000;
const REPORT_EVERY_MS = 10_000;
const PROGRESS_REPORT_MS = 60_000;

export interface IdleReport {
  autoLockMinutes: number;
  active: boolean;
  working: boolean;
}

export function autoLockDue(a: {
  now: number;
  lastActivity: number;
  lockMs: number;
  working: boolean;
  workSince: number;
}): boolean {
  if (a.lockMs <= 0 || a.now - a.lastActivity < a.lockMs) return false;
  return !a.working || a.now - a.workSince >= WORK_HOLD_MAX_MS;
}

export function watchAutoLock(opts: {
  minutes: number;
  lock: () => void;
  report: (r: IdleReport) => void;
}): { activity: () => void; stop: () => void } {
  const lockMs = opts.minutes * 60_000;
  let lastActivity = Date.now();
  let workSince = lastActivity;
  let reportedAt = 0;
  let stopped = false;

  const report = (active: boolean) => {
    reportedAt = Date.now();
    opts.report({ autoLockMinutes: opts.minutes, active, working: workInFlight() });
  };
  const due = () =>
    autoLockDue({ now: Date.now(), lastActivity, lockMs, working: workInFlight(), workSince });
  const lockIfDue = () => {
    if (stopped || !due()) return false;
    stop();
    opts.lock();
    return true;
  };

  const offWork = subscribeWork((flipped) => {
    const working = workInFlight();
    if (working || flipped) workSince = Date.now();
    if (flipped || (working && Date.now() - reportedAt >= PROGRESS_REPORT_MS)) report(false);
    lockIfDue();
  });
  const timer = lockMs > 0 ? setInterval(lockIfDue, CHECK_EVERY_MS) : null;
  function stop() {
    stopped = true;
    offWork();
    if (timer) clearInterval(timer);
  }

  report(true);
  return {
    activity: () => {
      if (lockIfDue()) return;
      lastActivity = Date.now();
      if (lastActivity - reportedAt >= REPORT_EVERY_MS) report(true);
    },
    stop,
  };
}
