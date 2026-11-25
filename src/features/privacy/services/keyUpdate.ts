import * as privacyService from "src/features/privacy/services/privacyService";
import * as networkService from "src/services/network/networkService";
import type { TxScope } from "src/services/network/networkService";
import {
  clearPendingKeySwitch,
  getPendingKeySwitch,
  resolveRotationState,
  type RotationState,
} from "src/features/privacy/services/keySwitchService";
import { logger } from "src/lib/logger";
import type { KeyUpdateExpectation } from "src/features/privacy/services/keyUpdatePolicy";
import { ensurePvacFor } from "src/hooks/privacy/usePvacSetup";
import { assertReviewedFee, type SetupReview } from "src/features/privacy/services/setupReview";

interface ModeWallet {
  id: string;
  address: string;
}

export function keySwitchModeQuery(wallet: ModeWallet, networkId: string) {
  return {
    queryKey: ["keySwitchMode", wallet.address, networkId],
    staleTime: 60_000,
    queryFn: async () => {
      await ensurePvacFor(wallet);
      return privacyService.resolveKeySwitchMode(wallet.address, wallet.id, networkId);
    },
  };
}

export function keyStatusQuery(wallet: ModeWallet, networkId: string) {
  const { address } = wallet;
  return {
    queryKey: ["pvacKeyStatus", address, networkId],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      await ensurePvacFor(wallet);
      const [localPub, remotePub] = await Promise.all([
        privacyService.getLocalPubkey(address),
        networkService.getPvacPubkey(address, networkId),
      ]);
      let matches = !!remotePub && remotePub === localPub;
      if (!matches && remotePub) {
        try {
          matches = await privacyService.isOurPubkey(address, remotePub);
        } catch {}
      }
      const checkedAt = Date.now();
      if (matches) {
        if (getPendingKeySwitch(networkId, address)) {
          logger.info("keySwitch", "rotation applied by the node - clearing pending record");
          clearPendingKeySwitch(networkId, address);
        }
        return {
          registered: true,
          matches,
          rotation: { kind: "none" } as RotationState,
          migration: null,
          checkedAt,
        };
      }
      const rotation = await resolveRotationState(networkId, address, localPub);
      const migration = await networkService.getPvacMigrationStatus(address, networkId);
      return { registered: !!remotePub, matches, rotation, migration, checkedAt };
    },
  };
}

export async function runKeyUpdate(params: {
  scope: TxScope;
  walletId: string;
  ou: string;
  expect?: KeyUpdateExpectation;
  onStep?: (step: "resolve" | "build" | "send") => void;
}): Promise<{ txHash: string }> {
  const { scope, walletId, ou, expect, onStep } = params;
  return privacyService.keySwitchBalance(scope, walletId, { ou, expect, onStep });
}

export async function keyUpdateReviewed(
  review: SetupReview & { expect: KeyUpdateExpectation },
  publicRaw: number | null,
): Promise<{ txHash: string }> {
  const scope = await assertReviewedFee(review, publicRaw, () =>
    privacyService.getKeySwitchFeeLive("recommended", review.networkId),
  );
  await ensurePvacFor({ id: review.walletId, address: review.address });
  return runKeyUpdate({
    scope,
    walletId: review.walletId,
    ou: review.feeRaw,
    expect: review.expect,
  });
}
