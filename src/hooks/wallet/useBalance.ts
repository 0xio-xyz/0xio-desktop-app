import { useState, useCallback, useEffect } from "react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import * as networkService from "src/services/network/networkService";
import * as privacyService from "src/features/privacy/services/privacyService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { NETWORKS, POLL_INTERVALS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import { publishDappEvent } from "src/features/dapp/services/dappEvents";
import { sitesUsing } from "src/features/dapp/services/dappService";
import { appendSnapshot } from "src/services/storage/balanceHistory";
import { keepWithinScope } from "src/lib/query/queryScope";
import { useBackgroundReads } from "src/services/app/backgroundReads";
import {
  getPendingKeySwitch,
  clearPendingKeySwitch,
  resolveRotationState,
} from "src/features/privacy/services/keySwitchService";

// Module level so every screen's useBalance shares one PVAC init per wallet.
let _initedWalletId: string | null = null;
let _initPromise: Promise<void> | null = null;
// A lock or network switch destroys the context after a successful init, so a settled promise
// must not stand in for a running one.
let _initInFlight = false;
// Fetched in parallel with the PVAC init.
let _prefetchedCipher: {
  address: string;
  networkId: string;
  cipher: string | null;
  promise: Promise<string | null>;
} | null = null;

// Re-checked so a rotation submitted mid-session is noticed.
let _pvacKeyChecked: { key: string; at: number } | null = null;
const PVAC_KEY_RECHECK_MS = 5 * 60 * 1000;

// Last balance sent to dapps, as "address:public:private".
let _lastBalanceEvent: string | null = null;

/** `active: false` reads nothing (the menu bar bridge passes it while the wallet is locked). */
export function useBalance(opts?: { active?: boolean }) {
  const active = opts?.active ?? true;
  const { activeWallet, networkId, setPvacForeign, setPvacLegacy } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const address = active ? activeWallet?.address : undefined;
  const [pvacReady, setPvacReady] = useState(pvacBridge.isInitialized());
  const background = useBackgroundReads();

  const walletId = active ? (activeWallet?.id ?? null) : null;
  useEffect(() => {
    if (_initedWalletId === walletId) {
      if (address && pvacBridge.isInitializedFor(address)) {
        setPvacReady(true);
        return;
      }
      if (_initInFlight && _initPromise) {
        // StrictMode remount: wait for the running init.
        let cancelled = false;
        _initPromise
          .then(() => {
            if (!cancelled && address && pvacBridge.isInitializedFor(address)) {
              setPvacReady(true);
            }
          })
          .catch(() => {});

        return () => {
          cancelled = true;
        };
      }
      // The context was destroyed (lock, then unlock into the same wallet): init again.
      logger.info("balance", "PVAC context is down for the current wallet - initializing again");
    }

    setPvacReady(false);

    const isWatchOnly = activeWallet?.wallet_type === "watch";
    if (!walletId || !address || !privacyEnabled || isWatchOnly) {
      _initedWalletId = null;
      _initPromise = null;
      return;
    }

    _initedWalletId = walletId;
    let cancelled = false;

    logger.info("balance", `PVAC init starting for wallet ${walletId.slice(0, 8)}...`);
    _initInFlight = true;
    _initPromise = (async () => {
      try {
        if (cancelled) return;
        if (address) {
          // The promise stays rejecting so the query tells a failed fetch (keep the last pOCT) from
          // no cipher (a real 0); the query awaits it again and rethrows.
          const cipherPromise = networkService.getEncryptedBalance(address, walletId, networkId);
          const prefetch = {
            address,
            networkId,
            cipher: null as string | null,
            promise: cipherPromise,
          };
          _prefetchedCipher = prefetch;
          cipherPromise.then(
            (c) => {
              prefetch.cipher = c;
            },
            () => {},
          );
        }
        await privacyService.initPvac(walletId, address);
        if (!cancelled) {
          logger.info("balance", "PVAC ready - enabling private balance query");
          setPvacReady(true);
        }
      } catch (e) {
        logger.error("balance", "PVAC auto-init failed", e);
      } finally {
        _initInFlight = false;
      }
    })();

    return () => {
      // A StrictMode remount for the same wallet reuses the running init.
      if (_initedWalletId !== walletId) {
        cancelled = true;
      }
    };
  }, [walletId, privacyEnabled, networkId]);

  const publicQuery = useQuery({
    queryKey: ["balance", address, networkId],
    queryFn: async () => {
      if (!address) return { balance: 0, nonce: 0 };
      try {
        const result = await networkService.getBalance(address, networkId, "poll");
        logger.info("balance", `public: ${result.balance} µOCT, nonce=${result.nonce}`);
        return result;
      } catch (err) {
        logger.error(
          "balance",
          `public balance FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
    enabled: !!address,
    staleTime: POLL_INTERVALS.balance,
    refetchInterval: POLL_INTERVALS.balance,
    refetchIntervalInBackground: background,
    placeholderData: keepWithinScope(address, networkId),
  });

  const privateQuery = useQuery({
    queryKey: ["privateBalance", address, networkId],
    queryFn: async (): Promise<number | null> => {
      if (!address || !walletId) return null;
      const stillCurrent = () => networkService.isScopeCurrent({ address, networkId });
      try {
        const start = performance.now();

        // Started beside the slow decrypt; every decision still waits for the decrypt.
        const checkKey = `${networkId}:${address}`;
        const checkedRecently =
          _pvacKeyChecked?.key === checkKey &&
          Date.now() - _pvacKeyChecked.at < PVAC_KEY_RECHECK_MS;
        let keyPair: Promise<[string, string | null]> | null = null;
        if (!checkedRecently) {
          keyPair = Promise.all([
            privacyService.getLocalPubkey(address),
            networkService.getPvacPubkey(address, networkId),
          ]);
          // Claimed below; this keeps a rejection from going unhandled during the decrypt.
          keyPair.catch(() => {});
        }

        let result: number | null;
        // Per call, not a shared flag, so another wallet's decrypt in flight cannot mark this one.
        let corrupted = false;
        let legacy = false;
        if (_prefetchedCipher?.address === address && _prefetchedCipher.networkId === networkId) {
          const prefetched = _prefetchedCipher;
          _prefetchedCipher = null;
          const cipher = prefetched.cipher ?? (await prefetched.promise);
          if (cipher) {
            const r = await privacyService.decryptCipher(address, cipher);
            result = r.value;
            corrupted = r.corrupted;
            legacy = r.legacy === true;
            logger.info(
              "balance",
              `private (prefetched): ${result} µOCT (${(performance.now() - start).toFixed(0)}ms)`,
            );
          } else {
            logger.info("balance", "private: no cipher -> 0");
            result = 0;
          }
        } else {
          const r = await privacyService.getPrivateBalance(address, walletId, networkId);
          result = r.value;
          corrupted = r.corrupted;
          legacy = r.legacy === true;
          logger.info(
            "balance",
            `private: ${result} µOCT (${(performance.now() - start).toFixed(0)}ms)`,
          );
        }
        if (!stillCurrent()) return result;
        // Legacy is not corruption: the value is readable and the key is ours. Screens block
        // private ops on it instead of failing at proof time.
        setPvacLegacy(legacy);

        // A cipher sealed under the old key cannot decrypt while a rotation is pending.
        if (corrupted) {
          if (getPendingKeySwitch(networkId, address)) {
            logger.warn(
              "balance",
              `cipher corrupted for ${address.slice(0, 8)}... but a rotation is pending - expected, not prompting`,
            );
            setPvacForeign(false);
          } else {
            logger.warn(
              "balance",
              `cipher corrupted for ${address.slice(0, 8)}... - triggering key switch overlay`,
            );
            setPvacForeign(true);
          }
        } else {
          setPvacForeign(false);
        }

        if (keyPair) {
          _pvacKeyChecked = { key: checkKey, at: Date.now() };
          keyPair
            .then(async ([localPub, remotePub]) => {
              if (!stillCurrent()) {
                logger.debug(
                  "balance",
                  `PVAC key check for ${address.slice(0, 8)}... is stale - wallet switched, discarding`,
                );
                return;
              }
              if (remotePub && remotePub !== localPub) {
                const ours = await privacyService.isOurPubkey(address, remotePub);
                if (!stillCurrent()) return;
                if (ours) {
                  if (corrupted) {
                    // Bound to an older key generation: keep the overlay, the mode resolver shows
                    // the hold.
                    logger.warn(
                      "balance",
                      `PVAC key for ${address.slice(0, 8)}... is ours but the cipher is unreadable - keeping overlay`,
                    );
                    return;
                  }
                  logger.info(
                    "balance",
                    `PVAC remote key for ${address.slice(0, 8)}... differs bytewise but is derived from our secret - no mismatch`,
                  );
                  setPvacForeign(false);
                  return;
                }
                const rotation = await resolveRotationState(networkId, address, localPub);
                if (!stillCurrent()) return;
                if (rotation.kind === "pending") {
                  const waitedMin = Math.round((Date.now() - rotation.submittedAt) / 60_000);
                  logger.warn(
                    "balance",
                    `PVAC key mismatch for ${address.slice(0, 8)}... but rotation ${rotation.txHash.slice(0, 10)}... is pending (${waitedMin}m) - suppressing overlay`,
                  );
                  setPvacForeign(false);
                  return;
                }
                if (rotation.kind === "stuck") {
                  logger.warn(
                    "balance",
                    `PVAC rotation ${rotation.txHash.slice(0, 10)}... for ${address.slice(0, 8)}... has not been applied by the node - see PVAC key status`,
                  );
                  setPvacForeign(false);
                  return;
                }
                logger.warn(
                  "balance",
                  `PVAC key MISMATCH for ${address.slice(0, 8)}... - showing key switch overlay`,
                );
                setPvacForeign(true);
              } else if (remotePub && corrupted) {
                logger.warn(
                  "balance",
                  `PVAC keys match but cipher corrupted for ${address.slice(0, 8)}... - keeping overlay`,
                );
              } else if (remotePub) {
                logger.debug("balance", `PVAC keys match for ${address.slice(0, 8)}...`);
                clearPendingKeySwitch(networkId, address);
                setPvacForeign(false);
              }
            })
            .catch((err) => {
              logger.warn("balance", `PVAC key check failed: ${err}`);
            });
        }

        return result;
      } catch (e) {
        // Rethrown so the query keeps the last good private balance; a real empty balance
        // returns 0 above.
        logger.warn("balance", `private balance fetch failed - keeping last-known (${e})`);
        throw e;
      }
    },
    enabled: !!address && pvacReady && privacyEnabled,
    staleTime: POLL_INTERVALS.balance * 2,
    refetchInterval: POLL_INTERVALS.balance * 2,
    placeholderData: keepWithinScope(address, networkId),
  });

  // effect:audited - portfolio history sampling, keyed on settled balances. Gated on settled
  // data, not a positive balance, so a drop to 0 is recorded; placeholder data from the previous
  // wallet is never recorded.
  const publicSettled = publicQuery.data !== undefined && !publicQuery.isPlaceholderData;
  const publicMicro = publicQuery.data?.balance ?? 0;
  const privateMicro = privateQuery.data ?? 0;
  // A stale or undecrypted private balance would show a phantom drop to public only.
  const privateBlocked =
    privacyEnabled && (privateQuery.isPlaceholderData || privateQuery.data == null);
  useEffect(() => {
    if (!address || !publicSettled || privateBlocked) return;
    appendSnapshot(address, networkId, publicMicro / 1_000_000, privateMicro / 1_000_000);
  }, [address, networkId, publicSettled, privateBlocked, publicMicro, privateMicro]);

  const refetch = useCallback(() => {
    publicQuery.refetch();
    privateQuery.refetch();
  }, [publicQuery, privateQuery]);

  // Deduped at module scope: several mounted screens observe the same query cache.
  const pubForEvent = publicQuery.data?.balance ?? null;
  const privForEvent = privateQuery.data ?? null;
  useEffect(() => {
    if (!address || pubForEvent === null) return;
    const priv = typeof privForEvent === "number" ? privForEvent : 0;
    const key = `${address}:${pubForEvent}:${priv}`;
    if (_lastBalanceEvent === key) return;
    const first = _lastBalanceEvent === null || !_lastBalanceEvent.startsWith(`${address}:`);
    _lastBalanceEvent = key;
    // The first reading for an address is the baseline, not a change.
    if (first) return;
    publishDappEvent(
      "balanceChanged",
      {
        address,
        balance: {
          public: pubForEvent,
          private: priv,
          total: pubForEvent + priv,
          currency: "OCT",
        },
        publicBalance: pubForEvent,
        privateBalance: priv,
      },
      // Only the sites that use this wallet on this network hear about its balance.
      sitesUsing(networkService.getNetwork(), address),
    );
  }, [address, pubForEvent, privForEvent]);

  return {
    publicBalance: publicQuery.data?.balance ?? 0,
    privateBalance: privateQuery.data ?? null,
    nonce: publicQuery.data?.nonce ?? 0,
    isLoading: publicQuery.isLoading,
    isRefetching: publicQuery.isRefetching,
    isPrivateLoading: privateQuery.isLoading,
    failed: publicQuery.isError,
    updatedAt: publicQuery.dataUpdatedAt || null,
    isPvacLoading: !pvacReady && privacyEnabled && activeWallet?.wallet_type !== "watch",
    refetch,
  };
}
