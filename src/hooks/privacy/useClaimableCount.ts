import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import * as privacyService from "src/features/privacy/services/privacyService";
import { NETWORKS } from "src/services/network/config";

/**
 * The scan is one node call walking every epoch from 0 (about 58s on mainnet), so the interval
 * adapts to the measured time and the always-mounted sidebar never rescans before the last scan
 * ends. Shares the "claimOutputs" key with the Privacy screen's claims.
 */
export function useClaimableCount(network?: string, enabled = true) {
  const { activeWallet, networkId: activeNetwork, isLocked } = useWallet();
  const networkId = network ?? activeNetwork;
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const interval = privacyService.suggestedScanIntervalMs();

  const { data: outputs = [] } = useQuery({
    queryKey: ["claimOutputs", activeWallet?.id, networkId],
    queryFn: async () => {
      if (!activeWallet) return [];
      return privacyService.getStealthOutputs(activeWallet.id, activeWallet.address, networkId);
    },
    enabled: !!activeWallet && privacyEnabled && enabled && !isLocked,
    staleTime: interval,
    gcTime: 10 * 60_000,
    refetchInterval: interval,
  });

  return outputs.length;
}
