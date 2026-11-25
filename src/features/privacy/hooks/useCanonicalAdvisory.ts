import { useEffect } from "react";
import { useWallet } from "src/contexts/useWallet";
import { usePvacSetup } from "src/hooks/privacy/usePvacSetup";
import { PRIVATE_SPEND_REFRESH_BASE_LAYERS } from "src/features/privacy/services/pvacUpgradePolicy";

// One-shot per address per session: devnet's v3 bound migration cannot produce a canonical
// cipher, so the advisory would re-fire forever.
const shown = new Set<string>();

export function useCanonicalAdvisory() {
  const { activeWallet, showMessage } = useWallet();
  const setup = usePvacSetup();
  const addr = activeWallet?.address;
  const due =
    setup.nonCanonical &&
    setup.baseLayers < PRIVATE_SPEND_REFRESH_BASE_LAYERS &&
    !!addr &&
    !shown.has(addr);

  useEffect(() => {
    if (!due || !addr || shown.has(addr)) return;
    shown.add(addr);
    showMessage(
      "info",
      "Some private operations on this balance may not go through yet while the network finishes upgrading.",
    );
  }, [due, addr, showMessage]);
}
