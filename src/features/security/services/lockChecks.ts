import { walletBridge, type UnlockStatus } from "src/services/wallet/walletBridge";
import { biometricService } from "src/services/wallet/biometricService";

type PasswordState = "set" | "needed" | "none";

interface LockChecks {
  password: Promise<PasswordState>;
  status: Promise<UnlockStatus | null>;
  biometric: Promise<boolean>;
}

const HINT_KEY = "0xio_touch_id_hint";

let pending: LockChecks | null = null;

function start(): LockChecks {
  const password = walletBridge
    .hasPassword()
    .then(async (has): Promise<PasswordState> => {
      if (has) return "set";
      return (await walletBridge.needsPassword()) ? "needed" : "none";
    })
    .catch((): PasswordState => "set");
  const status = password.then((p) =>
    p === "set" ? walletBridge.unlockStatus().catch(() => null) : null,
  );
  const biometric = password.then(async (p) => {
    const enabled = p === "set" && (await biometricService.isEnabled().catch(() => false));
    rememberBiometric(enabled);
    return enabled;
  });
  return { password, status, biometric };
}

export function prefetchLockChecks(): void {
  pending ??= start();
}

export function takeLockChecks(): LockChecks {
  const checks = pending ?? start();
  pending = null;
  return checks;
}

export function biometricHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberBiometric(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(HINT_KEY, "1");
    else localStorage.removeItem(HINT_KEY);
  } catch {}
}
