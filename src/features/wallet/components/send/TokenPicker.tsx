import { useCallback, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { TokenChip } from "src/shared/ui/BigAmount";
import { Num, EASE, FOCUS } from "src/shared/ui/look";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import type { TokenInfo } from "src/types/contract";
import { formatOCT, formatTokenAmount, truncateAddress } from "src/lib/format";

export default function TokenPicker({
  token,
  tokens,
  onPick,
  octBalance,
  locked,
}: {
  token: TokenInfo | null;
  tokens: TokenInfo[];
  onPick: (t: TokenInfo | null) => void;
  octBalance: number | null;
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(box, open, close);
  const chip = (
    <TokenChip
      symbol={token?.symbol ?? "OCT"}
      logo={token ? (token.logoURI ?? null) : undefined}
      chevron={!locked}
    />
  );
  if (locked) return chip;
  const pick = (next: TokenInfo | null) => {
    onPick(next);
    setOpen(false);
  };
  const row = (
    key: string,
    on: boolean,
    symbol: string,
    logo: string | null | undefined,
    sub: string,
    bal: string,
    next: TokenInfo | null,
  ) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={on}
      onClick={() => pick(next)}
      className={`flex h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] px-2.5 text-left hover:bg-surface-highlight ${EASE} ${FOCUS} ${on ? "bg-(--bg-3)" : ""}`}
    >
      <TokenChip symbol={symbol} logo={logo} />
      <span className="min-w-0 flex-1 truncate text-meta text-content-muted">{sub}</span>
      <Num value={bal} className="text-[0.8125rem] text-content-secondary" />
    </button>
  );
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("sendFlow.token")}
        className={`cursor-pointer rounded-full ${FOCUS}`}
      >
        {chip}
      </button>
      {open && (
        <div
          role="listbox"
          className="look-raise absolute top-full right-0 z-30 mt-2 max-h-72 w-80 overflow-y-auto rounded-[14px] bg-surface-card p-1 animate-in fade-in-0 duration-200"
        >
          {row(
            "oct",
            !token,
            "OCT",
            undefined,
            t("send.native"),
            octBalance === null ? "" : formatOCT(octBalance),
            null,
          )}
          {tokens.map((tk) =>
            row(
              tk.contractAddress,
              token?.contractAddress === tk.contractAddress,
              tk.symbol,
              tk.logoURI ?? null,
              truncateAddress(tk.contractAddress, 8, 6),
              formatTokenAmount(tk.balance, tk.decimals),
              tk,
            ),
          )}
        </div>
      )}
    </div>
  );
}
