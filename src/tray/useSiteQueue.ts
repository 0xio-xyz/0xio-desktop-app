import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { closesPanel, type SiteItem } from "./siteQueue";
import { hidePanel } from "./useTrayState";

interface SiteOutcome {
  id: string;
  origin: string;
  code: string;
  message: string;
}

const itemsOf = (v: unknown): SiteItem[] => {
  const items = (v as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as SiteItem[]) : [];
};

export function useSiteQueue(opened = 0) {
  const [items, setItems] = useState<SiteItem[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [focusSite, setFocusSite] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SiteOutcome | null>(null);

  // Syncs with Rust: the queue on every open.
  useEffect(() => {
    let alive = true;
    void invoke("site_queue")
      .then((q) => alive && setItems(itemsOf(q)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [opened]);

  // Syncs with Rust: every change of the queue, the request an open is for, and failures.
  useEffect(() => {
    const offs = [
      listen<unknown>("site-queue", ({ payload }) => setItems(itemsOf(payload))),
      listen<{ id: string | null; origin?: string | null }>("site-focus", ({ payload }) => {
        setFocus(payload.id);
        setFocusSite(payload.origin ?? null);
      }),
      listen<SiteOutcome>("site-outcome", ({ payload }) => setOutcome(payload)),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, []);

  // The last answer given here closes the panel; a failure stays until it is read.
  const answeredHere = useRef(false);
  useEffect(() => {
    if (!closesPanel(items, answeredHere.current, !!outcome)) return;
    answeredHere.current = false;
    void hidePanel();
  }, [items, outcome]);

  const dismissOutcome = useCallback(() => {
    setOutcome(null);
    if (items.length === 0) void hidePanel();
  }, [items.length]);
  const answer = useCallback((id: string) => {
    answeredHere.current = true;
    return invoke("site_answer", { id });
  }, []);
  const reject = useCallback((ids: string[]) => {
    answeredHere.current = true;
    return invoke("site_reject", { ids });
  }, []);

  return { items, focus, focusSite, outcome, dismissOutcome, answer, reject };
}

export type SiteQueueState = ReturnType<typeof useSiteQueue>;
