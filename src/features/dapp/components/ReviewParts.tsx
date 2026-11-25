import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Action } from "src/shared/ui/flat";
import { canSignWallet, type SiteWalletInfo } from "src/features/dapp/services/dappService";

export const hostOf = (origin: string): string => {
  try {
    const u = new URL(origin);
    return u.host || origin.replace(/^[a-z]+:\/\//, "");
  } catch {
    return origin;
  }
};

export const middleCut = (address: string, head = 8, tail = 6): string =>
  address.length > head + tail + 3
    ? `${address.slice(0, head)}...${address.slice(-tail)}`
    : address;

export function SiteMark({
  origin,
  favicon,
  size = 36,
}: {
  origin: string;
  favicon?: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const web = /^https?:\/\//.test(origin);
  const src = favicon ?? (web ? `${origin}/favicon.ico` : undefined);
  const letter =
    hostOf(origin)
      .replace(/^www\./, "")
      .charAt(0)
      .toUpperCase() || "?";
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-highlight"
      style={{ width: size, height: size }}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          onError={() => setBroken(true)}
          className="rounded-[5px] object-contain"
          style={{ width: Math.round(size * 0.55), height: Math.round(size * 0.55) }}
        />
      ) : (
        <span
          className="font-semibold text-content-secondary"
          style={{ fontSize: Math.round(size * 0.36) }}
        >
          {letter}
        </span>
      )}
    </span>
  );
}

function SiteHead({ origin, favicon }: { origin: string; favicon?: string }) {
  return (
    <div className="flex items-center gap-3">
      <SiteMark origin={origin} favicon={favicon} />
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-body font-semibold text-content truncate">{hostOf(origin)}</span>
        <span className="text-micro text-content-muted truncate">{origin}</span>
      </div>
    </div>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-meta text-content-secondary shrink-0">{label}</span>
      <span className="text-meta text-content text-right min-w-0 break-all tabular-nums">
        {children}
      </span>
    </div>
  );
}

export function ReviewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-card px-4 py-3 text-meta leading-relaxed text-content-secondary">
      {children}
    </div>
  );
}

function KindChip({ wallet }: { wallet: SiteWalletInfo }) {
  const { t } = useTranslation();
  if (canSignWallet(wallet)) return null;
  return (
    <span className="shrink-0 rounded-full bg-surface-highlight px-2 text-micro leading-4 text-content-secondary whitespace-nowrap">
      {t("dappReview.watchOnly")}
    </span>
  );
}

export function WalletRow({
  wallet,
  selected = false,
  onClick,
  right,
}: {
  wallet: SiteWalletInfo;
  selected?: boolean;
  onClick?: () => void;
  right?: React.ReactNode;
}) {
  const Tag: "button" | "div" = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={`w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-200 ${
        selected
          ? "bg-surface-highlight"
          : onClick
            ? "hover:bg-surface-highlight cursor-pointer"
            : ""
      }`}
    >
      <WalletAvatar address={wallet.address} size={30} />
      <span className="flex flex-col min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-body text-content truncate">{wallet.name}</span>
          <KindChip wallet={wallet} />
        </span>
        <span className="text-micro font-mono text-content-muted">{middleCut(wallet.address)}</span>
      </span>
      {right}
    </Tag>
  );
}

export function SignerRow({ wallet }: { wallet: SiteWalletInfo }) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="text-meta text-content-secondary mb-1.5 px-1">{t("dappReview.signingWith")}</p>
      <div className="rounded-2xl bg-surface-card">
        <WalletRow wallet={wallet} />
      </div>
    </div>
  );
}

export function ReviewDialog({
  open,
  caps,
  origin,
  favicon,
  head,
  heading,
  children,
  error,
  reject,
  action,
  onReject,
  onAction,
  disabled = false,
  busy = false,
  danger = false,
}: {
  open: boolean;
  caps: string;
  origin?: string;
  favicon?: string;
  head?: React.ReactNode;
  heading: React.ReactNode;
  children?: React.ReactNode;
  error?: string;
  reject: string;
  action: React.ReactNode;
  onReject: () => void;
  onAction: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onReject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onReject]);

  if (!open) return null;
  const target = typeof document !== "undefined" ? document.getElementById("content-area") : null;
  const overlay = (
    <div
      className={`${target ? "absolute" : "fixed"} inset-0 z-50 flex items-center justify-center`}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        data-testid="review-backdrop"
        onClick={() => !busy && onReject()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={caps}
        className="relative w-full max-w-md mx-4 max-h-[88%] flex flex-col bg-surface rounded-[22px] shadow-2xl shadow-black/40 animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-6 pt-5 pb-3">
          <p className="text-micro font-semibold uppercase tracking-wider text-content-muted mb-3">
            {caps}
          </p>
          {head ?? (origin ? <SiteHead origin={origin} favicon={favicon} /> : null)}
          <div className="mt-4 mb-4 text-[1.25rem] font-light leading-snug text-content wrap-break-word tabular-nums">
            {heading}
          </div>
          <div className="space-y-3">{children}</div>
        </div>
        <div className="shrink-0 px-6 pt-2 pb-5">
          <p className="min-h-5 text-meta text-danger" role={error ? "alert" : undefined}>
            {error ?? ""}
          </p>
          <div className="flex gap-2.5 mt-1">
            <Action weight="raised" full onClick={onReject} disabled={busy}>
              {reject}
            </Action>
            <Action
              weight={danger ? "danger" : "primary"}
              full
              onClick={onAction}
              disabled={disabled || busy}
            >
              {action}
            </Action>
          </div>
        </div>
      </div>
    </div>
  );
  return target ? createPortal(overlay, target) : overlay;
}
