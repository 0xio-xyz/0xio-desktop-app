// What the main window publishes to the menu bar panel, and what the panel can ask for.
// The main window owns all wallet state; the panel only shows this snapshot and sends actions.

interface TrayWallet {
  id: string;
  name: string;
  address: string;
}

interface TrayNetwork {
  id: string;
  name: string;
}

import type { KeyUpdateMode } from "src/features/privacy/services/keyUpdatePolicy";

export type { KeyUpdateMode };

/** No client can fix these: past the layer limit, or not provable with no migration route. */
type PrivateStuckReason = "pastCap" | "unprovable";

/** A live fee read in OU: loading, read, or failed (the panel offers a retry). `floor` is the
 *  lowest fee the node takes now; a review holds while its fee is at or above it. */
export type FeeRead =
  | { state: "loading" }
  | { state: "ok"; ou: number; floor?: number }
  | { state: "error" };

export const feeValue = (f: FeeRead): number | null => (f.state === "ok" ? f.ou : null);

type PrivateSetupOffer =
  | { state: "checking" }
  | { state: "unavailable"; reason: "fee" | "check" }
  | { state: "offer"; feeOu: number; floorOu?: number }
  | { state: "short"; feeOu: number; addMicro: number };

export type PrivateReadiness =
  | { state: "checking" }
  | { state: "ok" }
  /** The same-key migration (the Migrate balance popup) is due and the node takes it. */
  | { state: "needsRefresh" }
  /** The key dialog's update: a key rotation, with the private balance moved when it holds one,
   *  and the live key_switch quote. */
  | { state: "keyUpdate"; mode: KeyUpdateMode; amountMicro: number; fee: FeeRead }
  | { state: "noKey"; setup: PrivateSetupOffer }
  | { state: "waiting"; reason: "setupPending" | "refreshPending" }
  /** Nothing to do now: the node refuses every key update for this wallet. The detail is the
   *  main window's reason line (the node's reason when known). */
  | { state: "blocked"; reason: "keyBlocked" | "keyMismatch"; detail: string }
  | { state: "stuck"; reason: PrivateStuckReason; detail: string };

export type PrivateDirection = "encrypt" | "decrypt";

export interface TraySnapshot {
  locked: boolean;
  hasPassword: boolean;
  biometric: boolean;
  wallets: TrayWallet[];
  activeId: string | null;
  network: string;
  networks: TrayNetwork[];
  privacy: boolean;
  canSign: boolean;
  privateReadiness: PrivateReadiness;
  /** Last known balances in micro OCT; null until the main window has loaded them. */
  publicMicro: number | null;
  privateMicro: number | null;
  claims: number;
  fees: { public: FeeRead; private: FeeRead; encrypt: FeeRead; decrypt: FeeRead; refresh: FeeRead };
}

export type TrayAction =
  | { type: "switchWallet"; id: string }
  | { type: "setNetwork"; id: string }
  | { type: "lock" }
  | { type: "unlockBiometric" }
  | { type: "openApp"; route?: string }
  | {
      type: "send";
      requestId: string;
      to: string;
      amountMicro: number;
      mode: "public" | "private";
      /** The fee the review showed; the main window refuses if the live fee differs. */
      feeOu: number;
      /** The wallet and network the panel reviewed; the main window refuses if either changed. */
      walletId: string;
      network: string;
    }
  | {
      type: "private";
      requestId: string;
      direction: PrivateDirection;
      amountMicro: number;
      refresh: boolean;
      feeOu: number;
      refreshFeeOu: number;
      walletId: string;
      network: string;
    }
  | {
      type: "refresh";
      requestId: string;
      walletId: string;
      network: string;
      feeOu: number;
    }
  | {
      type: "turnOn";
      requestId: string;
      walletId: string;
      network: string;
      feeOu: number;
    }
  | {
      /** The key update the review showed: its mode, the balance it moves (0 when none), and
       *  the explicit confirm the key dialog requires. */
      type: "migrate";
      requestId: string;
      walletId: string;
      network: string;
      mode: KeyUpdateMode;
      amountMicro: number;
      feeOu: number;
      confirmed: true;
    }
  | { type: "cancelSend"; requestId: string }
  | { type: "retryReads" }
  | { type: "setOpenAtLogin"; enabled: boolean }
  | { type: "quit" };

/** Actions the main window receives (the panel's, forwarded by Rust, plus Rust's own). */
export type MainTrayAction =
  | Exclude<TrayAction, { type: "openApp" } | { type: "setOpenAtLogin" } | { type: "quit" }>
  | { type: "navigate"; route: string }
  | { type: "sendApproved"; requestId: string };

type SendStage = "approving" | "needPassword" | "sending" | "sent" | "failed";

export interface TraySendProgress {
  requestId: string;
  stage: SendStage;
  steps?: string[];
  stepIndex?: number;
  error?: string;
  /** With "sent": submitted, but the network has not confirmed it yet. */
  pending?: boolean;
}

export interface TrayState {
  snapshot: TraySnapshot | null;
  clients: number;
  computing: boolean;
  /** The running proof is for the extension (the rest are this wallet's own). */
  computingExtension: boolean;
  openAtLogin: boolean;
}

// Mirror the real stages: privacyService reports Prepare, FHE encrypt, Range proofs, Submit.
export const PRIVATE_STEPS = [
  "Encrypting the amount",
  "Generating the proof",
  "Range proofs",
  "Sending",
];
export const PUBLIC_STEPS = ["Signing", "Sending"];
const ENCRYPT_STEPS = ["Preparing", "Encrypting the amount", "Range proofs", "Sending"];
const DECRYPT_STEPS = ["Preparing", "Decrypting proof", "Range proofs", "Sending"];
const REFRESH_STEP = "Refreshing your private balance (1 of 2)";

export function privateSteps(direction: PrivateDirection, refresh: boolean): string[] {
  const op = direction === "encrypt" ? ENCRYPT_STEPS : DECRYPT_STEPS;
  if (!refresh) return op;
  return [REFRESH_STEP, ...op.slice(0, -1), `${op[op.length - 1]} (2 of 2)`];
}
export const REFRESH_ONLY_STEPS = ["Migrating your private balance", "Waiting for the network"];

/** The steps of a key update: moving the balance is its own step when there is one. */
export function keyUpdateSteps(movesBalance: boolean): string[] {
  return movesBalance
    ? ["Preparing", "Moving your balance", "Sending", "Waiting for the network"]
    : ["Preparing", "Updating the key", "Sending", "Waiting for the network"];
}
export const TURN_ON_STEPS = ["Preparing", "Sending"];
