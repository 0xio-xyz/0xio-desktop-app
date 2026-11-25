import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  isStagedFrameUrl,
  stageDataUrl,
  stageFrameAsset,
  stageFrameDocument,
} from "src/services/sites/frameStage";
import { useTranslation } from "src/i18n/react";
import {
  Globe,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Loader,
  Home,
  ExternalLink,
  Search,
  AppWindow,
  Star,
  AlertTriangle,
  Settings,
} from "src/shared/ui/icons";
import { invoke } from "@tauri-apps/api/core";
import { getDApps, type DApp } from "src/features/dapp/services/ecosystemService";
import { Screen, PageTitle, Action, ScrollArea } from "src/shared/ui/flat";
import { Btn, Caps, EASE, FOCUS, KV } from "src/shared/ui/look";
import BrowserSettingsPopup from "src/features/dapp/components/BrowserSettingsPopup";
import { networkLabel } from "src/features/transactions/history/sides";
import Mascot from "src/shared/ui/Mascot";
import SealedCircleModal from "src/features/privacy/components/SealedCircleModal";
import DappApprovalModal from "src/features/dapp/components/DappApprovalModal";
import { announceSiteWallet, useDappBridge } from "src/features/dapp/hooks/useDappBridge";
import SiteChip from "src/features/dapp/components/SiteChip";
import { useDappSites } from "src/features/dapp/hooks/useDappSites";
import { useNavigate } from "src/lib/router";
import { useWallet } from "src/contexts/useWallet";
import {
  loadBrowserSecurity,
  saveBrowserSecurity,
  isBlockedInsecureUrl,
  type BrowserSecuritySettings,
} from "src/features/dapp/services/browserSecurity";
import { NETWORKS } from "src/services/network/config";
import { openInSystemBrowser } from "src/lib/openExternal";
import { logger } from "src/lib/logger";
import { openSealedAsset, type SealedAsset } from "src/features/circles/services/circleSealed";
import {
  circleRpc,
  fetchCircleInfo,
  fetchSealedAsset,
  type CircleReader,
} from "src/features/dapp/services/circleRead";
import { getDesktopProviderScript } from "src/features/dapp/services/walletProviderScript";
import {
  createBridgeContext,
  getCircleBridgePrelude,
  handleBridgeMethod,
  type CircleBridgeContext,
} from "src/features/dapp/services/circleBridgeService";
import { createCircleAccess } from "src/features/dapp/services/circleAccess";
import {
  bytesToB64,
  resolveCircleAsset,
  type CircleAsset,
} from "src/features/circles/services/circleAsset";
import { wholeCirclePage } from "src/features/circles/services/circlePage";
import { cutId } from "src/features/circles/services/circleFormat";
import { openCircle } from "src/services/names/onsService";
import { RETRYABLE, onsDisplay, onsReasonKey } from "src/hooks/wallet/useOns";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import { isNameInput, normalizeName } from "src/services/names/ons";

const MAX_BOOKMARKS = 20;

const TOOL = `grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-content-secondary hover:bg-surface-highlight hover:text-content disabled:cursor-default disabled:opacity-30 ${EASE} ${FOCUS}`;
const MAX_HISTORY = 50;

interface Bookmark {
  url: string;
  title: string;
  addedAt: number;
}

interface CircleShown {
  address: string;
  name: string | null;
}

interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

function loadBookmarks(): Bookmark[] {
  try {
    return JSON.parse(localStorage.getItem("0xio_browser_bookmarks") || "[]");
  } catch {
    return [];
  }
}

function saveBookmarks(bm: Bookmark[]) {
  localStorage.setItem("0xio_browser_bookmarks", JSON.stringify(bm));
}

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem("0xio_browser_history") || "[]");
  } catch {
    return [];
  }
}

function saveHistory(h: HistoryEntry[]) {
  localStorage.setItem("0xio_browser_history", JSON.stringify(h));
}

const OCT_SHORTCUTS: Record<string, string> = {
  dex: "https://dex.0xio.xyz",
  bridge: "https://bridge.0xio.xyz",
  docs: "https://docs.0xio.xyz",
  explorer: "https://octrascan.io",
  home: "https://0xio.xyz",
};

function parseCircleUri(input: string): { circleId: string; path: string } | null {
  if (!input.toLowerCase().startsWith("oct://")) return null;
  const rest = input.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return null;
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return { circleId: rest, path: "/index.html" };
  const circleId = rest.slice(0, slashIdx);
  const path = rest.slice(slashIdx) || "/index.html";
  return circleId ? { circleId, path } : null;
}

function nameAddress(uri: string, circleId: string, name: string | null): string {
  const to = name ? parseCircleUri(uri) : null;
  return to && to.circleId === circleId ? `oct://${name}${uri.slice(6 + circleId.length)}` : uri;
}

async function fetchCircleAsset(
  rpcUrl: string,
  circleId: string,
  path: string,
): Promise<CircleAsset | null> {
  try {
    return await resolveCircleAsset((p) => circleRpc(rpcUrl, "circle_asset", [circleId, p]), path);
  } catch (e) {
    logger.warn("browser", `circle_asset ${circleId.slice(0, 12)} ${path} failed: ${e}`);
    return null;
  }
}

// A binary string from atob() is raw bytes (chars 0-255); decode as UTF-8 to a
// proper Unicode string before doing string work on it.
function binaryToText(binary: string): string {
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

async function decryptSealedContent(
  circleId: string,
  asset: SealedAsset,
  passphrase: string,
): Promise<{ content_type: string; dataUrl: string }> {
  const plaintext = await openSealedAsset(circleId, asset, passphrase);
  const ct = asset.content_type || "text/html";
  return { content_type: ct, dataUrl: `data:${ct};base64,${bytesToB64(plaintext)}` };
}

async function resolveCircleAssets(
  rpcUrl: string,
  html: string,
  circleId: string,
  currentPath: string,
  passphrase?: string,
  reader?: CircleReader | null,
): Promise<string> {
  return wholeCirclePage(html, circleId, currentPath, async (id, path) => {
    if (!passphrase) return fetchCircleAsset(rpcUrl, id, path);
    const asset = await fetchSealedAsset(rpcUrl, id, path, reader);
    return {
      contentType: asset.content_type || "application/octet-stream",
      bytes: await openSealedAsset(id, asset, passphrase),
    };
  });
}

function resolveOctProtocol(input: string): string | null {
  if (!input.startsWith("oct://")) return null;
  const rest = input.slice(6);
  const [route, ...parts] = rest.split("/");
  const key = route.toLowerCase();

  if (OCT_SHORTCUTS[key])
    return parts.length ? `${OCT_SHORTCUTS[key]}/${parts.join("/")}` : OCT_SHORTCUTS[key];

  if (key === "tx" && parts[0]) return `https://octrascan.io/tx.html?hash=${parts[0]}`;

  if (key === "address" && parts[0]) return `https://octrascan.io/address.html?addr=${parts[0]}`;

  return null;
}

function injectCircleScripts(html: string, bridgeContext: CircleBridgeContext): string {
  const providerScript = getDesktopProviderScript();
  const bridgePrelude = getCircleBridgePrelude(bridgeContext);
  const injection = `<script>${providerScript}\n${bridgePrelude}</script>`;

  if (html.includes("</head>")) {
    return html.replace("</head>", `${injection}</head>`);
  }
  if (html.includes("<body")) {
    return html.replace(/<body/i, `${injection}<body`);
  }
  return `${injection}${html}`;
}

function isValidUrl(str: string): boolean {
  if (/^(javascript|data|file|blob):/i.test(str)) return false;
  if (/^oct:\/\//i.test(str)) return true;
  if (/^(https?:\/\/)?localhost(:\d+)?(\/|$)/i.test(str)) return true;
  if (/^(https?:\/\/)?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(str)) return true;
  try {
    new URL(str.includes("://") ? str : `https://${str}`);
    return str.includes(".");
  } catch {
    return false;
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const octResolved = resolveOctProtocol(trimmed);
  if (octResolved) return octResolved;
  if (isValidUrl(trimmed)) {
    if (trimmed.includes("://")) return trimmed;
    if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
    return `https://${trimmed}`;
  }
  // A non-address is reported, never searched: search engines refuse to be framed.
  return "";
}

const UNFRAMEABLE_KEY = "0xio_browser_unframeable_v2";

/**
 * Hosts known to refuse embedding (X-Frame-Options / frame-ancestors). A refused frame fires no
 * load and no error event, so each host is tried once and remembered. Seeded with search engines,
 * which never render here.
 */
function loadUnframeable(): Set<string> {
  const seed = ["www.google.com", "google.com", "duckduckgo.com", "www.bing.com", "bing.com"];
  try {
    const raw = localStorage.getItem(UNFRAMEABLE_KEY);
    const stored = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set([...seed, ...stored]);
  } catch {
    return new Set(seed);
  }
}

function rememberUnframeable(host: string): void {
  if (!host) return;
  try {
    const raw = localStorage.getItem(UNFRAMEABLE_KEY);
    const stored = raw ? (JSON.parse(raw) as string[]) : [];
    if (!stored.includes(host)) {
      localStorage.setItem(UNFRAMEABLE_KEY, JSON.stringify([...stored, host].slice(-200)));
    }
  } catch {}
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function getInitials(title: string): string {
  return title.slice(0, 2).toUpperCase();
}

export default function BrowserScreen() {
  const { t } = useTranslation();
  const { networkId, setNetworkId, activeWallet } = useWallet();
  const rpcBaseUrl = useMemo(
    () => NETWORKS[networkId]?.rpcUrl ?? NETWORKS["devnet"].rpcUrl,
    [networkId],
  );
  const [url, setUrl] = useState(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
    return params.get("url") || "";
  });
  const [inputValue, setInputValue] = useState(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
    return params.get("url") || "";
  });
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [circlePassphrase, setCirclePassphrase] = useState<{
    circleId: string;
    pass: string;
  } | null>(null);
  const [sealedModal, setSealedModal] = useState<{
    circleId: string;
    path: string;
    bridgeCtx: CircleBridgeContext;
    shown: CircleShown;
  } | null>(null);
  const [circleError, setCircleError] = useState("");
  const [circlePage, setCirclePage] = useState<CircleShown | null>(null);
  const [openError, setOpenError] = useState<{
    address: string;
    text: string;
    retry: boolean;
  } | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const tagRef = useRef<HTMLDivElement>(null);
  const closeTag = useCallback(() => setTagOpen(false), []);
  useOutsideClose(tagRef, tagOpen, closeTag);
  const [webSearch, setWebSearch] = useState<string | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unframeable = useRef<Set<string>>(loadUnframeable());
  const [security, setSecurity] = useState<BrowserSecuritySettings>(() => loadBrowserSecurity());
  const [circleNetworkMismatch, setCircleNetworkMismatch] = useState<{
    foundOn: string;
    url: string;
  } | null>(null);
  const mismatch =
    circleNetworkMismatch && circleNetworkMismatch.foundOn !== networkId
      ? circleNetworkMismatch
      : null;
  const switchAndOpen = () => {
    if (!mismatch) return;
    pendingCircleNavigate.current = mismatch.url;
    setNetworkId(mismatch.foundOn);
    setCircleNetworkMismatch(null);
  };
  const pendingCircleNavigate = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const navHistoryStack = useRef<string[]>([]);
  const navHistoryIndex = useRef(-1);
  const navTurn = useRef(0);

  const { pendingApproval, approveRequest, rejectRequest, signalWalletReady, auth, askConnect } =
    useDappBridge(iframeRef, {
      // A staged circle page has an opaque origin shared by every circle; it speaks as its circle.
      pageOrigin: () =>
        circleBridgeCtxRef.current &&
        iframeRef.current?.getAttribute("src") === circleFrameRef.current.url
          ? `oct://${circleBridgeCtxRef.current.circle_id}`
          : null,
    });
  const openWalletRef = useRef(activeWallet);
  openWalletRef.current = activeWallet;
  const networkIdRef = useRef(networkId);
  networkIdRef.current = networkId;
  const circleAccess = useMemo(
    () =>
      createCircleAccess({
        network: () => networkIdRef.current,
        openWallet: () => {
          const w = openWalletRef.current;
          return w
            ? { id: w.id, address: w.address, name: w.name, wallet_type: w.wallet_type }
            : null;
        },
        ask: askConnect,
        announce: (origin, w) => void announceSiteWallet([origin], w),
      }),
    [askConnect],
  );

  const circleBridgeCtxRef = useRef<CircleBridgeContext | null>(null);
  const circleFrameRef = useRef<{ url: string; name: string | null }>({ url: "", name: null });
  const present = useCallback(
    (next: string, ctx: CircleBridgeContext | null, shown: CircleShown | null = null) => {
      circleBridgeCtxRef.current = ctx;
      circleFrameRef.current = { url: ctx ? next : "", name: (ctx && shown?.name) || null };
      setCirclePage(ctx ? shown : null);
      setOpenError(null);
      setWebSearch(null);
      setBlockedUrl(null);
      setTagOpen(false);
      setUrl(next);
    },
    [],
  );
  const navigateRef = useRef<((url: string, opts?: { within?: string }) => void) | null>(null);

  useEffect(() => {
    const handleCircleBridgeMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== "octra-circle-bridge") return;
      const ctx = circleBridgeCtxRef.current;
      if (!ctx || data.token !== ctx.bridge_token) return;

      if (data.type === "octra.circle.navigate") {
        if (data.uri && typeof data.uri === "string" && navigateRef.current) {
          const shownAs = nameAddress(data.uri, ctx.circle_id, circleFrameRef.current.name);
          navigateRef.current(
            shownAs,
            shownAs === data.uri ? undefined : { within: ctx.circle_id },
          );
        }
        return;
      }

      if (data.type !== "octra.circle.bridge.request") return;

      const iframe = iframeRef.current;
      const reply = (ok: boolean, result?: unknown, error?: string, code?: string) => {
        if (!iframe?.contentWindow) return;
        iframe.contentWindow.postMessage(
          {
            token: ctx.bridge_token,
            type: "octra.circle.bridge.reply",
            id: data.id,
            ok,
            result: ok ? result : undefined,
            error: ok ? undefined : error,
            code: ok ? undefined : code,
          },
          "*",
        );
      };

      try {
        const result = await handleBridgeMethod(ctx, data.method, data.payload || {}, () =>
          circleAccess(ctx.circle_id),
        );
        reply(true, result);
      } catch (err: any) {
        const msg = err?.message || "Bridge error";
        reply(false, undefined, msg, typeof err?.code === "string" ? err.code : undefined);
      }
    };

    window.addEventListener("message", handleCircleBridgeMessage);
    return () => window.removeEventListener("message", handleCircleBridgeMessage);
  }, [circleAccess]);

  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [showBrowserSettings, setShowBrowserSettings] = useState(false);
  // null while loading. Empty means the registry could not be reached: there is no built-in list.
  const [ecosystem, setEcosystem] = useState<DApp[] | null>(null);
  const [ecoTry, setEcoTry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getDApps().then((list) => {
      if (!cancelled) setEcosystem(list);
    });
    return () => {
      cancelled = true;
    };
  }, [ecoTry]);
  const connectedSites = useDappSites(networkId);
  const routerNavigate = useNavigate();

  // Security: a staged URL carries the document's secret path; only the oct:// address leaves.
  const address = useCallback(
    () => (isStagedFrameUrl(url) ? (circlePage?.address ?? "") : url),
    [url, circlePage],
  );
  const isBookmarked = useMemo(
    () => bookmarks.some((b) => b.url === address()),
    [bookmarks, address],
  );

  const circleId = circleBridgeCtxRef.current?.circle_id;
  const chipOrigin = useMemo(() => {
    if (circleId) return `oct://${circleId}`;
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch {
      return null;
    }
  }, [url, circleId]);

  const opened =
    circlePage?.name && circleId && inputValue === circlePage.address
      ? { name: circlePage.name, circleId }
      : null;
  const copyCircleId = () => {
    if (!circleId) return;
    void navigator.clipboard.writeText(circleId);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 1500);
  };

  const addToHistory = useCallback((navUrl: string) => {
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.url !== navUrl);
      const updated = [
        { url: navUrl, title: getDomain(navUrl), visitedAt: Date.now() },
        ...filtered,
      ].slice(0, MAX_HISTORY);
      saveHistory(updated);
      return updated;
    });
  }, []);

  const readerId = activeWallet?.id;
  const readerAddress = activeWallet?.address;
  const reader = useMemo(
    () => (readerId && readerAddress ? { id: readerId, address: readerAddress } : null),
    [readerId, readerAddress],
  );

  // Throws on a wrong passphrase so the modal shows the error and stays open.
  const renderSealedCircle = useCallback(
    async (
      circleId: string,
      path: string,
      bridgeCtx: CircleBridgeContext,
      pass: string,
      shown: CircleShown,
    ) => {
      const sealedAsset = await fetchSealedAsset(rpcBaseUrl, circleId, path, reader);
      const decrypted = await decryptSealedContent(circleId, sealedAsset, pass);
      if (decrypted.content_type.startsWith("text/html")) {
        const htmlContent = binaryToText(atob(decrypted.dataUrl.split(",")[1]));
        const resolved = await resolveCircleAssets(
          rpcBaseUrl,
          htmlContent,
          circleId,
          path,
          pass,
          reader,
        );
        const injected = injectCircleScripts(resolved, bridgeCtx);
        present(await stageFrameDocument(injected, "page"), bridgeCtx, shown);
      } else {
        present(await stageDataUrl(decrypted.dataUrl), bridgeCtx, shown);
      }
      logger.info(
        "browser",
        `circle loaded (sealed+bridge) - id=${circleId} type=${decrypted.content_type}`,
      );
    },
    [rpcBaseUrl, reader, present],
  );

  const navigate = useCallback(
    async (target: string, opts: { push?: boolean; fresh?: boolean; within?: string } = {}) => {
      const trimmed = target.trim();
      const turn = ++navTurn.current;
      setCircleError("");
      setCircleNetworkMismatch(null);

      const typed = parseCircleUri(trimmed);
      if (typed && !resolveOctProtocol(trimmed)) {
        const named = isNameInput(typed.circleId);
        const parsedName = named ? normalizeName(typed.circleId) : null;
        const name = parsedName?.ok ? onsDisplay(parsedName.name) : null;
        const shown: CircleShown = {
          address: name ? `oct://${name}${trimmed.slice(6 + typed.circleId.length)}` : trimmed,
          name,
        };
        setInputValue(shown.address);
        setIsLoading(true);

        if (opts.push !== false) {
          navHistoryStack.current = navHistoryStack.current.slice(0, navHistoryIndex.current + 1);
          navHistoryStack.current.push(shown.address);
          navHistoryIndex.current = navHistoryStack.current.length - 1;
          setCanGoBack(navHistoryIndex.current > 0);
          setCanGoForward(false);
          addToHistory(shown.address);
        }

        const refuse = (text: string, retry: boolean) => {
          if (!named) {
            setOpenError(null);
            setCircleError(text);
            return;
          }
          present("", null);
          setOpenError({ address: shown.address, text, retry });
        };

        let circleTarget = typed;
        if (name && opts.within) {
          circleTarget = { circleId: opts.within, path: typed.path };
        } else if (named) {
          const found = await openCircle(typed.circleId, { networkId, fresh: opts.fresh });
          if (turn !== navTurn.current) return;
          if (found.ok !== true) {
            logger.warn("browser", `name did not open - ${shown.address}: ${found.reason}`);
            refuse(
              t(
                found.reason === "not_set"
                  ? "ons.reason.circle_not_set"
                  : onsReasonKey(found.reason),
              ),
              RETRYABLE.has(found.reason),
            );
            setIsLoading(false);
            return;
          }
          const before = circleFrameRef.current.name === name && circleBridgeCtxRef.current;
          if (before && before.circle_id !== found.circleId)
            logger.warn(
              "browser",
              `name moved - ${name} from=${before.circle_id} to=${found.circleId}`,
            );
          circleTarget = { circleId: found.circleId, path: typed.path };
        }

        logger.info(
          "browser",
          `circle navigate - id=${circleTarget.circleId} path=${circleTarget.path} network=${networkId}`,
        );

        const bridgeCtx = createBridgeContext(circleTarget.circleId, circleTarget.path);
        const passphrase =
          circlePassphrase?.circleId === circleTarget.circleId ? circlePassphrase.pass : "";

        try {
          const info = await fetchCircleInfo(rpcBaseUrl, circleTarget.circleId, reader);
          if (info?.resource_mode === "sealed_read") {
            if (!passphrase) {
              logger.debug(
                "browser",
                `circle sealed - passphrase required id=${circleTarget.circleId}`,
              );
              setSealedModal({
                circleId: circleTarget.circleId,
                path: circleTarget.path,
                bridgeCtx,
                shown,
              });
              setIsLoading(false);
              return;
            }
            await renderSealedCircle(
              circleTarget.circleId,
              circleTarget.path,
              bridgeCtx,
              passphrase,
              shown,
            );
          } else {
            const asset = await fetchCircleAsset(
              rpcBaseUrl,
              circleTarget.circleId,
              circleTarget.path,
            );
            if (turn !== navTurn.current) return;
            if (asset) {
              const ct = asset.contentType;
              if (ct.startsWith("text/html")) {
                const htmlContent = new TextDecoder().decode(asset.bytes);
                const resolved = await resolveCircleAssets(
                  rpcBaseUrl,
                  htmlContent,
                  circleTarget.circleId,
                  circleTarget.path,
                );
                const injected = injectCircleScripts(resolved, bridgeCtx);
                present(await stageFrameDocument(injected, "page"), bridgeCtx, shown);
              } else {
                present(await stageFrameAsset(bytesToB64(asset.bytes), ct), bridgeCtx, shown);
              }
              logger.info(
                "browser",
                `circle loaded (public+bridge) - id=${circleTarget.circleId} type=${ct}`,
              );
            } else {
              const otherNetworkId = networkId === "mainnet" ? "devnet" : "mainnet";
              const otherRpcUrl = NETWORKS[otherNetworkId]?.rpcUrl;
              const existsOnOther = otherRpcUrl
                ? (await fetchCircleInfo(otherRpcUrl, circleTarget.circleId)) !== null
                : false;
              if (existsOnOther) {
                logger.warn(
                  "browser",
                  `circle on wrong network - id=${circleTarget.circleId} current=${networkId} foundOn=${otherNetworkId}`,
                );
                if (named) present("", null);
                setCircleNetworkMismatch({ foundOn: otherNetworkId, url: shown.address });
              } else {
                logger.warn(
                  "browser",
                  `circle not found on any network - id=${circleTarget.circleId}`,
                );
                refuse(t("browser.circleNotFound"), true);
              }
            }
          }
        } catch (e: any) {
          logger.error("browser", `circle load failed - id=${circleTarget.circleId}: ${e.message}`);
          refuse(e.message || t("browser.circleFailed"), true);
        }
        setIsLoading(false);
        return;
      }

      const normalized = normalizeUrl(trimmed);
      if (!normalized) {
        present("", null);
        setWebSearch(trimmed);
        setIsLoading(false);
        return;
      }
      setWebSearch(null);

      if (isBlockedInsecureUrl(normalized, security.blockInsecureSites)) {
        logger.warn("browser", `blocked insecure navigation - ${normalized}`);
        setOpenError(null);
        setCircleError(t("browser.insecureBlocked"));
        setIsLoading(false);
        return;
      }

      logger.debug("browser", `navigate - ${normalized}`);
      navHistoryStack.current = navHistoryStack.current.slice(0, navHistoryIndex.current + 1);
      navHistoryStack.current.push(normalized);
      navHistoryIndex.current = navHistoryStack.current.length - 1;

      if (unframeable.current.has(getDomain(normalized))) {
        logger.info("browser", `unframeable host - opening ${getDomain(normalized)} in a window`);
        setInputValue(normalized);
        setOpenError(null);
        setIsLoading(false);
        addToHistory(normalized);
        void openInWindow(normalized).then((ok) => {
          if (!ok) setBlockedUrl(normalized);
        });
        return;
      }

      present(normalized, null);
      setInputValue(normalized);
      setBlockedUrl(null);
      // A refused frame fires no load and no error event, so the only signal is silence.
      if (loadTimer.current) clearTimeout(loadTimer.current);
      loadTimer.current = setTimeout(() => {
        loadTimer.current = null;
        setIsLoading(false);
        const host = getDomain(normalized);
        unframeable.current.add(host);
        rememberUnframeable(host);
        logger.warn("browser", `no load signal for ${host} - opening it in a window instead`);
        void openInWindow(normalized).then((ok) => {
          if (!ok) setBlockedUrl(normalized);
        });
      }, 8000);
      setCanGoBack(navHistoryIndex.current > 0);
      setCanGoForward(false);
      setIsLoading(true);
      addToHistory(normalized);
    },
    [addToHistory, rpcBaseUrl, circlePassphrase, networkId, renderSealedCircle, reader, t, present],
  );

  navigateRef.current = navigate;

  useEffect(() => {
    if (pendingCircleNavigate.current) {
      const pending = pendingCircleNavigate.current;
      pendingCircleNavigate.current = null;
      navigate(pending);
    }
  }, [rpcBaseUrl, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const initUrl = params.get("url") || "";
    if (initUrl.startsWith("oct://")) navigate(initUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = useCallback(
    (by: number) => {
      const at = navHistoryIndex.current + by;
      const entry = navHistoryStack.current[at];
      if (entry === undefined) return;
      navHistoryIndex.current = at;
      setCanGoBack(at > 0);
      setCanGoForward(at < navHistoryStack.current.length - 1);
      if (parseCircleUri(entry) && !resolveOctProtocol(entry)) {
        void navigate(entry, { push: false });
        return;
      }
      navTurn.current++;
      present(entry, null);
      setInputValue(entry);
      setIsLoading(true);
    },
    [navigate, present],
  );
  const goBack = useCallback(() => step(-1), [step]);
  const goForward = useCallback(() => step(1), [step]);

  const goHome = useCallback(() => {
    navTurn.current++;
    present("", null);
    setInputValue("");
    setIsLoading(false);
    setCircleError("");
    setCircleNetworkMismatch(null);
  }, [present]);

  const refresh = useCallback(() => {
    const again = openError?.address ?? (circlePage?.name ? circlePage.address : null);
    if (again) {
      void navigate(again, { push: false, fresh: true });
      return;
    }
    if (!iframeRef.current || !url) return;
    setIsLoading(true);
    iframeRef.current.src = url;
  }, [url, openError, circlePage, navigate]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      navigate(inputValue);
    },
    [inputValue, navigate],
  );

  // effect:audited - drop the pending load timer on unmount so it cannot fire into a
  // dead component.
  useEffect(
    () => () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    },
    [],
  );

  const handleIframeLoad = useCallback(() => {
    if (loadTimer.current) {
      clearTimeout(loadTimer.current);
      loadTimer.current = null;
    }
    setBlockedUrl(null);
    setIsLoading(false);
    signalWalletReady();
  }, [signalWalletReady]);

  const openExternal = useCallback(() => {
    const target = address();
    if (!target) return;
    void openInSystemBrowser(target);
  }, [address]);

  /**
   * A native window is a top-level browsing context, so X-Frame-Options does not apply. Returns
   * false when it could not open and the OS browser was used instead.
   */
  const openInWindow = useCallback(
    async (target?: string): Promise<boolean> => {
      const dest = target ?? url;
      if (!dest) return false;
      try {
        // dapp_open_window injects the wallet provider, so the page can connect once it loads.
        const circle = circleBridgeCtxRef.current?.circle_id;
        const site = isStagedFrameUrl(dest) && circle ? `oct://${circle}` : null;
        await invoke("dapp_open_window", { url: dest, site });
        return true;
      } catch (e) {
        logger.warn("browser", `native window failed (${e}) - falling back to the system browser`);
        void openInSystemBrowser(dest);
        return false;
      }
    },
    [url],
  );

  const toggleBookmark = useCallback(() => {
    const url = address();
    if (!url) return;
    setBookmarks((prev) => {
      if (prev.some((b) => b.url === url)) {
        const updated = prev.filter((b) => b.url !== url);
        saveBookmarks(updated);
        return updated;
      }
      if (prev.length >= MAX_BOOKMARKS) return prev;
      const updated = [...prev, { url, title: getDomain(url), addedAt: Date.now() }];
      saveBookmarks(updated);
      return updated;
    });
  }, [address]);

  const removeBookmark = useCallback((bmUrl: string) => {
    setBookmarks((prev) => {
      const updated = prev.filter((b) => b.url !== bmUrl);
      saveBookmarks(updated);
      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  // The blocked and not-an-address notices render in the browser view, so they must not fall
  // through to Home.
  if (!url && !blockedUrl && !webSearch && !openError) {
    const recentHistory = history.slice(0, 5);
    const shownBookmarks = bookmarks.slice(0, 12);
    return (
      <Screen>
        <PageTitle
          title={t("browser.title")}
          right={
            <Action onClick={() => routerNavigate("/connected-sites")}>
              {t("browser.connectedSites")}
            </Action>
          }
        />

        <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(16.25rem,0.5fr)] gap-7">
          <ScrollArea fade className="space-y-6">
            <div className="flex items-center gap-2">
              <form onSubmit={handleSubmit} className="flex-1">
                <div className="relative">
                  <Search
                    size={16}
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-content-muted"
                  />
                  <input
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={t("browser.searchPlaceholder")}
                    aria-label={t("browser.searchPlaceholder")}
                    className="h-12.5 w-full rounded-full bg-surface-card py-3 pr-24 pl-11 text-body text-content placeholder:text-content-muted transition-colors focus:bg-surface-highlight focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!inputValue.trim() || isLoading}
                    className="look-key absolute top-1/2 right-1.5 inline-flex h-9.5 -translate-y-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-content px-3.5 text-meta font-semibold text-content-inverse transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    title={t("browser.go")}
                  >
                    {isLoading ? (
                      <Loader size={13} className="animate-spin" />
                    ) : (
                      <ArrowRight size={13} />
                    )}
                    {t("browser.go")}
                  </button>
                </div>
              </form>
              <button
                onClick={() => setShowBrowserSettings(true)}
                className="grid size-12.5 shrink-0 cursor-pointer place-items-center rounded-full bg-surface-card transition-colors hover:bg-surface-highlight"
                title={t("browser.settings")}
                aria-label={t("browser.settings")}
              >
                <Settings size={16} className="text-content-secondary" />
              </button>
            </div>

            {/* Notices float over the list so nothing moves when one appears. */}
            <div className="relative z-10 h-1">
              <div className="h-full overflow-hidden rounded-full">
                {isLoading && (
                  <div className="h-full w-2/3 animate-pulse rounded-full bg-content-muted" />
                )}
              </div>
              {(circleError || mismatch) && (
                <div className="absolute inset-x-0 top-3 flex flex-col gap-2">
                  {circleError && (
                    <div className="flex min-h-11 items-center gap-2.5 rounded-[22px] bg-surface-highlight py-1.5 pr-1.5 pl-4 text-meta text-content shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)] animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none">
                      <AlertTriangle size={14} className="shrink-0 text-content-muted" />
                      <span className="min-w-0 flex-1 py-1">{circleError}</span>
                    </div>
                  )}
                  {mismatch && (
                    <div className="flex min-h-11 items-center gap-2.5 rounded-[22px] bg-surface-highlight py-1.5 pr-1.5 pl-4 text-meta text-content shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)] animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none">
                      <AlertTriangle size={14} className="shrink-0 text-content-muted" />
                      <span className="min-w-0 flex-1 truncate">
                        {t("browser.circleOn", { network: networkLabel(mismatch.foundOn, t) })}
                      </span>
                      <Btn size="sm" onClick={switchAndOpen}>
                        {t("browser.switchAndOpen")}
                      </Btn>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Must render here too: a sealed circle opened from Home keeps `url` empty. */}
            {sealedModal && (
              <SealedCircleModal
                onDecrypt={async (pp) => {
                  await renderSealedCircle(
                    sealedModal!.circleId,
                    sealedModal!.path,
                    sealedModal!.bridgeCtx,
                    pp,
                    sealedModal!.shown,
                  );
                  setCirclePassphrase({ circleId: sealedModal!.circleId, pass: pp });
                  setSealedModal(null);
                  setIsLoading(false);
                }}
                onCancel={() => {
                  setSealedModal(null);
                  setIsLoading(false);
                }}
              />
            )}

            {bookmarks.length > 0 && (
              <div>
                <Caps
                  right={
                    bookmarks.length > shownBookmarks.length
                      ? t("browser.shownOf", {
                          shown: shownBookmarks.length,
                          total: bookmarks.length,
                        })
                      : undefined
                  }
                >
                  {t("browser.bookmarks")}
                </Caps>
                <div className="mt-3 grid grid-cols-3 gap-2 @lg:grid-cols-6">
                  {shownBookmarks.map((bm) => (
                    <div
                      key={bm.url}
                      className="group relative flex cursor-pointer flex-col items-center gap-2 rounded-2xl p-3 transition-colors duration-200 ease-out hover:bg-surface-card"
                      onClick={() => navigate(bm.url)}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeBookmark(bm.url);
                        }}
                        aria-label={t("browser.removeBookmark")}
                        className="absolute top-1.5 right-2 text-micro text-content-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-content"
                      >
                        {t("browser.remove")}
                      </button>
                      <div className="grid size-9 place-items-center rounded-full bg-surface-highlight">
                        <span className="text-xs font-bold text-content">
                          {getInitials(bm.title)}
                        </span>
                      </div>
                      <span className="w-full truncate text-center text-xs text-content">
                        {bm.title}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <Caps>{t("browser.ecosystem")}</Caps>
              {ecosystem === null ? (
                <div className="mt-3 grid grid-cols-2 gap-3.5 @3xl:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-29.5 rounded-2xl bg-surface-card/60 animate-pulse motion-reduce:animate-none"
                    />
                  ))}
                </div>
              ) : ecosystem.length === 0 ? (
                <div className="mt-3 flex items-center gap-3.5 py-3.5">
                  <Mascot id="browser-eco" phase="ok" size={40} />
                  <div className="min-w-0 flex-1 text-body font-medium text-content">
                    {t("browser.ecoDown")}
                  </div>
                  <Btn
                    size="sm"
                    onClick={() => {
                      setEcosystem(null);
                      setEcoTry((n) => n + 1);
                    }}
                  >
                    {t("activity.tryAgain")}
                  </Btn>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-3.5 @3xl:grid-cols-4">
                  {ecosystem.map((dapp) => (
                    <button
                      key={dapp.id}
                      onClick={() => navigate(dapp.url)}
                      className="flex h-29.5 flex-col items-center justify-center gap-2.5 rounded-2xl p-4 text-center transition-colors duration-200 ease-out hover:bg-surface-card"
                    >
                      {dapp.logoUrl ? (
                        <img
                          src={dapp.logoUrl}
                          alt=""
                          className="size-9 shrink-0 rounded-[10px] object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-highlight">
                          <span className="text-xs font-bold text-content">
                            {getInitials(dapp.name)}
                          </span>
                        </div>
                      )}
                      <p className="w-full min-w-0 truncate text-center text-body font-semibold text-content">
                        {dapp.name}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>

          <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
            <Caps
              right={
                recentHistory.length > 0 ? (
                  <button
                    type="button"
                    onClick={clearHistory}
                    className="cursor-pointer text-content-muted hover:text-content"
                  >
                    {t("browser.clearHistory")}
                  </button>
                ) : undefined
              }
            >
              {t("browser.recentHistory")}
            </Caps>
            <div className="-mx-3 mt-2">
              {recentHistory.length === 0 ? (
                <p className="px-3 py-2.5 text-meta text-content-muted">{t("browser.noRecent")}</p>
              ) : (
                recentHistory.map((entry) => (
                  <button
                    key={entry.url + entry.visitedAt}
                    onClick={() => navigate(entry.url)}
                    className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-surface-highlight"
                  >
                    <span className="min-w-0 flex-1 truncate text-body text-content">
                      {entry.title}
                    </span>
                    <span className="max-w-32 shrink-0 truncate font-mono text-micro text-content-muted">
                      {hostOf(entry.url)}
                    </span>
                  </button>
                ))
              )}
            </div>
            <Caps className="mt-5">{t("browser.connected")}</Caps>
            <KV label={t("browser.sites")}>
              {t("browser.sitesOn", {
                count: connectedSites.length,
                network: NETWORKS[networkId]?.name ?? networkId,
              })}
            </KV>
          </aside>
        </div>

        <BrowserSettingsPopup
          open={showBrowserSettings}
          onClose={() => setShowBrowserSettings(false)}
          historyCount={history.length}
          bookmarkCount={bookmarks.length}
          onClearHistory={() => {
            setHistory([]);
            localStorage.removeItem("0xio_browser_history");
          }}
          onClearBookmarks={() => {
            setBookmarks([]);
            localStorage.removeItem("0xio_browser_bookmarks");
          }}
          security={security}
          onSecurity={(next) => {
            setSecurity(next);
            saveBrowserSecurity(next);
            logger.info("browser", `block insecure sites -> ${next.blockInsecureSites}`);
          }}
          onOpenConnectedSites={() => {
            setShowBrowserSettings(false);
            routerNavigate("/connected-sites");
          }}
        />
      </Screen>
    );
  }

  return (
    <div data-look="ext" className="flex h-full flex-col bg-surface">
      <div className="flex h-13 shrink-0 items-center gap-1 px-3">
        <button
          type="button"
          onClick={goBack}
          disabled={!canGoBack}
          aria-label={t("browser.back")}
          className={TOOL}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!canGoForward}
          aria-label={t("browser.forward")}
          className={TOOL}
        >
          <ArrowRight size={16} />
        </button>
        <button type="button" onClick={refresh} aria-label={t("browser.reload")} className={TOOL}>
          <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
        </button>

        <form onSubmit={handleSubmit} className="mx-1.5 flex-1">
          <div ref={tagRef} className="relative">
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              aria-label={t("browser.searchPlaceholder")}
              className={`h-9 w-full rounded-full bg-surface-card ${opened ? "pr-48" : "pr-10"} pl-4 font-mono text-[0.8125rem] text-content placeholder:text-content-muted outline-none focus:bg-surface-highlight ${EASE}`}
            />
            {opened && (
              <button
                type="button"
                onClick={() => setTagOpen((open) => !open)}
                aria-expanded={tagOpen}
                aria-label={`${t("ons.opensCircle")} ${opened.circleId}`}
                data-testid="circle-tag"
                className={`absolute top-1/2 right-10 inline-flex h-6 -translate-y-1/2 cursor-pointer items-center rounded-full bg-(--bg-3) px-2.5 font-mono text-micro font-semibold text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
              >
                {cutId(opened.circleId)}
              </button>
            )}
            {opened && tagOpen && (
              <div
                role="dialog"
                aria-label={opened.name}
                className="absolute top-11 left-0 z-30 flex w-110 max-w-full flex-col gap-3.5 rounded-[22px] bg-surface-card p-5.5 shadow-[0_30px_70px_-20px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] animate-in fade-in-0 slide-in-from-top-1.5 duration-200 ease-out motion-reduce:animate-none"
              >
                <div className="text-title font-semibold whitespace-nowrap text-content">
                  {opened.name}
                </div>
                <div>
                  <Caps>{t("ons.opensCircle")}</Caps>
                  <div className="mt-2 font-mono text-meta break-all text-content">
                    {opened.circleId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={copyCircleId}
                  className={`h-7.5 cursor-pointer self-start rounded-full text-[0.8125rem] font-semibold text-content ${EASE} ${FOCUS}`}
                >
                  {t(idCopied ? "common.copied" : "ons.copyCircleId")}
                </button>
              </div>
            )}
            <button
              type="submit"
              disabled={!inputValue.trim() || isLoading}
              aria-label={t("browser.go")}
              className={`${TOOL} absolute top-1/2 right-0.5 size-8 -translate-y-1/2`}
            >
              <ArrowRight size={14} />
            </button>
          </div>
        </form>

        <SiteChip origin={chipOrigin} />

        <button
          type="button"
          onClick={toggleBookmark}
          aria-pressed={isBookmarked}
          aria-label={isBookmarked ? t("browser.removeBookmark") : t("browser.addBookmark")}
          className={`${TOOL} ${isBookmarked ? "text-content" : ""}`}
        >
          <Star size={14} filled={isBookmarked} />
        </button>
        <button
          type="button"
          onClick={() => openInWindow()}
          aria-label={t("browser.openInWindow")}
          className={TOOL}
        >
          <AppWindow size={14} />
        </button>
        <button
          type="button"
          onClick={openExternal}
          aria-label={t("browser.systemBrowser")}
          className={TOOL}
        >
          <ExternalLink size={14} />
        </button>
        <button type="button" onClick={goHome} aria-label={t("nav.home")} className={TOOL}>
          <Home size={16} />
        </button>
      </div>

      <div aria-hidden="true" className="h-0.5 shrink-0 overflow-hidden">
        {isLoading && <div className="h-full w-2/3 animate-pulse bg-content-muted" />}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {mismatch && (
          <div className="absolute top-3 left-1/2 z-10 flex h-11 -translate-x-1/2 items-center gap-2.5 rounded-full bg-surface-card pr-1.5 pl-4 text-meta text-content shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)] animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none">
            <AlertTriangle size={14} className="shrink-0 text-content-muted" />
            <span className="whitespace-nowrap">
              {t("browser.circleOn", { network: networkLabel(mismatch.foundOn, t) })}
            </span>
            <Btn size="sm" onClick={switchAndOpen}>
              {t("browser.switchAndOpen")}
            </Btn>
          </div>
        )}

        {webSearch && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <Globe size={28} className="text-content-muted" />
            <p className="text-body font-semibold text-content">
              {t("browser.notAddress", { query: webSearch })}
            </p>
            <div className="flex items-center gap-2">
              <Btn
                size="sm"
                weight="primary"
                onClick={() =>
                  void openInSystemBrowser(
                    `https://www.google.com/search?q=${encodeURIComponent(webSearch)}`,
                  )
                }
              >
                {t("browser.searchWeb")}
              </Btn>
              <Btn
                size="sm"
                weight="text"
                onClick={() => {
                  setWebSearch(null);
                  setInputValue("");
                }}
              >
                {t("browser.dismiss")}
              </Btn>
            </div>
          </div>
        )}

        {openError && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <AlertTriangle size={26} className="text-content-muted" />
            <p className="text-body font-semibold text-content">{openError.text}</p>
            <div className="flex items-center gap-2">
              {openError.retry && (
                <Btn size="sm" weight="primary" disabled={isLoading} onClick={refresh}>
                  {t("activity.tryAgain")}
                </Btn>
              )}
              <Btn size="sm" weight="text" onClick={goHome}>
                {t("browser.dismiss")}
              </Btn>
            </div>
          </div>
        )}

        {blockedUrl && !webSearch && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <AlertTriangle size={26} className="text-content-muted" />
            <p className="text-body font-semibold text-content">{t("browser.cantDisplay")}</p>
            <div className="flex items-center gap-2">
              <Btn size="sm" weight="primary" onClick={() => openInWindow(blockedUrl)}>
                {t("browser.openInWindow")}
              </Btn>
              <Btn size="sm" onClick={() => void openInSystemBrowser(blockedUrl)}>
                {t("browser.systemBrowser")}
              </Btn>
              <Btn
                size="sm"
                weight="text"
                onClick={() => {
                  setBlockedUrl(null);
                  setUrl("");
                  setInputValue("");
                }}
              >
                {t("browser.dismiss")}
              </Btn>
            </div>
          </div>
        )}

        {opened && tagOpen && <div className="absolute inset-0 z-10" onMouseDown={closeTag} />}

        {/* Rendered conditionally, not hidden: a hidden iframe still loads src. */}
        {!webSearch && !blockedUrl && !openError && (
          <iframe
            ref={iframeRef}
            src={url}
            onLoad={handleIframeLoad}
            className="flex-1 w-full min-h-0 border-none bg-white"
            // Staged documents share one origin, so they stay opaque (no allow-same-origin) or one
            // oct:// site could read another's storage.
            sandbox={
              isStagedFrameUrl(url)
                ? "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            }
            allow="clipboard-write"
            key={url}
          />
        )}
      </div>

      <DappApprovalModal
        approval={pendingApproval}
        onApprove={approveRequest}
        onReject={rejectRequest}
        auth={auth}
      />

      {sealedModal && (
        <SealedCircleModal
          onDecrypt={async (pp) => {
            // Throws on a wrong passphrase; the passphrase is kept only after decryption succeeds.
            await renderSealedCircle(
              sealedModal.circleId,
              sealedModal.path,
              sealedModal.bridgeCtx,
              pp,
              sealedModal.shown,
            );
            setCirclePassphrase({ circleId: sealedModal.circleId, pass: pp });
            setSealedModal(null);
            setIsLoading(false);
          }}
          onCancel={() => {
            setSealedModal(null);
            setIsLoading(false);
          }}
        />
      )}
    </div>
  );
}
