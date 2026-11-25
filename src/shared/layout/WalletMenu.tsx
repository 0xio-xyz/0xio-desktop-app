import React, { useCallback, useRef } from "react";
import { useNavigate } from "src/lib/router";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import { truncateAddress } from "src/lib/format";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { useSwitchWallet } from "src/hooks/wallet/useSwitchWallet";
import WalletAvatar from "src/shared/ui/WalletAvatar";

export type MenuPlacement = "below" | "right" | "above";

export function networkShortName(id: string): string {
  if (id === "mainnet") return "Mainnet";
  if (id === "devnet") return "Devnet";
  if (id === "devnet2") return "Devnet 2";
  return NETWORKS[id]?.name ?? id;
}

const ROW =
  "w-full flex items-center rounded-[10px] px-2.5 text-left transition-colors hover:bg-surface-highlight cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset";
const CAPS = "tab-caps px-2.5 text-content-muted";

function position(anchor: HTMLElement, placement: MenuPlacement): React.CSSProperties {
  const r = anchor.getBoundingClientRect();
  if (placement === "right") return { left: r.right + 8, top: r.top };
  if (placement === "above") return { left: r.left, bottom: window.innerHeight - r.top + 8 };
  return { left: r.left, top: r.bottom + 6 };
}

export default function WalletMenu({
  anchor,
  placement,
  onClose,
}: {
  anchor: HTMLElement;
  placement: MenuPlacement;
  onClose: (restoreFocus: boolean) => void;
}) {
  const navigate = useNavigate();
  const { wallets, activeWallet, networkId, setNetworkId } = useWallet();
  const ref = useRef<HTMLDivElement | null>(null);

  useMountEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

  const focusFirst = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    el?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") onClose(false);
  };

  const switchWallet = useSwitchWallet();
  const handleSwitch = (wallet: WalletData) => {
    onClose(true);
    void switchWallet(wallet);
  };

  return (
    <div
      ref={focusFirst}
      role="menu"
      aria-label="Wallets and networks"
      onKeyDown={onKeyDown}
      style={position(anchor, placement)}
      className="fixed z-50 w-72 rounded-2xl bg-surface-card p-2 look-raise"
    >
      <div className={`${CAPS} pt-1.5 pb-1`}>Wallets</div>
      <div className="max-h-64 overflow-y-auto scrollbar-hide">
        {wallets.map((w) => {
          const isActive = w.id === activeWallet?.id;
          return (
            <button
              key={w.id}
              role="menuitemradio"
              aria-checked={isActive}
              onClick={() => handleSwitch(w)}
              className={`${ROW} gap-3 py-2 ${isActive ? "bg-surface-highlight" : ""}`}
            >
              <WalletAvatar address={w.address} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-content">
                  {w.name}
                </span>
                <span className="block truncate text-[11.5px] text-content-muted tabular-nums">
                  {truncateAddress(w.address)}
                </span>
              </span>
              {w.wallet_type === "watch" && (
                <span className="shrink-0 text-micro text-content-muted">Watch only</span>
              )}
            </button>
          );
        })}
      </div>
      <button
        role="menuitem"
        onClick={() => {
          onClose(false);
          navigate("/wallets");
        }}
        className={`${ROW} py-2 text-[13px] font-medium text-content`}
      >
        Manage wallets
      </button>

      <div className={`${CAPS} pt-3 pb-1`}>Network</div>
      {Object.keys(NETWORKS).map((id) => (
        <button
          key={id}
          role="menuitemradio"
          aria-checked={id === networkId}
          onClick={() => {
            onClose(true);
            if (id !== networkId) setNetworkId(id);
          }}
          className={`${ROW} gap-2.5 py-2 ${id === networkId ? "bg-surface-highlight" : ""}`}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${id === "mainnet" ? "bg-positive" : "bg-content-muted"}`}
          />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${id === networkId ? "font-semibold text-content" : "text-content-secondary"}`}
          >
            {networkShortName(id)}
          </span>
        </button>
      ))}
    </div>
  );
}
