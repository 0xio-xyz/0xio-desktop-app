import type { PvacSetup } from "src/hooks/privacy/usePvacSetup";

export type GateKind =
  | "ok"
  | "checking"
  | "setup"
  | "setupPending"
  | "hold"
  | "foreign"
  | "legacy"
  | "upgrading"
  | "awaitMigration"
  | "migrate"
  | "refresh"
  | "unprovable";

export function privateGate(input: {
  setup: Pick<PvacSetup, "regState" | "held" | "needsCompact" | "canMigrate" | "notSpendable">;
  held: boolean;
  foreign: boolean;
  legacy: boolean;
  upgrading: boolean;
}): GateKind {
  const { setup } = input;
  if (setup.regState === "checking") return "checking";
  if (setup.regState === "unregistered") return "setup";
  if (setup.regState === "pending") return "setupPending";
  if (input.held) return "hold";
  if (input.foreign) return "foreign";
  if (input.legacy) return "legacy";
  if (setup.held || setup.needsCompact) {
    if (input.upgrading) return "upgrading";
    if (setup.held) return setup.canMigrate ? "migrate" : "awaitMigration";
    return "refresh";
  }
  if (setup.notSpendable) return "unprovable";
  return "ok";
}
