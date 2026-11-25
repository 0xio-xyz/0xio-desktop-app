import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  INSUFFICIENT_BALANCE,
} from "src/services/transactions/feeCopy";
import { reviewedFeeError } from "src/services/transactions/reviewedFee";
import { formatOCT } from "src/lib/format";
import { keyUpdateCopy } from "./commands";
import { feeValue, type FeeRead, type PrivateDirection, type TraySnapshot } from "./protocol";

export interface Gate {
  /** The fee the review shows and the request carries: one read, or the sum of two. */
  fee: FeeRead;
  feeOu: number | null;
  available: number;
  amountError: string;
  feeError: string;
  retry: boolean;
  ok: boolean;
}

function combine(reads: FeeRead[]): FeeRead {
  if (reads.some((f) => f.state === "error")) return { state: "error" };
  if (reads.some((f) => f.state === "loading")) return { state: "loading" };
  return { state: "ok", ou: reads.reduce((sum, f) => sum + (feeValue(f) ?? 0), 0) };
}

function gate(
  fee: FeeRead,
  publicMicro: number | null,
  spendable: (feeOu: number) => number,
  micro: number,
): Gate {
  const ou = feeValue(fee);
  const pub = publicMicro ?? 0;
  const available = Math.max(0, spendable(ou ?? 0));
  const feeShort = ou !== null && publicMicro !== null && pub < ou;
  return {
    fee,
    feeOu: ou,
    available,
    amountError: ou !== null && micro > available ? INSUFFICIENT_BALANCE : "",
    feeError: fee.state === "error" ? FEE_UNAVAILABLE : feeShort ? FEE_SHORT : "",
    retry: fee.state === "error",
    ok: ou !== null && publicMicro !== null && !feeShort && micro > 0 && micro <= available,
  };
}

/** A public or private send: the fee is always paid from public OCT. */
export function sendGate(snap: TraySnapshot, mode: "public" | "private", micro: number): Gate {
  const priv = mode === "private";
  return gate(
    priv ? snap.fees.private : snap.fees.public,
    snap.publicMicro,
    (ou) => (priv ? (snap.privateMicro ?? 0) : (snap.publicMicro ?? 0) - ou),
    micro,
  );
}

export type PrivateSendFix = "migrate" | "keyUpdate" | "turnOn" | "retry";

/** Why a private send can't be reviewed now, or null when the private balance is ready. No
 *  migration rides along with a send: anything but ready is refused before the review. The line
 *  is the private view's status line, empty while it is still being checked. */
export function privateSendBlock(
  r: TraySnapshot["privateReadiness"],
): { line: string; fix: PrivateSendFix | null } | null {
  if (r.state === "ok") return null;
  const checking = r.state === "checking" || (r.state === "noKey" && r.setup.state === "checking");
  const fix: PrivateSendFix | null =
    r.state === "needsRefresh"
      ? "migrate"
      : r.state === "keyUpdate"
        ? "keyUpdate"
        : r.state === "noKey" && r.setup.state === "offer"
          ? "turnOn"
          : r.state === "noKey" && r.setup.state === "unavailable"
            ? "retry"
            : null;
  const line =
    fix === "turnOn" ? "Your private balance is off" : checking ? "" : privateStatusLines(r)[0];
  return { line: line ?? "", fix };
}

/** An encrypt or decrypt, with the refresh's fee added when the review runs it first. */
export function privateOpGate(snap: TraySnapshot, dir: PrivateDirection, micro: number) {
  const refresh = snap.privateReadiness.state === "needsRefresh";
  const opFee = dir === "encrypt" ? snap.fees.encrypt : snap.fees.decrypt;
  const g = gate(
    combine(refresh ? [opFee, snap.fees.refresh] : [opFee]),
    snap.publicMicro,
    (ou) => (dir === "encrypt" ? (snap.publicMicro ?? 0) - ou : (snap.privateMicro ?? 0)),
    micro,
  );
  return {
    ...g,
    refresh,
    opFeeOu: feeValue(opFee),
    refreshFeeOu: refresh ? feeValue(snap.fees.refresh) : 0,
  };
}

/** A key_switch on its own (refresh, key update, turn on): only its fee has to be covered. */
export function keyFeeGate(fee: FeeRead, publicMicro: number | null): Gate {
  return gate(fee, publicMicro, () => 1, 1);
}

/** Why a reviewed fee no longer holds against the panel's latest reads, or null. Each part the
 *  review summed is checked against its own read. A read still loading or failed does not lapse
 *  it: the main window reads the fee again before signing. */
export function reviewedFeeLapse(parts: [reviewedOu: number, now: FeeRead][]): string | null {
  const lapsed = parts.some(
    ([ou, f]) =>
      f.state === "ok" && reviewedFeeError(ou, { ou: f.ou, floorOu: f.floor ?? f.ou }) !== null,
  );
  return lapsed ? FEE_CHANGED : null;
}

/** What a key update's confirm was given for: it lapses when any of these change. */
export function keyConfirmScope(snap: TraySnapshot): string | null {
  const r = snap.privateReadiness;
  if (r.state !== "keyUpdate") return null;
  return `${snap.activeId}|${snap.network}|${r.mode}|${r.amountMicro}`;
}

export function privateStatusLines(readiness: TraySnapshot["privateReadiness"]): string[] {
  switch (readiness.state) {
    case "checking":
      return ["Checking your private balance"];
    case "needsRefresh":
      return ["Your private balance is due for a migration"];
    case "keyUpdate":
      return [keyUpdateCopy(readiness.mode, readiness.amountMicro).status];
    case "stuck":
      return [readiness.detail];
    case "waiting":
      return [
        readiness.reason === "setupPending"
          ? "Setting up, waiting for the network"
          : "Migrating, waiting for the network",
      ];
    case "blocked":
      return [readiness.detail, "Nothing to do right now. Your balances are safe."];
    case "noKey":
      return readiness.setup.state === "short"
        ? [`Add ${formatOCT(readiness.setup.addMicro)} OCT to turn on private balance`]
        : readiness.setup.state === "unavailable"
          ? [
              readiness.setup.reason === "fee"
                ? FEE_UNAVAILABLE
                : "Could not check your private balance. Try again.",
            ]
          : ["Checking your private balance"];
    case "ok":
      return [];
  }
}
