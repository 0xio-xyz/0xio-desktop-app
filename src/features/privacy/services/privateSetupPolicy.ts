import type { PvacRegistrationState } from "src/features/privacy/services/privacyService";

/** What the chain said for this wallet on this network. Absent when the read failed. */
export interface PrivateSetupChecks {
  regState: PvacRegistrationState;
  /** False only when the node said it refuses a key_switch for this account. */
  canKeySwitch: boolean;
  feeRaw: string | null;
  floorRaw?: string | null;
}

export interface PrivateSetupSignals {
  privacy: boolean;
  canSign: boolean;
  keyBlocked: boolean;
  pending: boolean;
  checks: PrivateSetupChecks | null;
  publicBalanceRaw: number | null;
}

export function shouldOfferPrivateSetup(s: PrivateSetupSignals): boolean {
  if (!s.privacy || !s.canSign || s.keyBlocked || s.pending) return false;
  const c = s.checks;
  if (!c || c.regState !== "unregistered" || !c.canKeySwitch) return false;
  const fee = Number(c.feeRaw);
  if (!c.feeRaw || !Number.isFinite(fee) || fee <= 0) return false;
  if (s.publicBalanceRaw == null || !Number.isFinite(s.publicBalanceRaw)) return false;
  return s.publicBalanceRaw >= fee;
}
