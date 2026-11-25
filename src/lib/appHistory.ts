import { createHashHistory, resolveTo, type History, type NavigateFunction } from "src/lib/router";

/**
 * Decides whether the app may navigate now. Returning false holds the navigation; `proceed`
 * performs it later, once the page that held it is ready to let go.
 */
type LeaveGuard = (pathname: string | null, proceed: () => void) => boolean;

let guard: LeaveGuard | null = null;

export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export function createAppHistory(win: Window = window): History {
  const base = createHashHistory(win);
  const held = (path: string | null, run: () => void) => {
    if (!guard || guard(path, run)) run();
  };
  const navigate = ((to: string | number, options?: { replace?: boolean; state?: unknown }) => {
    if (typeof to === "number") held(null, () => base.navigate(to));
    else held(resolveTo(to, base.location()).pathname, () => base.navigate(to, options));
  }) as NavigateFunction;
  return { ...base, navigate };
}
