import i18n from "src/i18n/core";
import { onsReasonKey } from "src/hooks/wallet/useOns";
import { resolveWallet } from "src/services/names/onsService";
import type { OnsFailure } from "src/services/names/ons";

type NameCheck =
  | { holds: true }
  | { holds: false; moved: string }
  | { holds: false; reason: OnsFailure };

export async function checkName(
  name: string,
  address: string,
  networkId: string,
): Promise<NameCheck> {
  try {
    const r = await resolveWallet(name, { networkId, fresh: true });
    if (r.ok !== true) return { holds: false, reason: r.reason };
    return r.address === address ? { holds: true } : { holds: false, moved: r.address };
  } catch {
    return { holds: false, reason: "unavailable" };
  }
}

export async function holdName(name: string, address: string, networkId: string): Promise<void> {
  const check = await checkName(name, address, networkId);
  if (check.holds) return;
  throw new Error(
    "moved" in check ? i18n.t("ons.moved", { name }) : i18n.t(onsReasonKey(check.reason)),
  );
}
