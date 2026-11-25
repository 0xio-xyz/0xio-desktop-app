import { useEffect, useRef, useCallback } from "react";
import { useBalance } from "src/hooks/wallet/useBalance";
import { usePvac } from "src/hooks/privacy/usePvac";
import { useWallet } from "src/contexts/useWallet";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { liveRecommendedOu } from "src/services/network/networkService";
import * as privacySettingsService from "src/features/privacy/services/privacySettingsService";
import { AUTOMATIONS_ENABLED, FINANCE } from "src/services/network/config";
import { logger } from "src/lib/logger";

const DEBOUNCE_MS = 10_000;
const MIN_THRESHOLD = 1_000_000; // 1 OCT
const DAILY_COUNTER_KEY = (networkId: string) => `0xio_autoenc_daily_${networkId}`;

interface DailyCounter {
  date: string; // YYYY-MM-DD
  count: number;
}

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyCount(networkId: string): number {
  try {
    const raw = localStorage.getItem(DAILY_COUNTER_KEY(networkId));
    if (!raw) return 0;
    const parsed: DailyCounter = JSON.parse(raw);
    if (parsed.date !== getTodayStr()) return 0;
    return parsed.count;
  } catch {
    return 0;
  }
}

function incrementDailyCount(networkId: string): void {
  const today = getTodayStr();
  const current = getDailyCount(networkId);
  localStorage.setItem(
    DAILY_COUNTER_KEY(networkId),
    JSON.stringify({ date: today, count: current + 1 }),
  );
}

export function useAutoEncrypt() {
  const { activeWallet, networkId, showMessage } = useWallet();
  const { publicBalance } = useBalance();
  const { encrypt, isComputing } = usePvac();

  const lastSeenBalance = useRef<number | null>(null);
  const cooldownUntil = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTriggering = useRef(false);

  const doAutoEncrypt = useCallback(
    async (amount: number, cooldownMs: number) => {
      if (isTriggering.current || isComputing) return;
      if (Date.now() < cooldownUntil.current) {
        logger.debug(
          "autoEncrypt",
          `cooldown active, ${Math.ceil((cooldownUntil.current - Date.now()) / 1000)}s remaining`,
        );
        return;
      }
      if (!activeWallet || !pvacBridge.isInitializedFor(activeWallet.address)) {
        logger.debug("autoEncrypt", "PVAC not initialized, skipping");
        return;
      }

      isTriggering.current = true;
      const octAmount = amount / FINANCE.MICRO_OCT_MULTIPLIER;
      logger.info("autoEncrypt", `triggering auto-encrypt: ${octAmount} OCT`);
      showMessage("processing", `Auto-encrypting ${octAmount} OCT...`);

      try {
        await encrypt(amount, await liveRecommendedOu("encrypt", networkId));
        cooldownUntil.current = Date.now() + cooldownMs;
        incrementDailyCount(networkId);
        showMessage("success", `Auto-encrypted ${octAmount} OCT`);
        logger.info("autoEncrypt", "auto-encrypt succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Auto-encrypt failed";
        showMessage("error", `Auto-encrypt failed: ${msg}. Disabling.`);
        logger.error("autoEncrypt", "auto-encrypt failed, disabling", err);
        privacySettingsService.updateAutoEncrypt(networkId, { autoEncryptEnabled: false });
      } finally {
        isTriggering.current = false;
      }
    },
    [activeWallet, networkId, encrypt, isComputing, showMessage],
  );

  useEffect(() => {
    // This runner spends real fees: a stored autoEncryptEnabled must not fire while the screen
    // that switches it off is unreachable.
    if (!AUTOMATIONS_ENABLED) return;
    if (!activeWallet) return;

    const settings = privacySettingsService.getSettings(networkId);
    if (!settings.autoEncryptEnabled) {
      lastSeenBalance.current = publicBalance;
      return;
    }

    const threshold = Math.max(settings.autoEncryptThreshold, MIN_THRESHOLD);
    const keepMinPublic = settings.autoEncryptKeepMinPublic ?? 0;
    const cooldownMinutes = settings.autoEncryptCooldownMinutes ?? 5;
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const maxPerDay = settings.autoEncryptMaxPerDay ?? 0;

    if (maxPerDay > 0 && getDailyCount(networkId) >= maxPerDay) {
      logger.debug("autoEncrypt", `daily limit reached (${maxPerDay}), skipping`);
      lastSeenBalance.current = publicBalance;
      return;
    }

    // The first reading is the baseline, not an increase.
    if (lastSeenBalance.current === null) {
      lastSeenBalance.current = publicBalance;
      return;
    }

    const prevBalance = lastSeenBalance.current;
    lastSeenBalance.current = publicBalance;

    if (publicBalance <= threshold || publicBalance <= prevBalance) return;

    const excess = publicBalance - threshold;
    const maxEncryptable = publicBalance - keepMinPublic;
    if (maxEncryptable <= 0) return;

    let amount =
      settings.autoEncryptAmount > 0 ? Math.min(settings.autoEncryptAmount, excess) : excess;

    amount = Math.min(amount, maxEncryptable);

    if (amount <= 0) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      doAutoEncrypt(amount, cooldownMs);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [activeWallet, networkId, publicBalance, doAutoEncrypt]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);
}
