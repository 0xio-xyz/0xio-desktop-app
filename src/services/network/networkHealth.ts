// Set on an RPC timeout or unreachable node; it expires after the window rather than clearing on
// success. A network switch clears it so the toast does not carry onto the next network.

const SLOW_WINDOW_MS = 30_000;

let slowSince = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* a bad listener must not break the others */
    }
  });
}

export function markSlow(): void {
  slowSince = Date.now();
  notify();
}

export function clearSlow(): void {
  if (slowSince) {
    slowSince = 0;
    notify();
  }
}

export function isNetworkSlow(): boolean {
  return slowSince > 0 && Date.now() - slowSince < SLOW_WINDOW_MS;
}

export function subscribeNetworkHealth(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
