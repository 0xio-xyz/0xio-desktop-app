import { useCallback } from "react";
import { useQuery, useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import * as privacyService from "src/features/privacy/services/privacyService";
import * as networkService from "src/services/network/networkService";
import {
  getPendingKeySwitch,
  loadBlockedAck,
} from "src/features/privacy/services/keySwitchService";
import {
  shouldOfferPrivateSetup,
  type PrivateSetupChecks,
} from "src/features/privacy/services/privateSetupPolicy";
import { networkCapabilities } from "src/services/network/config";

export const PRIVATE_SETUP_QUERY = "privateSetupTag";

export async function readPrivateSetupChecks(
  address: string,
  networkId: string,
): Promise<PrivateSetupChecks> {
  const regState = await privacyService.getPvacRegistrationState(address, networkId);
  if (regState !== "unregistered") return { regState, canKeySwitch: false, feeRaw: null };
  const [migration, fee] = await Promise.all([
    networkService.getPvacMigrationStatus(address, networkId),
    privacyService.getKeySwitchFeeLive("recommended", networkId),
  ]);
  if (!migration) throw new Error("Migration status unavailable");
  return {
    regState,
    canKeySwitch: migration.can_key_switch !== false,
    feeRaw: String(fee.ou),
    floorRaw: String(fee.floorOu),
  };
}

/**
 * Home's "Set up private" tag: the wallet can sign, holds no PVAC key on chain, the node takes a
 * key_switch, and the public balance covers the live key_switch fee. Keyed by network and
 * address; a failed read leaves no data, so the tag stays hidden.
 */
export function usePrivateSetupTag(
  publicBalance: number,
  balanceReady: boolean,
  pvacReady: boolean,
) {
  const { activeWallet, networkId, pvacForeign, pvacLegacy } = useWallet();
  const qc = useQueryClient();
  const address = activeWallet?.address ?? "";
  const privacy = networkCapabilities(networkId).privacy;
  const canSign = !!activeWallet && activeWallet.wallet_type !== "watch";
  const keyBlocked =
    pvacForeign || pvacLegacy || (!!address && !!loadBlockedAck(networkId, address));
  const pending = !!address && !!getPendingKeySwitch(networkId, address);

  const checks = useQuery({
    queryKey: [PRIVATE_SETUP_QUERY, networkId, address, publicBalance],
    enabled: !!address && privacy && canSign && pvacReady && balanceReady && publicBalance > 0,
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === networkId && prevQuery?.queryKey[2] === address ? prev : undefined,
    queryFn: () => readPrivateSetupChecks(address, networkId),
  });

  const visible = shouldOfferPrivateSetup({
    privacy,
    canSign,
    keyBlocked,
    pending,
    checks: checks.isError ? null : (checks.data ?? null),
    publicBalanceRaw: balanceReady ? publicBalance : null,
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: [PRIVATE_SETUP_QUERY, networkId, address] });
  }, [qc, networkId, address]);

  return { visible, feeRaw: checks.data?.feeRaw ?? null, refresh };
}
