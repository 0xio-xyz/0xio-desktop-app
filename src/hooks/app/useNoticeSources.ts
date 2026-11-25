import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { skipToken, useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { getUpdateSnapshot, subscribeUpdates } from "src/services/app/updater";
import { announce } from "src/services/notices/noticeNative";
import { APP, resolve, resolveMissing, scopeOf } from "src/services/notices/notifications";
import type { Transaction } from "src/types/transaction";
import type { ClaimableOutput } from "src/features/privacy/services/privacyService";

const SINCE_KEY = "0xio_notices_since_v1";

/** When this wallet and network were first watched: older transfers are history, not news. */
function sinceFor(scope: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(SINCE_KEY) ?? "{}") as Record<string, number>;
    if (all[scope]) return all[scope];
    all[scope] = Date.now();
    localStorage.setItem(SINCE_KEY, JSON.stringify(all));
    return all[scope];
  } catch {
    return Date.now();
  }
}

const msOf = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

export function receivedNotice(tx: Transaction, scope: string, networkId: string, since: number) {
  if (tx.type !== "receive" || tx.status !== "confirmed" || msOf(tx.timestamp) <= since)
    return null;
  return {
    id: `received:${scope}:${tx.hash}`,
    kind: "received" as const,
    scope,
    at: msOf(tx.timestamp),
    title: "notices.received",
    values: { amount: tx.amount },
    who: tx.from,
    action: { kind: "view" as const, hash: tx.hash, network: networkId },
  };
}

export function claimNotice(o: Pick<ClaimableOutput, "id" | "amount" | "sender">, scope: string) {
  return {
    id: `claim:${scope}:${o.id}`,
    kind: "claim" as const,
    scope,
    title: "notices.claim",
    values: { amount: o.amount },
    who: o.sender,
    action: { kind: "claim" as const },
  };
}

export function siteNotice(item: { id: string; origin: string; createdAt?: number }) {
  let site = item.origin;
  try {
    site = new URL(item.origin).host || item.origin;
  } catch {}
  return {
    id: `site:${item.id}`,
    kind: "site" as const,
    scope: APP,
    at: item.createdAt,
    title: "notices.site",
    values: { site },
    action: { kind: "site" as const, id: item.id },
  };
}

const siteItems = (q: unknown) => {
  const items = (q as { items?: unknown } | null)?.items;
  return Array.isArray(items)
    ? (items as { id: string; origin: string; createdAt?: number }[]).filter((i) => i && i.id)
    : [];
};

function syncSites(q: unknown): void {
  const items = siteItems(q);
  items.forEach((i) => announce(siteNotice(i)));
  resolveMissing("site", APP, new Set(items.map((i) => `site:${i.id}`)));
}

/**
 * Feeds the notification centre from what the app already reads. Results of the user's own
 * actions come from the result toasts (services/notices/activity.ts). Mounted once while unlocked.
 */
export function useNoticeSources(): void {
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address ?? "";
  const scope = address ? scopeOf(networkId, address) : "";

  const { transactions } = useTransactionHistory();
  useEffect(() => {
    if (!scope) return;
    const since = sinceFor(scope);
    for (const tx of transactions) {
      const n = receivedNotice(tx, scope, networkId, since);
      if (n) announce(n);
    }
  }, [transactions, scope, networkId]);

  // The sidebar's scan fills this; reading it here starts no scan of its own.
  const { data: outputs } = useQuery<ClaimableOutput[]>({
    queryKey: ["claimOutputs", activeWallet?.id, networkId],
    queryFn: skipToken,
  });
  useEffect(() => {
    if (!scope || !outputs) return;
    outputs.forEach((o) => announce(claimNotice(o, scope)));
    resolveMissing("claim", scope, new Set(outputs.map((o) => claimNotice(o, scope).id)));
  }, [outputs, scope]);

  // The key status Privacy reads; a hold shows here once that read has run.
  const { data: keyStatus } = useQuery<{ rotation?: { kind: string } }>({
    queryKey: ["pvacKeyStatus", address, networkId],
    queryFn: skipToken,
  });
  useEffect(() => {
    if (!scope || !keyStatus) return;
    const id = `keyHold:${scope}`;
    const held = keyStatus.rotation && keyStatus.rotation.kind !== "none";
    if (held)
      announce({
        id,
        kind: "keyHold",
        scope,
        title: "notices.keyHold",
        action: { kind: "privacy" },
      });
    else resolve(id);
  }, [keyStatus, scope]);

  // Syncs with Rust: the queue now, then every change.
  useEffect(() => {
    let alive = true;
    void invoke("site_queue")
      .then((q) => alive && syncSites(q))
      .catch(() => {});
    const off = listen<unknown>("site-queue", ({ payload }) => syncSites(payload));
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, []);

  // Syncs with Rust: pairing reviews waiting now, then each one asked and answered.
  useEffect(() => {
    const pair = (r: { id: string; name: string }) =>
      announce({
        id: `pair:${r.id}`,
        kind: "pair",
        scope: APP,
        title: "notices.pair",
        values: { name: r.name },
        action: { kind: "pair" },
      });
    void invoke<{ id: string; name: string }[]>("ws_pair_pending")
      .then((list) => list.forEach(pair))
      .catch(() => {});
    const offAsk = listen<{ id: string; name: string }>("ws-pair-request", (e) => pair(e.payload));
    const offDone = listen<{ id: string }>("ws-pair-resolved", (e) =>
      resolve(`pair:${e.payload.id}`),
    );
    return () => {
      void offAsk.then((f) => f());
      void offDone.then((f) => f());
    };
  }, []);

  const update = useSyncExternalStore(subscribeUpdates, getUpdateSnapshot).update;
  useEffect(() => {
    const ready = update.phase === "ready" ? `update:${update.version}` : null;
    if (ready && update.phase === "ready")
      announce({
        id: ready,
        kind: "update",
        scope: APP,
        title: "notices.update",
        values: { version: update.version },
        action: { kind: "restart" },
      });
    resolveMissing("update", APP, new Set(ready ? [ready] : []));
  }, [update]);
}
