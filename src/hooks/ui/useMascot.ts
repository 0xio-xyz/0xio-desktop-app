import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { MascotPhase } from "src/shared/ui/Mascot";

const OPEN_MS = 900;
const IDLE_MS = 8000;
const SLEEP_MS = 2400;

/**
 * Mascot behaviour shared by the lock screen and the menu bar panel: the dial on open, then
 * awake; dozes after IDLE_MS without pointer movement and falls asleep; any movement wakes it;
 * while awake the slash follows the pointer. `working` holds the dial loop (unlocking).
 */
export function useMascot(anchor: RefObject<HTMLElement | null>, working: boolean) {
  const [phase, setPhase] = useState<MascotPhase>("op");
  const [look, setLook] = useState({ deg: 0, lean: 0 });
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sleep = useRef<ReturnType<typeof setTimeout>>(undefined);

  const arm = useCallback(() => {
    clearTimeout(idle.current);
    clearTimeout(sleep.current);
    idle.current = setTimeout(() => {
      setPhase("zz");
      sleep.current = setTimeout(() => setPhase("s0"), SLEEP_MS);
    }, IDLE_MS);
  }, []);

  // Syncs with time and the pointer: open, wake on movement, follow the pointer, doze when idle.
  useEffect(() => {
    if (working) {
      clearTimeout(idle.current);
      clearTimeout(sleep.current);
      setPhase("ld");
      return;
    }
    setPhase("op");
    const opened = setTimeout(() => {
      setPhase("up");
      arm();
    }, OPEN_MS);
    const onMove = (e: PointerEvent) => {
      setPhase((p) => (p === "zz" || p === "s0" ? "up" : p));
      arm();
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - (r.left + r.width / 2);
      const my = e.clientY - (r.top + r.height / 2);
      const deg = Math.max(
        -28,
        Math.min(28, Math.atan2(mx, Math.max(40, Math.abs(my) + 40)) * 57.3),
      );
      setLook({ deg: Math.round(deg), lean: Math.max(-3, Math.min(3, mx / 80)) });
    };
    const onLeave = () => setLook({ deg: 0, lean: 0 });
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      clearTimeout(opened);
      clearTimeout(idle.current);
      clearTimeout(sleep.current);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [working, anchor, arm]);

  return { phase, lookDeg: look.deg, leanX: look.lean };
}
