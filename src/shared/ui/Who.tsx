import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Small } from "src/shared/ui/look";
import { truncateAddress } from "src/lib/format";

export default function Who({
  address,
  name,
  size = 22,
  sub = true,
}: {
  address: string;
  name?: string | null;
  size?: number;
  sub?: boolean;
}) {
  if (!name)
    return (
      <span className="font-mono text-[0.8125rem] font-normal">
        {truncateAddress(address, 10, 8)}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2.25">
      <WalletAvatar address={address} size={size} />
      <span className="inline-flex flex-col items-end gap-0.75">
        <span>{name}</span>
        {sub && <Small>{truncateAddress(address, 10, 6)}</Small>}
      </span>
    </span>
  );
}
