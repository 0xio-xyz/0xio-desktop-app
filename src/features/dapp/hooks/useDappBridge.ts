/**
 * Transports in: the browser frame (postMessage), native dapp windows and the local WebSocket
 * (wallet-rpc-request events). Every request runs through services/dappRequest.ts.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWallet } from "src/contexts/useWallet";
import * as dappService from "src/features/dapp/services/dappService";
import type { SiteWalletInfo } from "src/features/dapp/services/dappService";
import { onDappEvent, publishDappEvent } from "src/features/dapp/services/dappEvents";
import {
  BridgeError,
  createDappRequestHandler,
  walletPayload,
  type ApprovalAnswer,
  type PendingApproval,
  type SdkRequest,
  type SdkResponse,
} from "src/features/dapp/services/dappRequest";
import {
  createFrameServer,
  maskStatus,
  type FrameRun,
} from "src/features/dapp/services/frameLifecycle";
import {
  liveWatchDeps,
  reportProgress,
  watchSiteTx,
  type SiteWatch,
} from "src/features/dapp/services/siteLifecycle";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { NETWORKS } from "src/services/network/config";
import { logger } from "src/lib/logger";

export type { PendingApproval } from "src/features/dapp/services/dappRequest";

export interface DappAuthState {
  isOpen: boolean;
  title: string;
  handleResult: (approved: boolean) => void;
}

interface DappBridgeResult {
  pendingApproval: PendingApproval | null;
  approveRequest: (selectedAddress?: string) => void;
  rejectRequest: () => void;
  signalWalletReady: () => void;
  auth: DappAuthState;
  /** The connect review for one wallet, for a circle asking for the wallet over its bridge. */
  askConnect: (origin: string, wallet: SiteWalletInfo) => Promise<ApprovalAnswer>;
}

const REVIEW_WINDOW_MS = 300_000;

let bridgeSeq = 0;

const asSiteWallet = (w: {
  id: string;
  address: string;
  name: string;
  wallet_type: string;
}): SiteWalletInfo => ({ id: w.id, address: w.address, name: w.name, wallet_type: w.wallet_type });

/**
 * Rust reads the site from the handshake: the paired extension or a paired program. Web pages
 * never reach this path.
 */
export function wsRequestOrigin(payload: { origin?: unknown }): string | null {
  const o = payload.origin;
  return typeof o === "string" && /^(chrome-extension|moz-extension|native):\/\/[^\s/]+$/.test(o)
    ? o
    : null;
}

export async function announceSiteWallet(origins: string[], wallet: SiteWalletInfo): Promise<void> {
  if (!origins.length) return;
  publishDappEvent("accountChanged", await walletPayload(wallet), origins);
}

const MUTATING_METHODS: Record<string, string> = {
  send_transaction: "Transaction",
  sendTransaction: "Transaction",
  call_contract: "Contract call",
  send_contract_transaction: "Contract call",
  send_contract_transaction_sequence: "Contract sequence",
  deploy_contract: "Deploy",
  deployContract: "Deploy",
  broadcast_only: "Transaction",
  sign_transaction: "Signature",
  signMessage: "Signature",
  send_private_transfer: "Private transfer",
  claim_private_transfer: "Claim",
  register_private_view_key: "Key registration",
  switch_network: "Network",
};

export function useDappBridge(
  iframeRef?: React.RefObject<HTMLIFrameElement | null>,
  options?: {
    ownsGlobalBridges?: boolean;
    pageOrigin?: () => string | null;
  },
): DappBridgeResult {
  // The native-window and WebSocket bridges are Tauri events, so they are process-wide. This hook
  // is mounted more than once (App, plus BrowserScreen for its iframe); exactly one caller owns
  // them, App, or a single request would be handled once per mount.
  const ownsGlobalBridges = options?.ownsGlobalBridges ?? false;
  const pageOriginRef = useRef(options?.pageOrigin);
  pageOriginRef.current = options?.pageOrigin;
  const { activeWallet, wallets, networkId, isLocked, setNetworkId, showMessage } = useWallet();
  const activeWalletRef = useRef(activeWallet);
  const walletsRef = useRef(wallets);
  const setNetworkIdRef = useRef(setNetworkId);
  const networkIdRef = useRef(networkId);
  const isLockedRef = useRef(isLocked);
  activeWalletRef.current = activeWallet;
  walletsRef.current = wallets;
  setNetworkIdRef.current = setNetworkId;
  networkIdRef.current = networkId;

  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const pendingResolveRef = useRef<((answer: ApprovalAnswer) => void) | null>(null);
  const openRidRef = useRef<string | null>(null);
  const openRunRef = useRef<FrameRun | null>(null);
  const instanceRef = useRef(`iframe:${++bridgeSeq}`);
  const iframeGenRef = useRef(0);
  const windowGenRef = useRef(new Map<string, number>());
  const unlockWaitersRef = useRef<Array<() => void>>([]);
  const auth = useTransactionAuth();
  const requestAuthRef = useRef(auth.requestAuth);
  requestAuthRef.current = auth.requestAuth;

  useEffect(() => {
    isLockedRef.current = isLocked;
    if (!isLocked) unlockWaitersRef.current.splice(0).forEach((resolve) => resolve());
  }, [isLocked]);

  const waitForUnlock = useCallback((timeoutMs = 120_000): Promise<boolean> => {
    if (!isLockedRef.current) return Promise.resolve(true);
    void getCurrentWindow()
      .setFocus()
      .catch(() => {});
    return new Promise<boolean>((resolve) => {
      const done = (unlocked: boolean) => {
        const i = unlockWaitersRef.current.indexOf(onUnlock);
        if (i > -1) unlockWaitersRef.current.splice(i, 1);
        clearTimeout(timer);
        resolve(unlocked);
      };
      const onUnlock = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      unlockWaitersRef.current.push(onUnlock);
    });
  }, []);

  /** One review at a time: a second request is refused, never replaces the open one. */
  const requestApproval = useCallback(
    (
      approval: Omit<PendingApproval, "networkId">,
      run?: FrameRun | null,
    ): Promise<ApprovalAnswer> => {
      if (pendingResolveRef.current) {
        const rid = openRidRef.current;
        return Promise.reject(
          new BridgeError("RATE_LIMIT_EXCEEDED", "Finish or reject the open request first", {
            reason: "review_pending",
            status: "review_open",
            ...(rid ? { requestId: rid } : {}),
          }),
        );
      }
      return new Promise<ApprovalAnswer>((resolve) => {
        openRidRef.current =
          typeof approval.request?.rid === "string" ? approval.request.rid : null;
        openRunRef.current = run ?? null;
        pendingResolveRef.current = resolve;
        setPendingApproval({ ...approval, networkId: networkIdRef.current });
      });
    },
    [],
  );

  const approveRequest = useCallback((selectedAddress?: string) => {
    pendingResolveRef.current?.({ approved: true, selectedAddress });
    pendingResolveRef.current = null;
    openRunRef.current = null;
    setPendingApproval(null);
  }, []);

  const rejectRequest = useCallback(() => {
    pendingResolveRef.current?.({ approved: false });
    pendingResolveRef.current = null;
    openRunRef.current = null;
    setPendingApproval(null);
  }, []);
  const askConnect = useCallback(
    (origin: string, wallet: SiteWalletInfo) =>
      requestApproval({
        type: "connect",
        origin,
        request: {
          id: `circle:${++bridgeSeq}`,
          method: "connect",
          params: {},
          timestamp: Date.now(),
        },
        signer: wallet,
        connect: { open: wallet, choices: [wallet], permissions: [] },
      }),
    [requestApproval],
  );

  const rejectRequestRef = useRef(rejectRequest);
  rejectRequestRef.current = rejectRequest;

  const frames = useMemo(() => {
    const server = createFrameServer({
      call: (cmd, args) => invoke(cmd, args),
      network: () => networkIdRef.current,
      siteView: (origin, network) => {
        const site = dappService.getSite(network, origin);
        return { connected: !!site, signer: site?.inUse ?? null };
      },
      handle: (req, origin, run) => handlerFor(run)(req, origin),
      closeReview: (run, why) => {
        if (run.approved) return;
        run.ended = why;
        if (openRunRef.current === run) rejectRequestRef.current();
      },
      follow: (watch: SiteWatch, origin: string) => {
        const scopeHolds = () =>
          !watch.address || dappService.getSite(watch.network, origin)?.inUse === watch.address;
        void watchSiteTx(watch, liveWatchDeps(scopeHolds)).then((verdict) =>
          reportProgress(watch.id, verdict).catch(() => {}),
        );
      },
    });
    const handlerFor = (run: FrameRun | null) =>
      createDappRequestHandler({
        getOpenWallet: () =>
          activeWalletRef.current ? asSiteWallet(activeWalletRef.current) : null,
        getWallets: () => walletsRef.current.map(asSiteWallet),
        getNetworkId: () => networkIdRef.current,
        isLocked: () => isLockedRef.current,
        waitForUnlock: async () => {
          if (run && isLockedRef.current) await server.stage(run, "locked");
          return waitForUnlock();
        },
        requestApproval: async (a) => {
          if (run?.ended) return { approved: false };
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (run && !pendingResolveRef.current) {
              await server.stage(run, "review_open");
              timer = setTimeout(() => {
                run.ended = "expired";
                if (openRunRef.current === run) rejectRequestRef.current();
              }, REVIEW_WINDOW_MS);
            }
            const answer = await requestApproval(a, run);
            if (run && answer.approved && !run.ended) {
              run.approved = true;
              await server.signing(run);
            }
            return run?.ended ? { approved: false } : answer;
          } catch (e) {
            if (e instanceof BridgeError) throw e;
            return { approved: false };
          } finally {
            clearTimeout(timer);
          }
        },
        requestAuth: (title) => requestAuthRef.current(title),
        setNetworkId: (id) => setNetworkIdRef.current(id),
      });
    return { server, handlerFor };
  }, [requestApproval, waitForUnlock]);
  const handleRequest = useMemo(() => frames.handlerFor(null), [frames]);
  const iframeFrame = () => `${instanceRef.current}:${iframeGenRef.current}`;
  const windowFrame = (label: string) => `window:${label}:${windowGenRef.current.get(label) ?? 0}`;

  const getOriginFromEvent = useCallback(
    (event: MessageEvent): string => {
      try {
        if (event.origin && event.origin !== "null") return event.origin;
        if (iframeRef?.current?.src) return new URL(iframeRef.current.src).origin;
      } catch {}
      return "unknown";
    },
    [iframeRef],
  );

  const frameIdentity = useCallback((): string | null => {
    const fromPage = pageOriginRef.current?.();
    if (fromPage) return fromPage;
    const src = iframeRef?.current?.src;
    if (!src) return null;
    try {
      return new URL(src).origin;
    } catch {
      return null;
    }
  }, [iframeRef]);

  const notifyOutcome = useCallback(
    (method: string, response: SdkResponse) => {
      const label = MUTATING_METHODS[method];
      if (!label) return;
      if (response.success) {
        const data = response.data as Record<string, unknown> | undefined;
        const hash = (data?.txHash || data?.hash) as string | undefined;
        showMessage(
          "success",
          hash ? `${label} submitted (${hash.slice(0, 10)}...)` : `${label} completed`,
        );
        return;
      }
      const err = response.error;
      const message = typeof err === "string" ? err : (err?.message ?? "Request failed");
      const code = typeof err === "string" ? "" : (err?.code ?? "");
      if (code === "USER_REJECTED") {
        showMessage("info", `${label} rejected`);
        return;
      }
      showMessage("error", `${label} failed: ${message}`);
    },
    [showMessage],
  );

  useEffect(() => {
    if (!iframeRef) return;
    const handleMessage = async (event: MessageEvent) => {
      if (!event.data || event.data.source !== "0xio-sdk-request" || !event.data.request) return;
      // Only the page in the browser frame speaks for itself, never a frame nested inside it.
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const req = event.data.request as SdkRequest;
      const origin = pageOriginRef.current?.() ?? getOriginFromEvent(event);
      logger.debug("[DappBridge] iframe request:", req.method, req.id, "from", origin);
      let response: SdkResponse;
      try {
        response = await frames.server.serve(req, origin, iframeFrame());
      } catch (e) {
        response = {
          id: req.id,
          success: false,
          error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) },
          timestamp: Date.now(),
        };
      }
      notifyOutcome(req.method, response);
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        // Wildcard: the SDK validates responses by request id, and a sandboxed frame has no
        // origin to target.
        try {
          iframe.contentWindow.postMessage({ source: "0xio-sdk-bridge", response }, "*");
        } catch {}
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [iframeRef, frames, getOriginFromEvent, notifyOutcome]);

  // Native dapp-window bridge. The origin is read from the webview by Rust, never from the page.
  useEffect(() => {
    if (!ownsGlobalBridges) return;
    const unlisten = listen<{
      id: string;
      origin: string;
      method: string;
      params: unknown;
      label: string;
      rid?: string;
    }>("dapp-bridge-request", async (event) => {
      const { id, origin, method, params, label, rid } = event.payload;
      logger.info("[DappBridge] window request IN:", method, id, "origin:", origin);
      let reply: {
        result?: unknown;
        error?: string;
        code?: string;
        details?: unknown;
        rid?: string;
        status?: string;
      };
      try {
        const response = await frames.server.serve(
          { id, method, params, timestamp: Date.now(), ...(rid !== undefined ? { rid } : {}) },
          origin,
          windowFrame(label),
        );
        notifyOutcome(method, response);
        const err = response.error;
        const lifecycle = response.rid ? { rid: response.rid, status: response.status } : {};
        // The code travels with the message so the page can tell WATCH_ONLY from a failure.
        reply = response.success
          ? { result: response.data, ...lifecycle }
          : typeof err === "string"
            ? { error: err, code: "INTERNAL_ERROR", ...lifecycle }
            : {
                error: err?.message ?? "Request failed",
                code: err?.code ?? "INTERNAL_ERROR",
                ...(err?.details ? { details: err.details } : {}),
                ...lifecycle,
              };
      } catch (e) {
        reply = { error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" };
      }
      logger.info(
        "[DappBridge] window request OUT:",
        method,
        id,
        reply.error ? `error=${reply.error}` : "ok",
      );
      try {
        await invoke("dapp_bridge_respond", { id, reply });
      } catch (e) {
        logger.warn("[DappBridge] could not answer window request", e);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [frames, ownsGlobalBridges, notifyOutcome]);

  useEffect(() => {
    const unlisten = listen<{ frame: string; origin: string; data: Record<string, unknown> }>(
      "frame-request-update",
      ({ payload }) => {
        const { frame, origin } = payload;
        const network =
          typeof payload.data.network === "string" ? payload.data.network : networkIdRef.current;
        const site = dappService.getSite(network, origin);
        const data = maskStatus(payload.data, { connected: !!site, signer: site?.inUse ?? null });
        if (frame === iframeFrame()) {
          try {
            iframeRef?.current?.contentWindow?.postMessage(
              {
                source: "0xio-sdk-bridge",
                event: { type: "requestUpdate", data },
                parentOrigin: window.location.origin,
              },
              "*",
            );
          } catch {}
          return;
        }
        const label = frame.startsWith("window:") ? frame.slice(7, frame.lastIndexOf(":")) : null;
        if (ownsGlobalBridges && label && frame === windowFrame(label)) {
          void invoke("dapp_emit_event", {
            event: "requestUpdate",
            payload: data,
            origins: [origin],
            label,
          }).catch(() => {});
        }
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, [iframeRef, ownsGlobalBridges]);

  useEffect(() => {
    if (!ownsGlobalBridges) return;
    const unlisten = listen<{ label: string }>("dapp-window-gone", ({ payload }) => {
      const gone = windowFrame(payload.label);
      windowGenRef.current.set(payload.label, (windowGenRef.current.get(payload.label) ?? 0) + 1);
      frames.server.pageGone(gone);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [frames, ownsGlobalBridges]);

  useEffect(() => {
    if (!ownsGlobalBridges) return;
    const unlisten = listen<string>("wallet-rpc-request", async (event) => {
      try {
        const payload = JSON.parse(event.payload);
        const rpcId: string = payload.rpc_id;
        const req = payload.request as SdkRequest;
        // Rust names the site from the handshake: the extension by its origin, a paired program
        // by its own name. Without one there is no site to answer for.
        const origin = wsRequestOrigin(payload);
        logger.debug("[DappBridge] WS RPC request:", req.method, rpcId);
        const response: SdkResponse = origin
          ? await handleRequest(req, origin)
          : {
              id: req?.id ?? "",
              success: false,
              error: { code: "UNAUTHORIZED", message: "Unknown site" },
              timestamp: Date.now(),
            };
        notifyOutcome(req.method, response);
        await invoke("wallet_rpc_respond", { rpcId, response });
      } catch (err) {
        logger.error("[DappBridge] Failed to handle WS RPC:", err);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleRequest, ownsGlobalBridges, notifyOutcome]);

  /** The SDK listens only after the dapp mounts, usually after `load`, so this repeats. */
  const postWalletReady = useCallback(() => {
    const iframe = iframeRef?.current;
    if (!iframe?.contentWindow) return;
    const msg = {
      source: "0xio-sdk-bridge",
      event: { type: "walletReady" },
      parentOrigin: window.location.origin,
    };
    try {
      iframe.contentWindow.postMessage(msg, "*");
    } catch {}
  }, [iframeRef]);

  // Forward bus events to the surfaces this instance owns, for the sites each event names: the
  // browser frame when its page is one of them, and (the owner only) the native dapp windows.
  useEffect(() => {
    return onDappEvent((type, data, origins) => {
      const iframe = iframeRef?.current;
      if (iframe?.contentWindow) {
        const who = frameIdentity();
        if (who && origins.includes(who)) {
          try {
            iframe.contentWindow.postMessage(
              {
                source: "0xio-sdk-bridge",
                event: { type, data },
                parentOrigin: window.location.origin,
              },
              "*",
            );
          } catch {}
        }
      }
      if (ownsGlobalBridges) {
        void invoke("dapp_emit_event", { event: type, payload: data, origins }).catch(() => {});
      }
    });
  }, [iframeRef, frameIdentity, ownsGlobalBridges]);

  useEffect(() => {
    if (!ownsGlobalBridges || !activeWallet) return;
    dappService.migrateLegacy(activeWallet);
  }, [activeWallet, ownsGlobalBridges]);

  // The open wallet changed: sites connected with it move to it and hear accountChanged; the
  // others keep their wallet and hear nothing. A lock (wallet -> null) is not a switch.
  const lastOpenRef = useRef<string | null>(null);
  const openAddress = activeWallet?.address ?? null;
  useEffect(() => {
    if (!ownsGlobalBridges || !openAddress) return;
    const list = walletsRef.current;
    const usable = (a: string) => list.some((w) => w.address === a);
    const moved = dappService.followOpenAll(networkIdRef.current, openAddress, usable);
    const previous = lastOpenRef.current;
    lastOpenRef.current = openAddress;
    if (previous === null || previous === openAddress) return;
    for (const { origin, address } of moved) {
      const w = list.find((x) => x.address === address);
      if (w) void announceSiteWallet([origin], asSiteWallet(w));
    }
  }, [openAddress, ownsGlobalBridges]);

  // The network changed: sites connected there hear networkChanged (and accountChanged when their
  // wallet there differs); sites connected only on the old network hear they are disconnected here.
  const lastNetRef = useRef(networkId);
  useEffect(() => {
    if (!ownsGlobalBridges) return;
    const previous = lastNetRef.current;
    lastNetRef.current = networkId;
    if (previous === networkId) return;
    const list = walletsRef.current;
    const usable = (a: string) => list.some((w) => w.address === a);
    const open = activeWalletRef.current?.address ?? null;
    dappService.followOpenAll(networkId, open, usable);
    const here = dappService.listSites(networkId);
    const hereOrigins = here.map((s) => s.origin);
    const before = dappService.connectedOrigins(previous);
    const leftBehind = before.filter((o) => !hereOrigins.includes(o));
    const net = NETWORKS[networkId];
    publishDappEvent(
      "networkChanged",
      {
        id: networkId,
        networkId,
        name: net?.name ?? networkId,
        isTestnet: networkId !== "mainnet",
        networkInfo: { ...(net ?? {}), isTestnet: networkId !== "mainnet" },
      },
      [...hereOrigins, ...leftBehind],
    );
    for (const site of here) {
      const was = dappService.getSite(previous, site.origin)?.inUse;
      const w = site.inUse ? list.find((x) => x.address === site.inUse) : undefined;
      if (w && was !== site.inUse) void announceSiteWallet([site.origin], asSiteWallet(w));
    }
    for (const origin of leftBehind) {
      publishDappEvent("disconnect", { origin, reason: "network" }, [origin]);
    }
  }, [networkId, ownsGlobalBridges]);

  const lockKnownRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = lockKnownRef.current;
    lockKnownRef.current = isLocked;
    if (!ownsGlobalBridges || previous === null || previous === isLocked) return;
    publishDappEvent(
      isLocked ? "extensionLocked" : "extensionUnlocked",
      {},
      dappService.connectedOrigins(networkIdRef.current),
    );
  }, [isLocked, ownsGlobalBridges]);

  const signalWalletReady = useCallback(() => {
    frames.server.pageGone(iframeFrame());
    iframeGenRef.current += 1;
    postWalletReady();
    [150, 400, 800, 1500, 2500].forEach((delay) => setTimeout(postWalletReady, delay));
  }, [postWalletReady, frames]);

  useEffect(() => {
    if (!iframeRef) return;
    return () => frames.server.pageGone(iframeFrame());
  }, [iframeRef, frames]);

  // Keep re-announcing walletReady at a low cadence, for a dapp that re-mounts its SDK instance.
  useEffect(() => {
    if (!iframeRef) return;
    const interval = setInterval(postWalletReady, 3000);
    return () => clearInterval(interval);
  }, [iframeRef, postWalletReady]);

  return {
    pendingApproval,
    approveRequest,
    rejectRequest,
    signalWalletReady,
    auth: { isOpen: auth.isOpen, title: auth.title, handleResult: auth.handleResult },
    askConnect,
  };
}
