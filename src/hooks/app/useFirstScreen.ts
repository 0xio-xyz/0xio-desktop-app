import { useLayoutEffect } from "react";
import { useLocation } from "src/lib/router";
import { firstScreenShown } from "src/services/app/startup";

/** Before paint, so the skeleton and the screen it stands for never share a frame. */
export function useFirstScreen(): void {
  const { pathname } = useLocation();
  useLayoutEffect(() => firstScreenShown(pathname.slice(1) || "home"), [pathname]);
}
