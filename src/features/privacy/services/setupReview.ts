import * as privacyService from "src/features/privacy/services/privacyService";
import * as networkService from "src/services/network/networkService";
import { ensurePvacFor } from "src/hooks/privacy/usePvacSetup";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";
import { reviewedFeeError, type LiveFee } from "src/services/transactions/reviewedFee";

export interface SetupReview {
  walletId: string;
  address: string;
  networkId: string;
  feeRaw: string;
}

export class SetupReviewError extends Error {
  readonly liveFeeRaw?: string;
  constructor(message: string, liveFeeRaw?: string) {
    super(message);
    this.name = "SetupReviewError";
    this.liveFeeRaw = liveFeeRaw;
  }
}

export async function readReviewFee<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new SetupReviewError(FEE_UNAVAILABLE);
  }
}

export function readSetupFee(networkId: string): Promise<string> {
  return readReviewFee(() => privacyService.getKeySwitchFeeQuote("recommended", networkId));
}

// Refuses only when the node now takes more than the reviewed fee; a recommendation that merely
// moved keeps the reviewed fee.
export async function assertReviewedFee(
  review: SetupReview,
  publicRaw: number | null,
  readFee: () => Promise<LiveFee>,
): Promise<networkService.TxScope> {
  const scope: networkService.TxScope = { networkId: review.networkId, address: review.address };
  if (!networkService.isScopeCurrent(scope)) throw new SetupReviewError(SCOPE_CHANGED);
  const live = await readReviewFee(readFee);
  if (reviewedFeeError(Number(review.feeRaw), live) === FEE_CHANGED)
    throw new SetupReviewError(FEE_CHANGED, String(live.ou));
  if (publicRaw !== null && publicRaw < Number(review.feeRaw))
    throw new SetupReviewError(FEE_SHORT);
  return scope;
}

export function setupScopeError(
  review: Pick<SetupReview, "walletId" | "address" | "networkId">,
  live: { walletId: string | null; address: string | null; networkId: string },
): string | null {
  return live.walletId === review.walletId &&
    live.address === review.address &&
    live.networkId === review.networkId
    ? null
    : SCOPE_CHANGED;
}

export async function turnOnReviewed(review: SetupReview, publicRaw: number | null): Promise<void> {
  const scope = await assertReviewedFee(review, publicRaw, () =>
    privacyService.getKeySwitchFeeLive("recommended", review.networkId),
  );
  await ensurePvacFor({ id: review.walletId, address: review.address });
  try {
    await privacyService.registerPvacKey(scope, review.walletId, { ou: review.feeRaw });
  } catch (e) {
    if (!(e instanceof Error && e.name === "PvacSetupPending")) throw e;
  }
}
