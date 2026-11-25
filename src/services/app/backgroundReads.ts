import { useSyncExternalStore } from "react";

let holds = 0;
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const backgroundReadsHeld = () => holds > 0;

export function holdBackgroundReads(): () => void {
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

export function useBackgroundReads(): boolean {
  return useSyncExternalStore(subscribe, backgroundReadsHeld, backgroundReadsHeld);
}
