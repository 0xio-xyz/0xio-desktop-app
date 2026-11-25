import { useCallback, useEffect, useState } from "react";

/** Rust holds the real deadline; each tick asks how long is left, so a throttled window still ends on time. */
export function useLockout() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // effect:audited - ticks a running wait down; stops itself when the deadline passes.
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) {
        clearInterval(id);
        setUntil(0);
      }
    }, 250);
    return () => clearInterval(id);
  }, [until]);

  const lockFor = useCallback((seconds: number) => {
    const t = Date.now();
    setNow(t);
    setUntil(seconds > 0 ? t + seconds * 1000 : 0);
  }, []);

  const seconds = until > now ? Math.ceil((until - now) / 1000) : 0;
  return { seconds, lockedOut: seconds > 0, lockFor };
}
