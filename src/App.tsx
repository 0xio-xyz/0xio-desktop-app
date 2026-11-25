import { useTrayBridge } from "src/hooks/app/useTrayBridge";
import {
  Suspense,
  lazy,
  useState,
  useEffect,
  useRef,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { HistoryRouter, Routes, Route, useLocation, Navigate } from "src/lib/router";
import { createAppHistory } from "src/lib/appHistory";
import { QueryClient, QueryClientProvider, persistQueryClient } from "src/lib/query";
import { ThemeProvider } from "src/contexts/ThemeContext";
import { WalletProvider } from "src/contexts/WalletContext";
import { useWallet } from "src/contexts/useWallet";
import ErrorBoundary from "src/shared/layout/ErrorBoundary";
import ActivityToasts from "src/shared/layout/ActivityToasts";
import GlobalNetworkBanner from "src/shared/layout/GlobalNetworkBanner";
import LoadingSpinner from "src/shared/ui/LoadingSpinner";
import UpdateChecker from "src/shared/layout/UpdateChecker";
import { useDappBridge } from "src/features/dapp/hooks/useDappBridge";
import { useSiteRelay } from "src/features/dapp/hooks/useSiteRelay";
import { pendingSealWallet, sealGate } from "src/hooks/wallet/useNeedsBackup";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useAppearance } from "src/features/settings/hooks/useAppearance";
import { useNavigationGestures } from "src/hooks/ui/useNavigationGestures";
import { useFirstScreen } from "src/hooks/app/useFirstScreen";
import { installStorageQuotaGuard } from "src/lib/storageQuota";
import { pauseQueriesWhileHidden } from "src/lib/query/queryVisibility";
import { PERSIST_BUSTER, retryQuery, shouldPersistQuery } from "src/lib/query/queryDefaults";
import {
  afterFirstScreen,
  loadCommandPalette,
  loadDappApproval,
  loadHome,
  loadKeySwitchOverlay,
  loadLockScreen,
  loadNoticeSources,
  loadOnboarding,
  loadPairingReview,
  loadSidebar,
  shellLoaded,
} from "src/services/app/startup";

// Must run before the query persister (below) or any cache write touches localStorage.
installStorageQuotaGuard();

/** Reloads once (session flag) when a chunk hash from an older build no longer exists. */
function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  key: string,
): LazyExoticComponent<T> {
  return lazy(async () => {
    const flag = `chunk_reload_${key}`;
    try {
      const mod = await factory();
      sessionStorage.removeItem(flag);
      return mod;
    } catch (err) {
      if (!sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, "1");
        window.location.reload();
        // Return a never-resolving promise so nothing renders before reload.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}

const HomeScreen = lazyWithRetry(loadHome, "home");
const SendScreen = lazyWithRetry(() => import("src/features/wallet/screens/SendScreen"), "send");
const ReceiveScreen = lazyWithRetry(
  () => import("src/features/wallet/screens/ReceiveScreen"),
  "receive",
);
const PrivacyScreen = lazyWithRetry(
  () => import("src/features/privacy/screens/PrivacyScreen"),
  "privacy",
);
const HistoryScreen = lazyWithRetry(
  () => import("src/features/transactions/screens/HistoryScreen"),
  "history",
);
const SettingsScreen = lazyWithRetry(
  () => import("src/features/settings/screens/SettingsScreen"),
  "settings",
);
const OnboardingScreen = lazyWithRetry(loadOnboarding, "onboarding");
const LockScreen = lazyWithRetry(loadLockScreen, "lock");
const BackupScreen = lazyWithRetry(
  () => import("src/features/security/screens/BackupScreen"),
  "backup",
);
const WalletListScreen = lazyWithRetry(
  () => import("src/features/wallet/screens/WalletListScreen"),
  "wallets",
);
const ContractsScreen = lazyWithRetry(
  () => import("src/features/contracts/screens/ContractsScreen"),
  "contracts",
);
const BrowserScreen = lazyWithRetry(
  () => import("src/features/dapp/screens/BrowserScreen"),
  "browser",
);
const ConnectedSitesScreen = lazyWithRetry(
  () => import("src/features/dapp/screens/ConnectedSitesScreen"),
  "connected-sites",
);
const ConnectedSiteScreen = lazyWithRetry(
  () => import("src/features/dapp/screens/ConnectedSiteScreen"),
  "connected-site",
);
const CirclesScreen = lazyWithRetry(
  () => import("src/features/circles/screens/CirclesScreen"),
  "circles",
);
const NftGalleryScreen = lazyWithRetry(
  () => import("src/features/nft/screens/NftGalleryScreen"),
  "nfts",
);
const NftDetailScreen = lazyWithRetry(
  () => import("src/features/nft/screens/NftDetailScreen"),
  "nftdetail",
);
const AddressBookScreen = lazyWithRetry(
  () => import("src/features/wallet/screens/AddressBookScreen"),
  "addressbook",
);
const AdvancedScreen = lazyWithRetry(
  () => import("src/features/settings/automations/AdvancedScreen"),
  "advanced",
);
const TokenDetailScreen = lazyWithRetry(
  () => import("src/features/wallet/screens/TokenDetailScreen"),
  "token",
);
const CipherMapScreen = lazyWithRetry(
  () => import("src/features/privacy/screens/CipherMapScreen"),
  "ciphermap",
);

const Sidebar = lazyWithRetry(loadSidebar, "sidebar");
const CommandPalette = lazyWithRetry(loadCommandPalette, "palette");
const NoticeSources = lazyWithRetry(loadNoticeSources, "notices");
const PairingReview = lazyWithRetry(loadPairingReview, "pairing");
const KeySwitchOverlay = lazyWithRetry(loadKeySwitchOverlay, "keyswitch");
const DappApprovalModal = lazyWithRetry(loadDappApproval, "approval");
const DebugPanel = lazyWithRetry(() => import("src/shared/dev/DebugPanel"), "debug");

afterFirstScreen(pauseQueriesWhileHidden);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: retryQuery,
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000,
    },
    mutations: {
      gcTime: 60_000,
    },
  },
});

// WKWebView has a tight localStorage quota: a save that does not fit drops the oldest cached query and retries.
persistQueryClient(queryClient, {
  storage: window.localStorage,
  key: "0xio-query-cache",
  buster: PERSIST_BUSTER,
  maxAge: 7 * 24 * 60 * 60_000,
  shouldPersist: shouldPersistQuery,
});

function RouteGuard({ children }: { children: React.ReactNode }) {
  const { isInitialized, isLocked, isLoading, wallets } = useWallet();
  const location = useLocation();

  if (isLoading) return <LoadingSpinner fullScreen text="Loading..." />;

  if (!isInitialized && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }
  if (
    isInitialized &&
    isLocked &&
    location.pathname !== "/lock" &&
    location.pathname !== "/onboarding"
  ) {
    return <Navigate to="/lock" replace />;
  }
  // A wallet waiting for its seal (the app quit on its phrase step): finish that first.
  const gate = sealGate({ isInitialized, isLocked, wallets }, location.pathname);
  if (gate) return <Navigate to={gate} replace />;
  return <>{children}</>;
}

/** Takes over from the skeleton in index.html once a real screen commits. */
function FirstScreen() {
  useFirstScreen();
  return null;
}

function AppLayout() {
  const { isInitialized, isLocked, wallets } = useWallet();
  const location = useLocation();
  const [showDebug, setShowDebug] = useState(false);
  const unlocked = isInitialized && !isLocked;
  const shell = shellLoaded();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "open") setShowDebug(true);
      else if (detail === "close") setShowDebug(false);
      else setShowDebug((prev) => !prev);
    };
    window.addEventListener("toggle-debug-console", handler);
    return () => window.removeEventListener("toggle-debug-console", handler);
  }, []);

  useAppearance();

  // App is the single owner of the process-wide dapp bridges, so they register exactly once.
  const {
    pendingApproval,
    approveRequest,
    rejectRequest,
    auth: dappAuth,
  } = useDappBridge(undefined, {
    ownsGlobalBridges: true,
  });

  useTrayBridge();
  useSiteRelay();

  // A dapp window sits above the wallet, so an approval behind it is invisible. setFocus alone can be
  // ignored while another window of the app is active, so the wallet stays on top while an approval
  // is pending; the dock bounce covers a minimised wallet.
  const pinned = useRef(false);
  useEffect(() => {
    const win = getCurrentWindow();
    if (!pendingApproval) {
      if (pinned.current) void win.setAlwaysOnTop(false).catch(() => {});
      pinned.current = false;
      return;
    }
    pinned.current = true;
    void (async () => {
      try {
        await win.unminimize();
      } catch {}
      await win.setAlwaysOnTop(true).catch(() => {});
      await win.setFocus().catch(() => {});
      // Critical keeps bouncing until the user looks; Informational bounces once.
      await win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
    })();
  }, [pendingApproval]);

  // Locking puts the dapp windows away too - otherwise the browsing session outlives the lock.
  // Hidden, not closed, so the page and its session come back untouched on unlock.
  const lockSeen = useRef(isLocked);
  useEffect(() => {
    if (lockSeen.current === isLocked) return;
    lockSeen.current = isLocked;
    void invoke("dapp_set_windows_hidden", { hidden: isLocked }).catch(() => {});
  }, [isLocked]);

  useNavigationGestures();

  const showSidebar =
    unlocked &&
    !pendingSealWallet(wallets) &&
    !["/onboarding", "/lock"].includes(location.pathname);

  const Side = shell?.Sidebar ?? Sidebar;

  return (
    <div className="h-screen flex overflow-hidden bg-surface text-content">
      <ActivityToasts unlocked={unlocked} />
      <Suspense fallback={null}>{unlocked && <NoticeSources />}</Suspense>
      <Suspense fallback={null}>
        {(shell || pendingApproval) && (
          <DappApprovalModal
            approval={pendingApproval}
            onApprove={approveRequest}
            onReject={rejectRequest}
            auth={dappAuth}
          />
        )}
      </Suspense>
      <Suspense fallback={null}>{unlocked && <PairingReview />}</Suspense>
      <Suspense fallback={null}>{(shell || unlocked) && <KeySwitchOverlay />}</Suspense>
      <Suspense fallback={null}>{showSidebar && <CommandPalette />}</Suspense>
      <GlobalNetworkBanner />
      <UpdateChecker />
      <Suspense fallback={null}>{showSidebar && <Side />}</Suspense>
      {/* content-area is the modal portal target, so modals center over the content, not the sidebar. */}
      <div id="content-area" className="relative flex-1 flex flex-col overflow-hidden">
        <main className="@container flex-1 overflow-y-auto scrollbar-hide">
          <Suspense fallback={<LoadingSpinner fullScreen />}>
            <RouteGuard>
              <FirstScreen />
              <Routes>
                <Route path="/" element={<HomeScreen />} />
                <Route path="/onboarding" element={<OnboardingScreen />} />
                <Route path="/lock" element={<LockScreen />} />
                <Route path="/backup" element={<BackupScreen />} />
                <Route path="/send" element={<SendScreen />} />
                <Route path="/receive" element={<ReceiveScreen />} />
                <Route path="/privacy" element={<PrivacyScreen />} />
                <Route path="/history" element={<HistoryScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="/contracts" element={<ContractsScreen />} />
                <Route path="/browser" element={<BrowserScreen />} />
                <Route path="/connected-sites" element={<ConnectedSitesScreen />} />
                <Route path="/connected-sites/site" element={<ConnectedSiteScreen />} />
                <Route path="/circles" element={<CirclesScreen />} />
                <Route path="/nfts" element={<NftGalleryScreen />} />
                <Route path="/nfts/:contract/:tokenId" element={<NftDetailScreen />} />
                <Route path="/wallets" element={<WalletListScreen />} />
                <Route path="/batch-send" element={<Navigate to="/send?tab=batch" replace />} />
                <Route path="/advanced" element={<AdvancedScreen />} />
                <Route path="/address-book" element={<AddressBookScreen />} />
                <Route path="/token" element={<TokenDetailScreen />} />
                <Route path="/cipher-map" element={<CipherMapScreen />} />
              </Routes>
            </RouteGuard>
          </Suspense>
        </main>
        {showDebug && (
          <Suspense fallback={null}>
            <DebugPanel onClose={() => setShowDebug(false)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

const appHistory = createAppHistory();

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HistoryRouter history={appHistory}>
          <ThemeProvider>
            <WalletProvider>
              <AppLayout />
            </WalletProvider>
          </ThemeProvider>
        </HistoryRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
