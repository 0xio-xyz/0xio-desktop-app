import i18n from "src/i18n/core";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  INSUFFICIENT_BALANCE,
  PROOF_POLICY_CHANGED,
  PROOF_POLICY_UNAVAILABLE,
  SCOPE_CHANGED,
  TX_NONCE_USED,
  TX_NOT_ACCEPTED,
  TX_REJECTED,
  TX_TOO_LARGE,
} from "./feeCopy";

const KEYS: [string, string][] = [
  [FEE_UNAVAILABLE, "fee.unavailableRetry"],
  [FEE_CHANGED, "fee.changed"],
  [FEE_SHORT, "fee.short"],
  [INSUFFICIENT_BALANCE, "fee.insufficientBalance"],
  [SCOPE_CHANGED, "fee.scopeChanged"],
  [TX_NONCE_USED, "submit.nonceUsed"],
  [TX_REJECTED, "submit.rejected"],
  [TX_TOO_LARGE, "submit.tooLarge"],
  [TX_NOT_ACCEPTED, "submit.notAccepted"],
  [PROOF_POLICY_UNAVAILABLE, "proofs.policyUnavailable"],
  [PROOF_POLICY_CHANGED, "proofs.policyChanged"],
];

/** The checks compare the feeCopy constants, so only the shown text is translated. */
export function feeText(message: string): string;
export function feeText(message: string | null | undefined): string | undefined;
export function feeText(message: string | null | undefined): string | undefined {
  if (!message || !i18n.isInitialized) return message ?? undefined;
  for (const [code, key] of KEYS) {
    if (message === code) return i18n.t(key);
    if (message.startsWith(`${code} (`)) return i18n.t(key) + message.slice(code.length);
  }
  return message;
}
