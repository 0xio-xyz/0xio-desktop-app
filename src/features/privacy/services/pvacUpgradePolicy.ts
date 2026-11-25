import { feeAllowed } from "src/services/network/feePolicy";

export function boundedKeySwitchFee(quote: string | undefined | null): string | null {
  if (!quote) return null;
  const parsed = Math.trunc(Number(quote));
  if (!feeAllowed("key_switch", parsed)) return null;
  return String(parsed);
}

// Layer math as webcli: every balance-mutating op adds two base layers
// (fresh cipher = two); spends/decrypt prove over B+2 with a 5-layer cap, the compact
// (key-switch proof) proves over B with a 6-layer cap. Past 6 the balance is unrecoverable.
export const PRIVATE_SPEND_REFRESH_BASE_LAYERS = 4;
export const KEY_SWITCH_MAX_LAYERS = 6;

export function claimCap(baseLayers: number): number {
  return Math.max(0, Math.floor((KEY_SWITCH_MAX_LAYERS - baseLayers) / 2));
}

/** webcli octra::cipher_route: the node takes a cipher_proof migration of a balance held under
 *  the historical key. */
export function cipherProofRoute(status: unknown): boolean {
  if (typeof status !== "object" || status === null) return false;
  const s = status as Record<string, unknown>;
  const formatAbsent = !Object.prototype.hasOwnProperty.call(s, "cipher_format");
  return (
    s.cipher_proof_rule === "active" &&
    s.can_cipher_proof_migrate === true &&
    (s.cipher_format === "proven" || (formatAbsent && s.cipher_class === "v3")) &&
    s.key_class === "historical"
  );
}
