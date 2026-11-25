import type { KeySwitchMode } from "src/features/privacy/services/privacyService";

export type KeyUpdateMode =
  | "empty_key_switch"
  | "legacy_public_migration"
  | "legacy_zero_reset"
  | "key_bound_migration";

export const KEY_UPDATE_MODES: readonly KeyUpdateMode[] = [
  "empty_key_switch",
  "legacy_public_migration",
  "legacy_zero_reset",
  "key_bound_migration",
];

export type KeyModeSignal =
  | { kind: "update"; mode: KeyUpdateMode; amountMicro: number }
  | { kind: "blocked"; reason: string }
  | { kind: "unavailable"; keyCurrent: boolean };

export function keyModeSignal(mode: KeySwitchMode): KeyModeSignal {
  switch (mode.mode) {
    case "empty_key_switch":
    case "legacy_zero_reset":
      return { kind: "update", mode: mode.mode, amountMicro: 0 };
    case "legacy_public_migration":
    case "key_bound_migration":
      return { kind: "update", mode: mode.mode, amountMicro: mode.amount };
    // Moves the balance to the current key like key_bound_migration; the dialogs and the menu
    // bar show the same migrate review for both, so it reads as that mode.
    case "cipher_proof":
      return { kind: "update", mode: "key_bound_migration", amountMicro: mode.amount };
    case "key_bound_unavailable":
      return { kind: "unavailable", keyCurrent: mode.keyCurrent };
    case "blocked":
      return { kind: "blocked", reason: mode.reason };
  }
}

export function keyUpdateMovesBalance(mode: KeyUpdateMode): boolean {
  return mode === "legacy_public_migration" || mode === "key_bound_migration";
}

export interface KeyUpdateExpectation {
  mode: KeyUpdateMode;
  amountMicro: number;
}

export function keyUpdateMismatch(
  resolved: KeySwitchMode,
  expected: KeyUpdateExpectation,
): string | null {
  const now = keyModeSignal(resolved);
  if (now.kind !== "update") return "The network no longer takes this update. Review again.";
  if (now.mode !== expected.mode) return "What this update does has changed. Review again.";
  if (now.amountMicro !== expected.amountMicro)
    return "Your private balance changed. Review again.";
  return null;
}
