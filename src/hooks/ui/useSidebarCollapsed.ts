import { useCallback, useState, useSyncExternalStore } from "react";
import { useLocation } from "src/lib/router";

export const NARROW_PX = 900;

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const isNarrow = () => window.innerWidth < NARROW_PX;

/**
 * The sidebar's collapsed state. The saved choice lives with the appearance settings. A narrow
 * window and the Contracts workspace fold it on their own; a toggle there lasts until that ends.
 */
export function useSidebarCollapsed(saved: boolean, save: (collapsed: boolean) => void) {
  const narrow = useSyncExternalStore(subscribeResize, isNarrow);
  const onContracts = useLocation().pathname.startsWith("/contracts");
  const auto = narrow || onContracts;
  const reason = `${narrow}:${onContracts}`;
  const [peek, setPeek] = useState<{ reason: string; collapsed: boolean } | null>(null);

  const collapsed = auto ? (peek?.reason === reason ? peek.collapsed : true) : saved;

  const toggle = useCallback(() => {
    if (auto) setPeek({ reason, collapsed: !collapsed });
    else save(!collapsed);
  }, [auto, reason, collapsed, save]);

  return { collapsed, toggle };
}
