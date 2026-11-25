import React, { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { Screen } from "src/shared/ui/flat";
import { EASE, FOCUS, Num } from "src/shared/ui/look";
import { ChevronLeft } from "src/shared/ui/icons";
import NamedAddress from "src/shared/ui/NamedAddress";
import EncryptedTag from "src/shared/ui/OutlineTag";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { SendIcon } from "src/shared/layout/navIcons";
import PriceChart, { samplePoints } from "src/features/wallet/components/PriceChart";
import TestnetTag from "src/features/transactions/components/OutlineTag";
import { middleOf } from "src/features/transactions/history/callRows";
import { isDead, isPendingState } from "src/features/transactions/history/outcome";
import { isTestnetId } from "src/features/transactions/history/sides";
import { txView } from "src/features/transactions/history/txView";
import { useBalance } from "src/hooks/wallet/useBalance";
import { peekTokenList, useTokens } from "src/hooks/wallet/useTokens";
import { useTokenPrice, type PricePoint } from "src/hooks/wallet/useTokenPrice";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { formatOCT, formatOCTShort, formatTokenAmount } from "src/lib/format";
import { NETWORKS } from "src/services/network/config";
import type { Transaction } from "src/types/transaction";

const OCT_LOGO = "https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/logos/Octra/Oct_Public.svg";
const OCT_DECIMALS = 6;
const MASK = "••••";
const UNKNOWN = "--";

type RangeKey = "1H" | "1D" | "1W" | "1M" | "1Y";
const RANGES: RangeKey[] = ["1H", "1D", "1W", "1M", "1Y"];
const LOCAL_RANGE_POINTS: Record<"1H" | "1D", number> = { "1H": 120, "1D": 2880 };
const RANGE_API: Record<RangeKey, string> = {
  "1H": "1h",
  "1D": "1d",
  "1W": "7d",
  "1M": "30d",
  "1Y": "1y",
};
const isLocalRange = (r: RangeKey): r is "1H" | "1D" => r === "1H" || r === "1D";

const OCT_MOVES: Transaction["type"][] = [
  "send",
  "receive",
  "encrypt",
  "decrypt",
  "stealth_send",
  "claim",
];
const SHORT_TITLE: Partial<Record<Transaction["type"], string>> = {
  encrypt: "history.encrypted",
  decrypt: "history.decrypted",
  claim: "history.claimed",
};
const MOVE_NOTE: Partial<Record<Transaction["type"], string>> = {
  encrypt: "token.publicToEncrypted",
  decrypt: "token.encryptedToPublic",
  claim: "token.privateTransfer",
  stealth_send: "token.privateTransfer",
};

const STALE = "transition-opacity duration-200 ease-out motion-reduce:transition-none";
const LIST_FADE: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, black calc(100% - 36px), transparent)",
};

export const formatPrice = (value: number) => `$${value.toFixed(6)}`;

const formatUsd = (n: number) =>
  n === 0
    ? "$0"
    : n < 0.01
      ? "< $0.01"
      : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const toMs = (ts: number) => (ts > 0 && ts < 1e12 ? ts * 1000 : ts);

function whenShort(timestamp: number, lang: string, yesterday: string): string {
  const ms = toMs(timestamp);
  if (!ms) return "";
  const diff = Math.max(0, Date.now() - ms);
  const rel = new Intl.RelativeTimeFormat(lang, { style: "narrow" });
  if (diff < 60_000) return rel.format(-Math.floor(diff / 1000), "second");
  if (diff < 3_600_000) return rel.format(-Math.floor(diff / 60_000), "minute");
  if (diff < 86_400_000) return rel.format(-Math.floor(diff / 3_600_000), "hour");
  const day = new Date(ms);
  if (new Date(Date.now() - 86_400_000).toDateString() === day.toDateString()) return yesterday;
  return day.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

const fit = (chars: number, base: string, reserve = "0px"): React.CSSProperties => ({
  fontSize: `min(${base}, calc((100cqw - ${reserve}) / ${(Math.max(1, chars) * 0.6).toFixed(2)}))`,
});

function Sk({ className, raised }: { className: string; raised?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="skeleton"
      className={`block shrink-0 rounded-[7px] ${raised ? "bg-(--bg-3)" : "bg-surface-highlight"} ${className}`}
    />
  );
}

function TokenMark({
  symbol,
  logoURI,
  className,
}: {
  symbol: string;
  logoURI?: string;
  className: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = !!logoURI && failed !== logoURI;
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full ${show ? "" : "bg-surface-card"} ${className}`}
    >
      {show ? (
        <img
          src={logoURI}
          crossOrigin="anonymous"
          alt=""
          className={`size-full object-cover ${logoURI === OCT_LOGO ? "look-logo" : ""}`}
          onError={() => setFailed(logoURI)}
        />
      ) : (
        <span className="text-[0.75em] font-semibold text-content-secondary">
          {symbol.slice(0, 2)}
        </span>
      )}
    </span>
  );
}

function Pill({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-10 flex-1 cursor-pointer items-center justify-center rounded-full bg-surface-highlight px-1.5 text-[0.84375rem] font-medium whitespace-nowrap text-content hover:bg-(--bg-3) ${EASE} ${FOCUS}`}
    >
      {children}
    </button>
  );
}

interface ActivityView {
  tx: Transaction;
  title: string;
  state: "failed" | "pending" | null;
  when: string;
  sign: string;
  amount: string | null;
  amountShort: string;
  unit: string;
  party: string | null;
  note: string | null;
}

function ActivityRow({
  view,
  network,
  wide,
  masked,
  onOpen,
}: {
  view: ActivityView;
  network: string;
  wide: boolean;
  masked: boolean;
  onOpen: (tx: Transaction) => void;
}) {
  const { t } = useTranslation();
  const testnet = isTestnetId(network);
  const state = view.state && (
    <span
      className={`shrink-0 text-meta font-normal ${view.state === "failed" ? "text-danger" : "text-content-muted"}`}
    >
      {t(view.state === "failed" ? "history.failed" : "history.pending")}
    </span>
  );
  const amount = view.amount != null && (
    <span
      data-testid="activity-amount"
      className={`shrink-0 whitespace-nowrap tabular-nums ${masked ? "text-content-muted" : view.sign === "+" ? "text-positive" : "text-content"}`}
    >
      {masked ? (
        MASK
      ) : (
        <>
          {view.sign}
          <Num value={wide ? view.amount : view.amountShort} /> {view.unit}
        </>
      )}
    </span>
  );
  const other = view.party ? (
    <NamedAddress address={view.party} networkId={network} className="text-meta text-content-muted">
      <span className="font-mono text-[0.92em]">
        {!wide && testnet ? middleOf(view.party, 6, 4) : middleOf(view.party, 8, 6)}
      </span>
    </NamedAddress>
  ) : (
    <span className="truncate text-meta text-content-muted">{view.note ? t(view.note) : ""}</span>
  );

  if (wide)
    return (
      <button
        type="button"
        data-testid="activity-row"
        onClick={() => onOpen(view.tx)}
        className={`grid min-h-13 w-full shrink-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-0.75 rounded-[14px] px-3.5 py-2 text-left [grid-template-areas:'title_amount'_'other_other'_'meta_meta'] hover:bg-surface-card @2xl:grid-cols-[auto_minmax(0,1fr)_auto] @2xl:[grid-template-areas:'mark_title_amount'_'mark_other_meta'] ${EASE} ${FOCUS}`}
      >
        <span className="hidden [grid-area:mark] @2xl:block">
          <WalletAvatar address={view.party ?? undefined} size={28} />
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[0.90625rem] font-medium text-content [grid-area:title]">
          <span className="whitespace-nowrap">{view.title}</span>
          {state}
        </span>
        <span className="justify-self-end text-[0.90625rem] font-medium [grid-area:amount]">
          {amount}
        </span>
        <span className="flex h-4.5 min-w-0 items-center [grid-area:other]">{other}</span>
        <span className="flex h-4.5 items-center gap-1.75 text-meta whitespace-nowrap text-content-muted [grid-area:meta] @2xl:justify-self-end">
          {view.when}
          {testnet && <TestnetTag label={t("history.testnet")} />}
        </span>
      </button>
    );

  return (
    <button
      type="button"
      data-testid="activity-row"
      onClick={() => onOpen(view.tx)}
      className={`flex h-13 w-full shrink-0 cursor-pointer flex-col justify-center gap-1 rounded-xl px-3 text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
    >
      <span className="flex items-baseline justify-between gap-2.5 text-body font-medium text-content">
        <span className="flex h-5 min-w-0 flex-wrap items-baseline gap-x-2 overflow-hidden">
          <span className="whitespace-nowrap">{view.title}</span>
          {state}
          <span className="text-meta font-normal whitespace-nowrap text-content-muted">
            {view.when}
          </span>
        </span>
        {amount}
      </span>
      <span className="flex h-4.5 min-w-0 items-center justify-between gap-2">
        {other}
        {testnet && <TestnetTag label={t("history.testnet")} />}
      </span>
    </button>
  );
}

function ActivitySkeleton({ wide }: { wide: boolean }) {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={`flex h-13 shrink-0 flex-col justify-center gap-2.25 ${wide ? "px-3.5" : "px-3"}`}
        >
          <div className="flex justify-between">
            <Sk className="h-3.25 w-27.5" />
            <Sk className="h-3.25 w-17.5" />
          </div>
          <Sk className="h-2.75 w-42.5" />
        </div>
      ))}
    </>
  );
}

function CopyWord({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className={`grid h-6 shrink-0 cursor-pointer place-items-center rounded-full bg-surface-highlight px-2.5 text-meta font-medium text-content hover:bg-(--bg-3) ${EASE} ${FOCUS}`}
    >
      <span aria-hidden={copied} className={`col-start-1 row-start-1 ${copied ? "invisible" : ""}`}>
        {t("history.copy")}
      </span>
      <span
        aria-hidden={!copied}
        className={`col-start-1 row-start-1 ${copied ? "" : "invisible"}`}
      >
        {t("history.copied")}
      </span>
    </button>
  );
}

export default function TokenDetailScreen() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const contract = params.get("contract") || null;
  const native = !contract;
  const encryptedFirst = native && params.get("private") === "1";

  const { activeWallet, networkId, showBalanceValues } = useWallet();
  const address = activeWallet?.address ?? "";
  const canSign = !!activeWallet && activeWallet.wallet_type !== "watch";
  const privacy = native && (NETWORKS[networkId]?.supportsPrivacy ?? false);
  const testnet = isTestnetId(networkId);
  const masked = showBalanceValues === false;

  const balance = useBalance();
  const tokens = useTokens();
  const price = useTokenPrice({ history: true });
  const history = useTransactionHistory();

  const held = contract ? tokens.tokens.find((tok) => tok.contractAddress === contract) : undefined;
  const listed = contract ? peekTokenList()?.find((e) => e.address === contract) : undefined;
  const symbol = native ? "OCT" : (held?.symbol ?? listed?.symbol ?? params.get("symbol") ?? "");
  const name = native ? "Octra" : (held?.name ?? listed?.name ?? symbol);
  const decimals = native ? OCT_DECIMALS : (held?.decimals ?? listed?.decimals ?? null);
  const logoURI = native
    ? OCT_LOGO
    : (held?.logoURI ?? listed?.logoURI ?? params.get("logo") ?? undefined);

  const octPrice = native ? price.getPrice("OCT") || 0 : 0;
  const priced = octPrice > 0;
  const priceLoading = native && !priced && !price.checked;
  const charted = priced || priceLoading;

  const [range, setRange] = useState<RangeKey>("1D");
  const [keptPoints, setKeptPoints] = useState<PricePoint[]>([]);
  const [scrubbed, setScrubbed] = useState<PricePoint | null>(null);

  const remote = useQuery({
    queryKey: ["priceRange", "OCT", range],
    queryFn: async () => {
      const data = await price.fetchHistoryRange(RANGE_API[range]);
      if (data.length < 2) throw new Error("no price history");
      return data;
    },
    enabled: priced && !isLocalRange(range),
    staleTime: 60_000,
  });

  const freshPoints = useMemo(
    () =>
      isLocalRange(range)
        ? samplePoints(price.priceHistory.slice(-LOCAL_RANGE_POINTS[range]))
        : remote.data
          ? samplePoints(remote.data)
          : null,
    [range, price.priceHistory, remote.data],
  );
  const rangePending = !isLocalRange(range) && !remote.data && !remote.isError;
  const rangeFailed = !isLocalRange(range) && !remote.data && remote.isError;
  const points = freshPoints ?? (rangePending ? keptPoints : []);
  const scrub = scrubbed && points.includes(scrubbed) ? scrubbed : null;

  const pickRange = (next: RangeKey) => {
    setKeptPoints(points);
    setScrubbed(null);
    setRange(next);
  };

  const first = points[0]?.value ?? 0;
  const shownPrice = scrub?.value ?? octPrice;
  const delta =
    points.length >= 2 && first > 0
      ? (((scrub?.value ?? points[points.length - 1].value) - first) / first) * 100
      : null;
  const up = delta == null || delta >= 0;
  const changeText = delta == null ? "" : `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(1)}%`;

  const publicKnown = !balance.isLoading && !(balance.failed && !balance.updatedAt);
  const privatePending =
    privacy &&
    canSign &&
    balance.privateBalance == null &&
    (balance.isPvacLoading || !!balance.isPrivateLoading);
  const tokenKnown = !tokens.isLoading && !(tokens.failed && !tokens.updatedAt);
  const totalKnown = native ? publicKnown && !privatePending : tokenKnown;
  const totalMicro = balance.publicBalance + (privacy ? (balance.privateBalance ?? 0) : 0);
  const totalText = native
    ? formatOCT(totalMicro)
    : formatTokenAmount(held?.balance ?? "0", decimals ?? 0);
  const usdOf = (micro: number) => formatUsd((micro / 1_000_000) * octPrice);

  const balanceFailed = native ? !!balance.failed : !!tokens.failed;
  const priceFailed = native && !!price.failed;
  const stale = useMemo(() => {
    const failed = [
      balanceFailed ? (native ? balance.updatedAt : tokens.updatedAt) : undefined,
      priceFailed ? price.updatedAt : undefined,
      history.failed ? history.updatedAt : undefined,
    ].filter((at) => at !== undefined);
    if (!failed.length) return null;
    const known = failed.filter((at): at is number => typeof at === "number" && at > 0);
    return { at: known.length === failed.length ? Math.min(...known) : null };
  }, [
    balanceFailed,
    priceFailed,
    native,
    balance.updatedAt,
    tokens.updatedAt,
    price.updatedAt,
    history.failed,
    history.updatedAt,
  ]);
  const dimBalance = balanceFailed ? "opacity-40" : "";
  const dimPrice = priceFailed ? "opacity-40" : "";

  const refresh = useCallback(() => {
    balance.refetch();
    tokens.refetch();
    void history.refetch();
    void price.refresh();
    if (remote.isError) void remote.refetch();
  }, [balance, tokens, history, price, remote]);

  const activity = useMemo((): ActivityView[] => {
    const mine = history.transactions.filter((tx) =>
      contract
        ? tx.token_transfer?.contract_address === contract
        : !tx.token_transfer && OCT_MOVES.includes(tx.type),
    );
    return [...mine]
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp))
      .map((tx) => {
        const view = txView(tx, { me: address, network: tx.network ?? networkId }, t);
        const within = tx.type === "encrypt" || tx.type === "decrypt";
        const noteKey = MOVE_NOTE[tx.type];
        const titleKey = SHORT_TITLE[tx.type];
        return {
          tx,
          title: titleKey ? t(titleKey) : view.title,
          state: isDead(view.state) ? "failed" : isPendingState(view.state) ? "pending" : null,
          when: whenShort(tx.timestamp, i18n.language, t("history.yesterday")),
          sign: within ? "" : view.sign === "-" ? "−" : view.sign,
          amount: view.amount,
          amountShort: tx.token_transfer ? (view.amount ?? "") : formatOCTShort(tx.amount),
          unit: contract ? symbol || view.unit : view.unit,
          party: noteKey ? null : view.counterparty,
          note: noteKey ?? null,
        };
      });
  }, [history.transactions, contract, address, networkId, symbol, t, i18n.language]);

  const openTx = useCallback(
    (tx: Transaction) => navigate(`/history?hash=${tx.hash}&net=${tx.network ?? networkId}`),
    [navigate, networkId],
  );

  const send = () => {
    if (contract) {
      navigate("/send", {
        state: {
          token: held ?? {
            contractAddress: contract,
            symbol,
            name,
            decimals: decimals ?? 0,
            balance: "0",
          },
        },
      });
    } else if (encryptedFirst && privacy) {
      navigate("/send", { state: { mode: "private" } });
    } else {
      navigate("/send");
    }
  };

  const activityHead = (
    <div className="flex min-h-6 shrink-0 items-center justify-between">
      <span className="tab-caps text-content-muted">{t("token.activity")}</span>
      <button
        type="button"
        onClick={() => navigate("/history")}
        className={`cursor-pointer text-[0.8125rem] font-medium text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
      >
        {t("token.seeAll")}
      </button>
    </div>
  );
  const activityList = (wide: boolean) => (
    <div
      data-testid="token-activity"
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide ${wide ? "-mx-3.5 mt-1.5" : "-mx-3 mt-1"} pb-6`}
      style={LIST_FADE}
    >
      {history.isLoading ? (
        <ActivitySkeleton wide={wide} />
      ) : activity.length === 0 ? (
        <p className={`py-3 text-meta text-content-muted ${wide ? "px-3.5" : "px-3"}`}>
          {t("token.noActivity")}
        </p>
      ) : (
        activity.map((view) => (
          <ActivityRow
            key={`${view.tx.network ?? networkId}:${view.tx.hash}`}
            view={view}
            network={view.tx.network ?? networkId}
            wide={wide}
            masked={masked}
            onOpen={openTx}
          />
        ))
      )}
    </div>
  );

  const holdingRow = (encrypted: boolean) => {
    const micro = encrypted ? balance.privateBalance : balance.publicBalance;
    const known = encrypted ? micro != null : publicKnown;
    const pending = encrypted ? privatePending : !publicKnown;
    const on = encrypted === encryptedFirst;
    const text = formatOCT(micro ?? 0);
    return (
      <div
        data-testid={encrypted ? "row-encrypted" : "row-public"}
        aria-current={on ? "true" : undefined}
        className={`-mx-3.5 grid h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[14px] px-3.5 @4xl:h-13 ${on ? "bg-surface-highlight" : ""}`}
      >
        <TokenMark symbol="OCT" logoURI={OCT_LOGO} className="size-5.5 text-[0.5rem]" />
        <span
          className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.90625rem] whitespace-nowrap text-content ${on ? "font-semibold" : "font-medium"}`}
        >
          OCT
          {encrypted && <EncryptedTag label={t("history.encrypted")} />}
        </span>
        <span className="flex flex-col items-end gap-0.75 text-right font-medium whitespace-nowrap">
          {masked ? (
            <span className="text-[0.90625rem] text-content-muted">{MASK}</span>
          ) : pending ? (
            <>
              <Sk raised={on} className="h-3.25 w-21" />
              {priced && <Sk raised={on} className="mt-0.75 h-2.75 w-15" />}
            </>
          ) : !known ? (
            <span className="text-[0.90625rem] text-content-muted">{UNKNOWN}</span>
          ) : (
            <>
              <span
                className={`${STALE} ${dimBalance} text-content`}
                style={fit(text.length, "0.90625rem", "5.5rem")}
              >
                <Num value={text} />
              </span>
              {priced && (
                <span className={`text-meta font-normal text-content-muted ${STALE} ${dimBalance}`}>
                  {usdOf(micro ?? 0)}
                </span>
              )}
            </>
          )}
        </span>
      </div>
    );
  };

  const facts = (
    <>
      {contract && (
        <div className="flex min-h-7.5 flex-wrap items-center justify-between gap-x-3.5 gap-y-1 text-[0.8125rem] whitespace-nowrap text-content-muted">
          <span>{t("txDetail.contract")}</span>
          <span className="ml-auto inline-flex items-center gap-2.5 text-content-secondary">
            <span className="font-mono text-[0.92em]" title={contract} data-testid="token-contract">
              {middleOf(contract, 8, 6)}
            </span>
            <CopyWord text={contract} />
          </span>
        </div>
      )}
      {decimals != null && (
        <div className="flex min-h-7.5 items-center justify-between gap-3.5 text-[0.8125rem] whitespace-nowrap text-content-muted">
          <span>{t("token.decimals")}</span>
          <span className="text-content-secondary tabular-nums">{decimals}</span>
        </div>
      )}
    </>
  );

  const ranges = (
    <div
      role="group"
      className="inline-flex shrink-0 justify-self-start gap-0.5 rounded-xl bg-surface-highlight p-0.75 [grid-area:ranges] @2xl:justify-self-end"
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={range === r}
          onClick={() => pickRange(r)}
          className={`h-6 cursor-pointer rounded-[9px] px-2.25 text-meta font-medium whitespace-nowrap @4xl:h-6.5 @4xl:px-3 @4xl:text-[0.8125rem] ${EASE} ${FOCUS} ${
            range === r
              ? "bg-(--bg-3) text-content in-data-[theme=light]:bg-surface-card"
              : "text-content-muted hover:text-content"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  const title = (
    <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [grid-area:title]">
      <TokenMark symbol={symbol} logoURI={logoURI} className="size-9 text-[1rem]" />
      <h1 className="min-w-0 text-[1.375rem] leading-tight font-semibold tracking-[-0.02em] wrap-anywhere text-content @4xl:text-[1.625rem]">
        {name}
      </h1>
      {symbol && symbol !== name && (
        <span className="mb-0.5 shrink-0 self-end text-body whitespace-nowrap text-content-muted">
          {symbol}
        </span>
      )}
      {testnet && <TestnetTag label={t("history.testnet")} />}
    </div>
  );

  return (
    <Screen
      onRefresh={refresh}
      refreshing={balance.isRefetching || history.isRefetching}
      stale={stale}
      lead={
        <button
          type="button"
          onClick={() => navigate("/")}
          className={`-ml-2 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full pr-3 pl-2 text-[0.84375rem] text-content-secondary hover:bg-surface-card hover:text-content ${EASE} ${FOCUS}`}
        >
          <ChevronLeft size={13} aria-hidden="true" />
          {t("nav.home")}
        </button>
      }
    >
      <div className="mt-1 flex min-h-0 flex-1 gap-5 @4xl:gap-7">
        <div className="flex min-w-0 flex-1 flex-col">
          {charted ? (
            <>
              <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 [grid-template-areas:'title_title'_'price_price'_'change_change'_'ranges_ranges'] @2xl:[grid-template-areas:'title_title'_'price_price'_'change_ranges'] @4xl:[grid-template-areas:'title_ranges'_'price_price'_'change_change']">
                {title}
                <div className="mt-3.5 [grid-area:price] @4xl:mt-5.5">
                  <div className="tab-caps text-content-muted">{t("token.price")}</div>
                  <div className="look-figure mt-2.5 flex h-10 items-center text-[2.5rem] whitespace-nowrap text-content @4xl:h-13.5 @4xl:text-[3.375rem]">
                    {priced ? (
                      <span data-testid="token-price" className={`${STALE} ${dimPrice}`}>
                        {formatPrice(shownPrice)}
                      </span>
                    ) : (
                      <Sk className="h-[0.74em] w-[4.6em]" />
                    )}
                  </div>
                </div>
                <div
                  data-testid="token-change"
                  className="mt-1.5 flex h-7.5 items-center gap-3 text-[0.84375rem] whitespace-nowrap tabular-nums [grid-area:change] @4xl:mt-2.5 @4xl:h-4.5"
                >
                  {!priced ? (
                    <Sk className="h-3 w-32.5" />
                  ) : delta == null ? null : (
                    <span className={`inline-flex items-center gap-3 ${STALE} ${dimPrice}`}>
                      <span className={up ? "text-positive" : "text-danger"}>
                        {scrub ? changeText : t(`token.change.${range}`, { change: changeText })}
                      </span>
                      {scrub && (
                        <span className="text-content-muted">
                          {new Date(toMs(scrub.time)).toLocaleString(i18n.language, {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {ranges}
              </div>
              <div className="relative mt-3.5 min-h-40 flex-1">
                {points.length >= 2 ? (
                  <div
                    className={`absolute inset-0 ${STALE} ${rangePending || priceFailed ? "opacity-40" : ""}`}
                  >
                    <PriceChart
                      points={points}
                      color={up ? "var(--pos)" : "var(--neg)"}
                      label={t("token.chartLabel", { symbol })}
                      format={formatPrice}
                      onScrub={setScrubbed}
                    />
                  </div>
                ) : rangeFailed || (priced && price.checked && !rangePending) ? (
                  <div className="absolute inset-0 grid place-items-center text-meta text-content-muted">
                    {t(rangeFailed ? "token.priceUnavailable" : "token.noPriceData")}
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center">
                    <span
                      aria-hidden="true"
                      data-testid="chart-skeleton"
                      className="block h-[82%] w-full rounded-2xl bg-surface-card"
                    />
                  </div>
                )}
              </div>
              <div className="flex h-7.5 shrink-0 items-center gap-2.5 text-[0.8125rem] whitespace-nowrap text-content-muted">
                <span>{t("token.decimals")}</span>
                <span className="text-content-secondary tabular-nums">{decimals}</span>
              </div>
            </>
          ) : (
            <>
              {title}
              <div className="mt-6 flex min-h-0 flex-1 flex-col">
                {activityHead}
                {activityList(true)}
              </div>
            </>
          )}
        </div>

        <aside
          data-testid="holdings-panel"
          className="look-raise @container flex w-64 shrink-0 flex-col overflow-hidden rounded-[22px] bg-surface-card px-4.5 pt-4.5 @4xl:w-80 @4xl:px-5.5 @4xl:pt-5.5"
        >
          <div className="tab-caps text-content-muted">{t("token.balance")}</div>
          <div
            data-testid="token-total"
            className="look-figure mt-3 flex h-7 shrink-0 items-center whitespace-nowrap text-content [--figure:1.75rem] @4xl:h-9 @4xl:[--figure:2.25rem]"
          >
            {masked ? (
              <span className="text-[1.25rem] tracking-[0.12em] text-content-muted">{MASK}</span>
            ) : totalKnown ? (
              <span
                className={`${STALE} ${dimBalance}`}
                style={fit(totalText.length + symbol.length * 0.34 + 0.5, "var(--figure)")}
              >
                <Num value={totalText} />
                <span className="ml-[0.5em] text-[0.34em] font-normal tracking-normal text-content-muted">
                  {symbol}
                </span>
              </span>
            ) : (
              <Sk className="h-6.5 w-42.5" />
            )}
          </div>
          <div className="mt-2.5 flex h-4.5 shrink-0 items-center text-[0.84375rem] whitespace-nowrap text-content-secondary tabular-nums">
            {!priced ? (
              priceLoading ? (
                <Sk className="h-3 w-20" />
              ) : (
                <span className="text-content-muted">{t("token.noPrice")}</span>
              )
            ) : masked ? (
              <span className="text-content-muted">{MASK}</span>
            ) : totalKnown ? (
              <span className={`${STALE} ${dimBalance}`}>{usdOf(totalMicro)}</span>
            ) : (
              <Sk className="h-3 w-20" />
            )}
          </div>

          {native && (
            <div className="mt-2 shrink-0 @4xl:mt-3">
              {holdingRow(false)}
              {privacy && holdingRow(true)}
            </div>
          )}

          <div className="mt-3 shrink-0 @4xl:mt-4.5">
            {canSign && (
              <button
                type="button"
                onClick={send}
                className={`look-key inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2.25 rounded-full text-meta font-semibold tracking-[0.14em] whitespace-nowrap uppercase transition-[opacity,transform] duration-250 ease-out hover:opacity-90 active:scale-[0.98] motion-reduce:transition-none ${FOCUS}`}
              >
                <SendIcon size={15} />
                {t("nav.send")}
              </button>
            )}
            <div className={`flex flex-wrap gap-2 ${canSign ? "mt-2" : ""}`}>
              <Pill onClick={() => navigate("/receive")}>{t("nav.receive")}</Pill>
              {privacy && canSign && (
                <>
                  <Pill onClick={() => navigate("/privacy?tab=encrypt")}>
                    {t("privacy.encrypt")}
                  </Pill>
                  <Pill onClick={() => navigate("/privacy?tab=decrypt")}>
                    {t("privacy.decrypt")}
                  </Pill>
                </>
              )}
            </div>
          </div>

          {charted ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col @4xl:mt-5.5">
              {activityHead}
              {activityList(false)}
            </div>
          ) : (
            <>
              <div className="mt-5.5 shrink-0">{facts}</div>
              <span className="flex-1" />
              {held?.source === "imported" && (
                <div className="flex min-h-7.5 shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => {
                      tokens.removeImportedToken(contract!);
                      navigate("/");
                    }}
                    className={`cursor-pointer text-[0.8125rem] font-medium text-content-muted hover:text-content ${EASE} ${FOCUS}`}
                  >
                    {t("token.remove")}
                  </button>
                </div>
              )}
              <span className="h-3.5 shrink-0" />
            </>
          )}
        </aside>
      </div>
    </Screen>
  );
}
