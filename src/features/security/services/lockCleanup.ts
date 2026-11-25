import type { QueryClient } from "src/lib/query";
import { resetStealthScanCache } from "src/features/privacy/services/privacyService";
import { forgetSavedClaims } from "src/features/privacy/services/claimLedger";

const SECRET_QUERIES = ["claimOutputs", "privateBalance"] as const;

export function dropLockedData(queryClient: QueryClient): void {
  resetStealthScanCache();
  forgetSavedClaims();
  for (const key of SECRET_QUERIES) queryClient.removeQueries({ queryKey: [key] });
}
