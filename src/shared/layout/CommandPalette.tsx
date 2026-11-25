import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { useQueryClient } from "src/lib/query";
import {
  AddressBookIcon,
  AutomationsIcon,
  CipherMapIcon,
  CirclesIcon,
  ContractsIcon,
  DappsIcon,
  HistoryIcon,
  HomeIcon,
  LockIcon,
  NftsIcon,
  PrivacyIcon,
  ReceiveIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  WalletsIcon,
} from "src/shared/layout/navIcons";
import { networkShortName } from "src/shared/layout/WalletMenu";
import PalettePreview, { Key, type Preview } from "src/shared/layout/PalettePreview";
import {
  cleanHash,
  looksLikeHash,
  rank,
  readRecent,
  rememberRecent,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
} from "src/shared/layout/paletteSearch";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { EASE } from "src/shared/ui/look";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { txView } from "src/features/transactions/history/txView";
import { middleOf } from "src/features/transactions/history/callRows";
import { useAddressName } from "src/hooks/wallet/useAddressName";
import { useLockWallet } from "src/hooks/wallet/useLockWallet";
import { useSwitchWallet } from "src/hooks/wallet/useSwitchWallet";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { walletBridge } from "src/services/wallet/walletBridge";
import { INTERNAL_TAG, getContacts, isValidAddress } from "src/services/storage/addressBookService";
import type { TokenInfo } from "src/types/contract";
import { NETWORKS } from "src/services/network/config";
import { openInSystemBrowser } from "src/lib/openExternal";

export const OPEN_COMMAND_PALETTE = "open-command-palette";

type Icon = React.ComponentType<{ size?: number; className?: string }>;
type Lead = { icon: Icon } | { address: string } | { letter: string };

interface PaletteEntry extends PaletteItem {
  lead: Lead;
  primary: PaletteAction;
  secondary?: PaletteAction;
  preview: Preview;
}

type Mode = "root" | "wallets" | "networks";

const PAGES: { path: string; key: string; icon: Icon; keywords: string; privacy?: boolean }[] = [
  { path: "/", key: "home", icon: HomeIcon, keywords: "balance dashboard" },
  { path: "/send", key: "send", icon: SendIcon, keywords: "transfer pay bulk" },
  { path: "/receive", key: "receive", icon: ReceiveIcon, keywords: "qr address deposit" },
  {
    path: "/privacy",
    key: "privacy",
    icon: PrivacyIcon,
    keywords: "encrypt decrypt claim",
    privacy: true,
  },
  { path: "/history", key: "history", icon: HistoryIcon, keywords: "transactions activity" },
  { path: "/nfts", key: "nfts", icon: NftsIcon, keywords: "collectibles" },
  {
    path: "/contracts",
    key: "contracts",
    icon: ContractsIcon,
    keywords: "deploy call",
    privacy: true,
  },
  { path: "/wallets", key: "wallets", icon: WalletsIcon, keywords: "accounts" },
  { path: "/address-book", key: "addressBook", icon: AddressBookIcon, keywords: "contacts" },
  { path: "/browser", key: "browser", icon: DappsIcon, keywords: "dapps sites web", privacy: true },
  {
    path: "/connected-sites",
    key: "connectedSites",
    icon: DappsIcon,
    keywords: "dapps permissions",
  },
  { path: "/circles", key: "circles", icon: CirclesIcon, keywords: "hosting oct", privacy: true },
  {
    path: "/cipher-map",
    key: "cipherMap",
    icon: CipherMapIcon,
    keywords: "layers ciphertext",
    privacy: true,
  },
  {
    path: "/advanced",
    key: "automations",
    icon: AutomationsIcon,
    keywords: "scheduled auto",
    privacy: true,
  },
  {
    path: "/settings",
    key: "settings",
    icon: SettingsIcon,
    keywords: "preferences security network",
  },
];

const SUGGESTED_PAGES = new Set(["/send", "/receive", "/privacy", "/history", "/settings"]);

/** Nothing signs from here: a page or money action only routes to its screen, where the review happens. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen);
    };
  }, []);

  if (!open || typeof document === "undefined") return null;
  return createPortal(<PaletteBody onClose={() => setOpen(false)} />, document.body);
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { wallets, activeWallet, networkId, setNetworkId } = useWallet();
  const { transactions } = useTransactionHistory();
  const nameOf = useAddressName();
  const lock = useLockWallet();
  const switchWallet = useSwitchWallet();
  const me = activeWallet?.address ?? "";
  const privacyOn = NETWORKS[networkId]?.supportsPrivacy ?? false;

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("root");
  const [at, setAt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    walletBridge
      .hasPassword()
      .then(setHasPassword)
      .catch(() => {});
  }, []);

  const enter = useCallback((next: Mode) => {
    setMode(next);
    setQuery("");
    setAt(0);
  }, []);

  const copy = useCallback((id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  }, []);

  const entries = useMemo((): PaletteEntry[] => {
    const go = (path: string, state?: unknown) => () =>
      navigate(path, state ? { state } : undefined);
    const person = (
      id: string,
      group: PaletteGroup,
      address: string,
      label: string,
      name: string | null,
    ): PaletteEntry => ({
      id,
      group,
      label,
      sub: group === "address" ? undefined : middleOf(address, 8, 6),
      keywords: address,
      lead: { address },
      primary: { label: t("palette.sendTo"), run: go("/send", { recipient: address }) },
      secondary: {
        label: copied === id ? t("palette.copied") : t("palette.copyAddress"),
        run: () => copy(id, address),
        stay: true,
      },
      preview: { kind: "person", address, name },
    });

    if (mode === "wallets") {
      return wallets.map((w: WalletData) => ({
        id: `wallet:${w.id}`,
        group: "wallets",
        label: w.name,
        sub: middleOf(w.address, 8, 6),
        hint: w.id === activeWallet?.id ? t("palette.current") : undefined,
        lead: { address: w.address },
        primary: { label: t("palette.switchTo"), run: () => void switchWallet(w) },
        secondary: { label: t("palette.openWallets"), run: go("/wallets") },
        preview: { kind: "person", address: w.address, name: w.name },
      }));
    }
    if (mode === "networks") {
      return Object.keys(NETWORKS).map((id) => ({
        id: `network:${id}`,
        group: "networks",
        label: networkShortName(id),
        hint: id === networkId ? t("palette.current") : undefined,
        lead: { icon: SettingsIcon },
        primary: {
          label: t("palette.switchTo"),
          run: () => id !== networkId && setNetworkId(id),
        },
        preview: { kind: "plain", title: networkShortName(id) },
      }));
    }

    const out: PaletteEntry[] = [];
    const q = query.trim();

    if (looksLikeHash(q)) {
      const hash = cleanHash(q);
      const hits = transactions.filter((tx) => tx.hash.toLowerCase().startsWith(hash));
      if (hits.length === 0) {
        const full = hash.length === 64;
        out.push({
          id: `lookup:${hash}`,
          group: "transaction",
          label: middleOf(hash, 10, 8),
          lead: { icon: HistoryIcon },
          primary: {
            label: t("palette.openInHistory"),
            run: go(`/history?hash=${hash}&net=${networkId}`),
          },
          secondary: full
            ? {
                label: t("palette.octrascan"),
                run: () => void openInSystemBrowser(`${NETWORKS[networkId]?.explorerUrl}${hash}`),
              }
            : undefined,
          preview: { kind: "plain", title: middleOf(hash, 10, 8), mono: true },
        });
      }
    }

    if (isValidAddress(q) && !getContacts(networkId).some((c) => c.address === q)) {
      out.push(person(`address:${q}`, "address", q, middleOf(q, 10, 8), nameOf(q)?.name ?? null));
    }

    if (privacyOn)
      out.push({
        id: "action:encrypt",
        group: "actions",
        label: t("palette.encrypt"),
        lead: { icon: PrivacyIcon },
        primary: { label: t("palette.open"), run: go("/privacy") },
        preview: { kind: "plain", title: t("palette.encrypt") },
      });
    const waiting =
      qc.getQueryData<unknown[]>(["claimOutputs", activeWallet?.id, networkId])?.length ?? 0;
    if (privacyOn && waiting > 0)
      out.push({
        id: "action:claim",
        group: "actions",
        label: t("palette.claimWaiting", { count: waiting }),
        keywords: "claim",
        lead: { icon: PrivacyIcon },
        primary: { label: t("palette.open"), run: go("/privacy") },
        preview: { kind: "plain", title: t("palette.claimWaiting", { count: waiting }) },
      });
    out.push({
      id: "action:wallet",
      group: "actions",
      label: t("palette.switchWallet"),
      sub: activeWallet?.name,
      lead: { icon: WalletsIcon },
      primary: { label: t("palette.choose"), run: () => enter("wallets"), stay: true },
      preview: { kind: "plain", title: t("palette.switchWallet") },
    });
    out.push({
      id: "action:network",
      group: "actions",
      label: t("palette.switchNetwork"),
      sub: networkShortName(networkId),
      lead: { icon: SettingsIcon },
      primary: { label: t("palette.choose"), run: () => enter("networks"), stay: true },
      preview: { kind: "plain", title: t("palette.switchNetwork") },
    });
    if (hasPassword)
      out.push({
        id: "action:lock",
        group: "actions",
        label: t("palette.lock"),
        hint: "⌘L",
        lead: { icon: LockIcon },
        primary: { label: t("palette.lock"), run: () => void lock() },
        preview: { kind: "plain", title: t("palette.lock"), shortcut: "⌘L" },
      });

    for (const p of PAGES) {
      if (p.privacy && !privacyOn) continue;
      if (!q && !SUGGESTED_PAGES.has(p.path)) continue;
      const label = t(`nav.${p.key}`);
      out.push({
        id: `page:${p.path}`,
        group: "pages",
        label,
        keywords: p.keywords,
        lead: { icon: p.icon },
        primary: { label: t("palette.open"), run: go(p.path) },
        preview: { kind: "plain", title: label },
      });
    }

    if (q) {
      for (const c of getContacts(networkId))
        if (!c.tags.includes(INTERNAL_TAG))
          out.push(person(`contact:${c.address}`, "contacts", c.address, c.label, c.label));
      for (const w of wallets)
        if (w.id !== activeWallet?.id)
          out.push({
            id: `wallet:${w.id}`,
            group: "wallets",
            label: w.name,
            sub: middleOf(w.address, 8, 6),
            keywords: w.address,
            lead: { address: w.address },
            primary: { label: t("palette.switchTo"), run: () => void switchWallet(w) },
            secondary: { label: t("palette.openWallets"), run: go("/wallets") },
            preview: { kind: "person", address: w.address, name: w.name },
          });
      const tokens =
        qc.getQueriesData<TokenInfo[]>({ queryKey: ["tokens", me, networkId] })[0]?.[1] ?? [];
      for (const tok of tokens) {
        const params = new URLSearchParams({ symbol: tok.symbol, contract: tok.contractAddress });
        out.push({
          id: `token:${tok.contractAddress}`,
          group: "tokens",
          label: tok.symbol,
          sub: tok.name !== tok.symbol ? tok.name : undefined,
          keywords: tok.contractAddress,
          lead: { letter: tok.symbol.slice(0, 1) },
          primary: { label: t("palette.open"), run: go(`/token?${params.toString()}`) },
          preview: { kind: "plain", title: tok.symbol },
        });
      }
    }

    for (const tx of transactions) {
      const network = tx.network ?? networkId;
      const view = txView(tx, { me, network }, t);
      const other = view.counterparty;
      const who = other ? (nameOf(other)?.name ?? middleOf(other, 6, 4)) : null;
      const label = who
        ? t(view.received ? "palette.txFrom" : "palette.txTo", { title: view.title, name: who })
        : view.title;
      const hashHit = looksLikeHash(q) && tx.hash.toLowerCase().startsWith(cleanHash(q));
      if (!q && !hashHit) continue;
      out.push({
        id: `tx:${tx.hash}`,
        group: hashHit ? "transaction" : "transactions",
        label,
        keywords: `${tx.hash} ${other ?? ""}`,
        hint: view.amount != null ? `${view.sign}${view.amount} ${view.unit}` : undefined,
        lead: other ? { address: other } : { icon: HistoryIcon },
        primary: {
          label: t("palette.openInHistory"),
          run: go(`/history?hash=${tx.hash}&net=${network}`),
        },
        secondary: {
          label: t("palette.octrascan"),
          run: () => void openInSystemBrowser(`${NETWORKS[network]?.explorerUrl}${tx.hash}`),
        },
        preview: { kind: "tx", tx, view, who },
      });
    }

    if (!q) {
      const byId = new Map(out.map((e) => [e.id, e]));
      const recent = readRecent(networkId, me)
        .map((id) => byId.get(id))
        .filter((e): e is PaletteEntry => !!e)
        .map((e) => ({ ...e, group: "recent" as const }));
      return [...recent, ...out.filter((e) => !recent.some((r) => r.id === e.id))];
    }
    return out;
  }, [
    mode,
    query,
    wallets,
    activeWallet,
    networkId,
    transactions,
    privacyOn,
    hasPassword,
    copied,
    me,
    t,
    navigate,
    qc,
    nameOf,
    lock,
    switchWallet,
    setNetworkId,
    enter,
    copy,
  ]);

  const results = useMemo(() => rank(entries, query), [entries, query]);
  const picked = results[Math.min(at, results.length - 1)] ?? null;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${Math.min(at, results.length - 1)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [at, results.length]);

  const run = (entry: PaletteEntry, action: PaletteAction | undefined) => {
    if (!action) return;
    if (action.stay) {
      action.run();
      return;
    }
    rememberRecent(networkId, me, entry.id);
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (picked) run(picked, e.metaKey || e.ctrlKey ? picked.secondary : picked.primary);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (mode !== "root") enter("root");
      else onClose();
    } else if (e.key === "Backspace" && !query && mode !== "root") {
      e.preventDefault();
      enter("root");
    }
  };

  let lastGroup: PaletteGroup | null = null;
  return (
    <div data-look="ext" className="fixed inset-0 z-60">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/55 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        className="look-raise absolute top-20 left-1/2 w-[min(860px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-[20px] bg-surface-card animate-in fade-in-0 zoom-in-[0.98] duration-200 ease-out motion-reduce:animate-none"
      >
        <div className="flex h-14.5 items-center gap-3 px-5">
          <SearchIcon size={18} className="shrink-0 text-content-muted" />
          {mode !== "root" && (
            <span className="shrink-0 rounded-full bg-surface-highlight px-3 py-1 text-meta font-medium text-content">
              {t(mode === "wallets" ? "palette.switchWallet" : "palette.switchNetwork")}
            </span>
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            aria-controls="palette-results"
            aria-activedescendant={
              picked ? `palette-row-${Math.min(at, results.length - 1)}` : undefined
            }
            className="min-w-0 flex-1 border-0 bg-transparent text-[1.0625rem] text-content outline-none placeholder:text-content-muted"
          />
        </div>
        <div className="grid h-[min(430px,calc(100vh-220px))] grid-cols-[minmax(0,1fr)_330px]">
          <div
            ref={listRef}
            id="palette-results"
            role="listbox"
            aria-label={t("palette.title")}
            className="min-h-0 overflow-y-auto scrollbar-hide pb-2"
          >
            {results.length === 0 && (
              <div className="px-5 pt-5 text-body text-content-muted">{t("palette.noMatches")}</div>
            )}
            {results.map((entry, i) => {
              const head = entry.group !== lastGroup;
              lastGroup = entry.group;
              const on = i === Math.min(at, results.length - 1);
              return (
                <div key={`${entry.group}:${entry.id}`}>
                  {head && (
                    <div className="tab-caps px-5 pt-3 pb-1.5 text-content-muted">
                      {t(`palette.group.${entry.group}`)}
                    </div>
                  )}
                  <div
                    id={`palette-row-${i}`}
                    data-row={i}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => !on && setAt(i)}
                    onClick={() => run(entry, entry.primary)}
                    className={`mx-2 flex h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-body text-content ${EASE} ${on ? "bg-surface-highlight" : ""}`}
                  >
                    <RowLead lead={entry.lead} on={on} />
                    <span className="min-w-0 truncate">{entry.label}</span>
                    {entry.sub && (
                      <span
                        className={`min-w-0 shrink truncate text-meta text-content-muted ${entry.sub.startsWith("oct") ? "font-mono" : ""}`}
                      >
                        {entry.sub}
                      </span>
                    )}
                    {entry.hint && (
                      <span className="ml-auto shrink-0 text-meta text-content-muted tabular-nums">
                        {entry.hint}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="m-2 ml-0 min-h-0 overflow-hidden rounded-2xl bg-surface-highlight px-5.5 py-5">
            {picked && (
              <PalettePreview
                key={picked.id}
                preview={picked.preview}
                primary={picked.primary}
                secondary={picked.secondary}
                onRun={(action) => run(picked, action)}
              />
            )}
          </div>
        </div>
        <div className="flex h-10 items-center gap-3.5 bg-surface px-5 text-meta text-content-muted">
          <span className="inline-flex items-center gap-1.5">
            <Key>↑</Key>
            <Key>↓</Key>
            {t("palette.keyMove")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Key>↵</Key>
            {picked?.primary.label ?? t("palette.open")}
          </span>
          {picked?.secondary && (
            <span className="inline-flex items-center gap-1.5">
              <Key>⌘↵</Key>
              {picked.secondary.label}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Key>esc</Key>
            {t(mode === "root" ? "palette.keyClose" : "palette.keyBack")}
          </span>
        </div>
      </div>
    </div>
  );
}

function RowLead({ lead, on }: { lead: Lead; on: boolean }) {
  if ("address" in lead) return <WalletAvatar address={lead.address} size={26} />;
  const tile = `grid size-6.5 shrink-0 place-items-center rounded-lg text-content-secondary ${on ? "bg-(--bg-3)" : "bg-surface-highlight"}`;
  if ("letter" in lead)
    return <span className={`${tile} text-micro font-semibold`}>{lead.letter}</span>;
  const Icon = lead.icon;
  return (
    <span className={tile}>
      <Icon size={14} />
    </span>
  );
}
