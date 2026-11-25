import NamedAddress from "src/shared/ui/NamedAddress";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { useQuery } from "src/lib/query";
import ImportTokenModal from "src/features/wallet/components/ImportTokenModal";
import HomeTxSheet, { type HomeTxView } from "src/features/wallet/components/HomeTxSheet";
import { useWallet } from "src/contexts/useWallet";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useTokens } from "src/hooks/wallet/useTokens";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { pvacSetupQuery } from "src/hooks/privacy/usePvacSetup";
import {
  formatOCT,
  formatOCTShort,
  formatMethodName,
  truncateAddress,
  timeAgo,
} from "src/lib/format";
import { NETWORKS } from "src/services/network/config";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { useClaimableCount } from "src/hooks/privacy/useClaimableCount";
import type { DiscoveredTokenInfo } from "src/hooks/wallet/useTokens";
import type { Transaction } from "src/types/transaction";
import { getSnapshots } from "src/services/storage/balanceHistory";
import { loadBlockedAck } from "src/features/privacy/services/keySwitchService";
import KeyBlockedTag from "src/features/privacy/components/KeyBlockedTag";
import SetupPrivateTag from "src/features/privacy/components/SetupPrivateTag";
import TopBar from "src/shared/layout/TopBar";
import { HistoryIcon, PrivacyIcon, ReceiveIcon, SendIcon } from "src/shared/layout/navIcons";
import { useTranslation } from "src/i18n/react";
import HomeTag from "src/shared/ui/HomeTag";
import { BACKUP_ROUTE, useNeedsBackup } from "src/hooks/wallet/useNeedsBackup";
import OutlineTag from "src/shared/ui/OutlineTag";
import { FOCUS } from "src/shared/ui/look";
import Mascot from "src/shared/ui/Mascot";
import { logger } from "src/lib/logger";
import "src/css/look-ext.css";

function formatTokenBalance(balance: string, decimals: number): string {
  if (!balance || balance === "0") return "0";
  const num = parseInt(balance);
  if (isNaN(num)) return balance;
  if (decimals === 0) return num.toLocaleString();
  const divisor = Math.pow(10, decimals);
  const val = num / divisor;
  return val % 1 === 0 ? val.toLocaleString() : val.toFixed(Math.min(decimals, 6));
}

const fmtUsd = (n: number) =>
  n > 0 && n < 0.01
    ? "< $0.01"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const OCT_LOGO = "https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/logos/Octra/Oct_Public.svg";
const MASK = "••••••";
const ROW_MASK = "••••";
const UNKNOWN = "--";
const LIST_FADE: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, black calc(100% - 24px), transparent)",
};
// The left fade runs longer so the line rises out from behind the figure instead of crossing
// its labels.
// fade runs longer so the line rises out from behind the figure instead of crossing its labels.
const SIDE_FADE: React.CSSProperties = {
  maskImage:
    "linear-gradient(to right, transparent, rgba(0,0,0,0.18) 14%, black 36%, black 88%, transparent)",
};
const CHART_W = 1000;
const CHART_H = 100;

function TokenIcon({
  logoURI,
  symbol,
  mono = false,
}: {
  logoURI?: string;
  symbol: string;
  mono?: boolean;
}) {
  const [fail, setFail] = React.useState(false);
  const showLogo = !!logoURI && !fail;
  return (
    <div className="w-9 h-9 rounded-full grid place-items-center shrink-0 overflow-hidden bg-surface-card">
      {showLogo ? (
        <img
          src={logoURI}
          crossOrigin="anonymous"
          className={`w-full h-full object-cover ${mono ? "look-logo" : ""}`}
          alt=""
          onError={() => setFail(true)}
        />
      ) : (
        <span className="text-micro font-bold uppercase text-content">{symbol.slice(0, 3)}</span>
      )}
    </div>
  );
}

function Figure({ text, unknown }: { text: string; unknown: boolean }) {
  if (text === MASK)
    return (
      <span className="look-figure text-[clamp(40px,min(5.4cqw,8.2vh),72px)] text-content-muted">
        <span className="text-[0.5em] tracking-[0.12em] align-middle">{MASK}</span>
      </span>
    );
  const sign = text.startsWith("$") ? "$" : "";
  const num = sign ? text.slice(1) : text;
  const dot = /^[\d,]+\.\d+$/.test(num) ? num.lastIndexOf(".") : -1;
  return (
    <span
      className={`look-figure text-[clamp(40px,min(5.4cqw,8.2vh),72px)] ${unknown ? "text-content-muted" : "text-content"}`}
    >
      {sign && (
        <span className="text-content-muted text-[0.55em] align-top relative top-[0.12em] mr-[0.06em]">
          {sign}
        </span>
      )}
      {dot > 0 ? (
        <>
          {num.slice(0, dot)}
          <span className="text-content-muted">{num.slice(dot)}</span>
        </>
      ) : (
        num
      )}
    </span>
  );
}

function txLabel(tx: Transaction): string {
  switch (tx.type) {
    case "receive":
      return "Received";
    case "send":
      return "Sent";
    case "encrypt":
      return "Encrypted";
    case "decrypt":
      return "Decrypted";
    case "stealth_send":
      return "Sent privately";
    case "claim":
      return "Claimed";
    case "contract_call":
      return tx.methodName ? formatMethodName(tx.methodName) : "Contract call";
    case "contract_deploy":
      return "Contract deploy";
    case "key_switch":
      return "Key update";
    default:
      return "Transaction";
  }
}

function txView(tx: Transaction): HomeTxView {
  const isPrivate =
    tx.type === "encrypt" ||
    tx.type === "decrypt" ||
    tx.type === "stealth_send" ||
    tx.type === "claim";
  const isIn = tx.type === "receive" || tx.type === "claim";
  // Sign reflects the spendable (public) balance: decrypt moves private to public and credits it.
  const credit = isIn || tx.type === "decrypt";
  const sym = isPrivate ? "pOCT" : tx.token_transfer?.symbol || "OCT";
  const tokenAmount = tx.token_transfer
    ? parseInt(tx.token_transfer.raw_amount) / Math.pow(10, tx.token_transfer.decimals || 6)
    : null;
  const amt = tokenAmount != null ? tokenAmount.toFixed(2) : formatOCTShort(tx.amount);
  // A call that moves nothing (approve, list_nft) has no amount; "-0" is not an amount.
  const moved = tokenAmount != null ? tokenAmount > 0 : tx.amount > 0;
  return {
    tx,
    label: txLabel(tx),
    amount: moved ? `${credit ? "+" : "-"}${amt} ${sym}` : "",
    credit,
  };
}

export default function HomeScreen() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { needsBackup } = useNeedsBackup();
  const {
    activeWallet,
    networkId,
    showBalanceValues,
    toggleBalanceVisibility,
    pvacForeign,
    pvacLegacy,
  } = useWallet();
  const address = activeWallet?.address ?? "";
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const canSign = !!activeWallet && activeWallet.wallet_type !== "watch";
  const { publicBalance, privateBalance, isLoading, refetch, isRefetching, isPvacLoading } =
    useBalance();
  const { tokens, addImportedToken } = useTokens();
  const tokenPrices = useTokenPrice({ history: true });
  const { transactions: recentTxs, isLoading: txLoading } = useTransactionHistory();
  const claimableCount = useClaimableCount();
  const [importOpen, setImportOpen] = useState(false);
  const [openTx, setOpenTx] = useState<HomeTxView | null>(null);
  const [inOct, setInOct] = useState(false);

  // The same setup read the menu bar keeps warm: the node holds this private balance.
  const setup = useQuery({
    ...pvacSetupQuery({ address, id: activeWallet?.id ?? "" }, networkId),
    enabled: !!address && privacyEnabled && canSign,
  });
  const keyBlocked =
    !!address && !pvacForeign && (pvacLegacy || !!loadBlockedAck(networkId, address));
  const privateHold = !keyBlocked && !pvacForeign && !!setup.data?.held && !setup.data?.canMigrate;

  const octPrice = tokenPrices.getPrice("OCT") || 0;
  const showFiat = octPrice > 0 && !inOct;
  const totalMicro = publicBalance + (privateBalance ?? 0);
  const privatePending = privacyEnabled && canSign && privateBalance == null && isPvacLoading;

  const tokenRows = useMemo(
    () =>
      tokens.map((token) => {
        const bal = formatTokenBalance(token.balance, token.decimals);
        const price = tokenPrices.prices[token.symbol.toUpperCase()] || 0;
        const amount = parseFloat(bal.replace(/,/g, "")) || 0;
        return { token, bal, usd: price > 0 ? amount * price : null };
      }),
    [tokens, tokenPrices.prices],
  );
  const octUsd = (micro: number) =>
    octPrice > 0 ? fmtUsd((micro / 1_000_000) * octPrice) : UNKNOWN;
  const tokensUsd = tokenRows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  const totalUsd = (totalMicro / 1_000_000) * octPrice + tokensUsd;

  const handleTokenDetail = useCallback(
    (token: DiscoveredTokenInfo) => {
      logger.debug(
        "home",
        `open token detail - ${token.symbol} ${token.contractAddress.slice(0, 12)}...`,
      );
      const params = new URLSearchParams({
        symbol: token.symbol,
        contract: token.contractAddress,
        ...(token.logoURI ? { logo: token.logoURI } : {}),
      });
      navigate(`/token?${params.toString()}`);
    },
    [navigate],
  );

  const chartRef = useRef<HTMLDivElement>(null);
  const [hoverData, setHoverData] = useState<{ ratio: number; value: string; time: string } | null>(
    null,
  );

  const balSnapshots = useMemo(
    () => (address ? getSnapshots(address, networkId, 24) : []),
    // re-read snapshots whenever balance updates (appendSnapshot runs just before)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, networkId, publicBalance, privateBalance],
  );

  const historyPoints = useMemo(() => {
    const now = Date.now();
    const cutoffTime = now - 24 * 60 * 60 * 1000;
    const currentBal = (publicBalance + (privateBalance ?? 0)) / 1_000_000;
    // Tokens with a price ride on top at today's value, so the line ends where the figure reads.
    const extra = octPrice > 0 ? tokensUsd : 0;

    // This wallet's balance snapshots as a step function: the balance holds until the next one.
    const balPts = balSnapshots
      .map((s) => ({ time: s.time * 1000, bal: s.bal }))
      .sort((a, b) => a.time - b.time);
    const balanceAt = (t: number): number => {
      if (balPts.length === 0) return currentBal;
      let b = balPts[0].bal;
      for (const p of balPts) {
        if (p.time <= t) b = p.bal;
        else break;
      }
      return b;
    };

    const fullCurve = (tokenPrices.priceHistory || [])
      .map((p) => ({ time: p.time > 1e12 ? p.time : p.time * 1000, value: p.value }))
      .filter((p) => p.time >= cutoffTime && p.value > 0)
      .sort((a, b) => a.time - b.time);
    // The oracle returns a point every 30s; ~240 are plenty for a line this size.
    const stride = Math.max(1, Math.ceil(fullCurve.length / 240));
    const priceCurve =
      stride === 1
        ? fullCurve
        : fullCurve.filter((_, i) => i % stride === 0 || i === fullCurve.length - 1);

    if (octPrice > 0 && priceCurve.length >= 2) {
      const pts = priceCurve.map((p) => ({
        time: p.time,
        val: balanceAt(p.time) * p.value + extra,
      }));
      if (pts[0].time > cutoffTime) {
        pts.unshift({
          time: cutoffTime,
          val: balanceAt(cutoffTime) * priceCurve[0].value + extra,
        });
      }
      pts.push({ time: now, val: currentBal * octPrice + extra });
      return pts;
    }

    const valueOf = (b: number) => (octPrice > 0 ? b * octPrice + extra : b);
    if (balPts.length >= 1) {
      const pts = balPts.map((s) => ({ time: s.time, val: valueOf(s.bal) }));
      if (pts[0].time > cutoffTime) pts.unshift({ time: cutoffTime, val: pts[0].val });
      pts.push({ time: now, val: valueOf(currentBal) });
      return pts;
    }
    const worth = valueOf(currentBal);
    return [
      { time: cutoffTime, val: worth },
      { time: now, val: worth },
    ];
  }, [publicBalance, privateBalance, balSnapshots, octPrice, tokensUsd, tokenPrices.priceHistory]);

  // The change in what the wallet holds: nothing held, nothing moved, whatever the price did.
  const { percent, up } = useMemo(() => {
    if (!(totalMicro > 0)) return { percent: "0.0", up: true };
    const change = tokenPrices.prices?.OCT_24H_CHANGE;
    if (change != null) return { percent: Math.abs(change).toFixed(1), up: change >= 0 };
    if (historyPoints.length < 2) return { percent: "0.0", up: true };
    const start = historyPoints[0].val;
    const end = historyPoints[historyPoints.length - 1].val;
    if (start === 0) return { percent: end > 0 ? "100.0" : "0.0", up: true };
    return { percent: Math.abs(((end - start) / start) * 100).toFixed(1), up: end >= start };
  }, [totalMicro, tokenPrices.prices, historyPoints]);
  const flat = percent === "0.0";
  const trendColor = flat ? "var(--fg-3)" : up ? "var(--pos)" : "var(--neg)";

  const pathD = useMemo(() => {
    if (historyPoints.length < 2) return "";
    const vals = historyPoints.map((p) => p.val);
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);
    const minTime = historyPoints[0].time;
    const rangeTime = historyPoints[historyPoints.length - 1].time - minTime || 1;
    // A near-flat day must not stretch into a cliff: a swing under ~4% of the value only fills
    // its share of the band. The band is half the height, low enough to pass under the figure.
    const mid = (minVal + maxVal) / 2;
    const span = Math.max(maxVal - minVal, Math.abs(mid) * 0.04) || 1;
    const lo = mid - span / 2;
    return historyPoints
      .map((p, i) => {
        const x = ((p.time - minTime) / rangeTime) * CHART_W;
        const norm = Math.max(0, Math.min(1, (p.val - lo) / span));
        const y = CHART_H - (norm * 0.5 + 0.06) * CHART_H;
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [historyPoints]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!chartRef.current || historyPoints.length < 2) return;
      const rect = chartRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const minTime = historyPoints[0].time;
      const rangeTime = historyPoints[historyPoints.length - 1].time - minTime || 1;
      const target = minTime + ratio * rangeTime;
      let p0 = historyPoints[0];
      let p1 = historyPoints[historyPoints.length - 1];
      for (let i = 0; i < historyPoints.length - 1; i++) {
        if (historyPoints[i].time <= target && historyPoints[i + 1].time >= target) {
          p0 = historyPoints[i];
          p1 = historyPoints[i + 1];
          break;
        }
      }
      const seg = p1.time === p0.time ? 0 : (target - p0.time) / (p1.time - p0.time);
      const val = p0.val + (p1.val - p0.val) * seg;
      const time =
        new Date(target).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }) + " UTC";
      setHoverData({
        ratio,
        value: octPrice > 0 ? fmtUsd(val) : `${formatOCT(Math.round(val * 1_000_000))} OCT`,
        time,
      });
    },
    [historyPoints, octPrice],
  );

  const figureText = !showBalanceValues
    ? MASK
    : isLoading
      ? UNKNOWN
      : showFiat
        ? fmtUsd(totalUsd)
        : formatOCT(totalMicro);
  const unknown = figureText === UNKNOWN;

  const claims = privacyEnabled ? claimableCount : 0;
  const actions = useMemo(
    () => [
      { id: "receive", key: "r", icon: ReceiveIcon, go: () => navigate("/receive") },
      {
        id: "privacy",
        key: "e",
        icon: PrivacyIcon,
        go: () => navigate(claims > 0 ? "/privacy?tab=claim" : "/privacy"),
        disabled: !privacyEnabled,
      },
      { id: "history", key: "y", icon: HistoryIcon, go: () => navigate("/history") },
    ],
    [navigate, claims, privacyEnabled],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        navigate("/send");
        return;
      }
      const action = actions.find((a) => a.key === k);
      if (!action) return;
      e.preventDefault();
      if (!action.disabled) action.go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, actions]);

  return (
    <div data-look="ext" className="h-full overflow-hidden bg-surface">
      <div className="h-full max-w-310 mx-auto px-7 min-[1600px]:px-11 pb-7 flex flex-col">
        <div className="shrink-0 pt-6.5 pb-3">
          <TopBar onRefresh={() => refetch()} refreshing={isRefetching} />
        </div>

        <div
          ref={chartRef}
          className="shrink-0 relative cursor-crosshair select-none"
          style={{ marginTop: "clamp(8px, 2.4vh, 32px)", height: "clamp(150px, 25vh, 240px)" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverData(null)}
        >
          <div className="absolute inset-0 pointer-events-none" style={SIDE_FADE}>
            {pathD && !unknown && (
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="none"
                className="block w-full h-full"
              >
                <defs>
                  <linearGradient id="homeDayFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={trendColor} stopOpacity="0.12" />
                    <stop offset="100%" stopColor={trendColor} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d={`${pathD} L${CHART_W} ${CHART_H} L0 ${CHART_H} Z`}
                  fill="url(#homeDayFill)"
                />
                <path
                  d={pathD}
                  fill="none"
                  stroke={trendColor}
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
          {hoverData && showBalanceValues && (
            <div
              className="absolute top-0 bottom-0 w-px bg-content opacity-30 pointer-events-none"
              style={{ left: `${hoverData.ratio * 100}%` }}
            />
          )}

          <div className="relative z-10 flex flex-col items-start">
            <div className="flex items-center gap-3 h-6">
              <span className="tab-caps text-content-muted">Total balance</span>
              <button
                type="button"
                onClick={toggleBalanceVisibility}
                aria-pressed={!showBalanceValues}
                className={`tab-caps transition-colors cursor-pointer ${showBalanceValues ? "text-content-muted hover:text-content" : "text-content"}`}
              >
                {showBalanceValues ? "Hide" : "Show"}
              </button>
            </div>
            <div className="mt-3 flex items-baseline gap-3 flex-wrap">
              <Figure text={figureText} unknown={unknown} />
              {!showFiat && showBalanceValues && !unknown && (
                <span className="text-title font-medium text-content-muted">OCT</span>
              )}
              {octPrice > 0 && showBalanceValues && !unknown && (
                <button
                  type="button"
                  onClick={() => setInOct((v) => !v)}
                  title="Switch between USD and OCT"
                  className="ml-1 text-meta font-medium text-content-muted hover:text-content transition-colors cursor-pointer"
                >
                  {showFiat ? "Show OCT" : "Show USD"}
                </button>
              )}
            </div>
            <div className="mt-3 h-5 flex items-center gap-2 tabular-nums">
              {!showBalanceValues ? (
                <span className="text-meta text-content-muted">{ROW_MASK}</span>
              ) : hoverData ? (
                <>
                  <span className="text-meta font-medium text-content">{hoverData.value}</span>
                  <span className="tab-caps text-content-muted">{hoverData.time}</span>
                </>
              ) : unknown ? null : (
                <>
                  <span className="text-meta font-medium" style={{ color: trendColor }}>
                    {flat ? "" : up ? "+" : "-"}
                    {percent}%
                  </span>
                  <span className="tab-caps text-content-muted">24h</span>
                  {privatePending && (
                    <span className="ml-2 text-meta text-content-muted">
                      Decrypting private balance
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Tags, most urgent first (the extension's order): Back up, then one private tag at most. */}
          <div className="absolute top-0 right-0 z-20 max-w-[50%] flex flex-wrap justify-end items-center gap-1.5">
            {needsBackup && (
              <HomeTag tone="neutral" onClick={() => navigate(BACKUP_ROUTE)}>
                {t("home.backUp")}
              </HomeTag>
            )}
            <KeyBlockedTag key={address} />
            {privateHold && (
              <HomeTag
                tone="blue"
                title="The network holds this private balance until its migration opens."
                onClick={() => navigate("/privacy")}
              >
                Private on hold
              </HomeTag>
            )}
            <SetupPrivateTag
              key={`${networkId}:${address}`}
              publicBalance={publicBalance}
              balanceReady={!isLoading}
              pvacReady={!isPvacLoading}
            />
          </div>
        </div>

        <div
          className="shrink-0 flex h-12 items-center gap-3.5 max-[1099px]:gap-2.5"
          style={{ marginTop: "clamp(4px, 1.2vh, 16px)" }}
        >
          <button
            type="button"
            onClick={() => navigate("/send")}
            className={`look-key group h-12 w-50 max-[1099px]:w-39 rounded-full inline-flex items-center justify-center gap-2.25 text-meta font-semibold uppercase tracking-[0.14em] hover:opacity-90 active:scale-[0.98] transition-[opacity,transform] duration-250 ease-out motion-reduce:transition-none cursor-pointer ${FOCUS}`}
          >
            <SendIcon size={15} />
            {t("nav.send")}
            <span
              aria-hidden="true"
              className="w-5.5 font-mono text-micro normal-case tracking-normal opacity-0 group-hover:opacity-55 group-focus-visible:opacity-55 transition-opacity duration-250 ease-out"
            >
              ⌘S
            </span>
          </button>
          <div className="flex items-center gap-2.5 max-[1099px]:gap-2 min-[1100px]:grid min-[1100px]:auto-cols-fr min-[1100px]:grid-flow-col">
            {actions.map(({ id, key, icon: Icon, go, disabled }) => {
              const label = t(`nav.${id}`);
              const count = id === "privacy" ? claims : 0;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => !disabled && go()}
                  aria-disabled={disabled}
                  aria-label={count > 0 ? `${label} ${count}` : label}
                  className={`group relative inline-flex h-11 items-center justify-center gap-2.25 rounded-full bg-surface-card pr-4 pl-3 text-body text-content transition-[background-color,transform] duration-250 ease-out max-[1099px]:w-11 max-[1099px]:p-0 min-[1100px]:w-full motion-reduce:transition-none ${FOCUS} ${
                    disabled
                      ? "cursor-not-allowed opacity-35"
                      : "cursor-pointer hover:bg-surface-highlight active:scale-[0.96]"
                  }`}
                >
                  <Icon size={16} />
                  <span className="max-[1099px]:hidden">{label}</span>
                  <span className="w-4 text-left text-[0.75rem] font-medium tabular-nums max-[1099px]:hidden">
                    {count > 0 ? count : ""}
                  </span>
                  {count > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute top-2.25 right-2.25 size-1.5 rounded-full bg-content min-[1100px]:hidden"
                    />
                  )}
                  <span
                    role="tooltip"
                    className="look-raise pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-lg bg-(--bg-3) px-2.25 py-1.5 text-[0.75rem] text-content opacity-0 transition-opacity duration-250 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 min-[1100px]:hidden"
                  >
                    {label}
                    <span className="ml-1.5 font-mono text-content-muted">
                      ⌘{key.toUpperCase()}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <section
          className="flex-1 min-h-0 grid grid-cols-1 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-10 gap-y-6 overflow-y-auto @2xl:overflow-hidden scrollbar-hide"
          style={{ marginTop: "clamp(16px, 3.4vh, 44px)" }}
        >
          <div className="min-w-0 @2xl:min-h-0 flex flex-col">
            <div className="shrink-0 h-9 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4.5">
                <span className="tab-caps text-content">Tokens</span>
                <button
                  type="button"
                  onClick={() => navigate("/nfts")}
                  className="tab-caps text-content-muted hover:text-content transition-colors cursor-pointer"
                >
                  NFTs
                </button>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="tab-caps text-content-muted hover:text-content transition-colors cursor-pointer"
              >
                Import
              </button>
            </div>
            <div
              className="mt-1 -mx-3 @2xl:flex-1 @2xl:min-h-0 @2xl:overflow-y-auto scrollbar-hide"
              style={LIST_FADE}
            >
              {isLoading ? (
                <ListLoader id="home-assets" />
              ) : (
                <>
                  <AssetRow
                    logoURI={OCT_LOGO}
                    symbol="OCT"
                    name="Octra"
                    amount={showBalanceValues ? formatOCT(publicBalance) : ROW_MASK}
                    fiat={showBalanceValues ? octUsd(publicBalance) : ROW_MASK}
                    onClick={() => navigate("/token?symbol=OCT")}
                  />
                  {privacyEnabled && (
                    <AssetRow
                      logoURI={OCT_LOGO}
                      symbol="OCT"
                      encrypted
                      name="Octra"
                      amount={
                        !showBalanceValues
                          ? ROW_MASK
                          : privateBalance != null
                            ? formatOCT(privateBalance)
                            : isPvacLoading
                              ? "Decrypting"
                              : UNKNOWN
                      }
                      quiet={showBalanceValues && privateBalance == null}
                      fiat={
                        !showBalanceValues
                          ? ROW_MASK
                          : privateBalance != null
                            ? octUsd(privateBalance)
                            : ""
                      }
                      onClick={() => navigate("/token?symbol=OCT&private=1")}
                    />
                  )}
                  {tokenRows.map(({ token, bal, usd }) => (
                    <AssetRow
                      key={token.contractAddress}
                      logoURI={token.logoURI}
                      symbol={token.symbol}
                      name={token.name}
                      amount={showBalanceValues ? bal : ROW_MASK}
                      fiat={showBalanceValues ? (usd != null ? fmtUsd(usd) : UNKNOWN) : ROW_MASK}
                      onClick={() => handleTokenDetail(token)}
                    />
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="min-w-0 @2xl:min-h-0 flex flex-col">
            <div className="shrink-0 h-9 flex items-center justify-between gap-4">
              <span className="tab-caps text-content">Activity</span>
              <button
                type="button"
                onClick={() => navigate("/history")}
                className="tab-caps text-content-muted hover:text-content transition-colors cursor-pointer"
              >
                See all
              </button>
            </div>
            <div
              className="mt-1 -mx-3 @2xl:flex-1 @2xl:min-h-0 @2xl:overflow-y-auto scrollbar-hide"
              style={LIST_FADE}
            >
              {txLoading ? (
                <ListLoader id="home-activity" />
              ) : recentTxs.length === 0 ? (
                <div className="py-10 flex flex-col items-center gap-4">
                  <Mascot id="home-empty" phase="s0" size={52} />
                  <span className="text-meta text-content-muted">No activity yet</span>
                </div>
              ) : (
                recentTxs.slice(0, 8).map((tx) => {
                  const v = txView(tx);
                  return (
                    <button
                      key={tx.hash}
                      type="button"
                      onClick={() => setOpenTx(v)}
                      className="w-full px-3 py-3 rounded-xl flex items-center justify-between gap-4 text-left hover:bg-surface-card transition-colors cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2 text-body font-medium text-content">
                          <span className="truncate">{v.label}</span>
                          {tx.status === "pending" && (
                            <span className="text-[0.75rem] font-normal text-content-muted shrink-0">
                              Pending
                            </span>
                          )}
                          {tx.status === "failed" && (
                            <span className="text-[0.75rem] font-normal text-danger shrink-0">
                              Failed
                            </span>
                          )}
                        </div>
                        <NamedAddress
                          address={v.credit ? tx.from : tx.to}
                          networkId={networkId}
                          className="mt-0.75 flex text-meta text-content-muted"
                        >
                          {truncateAddress(v.credit ? tx.from : tx.to)}
                        </NamedAddress>
                      </div>
                      <div className="text-right whitespace-nowrap tabular-nums">
                        <div
                          className={`text-body font-semibold ${!showBalanceValues ? "text-content-muted" : v.credit ? "text-positive" : "text-content"}`}
                        >
                          {v.amount ? (showBalanceValues ? v.amount : ROW_MASK) : ""}
                        </div>
                        <div className="text-meta text-content-muted mt-0.75">
                          {timeAgo(tx.timestamp)}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>

      {openTx && <HomeTxSheet view={openTx} onClose={() => setOpenTx(null)} />}

      {importOpen && (
        <ImportTokenModal
          onClose={() => setImportOpen(false)}
          onImport={(addr) => {
            addImportedToken(addr);
            setImportOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AssetRow({
  logoURI,
  symbol,
  name,
  encrypted = false,
  amount,
  quiet = false,
  fiat,
  onClick,
}: {
  logoURI?: string;
  symbol: string;
  name: string;
  encrypted?: boolean;
  amount: string;
  quiet?: boolean;
  fiat: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-3 rounded-xl grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3.5 text-left hover:bg-surface-card transition-colors cursor-pointer"
    >
      <TokenIcon logoURI={logoURI} symbol={symbol} mono={logoURI === OCT_LOGO} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-body font-semibold text-content truncate">{symbol}</span>
          {encrypted && <OutlineTag label="Encrypted" />}
        </div>
        <div className="text-meta text-content-muted mt-0.75 truncate">{name}</div>
      </div>
      <div className="text-right tabular-nums whitespace-nowrap">
        <div className={`text-body font-semibold ${quiet ? "text-content-muted" : "text-content"}`}>
          {amount}
        </div>
        <div className="text-meta text-content-muted mt-0.75 min-h-[1.2em]">{fiat}</div>
      </div>
    </button>
  );
}

function ListLoader({ id }: { id: string }) {
  return (
    <div className="h-40 grid place-items-center" aria-label="Loading">
      <Mascot id={id} phase="ld" size={36} />
    </div>
  );
}
