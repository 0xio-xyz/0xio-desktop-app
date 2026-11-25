import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { useQueries, useQuery, useQueryClient } from "src/lib/query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { biometricService } from "src/services/wallet/biometricService";
import { buildTransferTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import {
  FeeUnavailableError,
  getNetwork,
  getRecommendedFeeStrict,
  type FeeOpType,
  type FeeRecommendation,
} from "src/services/network/networkService";
import { FEE_QUERY, feeQueryOptions } from "src/hooks/transactions/useFees";
import { holdBackgroundReads } from "src/services/app/backgroundReads";
import { holdWork } from "src/services/app/workInFlight";
import { afterFirstScreen } from "src/services/app/startup";
import { isValidAddress } from "src/services/storage/addressBookService";
import { usePvac } from "src/hooks/privacy/usePvac";
import { useBalance } from "src/hooks/wallet/useBalance";
import { ensurePvacFor, pvacSetupQuery } from "src/hooks/privacy/usePvacSetup";
import { MIGRATION_PENDING_WINDOW_MS } from "src/hooks/privacy/useMigrateBalance";
import * as privacyService from "src/features/privacy/services/privacyService";
import {
  clearBlockedAck,
  clearPendingKeySwitch,
  getPendingKeySwitch,
  loadBlockedAck,
} from "src/features/privacy/services/keySwitchService";
import type { KeySwitchMode } from "src/features/privacy/services/privacyService";
import { keySwitchModeQuery, runKeyUpdate } from "src/features/privacy/services/keyUpdate";
import {
  keyModeSignal,
  keyUpdateMovesBalance,
} from "src/features/privacy/services/keyUpdatePolicy";
import { PRIVATE_SETUP_QUERY, readPrivateSetupChecks } from "src/hooks/privacy/usePrivateSetupTag";
import {
  quoteBalanceRefresh,
  runBalanceRefresh,
} from "src/features/privacy/services/balanceRefresh";
import {
  FEE_SHORT,
  INSUFFICIENT_BALANCE,
  SCOPE_CHANGED,
  TrayError,
  approveTrayRequest,
  feeRead,
  privateReadiness,
  runPrivateOp,
  runPrivateRefresh,
  runPrivateSend,
  trayErrorCopy,
  trayErrorDetail,
  trayFeeError,
  trayMigrateRequestError,
  trayScope,
  type ReadinessSignals,
} from "src/features/privacy/services/trayPrivate";
import { NETWORKS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import { liveFeeOf, type LiveFee } from "src/services/transactions/reviewedFee";
import { TRAY_UNLOCK_EVENT, withTrayAuthHold } from "src/hooks/app/useTrayUnlockRequest";
import { useLockWallet } from "src/hooks/wallet/useLockWallet";
import {
  PRIVATE_STEPS,
  PUBLIC_STEPS,
  REFRESH_ONLY_STEPS,
  TURN_ON_STEPS,
  keyUpdateSteps,
  privateSteps,
  type MainTrayAction,
  type TraySendProgress,
  type TraySnapshot,
} from "src/tray/protocol";

const KEY_QUOTE_QUERY = "trayKeyQuote";
const TRAY_FEE_OPS = ["standard", "stealth", "encrypt", "decrypt"] as const;
type TrayFeeOp = (typeof TRAY_FEE_OPS)[number];

const WATCHED = new Set([
  "balance",
  "privateBalance",
  "claimOutputs",
  "pvacSetup",
  "keySwitchMode",
]);
const networkName = (id: string) =>
  id === "mainnet"
    ? "Mainnet"
    : id === "devnet"
      ? "Devnet"
      : id === "devnet2"
        ? "Devnet 2"
        : (NETWORKS[id]?.name ?? id);

function whileWorking(work: Promise<unknown>): void {
  const release = holdWork();
  void work.finally(release);
}

async function liveFee(op: FeeOpType, networkId: string): Promise<LiveFee | null> {
  const rec = await getRecommendedFeeStrict(op, networkId);
  return liveFeeOf(rec?.recommended, rec?.minimum);
}

function shownFee(rec: FeeRecommendation): LiveFee {
  const fee = liveFeeOf(rec.recommended, rec.minimum);
  if (fee === null) throw new FeeUnavailableError();
  return fee;
}

function trayFeeQuery(op: TrayFeeOp, networkId: string, enabled: boolean) {
  return { ...feeQueryOptions(op, networkId), enabled, select: shownFee };
}

type SendRequest = Extract<MainTrayAction, { type: "send" }>;
type PrivateRequest = Extract<MainTrayAction, { type: "private" }>;
type KeyRequest = Extract<
  MainTrayAction,
  { type: "refresh" } | { type: "turnOn" } | { type: "migrate" }
>;
type MigrateRequest = Extract<KeyRequest, { type: "migrate" }>;

/** A key switch recorded for this wallet and network that may still be in staging (the popup's
 *  in-flight guard window). */
function stagedKeySwitch(networkId: string, address: string): boolean {
  const rec = getPendingKeySwitch(networkId, address);
  return !!rec && Date.now() - rec.submittedAt < MIGRATION_PENDING_WINDOW_MS;
}

/**
 * The main window's side of the menu bar panel. It publishes what the panel shows, keeps the
 * balances, fees and quotes it shows read for the active wallet and network, and runs what the
 * panel asks for through the same code paths as the main window's own controls.
 */
export function useTrayBridge() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {
    isLocked,
    wallets,
    activeWallet,
    networkId,
    setNetworkId,
    refreshWallets,
    setWallets,
    setActiveWallet,
    setIsLocked,
    pvacForeign,
    setPvacForeign,
    pvacLegacy,
  } = useWallet();
  const { sendStealth, encrypt, decrypt } = usePvac();
  useBalance({ active: !isLocked });
  const [cacheTick, setCacheTick] = useState(0);
  const [auth, setAuth] = useState({ hasPassword: true, biometric: false });
  const [panelOpen, setPanelOpen] = useState(false);
  const pending = useRef(new Map<string, SendRequest>());
  const pendingPrivate = useRef(new Map<string, PrivateRequest>());
  const pendingKey = useRef(new Map<string, KeyRequest>());

  // Syncs with the query cache: re-publish when a balance or the claim count changes.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && WATCHED.has(String(e.query.queryKey[0])))
          setCacheTick((t) => t + 1);
      }),
    [qc],
  );

  // Syncs with the vault: whether a password and Touch ID are set, refreshed on lock changes.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const hasPassword = await walletBridge.hasPassword().catch(() => true);
      const biometric = await biometricService.isEnabled().catch(() => false);
      if (alive) setAuth({ hasPassword, biometric });
    })();
    return () => {
      alive = false;
    };
  }, [isLocked]);

  void cacheTick;
  const address = isLocked ? undefined : activeWallet?.address;
  const privacy = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const canSign = !!activeWallet && activeWallet.wallet_type !== "watch";
  const privateOn = !!address && privacy && canSign;
  const privateShown = privateOn && panelOpen;

  const feeQueries = useQueries({
    queries: TRAY_FEE_OPS.map((op) =>
      trayFeeQuery(op, networkId, panelOpen && !!address && (op === "standard" || privateOn)),
    ),
  });

  const setupQuery = useQuery({
    ...pvacSetupQuery(
      { address: activeWallet?.address ?? "", id: activeWallet?.id ?? "" },
      networkId,
    ),
    enabled: privateShown,
  });
  const setup = privateOn ? setupQuery.data : undefined;
  const keyIssue = !!address && (pvacForeign || pvacLegacy || !!loadBlockedAck(networkId, address));
  const keyModeQuery = useQuery({
    ...keySwitchModeQuery(
      { address: activeWallet?.address ?? "", id: activeWallet?.id ?? "" },
      networkId,
    ),
    enabled: privateShown && keyIssue,
  });

  const pub = address
    ? qc.getQueryData<{ balance: number }>(["balance", address, networkId])
    : undefined;
  const priv = address
    ? qc.getQueryData<number | null>(["privateBalance", address, networkId])
    : undefined;
  const staged = address ? getPendingKeySwitch(networkId, address) : null;
  const claims =
    activeWallet && !isLocked
      ? qc.getQueryData<unknown[]>(["claimOutputs", activeWallet.id, networkId])
      : undefined;

  const setupChecksQuery = useQuery({
    queryKey: [PRIVATE_SETUP_QUERY, networkId, address ?? "", pub?.balance ?? null],
    enabled: privateShown && setup?.regState === "unregistered" && pub != null,
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    queryFn: () => readPrivateSetupChecks(address ?? "", networkId),
  });
  const setupFailed =
    setupChecksQuery.status === "error" && setupChecksQuery.fetchStatus !== "fetching";

  const keyMode = keyModeQuery.data
    ? keyModeSignal(keyModeQuery.data as KeySwitchMode)
    : keyModeQuery.status === "error"
      ? null
      : undefined;

  const signals: ReadinessSignals = {
    setup,
    foreign: pvacForeign,
    legacy: pvacLegacy,
    refreshPending: !!staged && Date.now() - staged.submittedAt < MIGRATION_PENDING_WINDOW_MS,
    staged: !!staged,
    blockedAck: address ? loadBlockedAck(networkId, address) : null,
    setupChecks: setupChecksQuery.data,
    setupError: setupFailed
      ? setupChecksQuery.error instanceof FeeUnavailableError
        ? "fee"
        : "check"
      : null,
    publicMicro: pub?.balance ?? null,
    keyMode,
  };
  const baseReadiness = privateReadiness(signals);

  const refreshQuoteQuery = useQuery({
    queryKey: [KEY_QUOTE_QUERY, networkId, address ?? "", "refresh"],
    enabled: privateShown && baseReadiness.state === "needsRefresh",
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      const q = await quoteBalanceRefresh(address ?? "", activeWallet?.id ?? "", networkId);
      return q.fee;
    },
  });
  const keyQuoteQuery = useQuery({
    queryKey: [KEY_QUOTE_QUERY, networkId, address ?? "", "key"],
    enabled: privateShown && keyMode?.kind === "update",
    staleTime: 15_000,
    retry: 1,
    queryFn: () => privacyService.getKeySwitchFeeLive("recommended", networkId),
  });

  const [standardFee, stealthFee, encryptFee, decryptFee] = feeQueries.map(feeRead);
  const snapshot: TraySnapshot = {
    locked: isLocked,
    hasPassword: auth.hasPassword,
    biometric: auth.biometric,
    wallets: isLocked ? [] : wallets.map((w) => ({ id: w.id, name: w.name, address: w.address })),
    activeId: isLocked ? null : (activeWallet?.id ?? null),
    network: networkId,
    networks: Object.keys(NETWORKS).map((id) => ({ id, name: networkName(id) })),
    privacy,
    canSign,
    privateReadiness: isLocked
      ? { state: "checking" }
      : privateReadiness({ ...signals, keyFee: feeRead(keyQuoteQuery) }),
    publicMicro: isLocked ? null : (pub?.balance ?? null),
    privateMicro: isLocked ? null : (priv ?? null),
    claims: isLocked ? 0 : (claims?.length ?? 0),
    fees: {
      public: standardFee,
      private: stealthFee,
      encrypt: encryptFee,
      decrypt: decryptFee,
      refresh: feeRead(refreshQuoteQuery),
    },
  };
  const published = JSON.stringify(snapshot);

  // Syncs with Rust: publish every change of what the panel shows, the latest one once the first
  // screen has painted.
  const lastPublished = useRef("");
  useEffect(() => {
    lastPublished.current = published;
    afterFirstScreen(() => {
      if (lastPublished.current !== published) return;
      void invoke("tray_publish", { snapshot: JSON.parse(published) }).catch(() => {});
    });
  }, [published]);

  const progress = useCallback((p: TraySendProgress) => {
    void invoke("tray_progress", { progress: p }).catch(() => {});
  }, []);

  const failWith = useCallback(
    (requestId: string, what: string, err: unknown) => {
      logger.error("tray", `${what} failed - ${trayErrorDetail(err)}`);
      progress({ requestId, stage: "failed", error: trayErrorCopy(err) });
    },
    [progress],
  );

  const pinScope = useCallback(
    (req: { walletId: string; network: string }) =>
      trayScope(req, {
        walletId: activeWallet?.id ?? null,
        address: activeWallet?.address ?? null,
        network: networkId,
        rpcNetwork: getNetwork(),
      }),
    [activeWallet, networkId],
  );

  const publicBalance = useCallback(
    (address: string, network: string) =>
      qc.getQueryData<{ balance: number }>(["balance", address, network])?.balance ?? null,
    [qc],
  );

  const refreshShown = useCallback(
    (address: string, network: string) => {
      void qc.invalidateQueries({ queryKey: ["balance", address, network] });
      void qc.invalidateQueries({ queryKey: ["privateBalance", address, network] });
      void qc.invalidateQueries({ queryKey: ["pvacSetup", address, network] });
      void qc.invalidateQueries({ queryKey: [FEE_QUERY, network] });
      void qc.invalidateQueries({ queryKey: [KEY_QUOTE_QUERY, network, address] });
    },
    [qc],
  );

  const execute = useCallback(
    async (req: SendRequest) => {
      pending.current.delete(req.requestId);
      const wallet = activeWallet;
      const scope = pinScope(req);
      if (!wallet || !scope) {
        failWith(req.requestId, "send", new TrayError(SCOPE_CHANGED));
        return;
      }
      const isPrivate = req.mode === "private";
      const steps = isPrivate ? PRIVATE_STEPS : PUBLIC_STEPS;
      progress({ requestId: req.requestId, stage: "sending", steps, stepIndex: 0 });
      try {
        const feeError = trayFeeError(
          req.feeOu,
          await liveFee(isPrivate ? "stealth" : "standard", scope.networkId),
        );
        if (feeError) throw new TrayError(feeError);
        const pubNow = publicBalance(wallet.address, scope.networkId);
        if (pubNow !== null && pubNow < req.feeOu + (isPrivate ? 0 : req.amountMicro))
          throw new TrayError(isPrivate ? FEE_SHORT : INSUFFICIENT_BALANCE);
        const ou = String(req.feeOu);
        if (isPrivate) {
          await runPrivateSend({
            readiness: async () => {
              await ensurePvacFor(wallet);
              const [registration, spend] = await Promise.all([
                privacyService.getPvacRegistrationState(wallet.address, scope.networkId),
                privacyService.getSpendReadiness(wallet.address, wallet.id, scope.networkId),
              ]);
              return {
                ...spend,
                registration,
                keyUpdate: pvacForeign || pvacLegacy,
                waiting: stagedKeySwitch(scope.networkId, wallet.address),
              };
            },
            op: () =>
              sendStealth(
                req.to,
                req.amountMicro,
                ou,
                (n: number) =>
                  progress({
                    requestId: req.requestId,
                    stage: "sending",
                    steps,
                    stepIndex: Math.min(n, steps.length - 1),
                  }),
                scope,
              ),
          });
        } else {
          const tx = await buildTransferTx({
            from: wallet.address,
            to: req.to,
            amount: req.amountMicro,
            walletId: wallet.id,
            ou,
            scope,
          });
          progress({ requestId: req.requestId, stage: "sending", steps, stepIndex: 1 });
          await broadcastSignedTx(tx, scope);
        }
        logger.info("tray", `send done - mode=${req.mode} amount=${req.amountMicro} ou=${ou}`);
        progress({ requestId: req.requestId, stage: "sent" });
      } catch (err: unknown) {
        failWith(req.requestId, "send", err);
      } finally {
        refreshShown(wallet.address, scope.networkId);
      }
    },
    [
      activeWallet,
      pinScope,
      progress,
      failWith,
      publicBalance,
      refreshShown,
      sendStealth,
      pvacForeign,
      pvacLegacy,
    ],
  );

  const executePrivate = useCallback(
    async (req: PrivateRequest) => {
      pendingPrivate.current.delete(req.requestId);
      const wallet = activeWallet;
      const scope = pinScope(req);
      if (!wallet || !scope) {
        failWith(req.requestId, req.direction, new TrayError(SCOPE_CHANGED));
        return;
      }
      const steps = privateSteps(req.direction, req.refresh);
      const offset = req.refresh ? 1 : 0;
      const at = (stepIndex: number) =>
        progress({
          requestId: req.requestId,
          stage: "sending",
          steps,
          stepIndex: Math.min(stepIndex, steps.length - 1),
        });
      const run = req.direction === "encrypt" ? encrypt : decrypt;
      at(0);
      try {
        const feeError = trayFeeError(req.feeOu, await liveFee(req.direction, scope.networkId));
        if (feeError) throw new TrayError(feeError);
        let reuse = false;
        if (req.refresh) {
          const q = await quoteBalanceRefresh(wallet.address, wallet.id, scope.networkId);
          const refreshError = trayFeeError(req.refreshFeeOu, q.fee);
          if (refreshError) throw new TrayError(refreshError);
          reuse = q.reuse;
        }
        const pubNow = publicBalance(wallet.address, scope.networkId);
        const fees = req.feeOu + (req.refresh ? req.refreshFeeOu : 0);
        if (pubNow !== null && pubNow < fees) throw new TrayError(FEE_SHORT);
        if (pubNow !== null && req.direction === "encrypt" && pubNow < fees + req.amountMicro)
          throw new TrayError(INSUFFICIENT_BALANCE);
        await runPrivateOp({
          reviewedRefresh: req.refresh,
          deps: {
            readiness: async () => {
              await ensurePvacFor(wallet);
              return privacyService.getSpendReadiness(wallet.address, wallet.id, scope.networkId);
            },
            refresh: () =>
              runBalanceRefresh({
                scope,
                walletId: wallet.id,
                reuse,
                ou: String(req.refreshFeeOu),
              }),
            op: (onStep) => run(req.amountMicro, String(req.feeOu), onStep, scope),
          },
          onEvent: (e) => at(e.phase === "refresh" ? 0 : offset + e.step),
        });
        logger.info(
          "tray",
          `${req.direction} done - amount=${req.amountMicro} refresh=${req.refresh} ou=${req.feeOu}`,
        );
        progress({ requestId: req.requestId, stage: "sent" });
      } catch (err: unknown) {
        failWith(req.requestId, req.direction, err);
      } finally {
        refreshShown(wallet.address, scope.networkId);
      }
    },
    [activeWallet, pinScope, progress, failWith, publicBalance, refreshShown, encrypt, decrypt],
  );

  const executeRefresh = useCallback(
    async (req: Extract<KeyRequest, { type: "refresh" }>) => {
      pendingKey.current.delete(req.requestId);
      const wallet = activeWallet;
      const scope = pinScope(req);
      if (!wallet || !scope) {
        failWith(req.requestId, "migration", new TrayError(SCOPE_CHANGED));
        return;
      }
      const at = (stepIndex: number) =>
        progress({
          requestId: req.requestId,
          stage: "sending",
          steps: REFRESH_ONLY_STEPS,
          stepIndex,
        });
      at(0);
      try {
        const quote = await quoteBalanceRefresh(wallet.address, wallet.id, scope.networkId);
        const feeError = trayFeeError(req.feeOu, quote.fee);
        if (feeError) throw new TrayError(feeError);
        if (stagedKeySwitch(scope.networkId, wallet.address))
          throw new TrayError("A migration is already waiting for the network.");
        const pubNow = publicBalance(wallet.address, scope.networkId);
        if (pubNow !== null && pubNow < req.feeOu) throw new TrayError(FEE_SHORT);
        await runPrivateRefresh({
          deps: {
            readiness: async () => {
              await ensurePvacFor(wallet);
              return privacyService.getSpendReadiness(wallet.address, wallet.id, scope.networkId);
            },
            refresh: () =>
              runBalanceRefresh({
                scope,
                walletId: wallet.id,
                reuse: quote.reuse,
                ou: String(req.feeOu),
              }),
          },
          onEvent: (e) => at(e.phase === "refresh" ? 0 : 1),
        });
        logger.info("tray", `migration done - ou=${req.feeOu}`);
        progress({ requestId: req.requestId, stage: "sent" });
      } catch (err: unknown) {
        failWith(req.requestId, "migration", err);
      } finally {
        refreshShown(wallet.address, scope.networkId);
      }
    },
    [activeWallet, pinScope, progress, failWith, publicBalance, refreshShown],
  );

  const executeMigrate = useCallback(
    async (req: MigrateRequest) => {
      pendingKey.current.delete(req.requestId);
      const wallet = activeWallet;
      const scope = pinScope(req);
      if (!wallet || !scope) {
        failWith(req.requestId, "key update", new TrayError(SCOPE_CHANGED));
        return;
      }
      const steps = keyUpdateSteps(keyUpdateMovesBalance(req.mode));
      const at = (stepIndex: number) =>
        progress({ requestId: req.requestId, stage: "sending", steps, stepIndex });
      at(0);
      try {
        const fee = await privacyService.getKeySwitchFeeLive("recommended", scope.networkId);
        const mismatch = trayMigrateRequestError(req, {
          walletId: wallet.id,
          network: scope.networkId,
          fee,
        });
        if (mismatch) throw new TrayError(mismatch);
        if (stagedKeySwitch(scope.networkId, wallet.address))
          throw new TrayError("A key update is already waiting for the network.");
        const pubNow = publicBalance(wallet.address, scope.networkId);
        if (pubNow !== null && pubNow < req.feeOu) throw new TrayError(FEE_SHORT);
        await ensurePvacFor(wallet);
        const { txHash } = await runKeyUpdate({
          scope,
          walletId: wallet.id,
          ou: String(req.feeOu),
          expect: { mode: req.mode, amountMicro: req.amountMicro },
          onStep: (step) => at(step === "resolve" ? 0 : step === "build" ? 1 : 2),
        });
        setPvacForeign(false);
        clearBlockedAck(scope.networkId, wallet.address);
        at(3);
        const exec = await privacyService.confirmKeySwitchOutcome(txHash, 240_000, scope.networkId);
        if (exec.status === "rejected") {
          clearPendingKeySwitch(scope.networkId, wallet.address, txHash);
          throw new TrayError("The network rejected the update.", exec.reason || "unknown reason");
        }
        logger.info("tray", `key update ${req.mode} ${exec.status} - ou=${req.feeOu}`);
        progress({ requestId: req.requestId, stage: "sent", pending: exec.status === "pending" });
      } catch (err: unknown) {
        failWith(req.requestId, "key update", err);
      } finally {
        refreshShown(wallet.address, scope.networkId);
        void qc.invalidateQueries({ queryKey: ["keySwitchMode", wallet.address, scope.networkId] });
      }
    },
    [activeWallet, pinScope, progress, failWith, publicBalance, refreshShown, qc, setPvacForeign],
  );

  const executeTurnOn = useCallback(
    async (req: Extract<KeyRequest, { type: "turnOn" }>) => {
      pendingKey.current.delete(req.requestId);
      const wallet = activeWallet;
      const scope = pinScope(req);
      if (!wallet || !scope) {
        failWith(req.requestId, "turn on", new TrayError(SCOPE_CHANGED));
        return;
      }
      const at = (stepIndex: number) =>
        progress({ requestId: req.requestId, stage: "sending", steps: TURN_ON_STEPS, stepIndex });
      at(0);
      try {
        const [fee, regState] = await Promise.all([
          privacyService.getKeySwitchFeeLive("recommended", scope.networkId),
          privacyService.getPvacRegistrationState(wallet.address, scope.networkId),
        ]);
        const feeError = trayFeeError(req.feeOu, fee);
        if (feeError) throw new TrayError(feeError);
        if (regState !== "unregistered" || getPendingKeySwitch(scope.networkId, wallet.address))
          throw new TrayError("Your private balance is already set up or waiting for the network.");
        const pubNow = publicBalance(wallet.address, scope.networkId);
        if (pubNow !== null && pubNow < req.feeOu) throw new TrayError(FEE_SHORT);
        await ensurePvacFor(wallet);
        at(1);
        try {
          await privacyService.registerPvacKey(scope, wallet.id, { ou: String(req.feeOu) });
        } catch (e) {
          if (!(e instanceof Error && e.name === "PvacSetupPending")) throw e;
        }
        logger.info("tray", `turn on submitted - ou=${req.feeOu}`);
        progress({ requestId: req.requestId, stage: "sent" });
      } catch (err: unknown) {
        failWith(req.requestId, "turn on", err);
      } finally {
        refreshShown(wallet.address, scope.networkId);
        void qc.invalidateQueries({
          queryKey: [PRIVATE_SETUP_QUERY, scope.networkId, wallet.address],
        });
      }
    },
    [activeWallet, pinScope, progress, failWith, publicBalance, refreshShown, qc],
  );

  // Through handlers.current: an approval must check the wallet and network of approval time.
  const runApproved = useCallback((requestId: string) => {
    const h = handlers.current;
    const send = pending.current.get(requestId);
    if (send) return void whileWorking(h.execute(send));
    const priv = pendingPrivate.current.get(requestId);
    if (priv) return void whileWorking(h.executePrivate(priv));
    const key = pendingKey.current.get(requestId);
    if (!key) return;
    whileWorking(
      key.type === "refresh"
        ? h.executeRefresh(key)
        : key.type === "migrate"
          ? h.executeMigrate(key)
          : h.executeTurnOn(key),
    );
  }, []);

  const isPending = useCallback(
    (requestId: string) =>
      pending.current.has(requestId) ||
      pendingPrivate.current.has(requestId) ||
      pendingKey.current.has(requestId),
    [],
  );

  const approve = useCallback(
    (requestId: string, reason: string) =>
      approveTrayRequest({
        hasPassword: auth.hasPassword,
        biometric: auth.biometric,
        promptBiometric: () => withTrayAuthHold(() => biometricService.unlock(reason)),
        isPending: () => isPending(requestId),
        run: () => runApproved(requestId),
        approving: () => progress({ requestId, stage: "approving" }),
        needPassword: () => progress({ requestId, stage: "needPassword" }),
      }),
    [auth, isPending, runApproved, progress],
  );

  const refuse = useCallback(
    (requestId: string) =>
      progress({ requestId, stage: "failed", error: "That request does not look right." }),
    [progress],
  );

  const requestSend = useCallback(
    async (req: SendRequest) => {
      if (
        !isValidAddress(req.to) ||
        !(req.amountMicro > 0) ||
        !Number.isSafeInteger(req.feeOu) ||
        req.feeOu <= 0
      )
        return refuse(req.requestId);
      pending.current.set(req.requestId, req);
      await approve(req.requestId, "Approve the send from the menu bar");
    },
    [approve, refuse],
  );

  const requestPrivate = useCallback(
    async (req: PrivateRequest) => {
      if (
        !(req.amountMicro > 0) ||
        !Number.isSafeInteger(req.feeOu) ||
        req.feeOu <= 0 ||
        !NETWORKS[req.network]?.supportsPrivacy
      )
        return refuse(req.requestId);
      pendingPrivate.current.set(req.requestId, req);
      await approve(
        req.requestId,
        req.direction === "encrypt"
          ? "Approve the encrypt from the menu bar"
          : "Approve the decrypt from the menu bar",
      );
    },
    [approve, refuse],
  );

  const requestKey = useCallback(
    async (req: KeyRequest) => {
      const shapeError =
        req.type === "migrate"
          ? trayMigrateRequestError(req, {
              walletId: req.walletId,
              network: req.network,
              fee: { ou: req.feeOu, floorOu: req.feeOu },
            })
          : null;
      if (
        shapeError ||
        !Number.isSafeInteger(req.feeOu) ||
        req.feeOu <= 0 ||
        !NETWORKS[req.network]?.supportsPrivacy
      )
        return refuse(req.requestId);
      pendingKey.current.set(req.requestId, req);
      await approve(
        req.requestId,
        req.type === "refresh"
          ? "Approve the balance migration from the menu bar"
          : req.type === "migrate"
            ? keyUpdateMovesBalance(req.mode)
              ? "Approve the balance migration from the menu bar"
              : "Approve the encryption key update from the menu bar"
            : "Approve turning on private balance from the menu bar",
      );
    },
    [approve, refuse],
  );

  const retryReads = useCallback(() => {
    for (const op of TRAY_FEE_OPS)
      void qc.refetchQueries({ queryKey: feeQueryOptions(op, networkId).queryKey, exact: true });
    if (!address) return;
    void qc.refetchQueries({ queryKey: [KEY_QUOTE_QUERY, networkId, address] });
    void qc.refetchQueries({ queryKey: [PRIVATE_SETUP_QUERY, networkId, address] });
  }, [qc, networkId, address]);

  const switchWallet = useCallback(
    async (id: string) => {
      if (id === activeWallet?.id) return;
      const target = wallets.find((w) => w.id === id);
      if (!target) return;
      pvacBridge.destroy().catch(() => {});
      await walletBridge.setActive(id);
      refreshWallets(wallets.map((w) => ({ ...w, is_active: w.id === id })));
    },
    [activeWallet?.id, wallets, refreshWallets],
  );

  const lock = useLockWallet();

  const handlers = useRef({
    requestSend,
    requestPrivate,
    requestKey,
    executeRefresh,
    executeMigrate,
    executeTurnOn,
    switchWallet,
    lock,
    execute,
    executePrivate,
    retryReads,
    runApproved,
    setNetworkId,
    navigate,
  });
  handlers.current = {
    requestSend,
    requestPrivate,
    requestKey,
    executeRefresh,
    executeMigrate,
    executeTurnOn,
    switchWallet,
    lock,
    execute,
    executePrivate,
    retryReads,
    runApproved,
    setNetworkId,
    navigate,
  };

  // Syncs with Rust: the panel's requests, its password unlock, and panel opens.
  useEffect(() => {
    let release: (() => void) | null = null;
    const offs = [
      listen<MainTrayAction>("tray-action", ({ payload: a }) => {
        const h = handlers.current;
        switch (a.type) {
          case "switchWallet":
            void h.switchWallet(a.id).catch((e) => logger.error("tray", `switch failed: ${e}`));
            break;
          case "setNetwork":
            if (NETWORKS[a.id]) h.setNetworkId(a.id);
            break;
          case "lock":
            void h.lock();
            break;
          case "unlockBiometric":
            window.dispatchEvent(new Event(TRAY_UNLOCK_EVENT));
            break;
          case "navigate":
            h.navigate(a.route);
            break;
          case "send":
            void h.requestSend(a);
            break;
          case "private":
            void h.requestPrivate(a);
            break;
          case "refresh":
          case "turnOn":
          case "migrate":
            void h.requestKey(a);
            break;
          case "sendApproved":
            h.runApproved(a.requestId);
            break;
          case "cancelSend":
            pending.current.delete(a.requestId);
            pendingPrivate.current.delete(a.requestId);
            pendingKey.current.delete(a.requestId);
            break;
          case "retryReads":
            h.retryReads();
            break;
        }
      }),
      listen<WalletData[]>("tray-unlocked", ({ payload }) => {
        setWallets(payload);
        setActiveWallet(payload.find((w) => w.is_active) || payload[0] || null);
        setIsLocked(false);
        handlers.current.navigate("/");
      }),
      listen("tray-opened", () => {
        release ??= holdBackgroundReads();
        setPanelOpen(true);
        void qc.invalidateQueries({ queryKey: ["balance"] });
        void qc.invalidateQueries({ queryKey: ["privateBalance"] });
        void qc.invalidateQueries({ queryKey: ["claimOutputs"] });
        void qc.invalidateQueries({ queryKey: [KEY_QUOTE_QUERY] });
        void qc.refetchQueries({ queryKey: ["pvacSetup"], stale: true, type: "active" });
        void qc.refetchQueries({ queryKey: ["keySwitchMode"], stale: true, type: "active" });
      }),
      listen("tray-closed", () => {
        release?.();
        release = null;
        setPanelOpen(false);
      }),
    ];
    return () => {
      release?.();
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [qc, setWallets, setActiveWallet, setIsLocked]);
}
