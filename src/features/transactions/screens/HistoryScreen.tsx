import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { logger } from "src/lib/logger";
import { Screen, PageTitle, PillTabs, Action, ScrollArea } from "src/shared/ui/flat";
import { EASE, FOCUS, Num } from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import { peekTokenList } from "src/hooks/wallet/useTokens";
import { formatOCT } from "src/lib/format";
import type { Transaction } from "src/types/transaction";
import { useHistoryPages } from "src/features/transactions/hooks/useHistoryPages";
import { sideOf, type Side } from "src/features/transactions/history/sides";
import { methodKey, useContractMethods } from "src/features/transactions/history/contractMethods";
import { contractKey, useTokenFacts } from "src/features/transactions/history/contractFacts";
import { txView } from "src/features/transactions/history/txView";
import HistoryRow from "src/features/transactions/components/HistoryRow";
import TxDetailsPanel from "src/features/transactions/components/TxDetailsPanel";

const rowKey = (tx: Transaction) => `${tx.network}:${tx.hash}`;

// `/history?hash=<hash>&net=<network>` opens that transaction's details.
export default function HistoryScreen() {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address ?? "";
  const [searchParams] = useSearchParams();
  const linkNet = searchParams.get("net");

  const [picked, setPicked] = useState<{ net: string; side: Side }>(() => ({
    net: networkId,
    side: sideOf(linkNet || networkId),
  }));
  const side = picked.net === networkId ? picked.side : sideOf(networkId);
  const [selected, setSelected] = useState<{ hash: string; network: string } | null>(() => {
    const hash = searchParams.get("hash");
    return hash ? { hash, network: linkNet || "" } : null;
  });

  const [filter, setFilter] = useState<Filter>("all");
  const history = useHistoryPages(address, networkId, side);
  const { rows, pending } = history;

  const calls = useMemo(
    () =>
      rows
        .filter((tx) => tx.type === "contract_call" && tx.hash && !tx.methodName)
        .map((tx) => ({ network: tx.network!, hash: tx.hash })),
    [rows],
  );
  const methods = useContractMethods(calls);
  const contracts = useMemo(
    () =>
      rows
        .filter((tx) => tx.type === "contract_call" && tx.to)
        .map((tx) => ({ network: tx.network!, address: tx.to })),
    [rows],
  );
  const facts = useTokenFacts(contracts);
  const listed = peekTokenList();
  const viewOf = (tx: Transaction) =>
    txView(
      tx,
      {
        me: address,
        network: tx.network!,
        method: methods[methodKey(tx.network!, tx.hash)],
        facts: tx.type === "contract_call" ? facts[contractKey(tx.network!, tx.to)] : null,
        listed,
      },
      t,
    );

  // Avg fee counts only outgoing txs: a received tx's fee was paid by the sender.
  // (outgoing): a received tx's fee was paid by the sender. The node reports the fee as `ou`.
  const stats = useMemo(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);
    let sent = 0,
      recv = 0,
      feeSum = 0,
      feeCount = 0,
      privacy = 0;
    for (const tx of rows) {
      if (tx.status !== "confirmed") continue;
      const recent = toMs(tx.timestamp) >= cutoff;
      // A contract call that carries OCT (a bridge lock, say) leaves the wallet like a transfer.
      const paidOut =
        tx.type === "send" ||
        ((tx.type === "contract_call" || tx.type === "contract_deploy") &&
          tx.amount > 0 &&
          tx.from === address);
      if (paidOut && recent) sent += tx.amount;
      else if (tx.type === "receive" && recent) recv += tx.amount;
      if (["encrypt", "decrypt", "stealth_send", "claim"].includes(tx.type)) privacy++;
      if (tx.from === address && tx.fee > 0) {
        feeSum += tx.fee;
        feeCount++;
      }
    }
    return { sent, recv, privacy, avgFee: feeCount ? Math.round(feeSum / feeCount) : 0 };
  }, [rows, address]);

  const handleRefetch = useCallback(() => {
    logger.debug("history", "manual refetch triggered");
    history.refetch();
  }, [history]);

  const openTx = useCallback(
    (tx: Transaction) => setSelected({ hash: tx.hash, network: tx.network! }),
    [],
  );
  const closeTx = useCallback(() => setSelected(null), []);

  const selectedRow = selected
    ? [...pending, ...history.allRows].find(
        (tx) => tx.hash === selected.hash && (!selected.network || tx.network === selected.network),
      )
    : undefined;
  const selectedNetwork = selected ? selected.network || selectedRow?.network || networkId : "";

  const shown = filter === "all" ? rows : rows.filter((tx) => kindOf(tx, address) === filter);
  const current = selectedRow ?? (selected ? null : (pending[0] ?? shown[0] ?? null));
  const currentNetwork = selected ? selectedNetwork : (current?.network ?? networkId);
  const currentKey = current ? rowKey(current) : null;
  const row = (tx: Transaction, key: string) => (
    <HistoryRow
      key={key}
      tx={tx}
      view={viewOf(tx)}
      network={tx.network!}
      onOpen={openTx}
      selected={currentKey === rowKey(tx)}
    />
  );

  return (
    <Screen onRefresh={handleRefetch} refreshing={history.isFetching}>
      <PageTitle
        title={t("history.title")}
        right={
          <PillTabs
            tabs={[
              { id: "mainnet" as const, label: t("history.mainnet", { defaultValue: "Mainnet" }) },
              { id: "testnet" as const, label: t("history.testnet") },
            ]}
            value={side}
            onChange={(s) => setPicked({ net: networkId, side: s })}
          />
        }
      />

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(16.25rem,0.55fr)] gap-7">
        <div className="@container flex min-h-0 min-w-0 flex-col">
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-4 px-1 @4xl:grid-cols-4">
            {[
              {
                label: t("history.sent30d", { defaultValue: "Sent (30d)" }),
                value: formatOCT(stats.sent),
                unit: "OCT",
              },
              {
                label: t("history.received30d", { defaultValue: "Received (30d)" }),
                value: formatOCT(stats.recv),
                unit: "OCT",
              },
              {
                label: t("history.privacyCount", { defaultValue: "Privacy transactions" }),
                value: String(stats.privacy),
                unit: "",
              },
              {
                label: t("history.averageFee", { defaultValue: "Average fee" }),
                value: formatOCT(stats.avgFee),
                unit: "OCT",
              },
            ].map((st) => (
              <div key={st.label} className="min-w-0">
                <p className="truncate text-meta text-content-muted">{st.label}</p>
                <p className="mt-1.5 text-[1.375rem] font-light tracking-[-0.02em] whitespace-nowrap text-content">
                  <Num value={st.value} />
                  {st.unit && (
                    <span className="ml-1.25 text-meta text-content-muted">{st.unit}</span>
                  )}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex h-7 shrink-0 items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`h-7 cursor-pointer rounded-full px-3 text-[0.8125rem] font-medium ${EASE} ${FOCUS} ${
                  filter === f
                    ? "bg-surface-highlight text-content"
                    : "text-content-muted hover:text-content"
                }`}
              >
                {t(`history.filter.${f}`)}
              </button>
            ))}
          </div>

          <ScrollArea fade className="mt-3">
            {pending.length > 0 && (
              <>
                <DayHead label={t("staging.pending")} />
                {pending.map((tx) => row(tx, `pending-${rowKey(tx)}`))}
              </>
            )}
            {history.isLoading && rows.length === 0 ? (
              <div className="space-y-1">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-17 rounded-2xl bg-surface-card" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <p className="px-5 py-6 text-body text-content-muted">
                {t("history.noTransactions")}
              </p>
            ) : (
              byDay(shown, t).map(([label, txs]) => (
                <div key={label}>
                  <DayHead label={label} />
                  {txs.map((tx) => row(tx, rowKey(tx)))}
                </div>
              ))
            )}
            {history.hasMore && !history.isLoading && (
              <div className="flex justify-center py-4">
                <Action onClick={history.loadMore} disabled={history.isFetching}>
                  {t("history.loadMore")}
                </Action>
              </div>
            )}
          </ScrollArea>
        </div>

        <aside className="look-raise flex min-h-0 flex-col overflow-hidden rounded-[22px] bg-surface-card">
          {current || selected ? (
            <TxDetailsPanel
              inline
              hash={current?.hash ?? selected!.hash}
              network={currentNetwork}
              tx={current}
              onClose={closeTx}
            />
          ) : (
            <p className="px-6 py-5.5 text-body text-content-muted">
              {t("history.noTransactions")}
            </p>
          )}
        </aside>
      </div>
    </Screen>
  );
}

const FILTERS = ["all", "sent", "received", "private", "contracts"] as const;
type Filter = (typeof FILTERS)[number];

function kindOf(tx: Transaction, me: string): Filter {
  if (["encrypt", "decrypt", "stealth_send", "claim"].includes(tx.type)) return "private";
  if (tx.type === "contract_call" || tx.type === "contract_deploy") return "contracts";
  if (tx.type === "receive" || (tx.to === me && tx.from !== me)) return "received";
  return "sent";
}

function byDay(txs: Transaction[], t: (k: string) => string): [string, Transaction[]][] {
  const groups = new Map<string, Transaction[]>();
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  for (const tx of txs) {
    const d = new Date(tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp);
    const label = !tx.timestamp
      ? t("history.pending")
      : same(d, today)
        ? t("history.today")
        : same(d, yesterday)
          ? t("history.yesterday")
          : d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
    groups.set(label, [...(groups.get(label) ?? []), tx]);
  }
  return [...groups];
}

function DayHead({ label }: { label: string }) {
  return <div className="tab-caps px-5 pt-4 pb-2 text-content-muted">{label}</div>;
}
