import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronDown } from "src/shared/ui/icons";
import PasswordPrompt from "src/features/wallet/components/PasswordPrompt";
import { authErrorText } from "src/features/security/components/PhraseReveal";
import { useCopied } from "src/features/security/components/SecretSurface";
import NamedAddress from "src/shared/ui/NamedAddress";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Amount, Btn, EASE, FOCUS, Pair, Skel } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import useMountEffect from "src/hooks/ui/useMountEffect";
import type { WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { getBalance } from "src/services/network/networkService";
import { formatOCTShort, truncateAddress } from "src/lib/format";
import { logger } from "src/lib/logger";

const SCAN_CAP = 50;
const SCAN_FIRST = 20;
const SCAN_STEP = 10;

type Found = { index: number; address: string; imported: boolean };
type Scan = (password: string, accepted: () => void) => Promise<void>;

const ROW = `group relative grid h-13 items-center gap-3 rounded-[14px] px-3.5 ${EASE}`;
const COVER = `absolute inset-0 cursor-pointer rounded-[14px] disabled:cursor-default ${FOCUS}`;
const QUIET = `cursor-pointer rounded-full font-semibold text-content-secondary hover:bg-(--bg-3) hover:text-content disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-secondary ${EASE} ${FOCUS}`;
const DOT = "size-1.25 rounded-full bg-content-secondary motion-safe:animate-pulse";

const isFullAddress = (text: string) => text.length === 47 && text.startsWith("oct");

function CopyAddress({ address, shown }: { address: string; shown: boolean }) {
  const { t } = useTranslation();
  const { copied, flash } = useCopied();
  return (
    <button
      type="button"
      aria-label={t("wallet.copyAddress")}
      onClick={() => {
        void navigator.clipboard
          .writeText(address)
          .then(flash)
          .catch(() => {});
      }}
      className={`relative h-8 w-17 text-meta ${QUIET} ${shown || copied ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
    >
      {copied ? t("backup.copied") : t("backup.copy")}
    </button>
  );
}

export default function AccountScan({
  wallets,
  networkId,
  hasPassword,
  held,
  onAdd,
  onClose,
}: {
  wallets: WalletData[];
  networkId: string;
  hasPassword: boolean;
  held: boolean;
  onAdd: (parentId: string, index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [parentId, setParentId] = useState<string | null>(
    wallets.length === 1 ? wallets[0].id : null,
  );
  const [accounts, setAccounts] = useState<Found[] | null>(null);
  const [ended, setEnded] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [searching, setSearching] = useState(false);
  const [scanAuth, setScanAuth] = useState<{ scan: Scan } | null>(null);
  const [scanError, setScanError] = useState("");
  const [failed, setFailed] = useState<{ scan: Scan; text: string } | null>(null);
  const [showBalances, setShowBalances] = useState(false);
  const [balances, setBalances] = useState<Record<string, number | null>>({});
  const asked = useRef(new Set<string>());
  const live = useRef({ alive: true, stop: false, showBalances });
  live.current.showBalances = showBalances;

  useMountEffect(() => {
    live.current.alive = true;
    return () => {
      live.current.alive = false;
      live.current.stop = true;
    };
  });
  useEscapeKey(!held && !scanAuth, onClose);

  const parent = wallets.find((w) => w.id === parentId) ?? null;
  const balanceKey = (address: string) => `${networkId}:${address}`;

  const loadBalances = async (list: Found[]) => {
    const todo = list.filter((a) => !a.imported && !asked.current.has(balanceKey(a.address)));
    if (todo.length === 0) return;
    for (const a of todo) asked.current.add(balanceKey(a.address));
    setBalances((prev) => {
      const next = { ...prev };
      for (const a of todo) delete next[balanceKey(a.address)];
      return next;
    });
    for (const a of todo) {
      if (!live.current.alive) return;
      const key = balanceKey(a.address);
      let value: number | null = null;
      try {
        value = (await getBalance(a.address, networkId)).balance;
      } catch {
        asked.current.delete(key);
      }
      if (!live.current.alive) return;
      setBalances((prev) => ({ ...prev, [key]: value }));
    }
  };

  const runScan = async (scan: Scan, password: string) => {
    let sheet = hasPassword;
    setScanError("");
    setFailed(null);
    setScanning(true);
    try {
      await scan(password, () => {
        sheet = false;
        setScanAuth(null);
      });
      setScanAuth(null);
    } catch (err: unknown) {
      const text = authErrorText(err, t);
      const raw = err instanceof Error ? err.message : String(err);
      if (sheet) setScanError(text ?? raw);
      else {
        logger.warn("wallet", `account scan failed: ${raw}`);
        setFailed({ scan, text: text ?? t("wallet.scanFailed") });
      }
    } finally {
      setScanning(false);
    }
  };

  const startScan = (scan: Scan) => {
    if (scanning) return;
    if (hasPassword) {
      setScanError("");
      setScanAuth({ scan });
      return;
    }
    void runScan(scan, "");
  };

  const scanTo =
    (upTo: number, want: number | null): Scan =>
    async (password) => {
      if (!parentId) return;
      const count = Math.min(upTo, SCAN_CAP);
      const { accounts: list } = await walletBridge.scanHdAccounts(parentId, password, count);
      setAccounts(list);
      setEnded(list.length < count);
      if (want !== null && list.some((a) => a.index === want && !a.imported)) setPicked(want);
      if (live.current.showBalances) void loadBalances(list);
    };

  const scanForAddress: Scan = async (password, accepted) => {
    if (!parentId) return;
    const q = query.trim().toLowerCase();
    live.current.stop = false;
    setSearching(true);
    try {
      for (let from = accounts?.length ?? 0; from < SCAN_CAP; from += SCAN_STEP) {
        const count = Math.min(from + SCAN_STEP, SCAN_CAP);
        const { accounts: list } = await walletBridge.scanHdAccounts(parentId, password, count);
        accepted();
        if (!live.current.alive) return;
        setAccounts(list);
        if (live.current.showBalances) void loadBalances(list);
        if (list.length < count) {
          setEnded(true);
          break;
        }
        const hit = list.find((a) => a.index >= from && a.address.toLowerCase() === q);
        if (hit) {
          if (!hit.imported) setPicked(hit.index);
          break;
        }
        if (live.current.stop) break;
      }
    } finally {
      setSearching(false);
    }
  };

  const q = query.trim();
  const wantIndex = /^\d{1,9}$/.test(q) ? Number(q) : null;
  const shown = !accounts
    ? []
    : wantIndex !== null
      ? accounts.filter((a) => a.index === wantIndex)
      : q
        ? accounts.filter((a) => a.address.toLowerCase().includes(q.toLowerCase()))
        : accounts;
  const more = accounts !== null && accounts.length < SCAN_CAP && !ended;
  const reachable = accounts === null || more;
  const firstScan = scanTo(Math.max(SCAN_FIRST, (wantIndex ?? -1) + 1), wantIndex);
  const search: Scan | null =
    !parentId || shown.length > 0 || !reachable
      ? null
      : wantIndex !== null
        ? wantIndex < SCAN_CAP
          ? accounts === null
            ? firstScan
            : scanTo(wantIndex + 1, wantIndex)
          : null
        : isFullAddress(q)
          ? scanForAddress
          : null;
  const runSearch = () => {
    if (search && !scanning) startScan(search);
  };

  const balanceFailed =
    showBalances && (accounts ?? []).some((a) => balances[balanceKey(a.address)] === null);
  const pickParent = (id: string | null) => {
    setParentId(id);
    setAccounts(null);
    setEnded(false);
    setPicked(null);
    setFailed(null);
  };

  const message = (text: string, action?: ReactNode) => (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      {text && <p className="text-body text-content-secondary">{text}</p>}
      {action}
    </div>
  );

  const slot = !parent ? (
    <div className="flex flex-col gap-0.5">
      {wallets.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => pickParent(w.id)}
          className={`flex h-13 w-full cursor-pointer items-center gap-3.5 rounded-[14px] px-3.5 text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
        >
          <WalletAvatar address={w.address} size={28} />
          <span className="truncate text-body font-semibold text-content">{w.name}</span>
          <span className="ml-auto shrink-0 font-mono text-meta text-content-muted">
            {truncateAddress(w.address, 12, 8)}
          </span>
        </button>
      ))}
    </div>
  ) : failed ? (
    message(
      failed.text,
      <Btn size="sm" onClick={() => startScan(failed.scan)}>
        {t("wallet.scanRetry")}
      </Btn>,
    )
  ) : accounts === null ? (
    message(
      "",
      <Btn size="sm" weight="primary" disabled={scanning} onClick={() => startScan(firstScan)}>
        {t("wallet.scanAccounts")}
      </Btn>,
    )
  ) : shown.length === 0 ? (
    message(
      wantIndex !== null && wantIndex >= SCAN_CAP
        ? t("wallet.scanRange", { last: SCAN_CAP - 1 })
        : t("wallet.scanNone"),
    )
  ) : (
    <div className="flex flex-col gap-0.5 pb-5">
      {shown.map((a) => {
        const on = picked === a.index;
        const balance = balances[balanceKey(a.address)];
        return (
          <div
            key={a.index}
            className={`${ROW} grid-cols-[2.25rem_minmax(0,1fr)_7rem_auto] ${on ? "bg-surface-highlight" : a.imported ? "" : "hover:bg-surface-highlight"}`}
          >
            <button
              type="button"
              aria-pressed={on}
              aria-label={t("wallet.scanAccount", { index: a.index })}
              title={a.address}
              disabled={a.imported}
              onClick={() => setPicked(a.index)}
              className={COVER}
            />
            <span
              className={`text-meta tabular-nums ${on ? "font-semibold text-content" : "text-content-muted"}`}
            >
              #{a.index}
            </span>
            <NamedAddress
              address={a.address}
              networkId={networkId}
              className={`font-mono text-meta ${a.imported ? "text-content-muted" : "text-content"}`}
            >
              {truncateAddress(a.address, 12, 8)}
            </NamedAddress>
            <span className="flex justify-end text-body font-medium text-content">
              {a.imported ? (
                <span className="rounded-full bg-(--bg-3) px-2 py-0.5 text-micro font-normal text-content-secondary">
                  {t("wallet.scanAdded")}
                </span>
              ) : !showBalances || balance === null ? null : balance === undefined ? (
                <Skel w="w-14" />
              ) : (
                <Amount value={formatOCTShort(balance)} />
              )}
            </span>
            <CopyAddress address={a.address} shown={on} />
          </div>
        );
      })}
      {more && !q && (
        <button
          type="button"
          onClick={() => startScan(scanTo(accounts.length + SCAN_STEP, null))}
          className={`h-11 w-full shrink-0 cursor-pointer rounded-[14px] text-body font-medium text-content-secondary hover:bg-surface-highlight hover:text-content ${EASE} ${FOCUS}`}
        >
          {t("wallet.scanMore")}
        </button>
      )}
    </div>
  );

  return (
    <>
      <PopupShell
        open
        wide
        label={t("wallet.deriveAccount")}
        onScrim={held || scanAuth ? undefined : onClose}
      >
        <div className="flex h-8 items-center justify-between gap-4">
          <h2 className="text-title font-semibold text-content">{t("wallet.deriveAccount")}</h2>
          <button
            type="button"
            aria-pressed={showBalances}
            disabled={!parent}
            onClick={() => {
              setShowBalances(!showBalances);
              if (!showBalances) void loadBalances(accounts ?? []);
            }}
            className={`h-8 px-3 text-meta ${QUIET}`}
          >
            {t(showBalances ? "wallet.scanHideBalances" : "wallet.scanShowBalances")}
          </button>
        </div>
        <div className="mt-3 flex h-11 items-center justify-between gap-4">
          <span className="text-[0.84375rem] whitespace-nowrap text-content-muted">
            {t("wallet.parentWallet")}
          </span>
          {parent && (
            <button
              type="button"
              disabled={wallets.length < 2 || scanning}
              onClick={() => pickParent(null)}
              className={`-mr-2.5 flex h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-full px-2.5 enabled:hover:bg-surface-highlight disabled:cursor-default ${EASE} ${FOCUS}`}
            >
              <WalletAvatar address={parent.address} size={20} />
              <span className="truncate text-body font-semibold text-content">{parent.name}</span>
              <span className="shrink-0 font-mono text-meta text-content-muted">
                {truncateAddress(parent.address, 12, 8)}
              </span>
              {wallets.length > 1 && (
                <ChevronDown size={14} className="shrink-0 text-content-muted" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
        <form
          className="relative mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <input
            data-autofocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("wallet.scanField")}
            aria-label={t("wallet.scanField")}
            autoComplete="off"
            spellCheck={false}
            disabled={!parent}
            className={`h-11.5 w-full rounded-xl bg-surface-highlight pr-22 pl-4 text-body text-content placeholder:text-content-muted outline-none disabled:opacity-50 ${FOCUS}`}
          />
          {searching ? (
            <button
              type="button"
              onClick={() => {
                live.current.stop = true;
              }}
              className={`absolute top-1/2 right-2 h-8 w-17 -translate-y-1/2 text-meta ${QUIET}`}
            >
              {t("wallet.scanStop")}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!search || scanning}
              className={`absolute top-1/2 right-2 h-8 w-17 -translate-y-1/2 text-meta ${QUIET}`}
            >
              {t("wallet.scanSearch")}
            </button>
          )}
        </form>
        <div
          aria-busy={scanning}
          className={`mt-2 h-72 overflow-y-auto scrollbar-hide transition-opacity duration-200 ease-out motion-reduce:transition-none ${scanning && accounts ? "pointer-events-none opacity-50" : ""}`}
        >
          {slot}
        </div>
        <div className="mt-2 flex h-5 items-center gap-3 text-meta text-content">
          {scanning ? (
            <span role="status" aria-label={t("wallet.scanning")} className="inline-flex gap-1.25">
              <i className={DOT} />
              <i className={`${DOT} [animation-delay:200ms]`} />
              <i className={`${DOT} [animation-delay:400ms]`} />
            </span>
          ) : (
            balanceFailed && (
              <>
                <span role="alert">{t("wallet.scanNoAnswer")}</span>
                <button
                  type="button"
                  onClick={() => void loadBalances(accounts ?? [])}
                  className={`cursor-pointer rounded-full font-semibold text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
                >
                  {t("wallet.scanRetry")}
                </button>
              </>
            )
          )}
        </div>
        <Pair
          className="mt-3.5"
          left={<Btn onClick={onClose}>{t("common.cancel")}</Btn>}
          right={
            <Btn
              weight="primary"
              className="look-key"
              disabled={!parentId || picked === null || scanning}
              onClick={() => parentId && picked !== null && onAdd(parentId, picked)}
            >
              {picked === null ? t("wallet.scanAdd") : t("wallet.scanAddAt", { index: picked })}
            </Btn>
          }
        />
      </PopupShell>
      {scanAuth && (
        <PasswordPrompt
          isOpen
          onSubmit={(password) => void runScan(scanAuth.scan, password)}
          onCancel={() => {
            setScanAuth(null);
            setScanError("");
          }}
          error={scanError}
          busy={scanning}
        />
      )}
    </>
  );
}
