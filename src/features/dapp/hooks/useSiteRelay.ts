import { useEffect, useRef } from "react";
import { afterFirstScreen } from "src/services/app/startup";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWallet } from "src/contexts/useWallet";
import {
  createDappRequestHandler,
  type ApprovalAnswer,
  type PendingApproval,
  type SdkResponse,
} from "src/features/dapp/services/dappRequest";
import type { SiteWalletInfo } from "src/features/dapp/services/dappService";
import {
  loadRelaySites,
  relayBook,
  relayRecord,
  relayReview,
  reviewFeeOp,
  reviewedOu,
  sendRelayEvent,
  setRelaySites,
  type RelayEffect,
  type RelayRequest,
} from "src/features/dapp/services/relaySites";
import {
  approveOnce,
  chainDeps,
  checkOnce,
  liveWatchDeps,
  reportProgress,
  watchSiteTx,
  type SiteWatch,
} from "src/features/dapp/services/siteLifecycle";
import { approveTrayRequest } from "src/features/privacy/services/trayPrivate";
import { recheckReviewedFee } from "src/hooks/transactions/useFees";
import { withTrayAuthHold } from "src/hooks/app/useTrayUnlockRequest";
import { biometricService } from "src/services/wallet/biometricService";
import { walletBridge } from "src/services/wallet/walletBridge";
import { NETWORKS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import type { MainTrayAction, TraySendProgress } from "src/tray/protocol";
import { noticeKey, type RelayReview } from "src/tray/siteQueue";
import i18n from "src/i18n";

const RELAY_NETWORKS = new Set(["mainnet", "devnet"]);
/** Rust ends a review, unlock included, left open this long as expired. */
const UNLOCK_WAIT_MS = 300_000;
/** Reviews that sign get Touch ID or the password after the verb, as the panel's own sends do. */
const SIGNING = new Set(["transaction", "sign", "deploy"]);

const asSiteWallet = (w: {
  id: string;
  address: string;
  name: string;
  wallet_type: string;
}): SiteWalletInfo => ({ id: w.id, address: w.address, name: w.name, wallet_type: w.wallet_type });

interface Open {
  req: RelayRequest;
  approval: Omit<PendingApproval, "networkId"> | null;
  resolve: ((a: ApprovalAnswer) => void) | null;
  unlock: ((ok: boolean) => void) | null;
  authing: boolean;
}

const fail = (id: string, code: string, message: string): SdkResponse => ({
  id,
  success: false,
  error: { code, message },
  timestamp: Date.now(),
});

function switchRefusal(req: RelayRequest): SdkResponse | null {
  if (req.method !== "switch_network") return null;
  const p = (req.params ?? {}) as Record<string, unknown>;
  const target = p.networkId ?? p.network;
  if (typeof target === "string" && RELAY_NETWORKS.has(target)) return null;
  return fail(req.id, "INVALID_PARAMS", "0xio Desktop signs for sites on Mainnet or Devnet.");
}

export function useSiteRelay() {
  const { activeWallet, wallets, isLocked } = useWallet();
  const live = useRef({ activeWallet, wallets, isLocked });
  live.current = { activeWallet, wallets, isLocked };
  const open = useRef(new Map<string, Open>());

  // Unlocked requests go on to their review; a lock tells relayed sites.
  const lockSeen = useRef<boolean | null>(null);
  useEffect(() => {
    const was = lockSeen.current;
    lockSeen.current = isLocked;
    if (!isLocked) {
      for (const o of open.current.values()) {
        o.unlock?.(true);
        o.unlock = null;
      }
    }
    if (was === false && isLocked) void invoke("site_lock_event").catch(() => {});
  }, [isLocked]);

  useEffect(() => {
    afterFirstScreen(() => void loadRelaySites());
    const progress = (p: TraySendProgress) =>
      void invoke("tray_progress", { progress: p }).catch(() => {});

    const stage = (id: string, s: "unlock" | "review" | "approved", review?: RelayReview) => {
      const req = open.current.get(id)?.req;
      const notice = req
        ? i18n.t(noticeKey({ method: req.method, review: review ?? null }), { origin: req.origin })
        : null;
      return invoke("site_stage", { id, stage: s, review: review ?? null, notice });
    };

    const run = async (req: RelayRequest) => {
      const entry: Open = { req, approval: null, resolve: null, unlock: null, authing: false };
      open.current.set(req.id, entry);
      const effects: RelayEffect[] = [];
      let response: SdkResponse;
      try {
        const handle = createDappRequestHandler({
          getOpenWallet: () => {
            const w = live.current.activeWallet;
            return w ? asSiteWallet(w) : null;
          },
          getWallets: () => live.current.wallets.map(asSiteWallet),
          getNetworkId: () => req.network,
          isLocked: () => live.current.isLocked,
          waitForUnlock: async () => {
            if (!live.current.isLocked) return true;
            await stage(req.id, "unlock");
            return new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => done(false), UNLOCK_WAIT_MS);
              const done = (ok: boolean) => {
                clearTimeout(timer);
                entry.unlock = null;
                resolve(ok);
              };
              entry.unlock = done;
            });
          },
          requestApproval: async (approval) => {
            entry.approval = approval;
            const answer = new Promise<ApprovalAnswer>((resolve) => {
              entry.resolve = resolve;
            });
            try {
              await stage(req.id, "review", relayReview(approval));
            } catch {
              entry.resolve = null;
              return { approved: false };
            }
            return answer;
          },
          // Touch ID or the password ran when the verb was clicked.
          requestAuth: async () => true,
          // Only this site moves; the network 0xio shows stays.
          setNetworkId: () => {},
          sites: relayBook(req, effects),
        });
        response =
          switchRefusal(req) ??
          (await handle(
            { id: req.id, method: req.method, params: req.params ?? {}, timestamp: Date.now() },
            req.origin,
          ));
      } catch (e) {
        response = fail(req.id, "INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
      } finally {
        open.current.delete(req.id);
      }
      try {
        const watch = await invoke<SiteWatch | null>("site_respond", {
          id: req.id,
          response,
          effects,
        });
        if (watch) void follow(req, watch);
      } catch (err) {
        logger.warn("sites", "could not answer a relayed request", err);
      }
      const to = effects.find((e) => e.type === "switch");
      if (response.success && to?.type === "switch") {
        const net = NETWORKS[to.to];
        sendRelayEvent(req.origin, req.clientId, "networkChanged", {
          id: to.to,
          networkId: to.to,
          name: net?.name ?? to.to,
          isTestnet: to.to !== "mainnet",
          networkInfo: { ...(net ?? {}), isTestnet: to.to !== "mainnet" },
        });
      }
    };

    const follow = async (req: RelayRequest, watch: SiteWatch) => {
      const scopeHolds = () =>
        !watch.address ||
        relayRecord(watch.network, req.origin, req.clientId)?.address === watch.address;
      const verdict = await watchSiteTx(watch, liveWatchDeps(scopeHolds));
      await reportProgress(watch.id, verdict).catch(() => {});
    };

    const answered = async (id: string) => {
      const entry = open.current.get(id);
      if (!entry?.approval || !entry.resolve || entry.authing) return;
      const review = relayReview(entry.approval);
      const op = reviewFeeOp(entry.req.method, review);
      const ou = reviewedOu(review);
      if (op && ou) {
        const checked = await recheckReviewedFee(op, entry.req.network, ou).catch(() => null);
        const error = checked ? checked.error : "Network fee unavailable. Try again.";
        if (error) {
          await stage(id, "review", relayReview(entry.approval, error)).catch(() => {});
          return;
        }
      }
      const approve = () => void approveOnce(open.current.get(id), id);
      if (!SIGNING.has(entry.approval.type)) return approve();
      entry.authing = true;
      try {
        const hasPassword = await walletBridge.hasPassword().catch(() => true);
        const biometric = await biometricService.isEnabled().catch(() => false);
        await approveTrayRequest({
          hasPassword,
          biometric,
          promptBiometric: () =>
            withTrayAuthHold(() => biometricService.unlock("Approve the site request")),
          isPending: () => !!open.current.get(id)?.resolve,
          run: approve,
          approving: () => progress({ requestId: id, stage: "approving" }),
          needPassword: () => progress({ requestId: id, stage: "needPassword" }),
        });
      } finally {
        const e = open.current.get(id);
        if (e) e.authing = false;
      }
    };

    const offs = [
      listen<unknown>("relay-sites", ({ payload }) => setRelaySites(payload)),
      listen<RelayRequest>("site-request", ({ payload }) => void run(payload)),
      listen<{ id: string }>("site-answer", ({ payload }) => void answered(payload.id)),
      listen<{ ids: string[] }>("site-dropped", ({ payload }) => {
        for (const id of payload.ids ?? []) {
          const e = open.current.get(id);
          if (!e) continue;
          e.resolve?.({ approved: false });
          e.resolve = null;
          e.unlock?.(false);
        }
      }),
      listen<MainTrayAction>("tray-action", ({ payload: a }) => {
        if (a.type !== "sendApproved") return;
        void approveOnce(open.current.get(a.requestId), a.requestId);
      }),
      listen<SiteWatch>("site-recheck", ({ payload }) => {
        void checkOnce(payload, chainDeps).then((verdict) => {
          if (verdict) void reportProgress(payload.id, verdict).catch(() => {});
        });
      }),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, []);
}
