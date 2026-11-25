import { useState } from "react";
import { useWallet } from "src/contexts/useWallet";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useMigrateBalance } from "src/hooks/privacy/useMigrateBalance";
import { usePvacSetup } from "src/hooks/privacy/usePvacSetup";
import { useKeyHold } from "src/features/privacy/hooks/useKeyHold";
import { privateGate } from "src/features/privacy/hooks/usePrivateGate";
import type { GateContext } from "src/features/privacy/components/GateViews";

export function usePrivacyEnv(enabled = true) {
  const { activeWallet, networkId, showMessage, pvacForeign, pvacLegacy, setPvacForeign } =
    useWallet();
  const { publicBalance, privateBalance, isLoading } = useBalance();
  const setup = usePvacSetup();
  const hold = useKeyHold(enabled);
  const [turnOnClosed, setTurnOnClosed] = useState(false);
  const migrate = useMigrateBalance({
    address: activeWallet?.address ?? "",
    walletId: activeWallet?.id ?? "",
    networkId,
    publicRaw: publicBalance ?? null,
    showMessage,
    kind: setup.held ? "migrate" : "refresh",
    onMigrated: setup.refresh,
  });
  const gate = privateGate({
    setup,
    held: !!hold.hold,
    foreign: pvacForeign,
    legacy: pvacLegacy,
    upgrading: !!migrate.upgrading,
  });
  const ctx: GateContext = {
    gate,
    baseLayers: setup.baseLayers,
    spendReason: setup.spendReason,
    onReviewRefresh: () => void migrate.open(),
    onCheckSetup: setup.refresh,
    onReviewKey: () => setPvacForeign(true),
  };
  return {
    scope: activeWallet ? { networkId, address: activeWallet.address } : null,
    publicKnown: isLoading ? null : publicBalance,
    privateBalance,
    setup,
    hold,
    migrate,
    gate,
    ctx,
    turnOnClosed,
    setTurnOnClosed,
  };
}

export type PrivacyEnv = ReturnType<typeof usePrivacyEnv>;
