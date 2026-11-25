import { useState, useCallback, useRef, useEffect } from "react";
import * as privacyService from "src/features/privacy/services/privacyService";
import type {
  ClaimableOutput,
  StealthProgressCallback,
} from "src/features/privacy/services/privacyService";
import { resetStealthScanCache } from "src/features/privacy/services/privacyService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { useWallet } from "src/contexts/useWallet";
import { assertScope, captureScope, type TxScope } from "src/services/network/networkService";
import { logger } from "src/lib/logger";

export function usePvac() {
  const [isComputing, setIsComputing] = useState(false);
  const { activeWallet, showMessage } = useWallet();
  const cachedWalletId = useRef<string | null>(null);

  useEffect(() => {
    const walletId = activeWallet?.id ?? null;
    if (cachedWalletId.current !== null && cachedWalletId.current !== walletId) {
      pvacBridge.destroy().catch(() => {});
      resetStealthScanCache();
    }
    cachedWalletId.current = walletId;
  }, [activeWallet]);

  const walletId = activeWallet?.id ?? "";

  const init = useCallback(async () => {
    if (!activeWallet) return;
    if (pvacBridge.isInitialized()) return;
    try {
      logger.info("usePvac", "initializing privacy engine...");
      await privacyService.initPvac(activeWallet.id, activeWallet.address);
      logger.info("usePvac", "privacy engine ready");
    } catch {
      showMessage("error", "Failed to initialize privacy engine");
    }
  }, [activeWallet, showMessage]);

  const encrypt = useCallback(
    async (amount: number, ou?: string, onProgress?: StealthProgressCallback, pinned?: TxScope) => {
      if (!activeWallet) throw new Error("No wallet");
      const scope = pinned ?? captureScope(activeWallet.address);
      assertScope(scope);
      setIsComputing(true);
      try {
        return await logger.timed("usePvac", `encrypt(${amount})`, async () => {
          if (!pvacBridge.isInitializedFor(scope.address))
            await privacyService.initPvac(walletId, scope.address);
          return await privacyService.encryptBalance(scope, amount, walletId, ou, onProgress);
        });
      } finally {
        setIsComputing(false);
      }
    },
    [activeWallet, walletId],
  );

  const decrypt = useCallback(
    async (amount: number, ou?: string, onProgress?: StealthProgressCallback, pinned?: TxScope) => {
      if (!activeWallet) throw new Error("No wallet");
      const scope = pinned ?? captureScope(activeWallet.address);
      assertScope(scope);
      setIsComputing(true);
      try {
        return await logger.timed("usePvac", `decrypt(${amount})`, async () => {
          if (!pvacBridge.isInitializedFor(scope.address))
            await privacyService.initPvac(walletId, scope.address);
          return await privacyService.decryptBalance(scope, amount, walletId, ou, onProgress);
        });
      } finally {
        setIsComputing(false);
      }
    },
    [activeWallet, walletId],
  );

  const claim = useCallback(
    async (
      output: ClaimableOutput,
      ou?: string,
      nonce?: number,
      onProgress?: StealthProgressCallback,
      pinned?: TxScope,
    ) => {
      if (!activeWallet) throw new Error("No wallet");
      const scope = pinned ?? captureScope(activeWallet.address);
      assertScope(scope);
      setIsComputing(true);
      try {
        return await logger.timed("usePvac", "claim", async () => {
          if (!pvacBridge.isInitializedFor(scope.address))
            await privacyService.initPvac(walletId, scope.address);
          return await privacyService.claimOutput(scope, output, walletId, ou, nonce, onProgress);
        });
      } finally {
        setIsComputing(false);
      }
    },
    [activeWallet, walletId],
  );

  const sendStealth = useCallback(
    async (
      recipient: string,
      amount: number,
      ou?: string,
      onProgress?: StealthProgressCallback,
      pinned?: TxScope,
    ) => {
      if (!activeWallet) throw new Error("No wallet");
      const scope = pinned ?? captureScope(activeWallet.address);
      assertScope(scope);
      setIsComputing(true);
      try {
        return await logger.timed("usePvac", `sendStealth(${amount})`, async () => {
          if (!pvacBridge.isInitializedFor(scope.address))
            await privacyService.initPvac(walletId, scope.address);
          return await privacyService.sendStealth({
            scope,
            recipient,
            amount,
            walletId,
            ou,
            onProgress,
          });
        });
      } finally {
        setIsComputing(false);
      }
    },
    [activeWallet, walletId],
  );

  const destroy = useCallback(async () => {
    await privacyService.destroyPvac();
  }, []);

  return {
    isInitialized: pvacBridge.isInitialized(),
    isComputing,
    init,
    encrypt,
    decrypt,
    claim,
    sendStealth,
    destroy,
  };
}
