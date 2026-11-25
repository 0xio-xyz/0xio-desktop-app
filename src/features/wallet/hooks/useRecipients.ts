import { useMemo, useState } from "react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { getContacts, INTERNAL_TAG } from "src/services/storage/addressBookService";
import {
  fetchHistoryPage,
  historyQueryKey,
  HISTORY_PAGE_SIZE,
} from "src/hooks/transactions/useTransactionHistory";
import { toMs } from "src/lib/dates";

export type RecipientSource = "book" | "wallet" | "recent";

export interface RecipientInfo {
  address: string;
  name: string | null;
  source: RecipientSource | null;
  sent: number;
  last: { amount: number; at: number } | null;
}

export function useRecipients() {
  const { activeWallet, networkId, wallets } = useWallet();
  const self = activeWallet?.address;
  const [bookVersion, setBookVersion] = useState(0);
  const history = useQuery({
    queryKey: historyQueryKey(self, networkId, HISTORY_PAGE_SIZE),
    queryFn: () => fetchHistoryPage(self!, HISTORY_PAGE_SIZE, networkId),
    enabled: !!self,
    staleTime: 60_000,
  });

  const recent = useMemo(() => {
    const map = new Map<string, { sent: number; last: { amount: number; at: number } }>();
    for (const tx of history.data?.transactions ?? []) {
      if (tx.from !== self || !tx.to || tx.to === self || tx.token_transfer) continue;
      if (tx.status === "failed") continue;
      const at = toMs(tx.timestamp);
      const cur = map.get(tx.to);
      if (!cur) map.set(tx.to, { sent: 1, last: { amount: tx.amount, at } });
      else {
        cur.sent += 1;
        if (at > cur.last.at) cur.last = { amount: tx.amount, at };
      }
    }
    return map;
  }, [history.data, self]);

  const known = useMemo(() => {
    const map = new Map<string, { name: string; source: RecipientSource }>();
    for (const c of getContacts(networkId)) {
      if (c.address === self) continue;
      map.set(c.address, {
        name: c.label,
        source: c.tags.includes(INTERNAL_TAG) ? "wallet" : "book",
      });
    }
    for (const w of wallets) {
      if (w.address === self) continue;
      map.set(w.address, { name: w.name, source: "wallet" });
    }
    return map;
  }, [networkId, wallets, self, bookVersion]);

  const info = (address: string): RecipientInfo => {
    const k = known.get(address);
    const r = recent.get(address);
    return {
      address,
      name: k?.name ?? null,
      source: k?.source ?? (r ? "recent" : null),
      sent: r?.sent ?? 0,
      last: r?.last ?? null,
    };
  };

  const all = useMemo(() => {
    const addrs = new Set<string>([...known.keys(), ...recent.keys()]);
    const list = [...addrs].map((a) => {
      const k = known.get(a);
      const r = recent.get(a);
      return {
        address: a,
        name: k?.name ?? null,
        source: (k?.source ?? "recent") as RecipientSource,
        sent: r?.sent ?? 0,
        last: r?.last ?? null,
      };
    });
    return list.sort(
      (a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
    );
  }, [known, recent]);

  const search = (q: string): RecipientInfo[] => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter(
      (r) => r.address.toLowerCase().includes(s) || (r.name ?? "").toLowerCase().includes(s),
    );
  };

  return {
    info,
    search,
    reload: () => setBookVersion((v) => v + 1),
    historyReady: !history.isLoading,
  };
}

export type Recipients = ReturnType<typeof useRecipients>;
