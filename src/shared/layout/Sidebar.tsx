import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import "src/css/look-ext.css";
import "src/css/sidebar.css";
import { useWallet } from "src/contexts/useWallet";
import { useAppearance } from "src/features/settings/hooks/useAppearance";
import { useSyncStatus } from "src/hooks/app/useSyncStatus";
import { useClaimableCount } from "src/hooks/privacy/useClaimableCount";
import { NARROW_PX, useSidebarCollapsed } from "src/hooks/ui/useSidebarCollapsed";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import { sidebarFloats } from "src/features/contracts/components/editor/dockLayout";
import { NETWORKS, isCustomNetwork } from "src/services/network/config";
import NamedAddress from "src/shared/ui/NamedAddress";
import { truncateAddress } from "src/lib/format";
import { isTestnetId } from "src/features/transactions/history/sides";
import { NAV_LABEL_KEYS } from "src/shared/layout/navCatalog";
import WalletMenu, { networkShortName, type MenuPlacement } from "src/shared/layout/WalletMenu";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import {
  HomeIcon,
  SendIcon,
  PrivacyIcon,
  HistoryIcon,
  ReceiveIcon,
  NftsIcon,
  ContractsIcon,
  WalletsIcon,
  AddressBookIcon,
  DappsIcon,
  CirclesIcon,
  CipherMapIcon,
  AutomationsIcon,
  SettingsIcon,
  ExpandIcon,
  PanelIcon,
  UpDownIcon,
} from "src/shared/layout/navIcons";

type Icon = React.ComponentType<{ size?: number; className?: string; live?: boolean }>;

const NAV_ICONS: Record<string, Icon> = {
  "/": HomeIcon,
  "/send": SendIcon,
  "/privacy": PrivacyIcon,
  "/history": HistoryIcon,
  "/receive": ReceiveIcon,
  "/nfts": NftsIcon,
  "/contracts": ContractsIcon,
  "/wallets": WalletsIcon,
  "/address-book": AddressBookIcon,
  "/browser": DappsIcon,
  "/circles": CirclesIcon,
  "/cipher-map": CipherMapIcon,
  "/advanced": AutomationsIcon,
};

const PRIVACY_PATHS = new Set([
  "/privacy",
  "/contracts",
  "/browser",
  "/circles",
  "/cipher-map",
  "/advanced",
]);

const EXPANDED_W = 256;
const RAIL_W = 76;
const CELL = 44;

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset";
const ROW = `side-press flex items-center cursor-pointer ${FOCUS}`;
const IDLE = "text-content-secondary hover:bg-(--hover) hover:text-content";
const QUIET = "text-content-muted hover:bg-(--hover) hover:text-content";
const ON = "bg-surface-card font-medium text-content";
const CHIP =
  "inline-flex h-6.5 items-center gap-1.5 rounded-full bg-surface-card px-2 whitespace-nowrap text-content-secondary";

const NAV_MASK = { maskImage: "linear-gradient(to bottom, black calc(100% - 24px), transparent)" };

/** The Contracts page's side padding (Screen wide: 8 left, 24 right). */
const CONTRACTS_PADDING = 32;

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const windowWidth = () => window.innerWidth;

function isActivePath(pathname: string, path: string) {
  return pathname === path || (path !== "/" && pathname.startsWith(`${path}/`));
}

function networkSide(id: string) {
  if (id === "mainnet") return "Mainnet";
  if (isTestnetId(id)) return "Testnet";
  return isCustomNetwork(id) ? "Custom" : networkShortName(id);
}

interface Menu {
  anchor: HTMLElement;
  placement: MenuPlacement;
}

interface Tip {
  label: string;
  rect: DOMRect;
}

export default React.memo(function Sidebar() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { networkId, activeWallet } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const { extensionConnected, isComputing } = useSyncStatus();
  const claimableCount = useClaimableCount();
  const { settings, update } = useAppearance();
  const { sizes } = settings;

  const saveCollapsed = useCallback(
    (sidebarCollapsed: boolean) => update({ ...settings, sidebarCollapsed }),
    [settings, update],
  );
  const { collapsed, toggle } = useSidebarCollapsed(settings.sidebarCollapsed, saveCollapsed);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [cut, setCut] = useState({ path: pathname, collapsed, go: false });
  if (cut.path !== pathname || cut.collapsed !== collapsed) {
    setCut({ path: pathname, collapsed, go: cut.path !== pathname });
  }
  const asideRef = useRef<HTMLElement>(null);
  const winW = useSyncExternalStore(subscribeResize, windowWidth);
  // On a narrow window, and on Contracts when pushing would squeeze the editor under its minimum,
  // an expanded sidebar floats over the page; elsewhere it pushes.
  const floating =
    !collapsed &&
    (winW < NARROW_PX ||
      (pathname.startsWith("/contracts") && sidebarFloats(winW, CONTRACTS_PADDING)));
  const go = (path: string) => {
    if (floating) toggle();
    navigate(path);
  };

  const groups = useMemo(
    () =>
      settings.groups
        .map((g) => ({
          id: g.id,
          title: g.title,
          paths: g.paths.filter(
            (p) => p in NAV_LABEL_KEYS && (!PRIVACY_PATHS.has(p) || privacyEnabled),
          ),
        }))
        .filter((g) => g.paths.length > 0),
    [settings.groups, privacyEnabled],
  );

  const toggleCollapsed = () => {
    setMenu(null);
    setTip(null);
    toggle();
  };

  const openMenu = (e: React.MouseEvent<HTMLElement>, placement: MenuPlacement) => {
    const anchor = e.currentTarget;
    setTip(null);
    setMenu((m) => (m?.anchor === anchor ? null : { anchor, placement }));
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  useOutsideClose(asideRef, floating && !menu, toggle);

  const tipFor = (label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) =>
      setTip({ label, rect: e.currentTarget.getBoundingClientRect() }),
    onFocus: (e: React.FocusEvent<HTMLElement>) =>
      setTip({ label, rect: e.currentTarget.getBoundingClientRect() }),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null),
  });

  const extText = extensionConnected ? (isComputing ? "Proving" : "Extension") : "No extension";
  const extTitle = extensionConnected
    ? isComputing
      ? "Extension connected, computing a proof"
      : "Extension connected"
    : "No extension connected";
  const extDot = extensionConnected
    ? `bg-positive ${isComputing ? "motion-safe:animate-pulse" : ""}`
    : "bg-content-muted";
  const networkName = NETWORKS[networkId]?.name ?? networkShortName(networkId);

  const walletName = activeWallet?.name ?? "";
  const width = collapsed ? RAIL_W : EXPANDED_W;
  const badge = (path: string) => (path === "/privacy" ? claimableCount : 0);

  const rail = (
    <div style={{ width: RAIL_W }} className="flex h-full flex-col items-center pt-5 pb-4">
      <button
        onClick={(e) => openMenu(e, "right")}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={walletName}
        {...tipFor(walletName)}
        className={`mb-4.5 shrink-0 rounded-[10px] ${FOCUS}`}
      >
        <WalletAvatar address={activeWallet?.address} size={32} />
      </button>
      <nav
        aria-label="Main"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto scrollbar-hide"
      >
        {groups.map((g) => (
          <React.Fragment key={g.id}>
            {g.paths.map((path) => {
              const Icon = NAV_ICONS[path];
              const active = isActivePath(pathname, path);
              const label = t(NAV_LABEL_KEYS[path]);
              return (
                <button
                  key={path}
                  onClick={() => go(path)}
                  aria-label={badge(path) > 0 ? `${label} (${badge(path)})` : label}
                  aria-current={active ? "page" : undefined}
                  {...tipFor(label)}
                  style={{ width: CELL }}
                  className={`${ROW} relative h-10 shrink-0 justify-center rounded-xl ${active ? ON : IDLE}`}
                >
                  <Icon size={sizes.itemIconPx} live />
                  {badge(path) > 0 && (
                    <span className="absolute top-2 right-2 size-1.5 rounded-full bg-positive" />
                  )}
                </button>
              );
            })}
            <span className="h-3.5 shrink-0" />
          </React.Fragment>
        ))}
      </nav>
      <button
        onClick={() => go("/settings")}
        aria-label="Settings"
        aria-current={pathname === "/settings" ? "page" : undefined}
        {...tipFor("Settings")}
        style={{ width: CELL }}
        className={`${ROW} h-10 shrink-0 justify-center rounded-xl ${pathname === "/settings" ? ON : IDLE}`}
      >
        <SettingsIcon size={sizes.itemIconPx} live />
      </button>
      <button
        onClick={toggleCollapsed}
        aria-label="Expand sidebar"
        {...tipFor("Expand sidebar")}
        style={{ width: CELL }}
        className={`${ROW} ${QUIET} h-10 shrink-0 justify-center rounded-xl`}
      >
        <ExpandIcon size={sizes.itemIconPx} />
      </button>
      <span
        role="img"
        aria-label={`${extTitle} on ${networkName}`}
        {...tipFor(extTitle)}
        className="grid h-7.5 shrink-0 place-items-center px-2"
      >
        <span className={`size-1.5 rounded-full ${extDot}`} />
      </span>
    </div>
  );

  const list = (
    <div style={{ width: EXPANDED_W }} className="flex h-full flex-col px-3.5 pt-4.5 pb-4">
      <button
        onClick={(e) => openMenu(e, "below")}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="Switch wallet or network"
        className={`${ROW} ${IDLE} mb-4.5 h-13 shrink-0 gap-2.75 rounded-[14px] px-2.5 text-left`}
      >
        <WalletAvatar address={activeWallet?.address} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold text-content">
            {walletName}
          </span>
          <NamedAddress
            address={activeWallet?.address}
            className="mt-0.5 flex text-[13px] text-content-muted tabular-nums"
          >
            {activeWallet ? truncateAddress(activeWallet.address) : ""}
          </NamedAddress>
        </span>
        <UpDownIcon size={14} className="shrink-0 text-content-muted" />
      </button>

      <nav
        aria-label="Main"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto scrollbar-hide pb-6"
        style={NAV_MASK}
      >
        {groups.map((g, gi) => (
          <React.Fragment key={g.id}>
            {gi > 0 && (
              <div
                style={{ fontSize: sizes.categoryPx }}
                className="tab-caps shrink-0 truncate px-3.5 pt-5.5 pb-2 text-content-muted"
              >
                {g.title}
              </div>
            )}
            {g.paths.map((path) => {
              const Icon = NAV_ICONS[path];
              const active = isActivePath(pathname, path);
              const count = badge(path);
              return (
                <button
                  key={path}
                  onClick={() => go(path)}
                  aria-current={active ? "page" : undefined}
                  style={{ fontSize: sizes.itemLabelPx }}
                  className={`${ROW} h-9.5 w-full shrink-0 gap-3 rounded-xl px-3.5 text-left ${active ? ON : IDLE}`}
                >
                  <Icon size={sizes.itemIconPx} live />
                  <span className="truncate">{t(NAV_LABEL_KEYS[path])}</span>
                  {count > 0 && (
                    <span className="ml-auto pl-2 text-[12px] font-medium text-positive tabular-nums">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </nav>

      <button
        onClick={() => go("/settings")}
        aria-current={pathname === "/settings" ? "page" : undefined}
        style={{ fontSize: sizes.itemLabelPx }}
        className={`${ROW} mt-2.5 h-9.5 w-full shrink-0 gap-3 rounded-xl px-3.5 text-left ${pathname === "/settings" ? ON : IDLE}`}
      >
        <SettingsIcon size={sizes.itemIconPx} live />
        <span className="truncate">Settings</span>
      </button>

      <div className="mt-3 flex shrink-0 items-center gap-1.5">
        <span title={extTitle} className={`${CHIP} text-[11.5px]`}>
          <span className={`size-1.5 shrink-0 rounded-full ${extDot}`} />
          {extText}
        </span>
        <button
          onClick={(e) => openMenu(e, "above")}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={`Network ${networkName}`}
          title={networkName}
          className={`${CHIP} cursor-pointer text-[10px] font-medium tracking-[0.14em] uppercase transition-colors hover:text-content ${FOCUS}`}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${networkId === "mainnet" ? "bg-positive" : "bg-content-muted"}`}
          />
          {networkSide(networkId)}
        </button>
        <button
          onClick={toggleCollapsed}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className={`${ROW} ${QUIET} ml-auto size-7 shrink-0 justify-center rounded-[9px]`}
        >
          <PanelIcon size={16} />
        </button>
      </div>
    </div>
  );

  const aside = (
    <aside
      ref={asideRef}
      data-look="ext"
      data-cut={cut.go ? "go" : "rest"}
      style={{ width }}
      className={
        floating
          ? "fixed top-0 left-0 z-40 h-screen overflow-hidden bg-surface shadow-[24px_0_60px_-20px_rgba(0,0,0,0.95)] animate-in slide-in-from-left-3 duration-200 ease-out motion-reduce:animate-none"
          : "h-screen shrink-0 overflow-hidden bg-surface transition-[width] duration-250 ease-out motion-reduce:transition-none"
      }
    >
      {collapsed ? rail : list}
      {menu && <WalletMenu anchor={menu.anchor} placement={menu.placement} onClose={closeMenu} />}
      {collapsed && tip && (
        <div
          aria-hidden="true"
          style={{ left: tip.rect.right + 8, top: tip.rect.top + tip.rect.height / 2 }}
          className="pointer-events-none fixed z-50 flex h-7.5 -translate-y-1/2 items-center rounded-[10px] bg-(--bg-3) px-3 text-[13px] font-medium whitespace-nowrap text-content look-raise"
        >
          {tip.label}
        </div>
      )}
    </aside>
  );

  return floating ? (
    <>
      <div aria-hidden="true" style={{ width: RAIL_W }} className="h-screen shrink-0" />
      {aside}
    </>
  ) : (
    aside
  );
});
