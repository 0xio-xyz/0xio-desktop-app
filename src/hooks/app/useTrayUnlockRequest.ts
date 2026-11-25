import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "src/lib/logger";

export const TRAY_UNLOCK_EVENT = "0xio-tray-unlock";

/** Keeps the menu bar panel open while a Touch ID prompt (which takes focus) is up. */
export async function withTrayAuthHold<T>(run: () => Promise<T>): Promise<T> {
  await invoke("tray_auth_hold", { on: true }).catch((e) =>
    logger.warn("tray", "auth hold failed", e),
  );
  try {
    return await run();
  } finally {
    await invoke("tray_auth_hold", { on: false }).catch((e) =>
      logger.warn("tray", "auth hold release failed", e),
    );
  }
}

/** Runs `unlock` when the menu bar panel asks for a Touch ID unlock (relayed by useTrayBridge). */
export function useTrayUnlockRequest(unlock: () => Promise<void>) {
  const latest = useRef(unlock);
  latest.current = unlock;
  // Syncs with the tray bridge's window event.
  useEffect(() => {
    const run = () => void withTrayAuthHold(() => latest.current());
    window.addEventListener(TRAY_UNLOCK_EVENT, run);
    return () => window.removeEventListener(TRAY_UNLOCK_EVENT, run);
  }, []);
}
