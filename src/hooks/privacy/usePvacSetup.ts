import { useCallback } from "react";
import { useQuery, useQueryClient } from "src/lib/query";
import * as privacyService from "src/features/privacy/services/privacyService";
import type { PvacRegistrationState } from "src/features/privacy/services/privacyService";
import * as networkService from "src/services/network/networkService";
import { PRIVATE_SPEND_REFRESH_BASE_LAYERS } from "src/features/privacy/services/pvacUpgradePolicy";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { useWallet, type WalletData } from "src/contexts/useWallet";

export interface PvacSetup {
  regState: PvacRegistrationState | "checking";
  needsCompact: boolean;
  baseLayers: number;
  nonCanonical: boolean;
  // A key-bound balance that needs a refresh while the node refuses key updates: spends are
  // unprovable and compaction is refused. A low-layer v3 is not held (webcli mode "current").
  held: boolean;
  holdKeyFine: boolean;
  // Held, and the node has opened the bound migration for this balance (can_v3_migrate).
  canMigrate: boolean;
  /** Not provable for a reason a refresh cannot fix; private spends are blocked. */
  notSpendable: boolean;
  spendReason?: string;
  refresh: () => void;
}

export interface PvacSetupData {
  regState: PvacRegistrationState;
  needsCompact: boolean;
  baseLayers: number;
  nonCanonical: boolean;
  held: boolean;
  holdKeyFine: boolean;
  canMigrate: boolean;
  /** Not provable for a reason a refresh cannot fix (needs key rotation). */
  notSpendable?: boolean;
  spendReason?: string;
  /** The node accepts the refresh (bound migration) for this balance right now. */
  canRefresh?: boolean;
}

type SetupWallet = Pick<WalletData, "id" | "address">;

export async function ensurePvacFor(wallet: SetupWallet): Promise<void> {
  if (pvacBridge.isInitializedFor(wallet.address)) return;
  await privacyService.initPvac(wallet.id, wallet.address);
}

/** The setup query, shared by the Privacy screen and the menu bar panel's readiness. */
export function pvacSetupQuery(wallet: SetupWallet, networkId: string) {
  const { address, id: walletId } = wallet;
  return {
    queryKey: ["pvacSetup", address, networkId],
    staleTime: 10_000,
    queryFn: async (): Promise<PvacSetupData> => {
      await ensurePvacFor(wallet);
      const regState = await privacyService.getPvacRegistrationState(address, networkId);
      if (regState !== "registered")
        return {
          regState,
          needsCompact: false,
          baseLayers: 0,
          nonCanonical: false,
          held: false,
          holdKeyFine: false,
          canMigrate: false,
        };
      const spend = await privacyService.getSpendReadiness(address, walletId, networkId);
      // Fails open so a busy node never wrongly shows the hold.
      let held = false;
      let holdKeyFine = false;
      let canMigrate = false;
      let canRefresh = false;
      try {
        const migration = await networkService.getPvacMigrationStatus(address, networkId);
        // As webcli: a key-bound balance is usable unless it needs a refresh it cannot get (over
        // the refresh threshold and the node refuses the key_switch).
        const isV3 = migration?.cipher_class === "v3" || migration?.cipher_class === "key_bound";
        held =
          isV3 &&
          spend.baseLayers >= PRIVATE_SPEND_REFRESH_BASE_LAYERS &&
          migration?.can_key_switch === false;
        holdKeyFine = held && migration?.key_class === "current";
        canMigrate = held && migration?.can_v3_migrate === true;
        canRefresh = migration?.can_v3_migrate === true;
      } catch {
        held = false;
      }
      return {
        regState,
        needsCompact: spend.needsCompact,
        baseLayers: spend.baseLayers,
        nonCanonical: spend.nonCanonical,
        held,
        holdKeyFine,
        canMigrate,
        notSpendable: !spend.ready && !spend.needsCompact,
        spendReason: spend.reason,
        canRefresh,
      };
    },
  };
}

// Registration and migration are user actions, never fired inside encrypt or decrypt. A transient
// pubkey-fetch failure resolves to "registered" so a busy node cannot block the form; the op's own
// guard checks again.
export function usePvacSetup(): PvacSetup {
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address ?? "";
  const walletId = activeWallet?.id ?? "";
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    ...pvacSetupQuery({ id: walletId, address }, networkId),
    enabled: !!address,
    // Picks up a compaction or registration done in another client on the same wallet.
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["pvacSetup", address, networkId] });
  }, [qc, address, networkId]);

  return {
    regState: data?.regState ?? (isLoading ? "checking" : "registered"),
    needsCompact: data?.needsCompact ?? false,
    baseLayers: data?.baseLayers ?? 0,
    nonCanonical: data?.nonCanonical ?? false,
    held: data?.held ?? false,
    holdKeyFine: data?.holdKeyFine ?? false,
    canMigrate: data?.canMigrate ?? false,
    notSpendable: data?.notSpendable ?? false,
    spendReason: data?.spendReason,
    refresh,
  };
}
