import { useCallback, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { logger } from "src/lib/logger";

export interface PairRequest {
  id: string;
  name: string;
  code: string;
  /** "extension" is the 0xio Chrome id; "firefox" is a Firefox extension; "app" sent no Origin. */
  kind: "extension" | "firefox" | "app";
  origin: string | null;
}

interface Resolved {
  id: string;
  outcome?: "paired" | "refused" | "cancelled" | "expired" | "closed";
}

export const PAIRED_MS = 1500;

const bringForward = () => {
  const win = getCurrentWindow();
  void (async () => {
    await win.unminimize().catch(() => {});
    await win.setFocus().catch(() => {});
    await win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  })();
};

/**
 * Rust holds the pairing reviews and their timeout; this mirrors them and sends the answer. An
 * extension's pairing is kept only once its user picks the same code.
 */
export function useWsPairing() {
  const [queue, setQueue] = useState<PairRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const pairedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showPaired = useCallback(() => {
    if (pairedTimer.current) clearTimeout(pairedTimer.current);
    setPaired(true);
    pairedTimer.current = setTimeout(() => setPaired(false), PAIRED_MS);
  }, []);

  useMountEffect(() => {
    let alive = true;
    invoke<PairRequest[]>("ws_pair_pending")
      .then((list) => {
        if (alive && list.length) {
          setQueue(list);
          bringForward();
        }
      })
      .catch(() => {});
    const offRequest = listen<PairRequest>("ws-pair-request", (e) => {
      setQueue((q) => (q.some((p) => p.id === e.payload.id) ? q : [...q, e.payload]));
      bringForward();
    });
    const offResolved = listen<Resolved>("ws-pair-resolved", (e) => {
      setQueue((q) => q.filter((p) => p.id !== e.payload.id));
      setWaiting((w) => (w === e.payload.id ? null : w));
      if (e.payload.outcome === "paired") showPaired();
    });
    return () => {
      alive = false;
      if (pairedTimer.current) clearTimeout(pairedTimer.current);
      void offRequest.then((f) => f());
      void offResolved.then((f) => f());
    };
  });

  const current = queue[0] ?? null;

  const answer = useCallback(
    async (approve: boolean) => {
      if (!current || busy) return;
      if (approve && waiting === current.id) return;
      setBusy(true);
      let result: string | null = null;
      try {
        result = await invoke<string>("ws_pair_respond", { id: current.id, approve });
      } catch (err) {
        logger.warn("pairing", "the request ended before the answer", err);
      } finally {
        setBusy(false);
      }
      if (result === "waiting") {
        setWaiting(current.id);
        return;
      }
      setQueue((q) => q.filter((p) => p.id !== current.id));
      setWaiting((w) => (w === current.id ? null : w));
      if (result === "paired") showPaired();
    },
    [current, busy, waiting, showPaired],
  );

  return {
    current,
    busy,
    waiting: !!current && waiting === current.id,
    paired,
    approve: () => void answer(true),
    reject: () => void answer(false),
  };
}
