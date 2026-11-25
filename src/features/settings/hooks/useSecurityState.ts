import { useState } from "react";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { walletBridge } from "src/services/wallet/walletBridge";
import { biometricService, BiometryType } from "src/services/wallet/biometricService";
import { biometricLabel } from "src/features/security/onboarding/biometricLabel";

export function biometricName(type: BiometryType | undefined): string {
  if (type === BiometryType.TouchID) return "Touch ID";
  if (type === BiometryType.FaceID) return "Face ID";
  return biometricLabel();
}

interface BiometricState {
  available: boolean;
  type: BiometryType;
  enabled: boolean;
  turnedOff: boolean;
}

export function useSecurityState() {
  const [hasPassword, setHasPassword] = useState(true);
  const [isHellMode, setIsHellMode] = useState(false);
  const [biometric, setBiometric] = useState<BiometricState | null>(null);

  useMountEffect(() => {
    let alive = true;
    walletBridge
      .hasPassword()
      .then((v) => alive && setHasPassword(v))
      .catch(() => {});
    walletBridge
      .isHellMode()
      .then((v) => alive && setIsHellMode(v))
      .catch(() => {});
    (async () => {
      try {
        const { available, type } = await biometricService.isAvailable();
        const enabled = available ? await biometricService.isEnabled() : false;
        const turnedOff = !enabled && (await biometricService.wasTurnedOff());
        if (alive) setBiometric({ available, type, enabled, turnedOff });
      } catch {
        if (alive)
          setBiometric({
            available: false,
            type: BiometryType.None,
            enabled: false,
            turnedOff: false,
          });
      }
    })();
    return () => {
      alive = false;
    };
  });

  const setBiometricEnabled = (enabled: boolean) =>
    setBiometric((b) => (b ? { ...b, enabled, turnedOff: enabled ? false : b.turnedOff } : b));

  return {
    hasPassword,
    setHasPassword,
    isHellMode,
    setIsHellMode,
    biometric,
    setBiometricEnabled,
  };
}

export type SecurityState = ReturnType<typeof useSecurityState>;
