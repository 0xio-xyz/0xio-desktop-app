import { useWallet } from "src/contexts/useWallet";
import HomeTag from "src/shared/ui/HomeTag";
import { loadBlockedAck, clearBlockedAck } from "src/features/privacy/services/keySwitchService";

export default function KeyBlockedTag() {
  const { activeWallet, networkId, pvacForeign, setPvacForeign, pvacLegacy } = useWallet();
  const net = networkId ?? "";
  const address = activeWallet?.address;
  const ackReason = address ? loadBlockedAck(net, address) : null;

  const blocked = !!ackReason || pvacLegacy;
  if (!blocked || pvacForeign || !address) return null;

  return (
    <HomeTag
      tone="neutral"
      onClick={() => {
        clearBlockedAck(net, address);
        setPvacForeign(true);
      }}
      title={
        ackReason ??
        "This encrypted balance was written by an earlier wallet version. It stays readable, but private operations are paused on it."
      }
    >
      Key update blocked
    </HomeTag>
  );
}
