import { walletBridge } from "src/services/wallet/walletBridge";
import { checksFor, type SecretChecks } from "src/features/security/onboarding/readSecret";

let loading: Promise<SecretChecks> | null = null;

export function loadSecretChecks(): Promise<SecretChecks> {
  loading ??= walletBridge
    .mnemonicWordlist()
    .then(checksFor)
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}
