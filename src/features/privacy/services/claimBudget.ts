// The balance cipher grows only when the node executes a claim, so every read during a claim
// burst sees the same stale layer count. The budget lives in localStorage so a reload cannot
// re-seed a full budget from that stale cipher. Layer math in pvacUpgradePolicy.ts.
// - seed from executed state; the SAME cipher fingerprint never resets in-flight decrements
// - implausible layer readings (not finite/even/>= 2) fail CLOSED
// - a missing cipher (first-time claimer) seeds the true cap for B=0: three claims
// - an unseeded consume allows exactly ONE claim, then pins the budget to zero
// - refunds are clamped to the seeded cap and only issued for DEFINITIVE rejections

import { claimCap } from "src/features/privacy/services/pvacUpgradePolicy";
import type { TxScope } from "src/services/network/networkService";
import { logger } from "src/lib/logger";

interface BudgetEntry {
  remaining: number;
  cap: number;
  cipherFp: string;
}

const STORAGE_PREFIX = "0xio_claim_budget_";
const EMPTY_BALANCE_CAP = 3; // B=0 -> floor((6-0)/2)
const EMPTY_FP = "empty";
const UNSEEDED_FP = "unseeded";
// A bad layer reading over a real cipher: only a plausible read may re-seed it, never empty-seed.
const IMPLAUSIBLE_FP = "implausible";

function budgetKey(scope: TxScope): string {
  return `${STORAGE_PREFIX}${scope.networkId}_${scope.address}`;
}

function readEntry(scope: TxScope): BudgetEntry | null {
  try {
    const raw = localStorage.getItem(budgetKey(scope));
    return raw ? (JSON.parse(raw) as BudgetEntry) : null;
  } catch {
    return null;
  }
}

function writeEntry(scope: TxScope, entry: BudgetEntry | null): void {
  try {
    if (entry === null) localStorage.removeItem(budgetKey(scope));
    else localStorage.setItem(budgetKey(scope), JSON.stringify(entry));
  } catch {}
}

function fingerprint(cipher: string): string {
  return `${cipher.length}:${cipher.slice(0, 48)}`;
}

export function plausibleLayers(layers: unknown): layers is number {
  return typeof layers === "number" && Number.isFinite(layers) && layers >= 2 && layers % 2 === 0;
}

export function seedClaimBudget(scope: TxScope, cipher: string, layers: number): void {
  const fp = fingerprint(cipher);
  const existing = readEntry(scope);
  if (existing && existing.cipherFp === fp) return;
  if (!plausibleLayers(layers)) {
    // Pin (not clear): a cleared entry would hand the next consume the one-claim
    // unseeded allowance - fail closed means ZERO claims until a plausible read.
    writeEntry(scope, { remaining: 0, cap: 0, cipherFp: IMPLAUSIBLE_FP });
    logger.warn("claim", `budget: implausible layer reading (${layers}) - failing closed`);
    return;
  }
  const cap = claimCap(layers);
  writeEntry(scope, { remaining: cap, cap, cipherFp: fp });
  logger.debug("claim", `budget: seeded ${scope.address.slice(0, 10)} layers=${layers} cap=${cap}`);
}

export function seedClaimBudgetEmpty(scope: TxScope): void {
  const existing = readEntry(scope);
  // A cipher that once existed cannot un-exist: a false "no cipher" must never reset a real
  // budget. Empty-seed only from no-entry or the unseeded pin.
  if (existing && existing.cipherFp !== UNSEEDED_FP) return;
  writeEntry(scope, { remaining: EMPTY_BALANCE_CAP, cap: EMPTY_BALANCE_CAP, cipherFp: EMPTY_FP });
  logger.debug(
    "claim",
    `budget: seeded ${scope.address.slice(0, 10)} (no cipher yet) cap=${EMPTY_BALANCE_CAP}`,
  );
}

export function consumeClaimSlot(scope: TxScope): boolean {
  const e = readEntry(scope);
  if (!e) {
    writeEntry(scope, { remaining: 0, cap: 0, cipherFp: UNSEEDED_FP });
    logger.warn(
      "claim",
      `budget: unseeded consume for ${scope.address.slice(0, 10)} - allowing ONE claim`,
    );
    return true;
  }
  if (e.remaining <= 0) return false;
  e.remaining -= 1;
  writeEntry(scope, e);
  logger.debug(
    "claim",
    `budget: consumed slot for ${scope.address.slice(0, 10)} - ${e.remaining} left`,
  );
  return true;
}

export function hasClaimSlot(scope: TxScope): boolean {
  const e = readEntry(scope);
  return !e || e.remaining > 0;
}

export function refundClaimSlot(scope: TxScope): void {
  const e = readEntry(scope);
  if (!e) return;
  e.remaining = Math.min(e.cap, e.remaining + 1);
  writeEntry(scope, e);
}
