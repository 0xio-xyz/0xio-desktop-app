import { useEffect } from "react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { keyStatusQuery } from "src/features/privacy/services/keyUpdate";
import { clearPendingKeySwitch } from "src/features/privacy/services/keySwitchService";
import { setHold } from "src/features/privacy/services/proofQueue";

export function useKeyHold(enabled = true) {
  const { activeWallet, networkId, setPvacForeign } = useWallet();
  const address = activeWallet?.address ?? "";
  const q = useQuery({
    ...keyStatusQuery({ id: activeWallet?.id ?? "", address }, networkId),
    enabled: !!address && enabled,
  });
  const rotation = q.data?.rotation;
  const hold = rotation && rotation.kind !== "none" ? rotation : null;
  const held = !!hold;

  useEffect(() => {
    if (!address || !enabled) return;
    setHold({ networkId, address }, held);
  }, [address, networkId, held, enabled]);

  return {
    hold,
    checkedAt: q.data?.checkedAt ?? null,
    checking: q.isFetching,
    check: () => void q.refetch(),
    clearAndUpdate: () => {
      if (!address) return;
      clearPendingKeySwitch(networkId, address);
      setHold({ networkId, address }, false);
      setPvacForeign(true);
      void q.refetch();
    },
  };
}

export type KeyHold = ReturnType<typeof useKeyHold>;
