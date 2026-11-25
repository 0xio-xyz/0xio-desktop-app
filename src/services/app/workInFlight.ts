import {
  hasRunnableWork,
  subscribe as subscribeQueue,
} from "src/features/privacy/services/proofQueue";
import { getActivity, subscribe as subscribeActivity } from "src/services/notices/activity";

let holds = 0;
const listeners = new Set<() => void>();

export function holdWork(): () => void {
  let held = true;
  holds++;
  listeners.forEach((fn) => fn());
  return () => {
    if (!held) return;
    held = false;
    holds--;
    listeners.forEach((fn) => fn());
  };
}

export function workInFlight(): boolean {
  return holds > 0 || hasRunnableWork() || getActivity().sends.length > 0;
}

export function subscribeWork(fn: (flipped: boolean) => void): () => void {
  let last = workInFlight();
  const changed = () => {
    const next = workInFlight();
    const flipped = next !== last;
    last = next;
    fn(flipped);
  };
  listeners.add(changed);
  const offQueue = subscribeQueue(changed);
  const offActivity = subscribeActivity(changed);
  return () => {
    listeners.delete(changed);
    offQueue();
    offActivity();
  };
}
