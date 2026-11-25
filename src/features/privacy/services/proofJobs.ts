import * as privacyService from "src/features/privacy/services/privacyService";
import type { ClaimableOutput } from "src/features/privacy/services/privacyService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { assertScope, type FeeOpType, type TxScope } from "src/services/network/networkService";
import { recheckReviewedFee } from "src/hooks/transactions/useFees";
import { holdName } from "src/features/wallet/services/nameCheck";
import type { DoneKind, JobSpec, ProofKind } from "src/features/privacy/services/proofQueue";

/** Encrypt has no range proof. */
export const STEPS: Record<
  "encrypt" | "decrypt" | "claim" | "send" | "refresh" | "setup",
  string[]
> = {
  encrypt: [
    "proofs.step.encrypting",
    "proofs.step.proof",
    "proofs.step.signing",
    "proofs.step.broadcasting",
  ],
  decrypt: [
    "proofs.step.encrypting",
    "proofs.step.proof",
    "proofs.step.range",
    "proofs.step.signing",
    "proofs.step.broadcasting",
  ],
  claim: [
    "proofs.step.checking",
    "proofs.step.encrypting",
    "proofs.step.proof",
    "proofs.step.signing",
    "proofs.step.broadcasting",
  ],
  send: [
    "proofs.step.encrypting",
    "proofs.step.proof",
    "proofs.step.range",
    "proofs.step.signing",
    "proofs.step.broadcasting",
  ],
  refresh: ["proofs.step.proof", "proofs.step.broadcasting", "proofs.step.confirming"],
  setup: ["proofs.step.signing", "proofs.step.confirming"],
};

export const RUNNING: Record<ProofKind, string> = {
  encrypt: "proofs.running.encrypt",
  decrypt: "proofs.running.decrypt",
  claim: "proofs.running.claim",
  send: "proofs.running.send",
  bulk: "proofs.running.send",
  refresh: "proofs.running.refresh",
  migrate: "proofs.running.migrate",
  setup: "proofs.running.setup",
};
export const STOPPED: Record<ProofKind, string> = {
  encrypt: "proofs.stopped.encrypt",
  decrypt: "proofs.stopped.decrypt",
  claim: "proofs.stopped.claim",
  send: "proofs.stopped.send",
  bulk: "proofs.stopped.send",
  refresh: "proofs.stopped.refresh",
  migrate: "proofs.stopped.migrate",
  setup: "proofs.stopped.setup",
};
export const NEXT: Record<ProofKind, string> = {
  encrypt: "proofs.next.encrypt",
  decrypt: "proofs.next.decrypt",
  claim: "proofs.next.claim",
  send: "proofs.next.send",
  bulk: "proofs.next.send",
  refresh: "proofs.next.refresh",
  migrate: "proofs.next.migrate",
  setup: "proofs.next.setup",
};
export const DONE: Record<DoneKind, string> = {
  encrypt: "proofs.done.encrypt",
  decrypt: "proofs.done.decrypt",
  claim: "proofs.done.claim",
  send: "proofs.done.send",
  bulk: "proofs.done.send",
  refresh: "proofs.done.refresh",
  migrate: "proofs.done.migrate",
  setup: "proofs.done.setup",
  keyUpdate: "proofs.done.keyUpdate",
};

async function ensureEngine(walletId: string, scope: TxScope): Promise<void> {
  assertScope(scope);
  if (!pvacBridge.isInitializedFor(scope.address))
    await privacyService.initPvac(walletId, scope.address);
}

async function holdsFee(op: FeeOpType, scope: TxScope, ou: string): Promise<void> {
  const { error } = await recheckReviewedFee(op, scope.networkId, ou);
  if (error) throw new Error(error);
}

interface Reviewed {
  scope: TxScope;
  walletId: string;
  amount: number;
  ou: string;
}

export function encryptJob(r: Reviewed): JobSpec {
  return {
    kind: "encrypt",
    scope: r.scope,
    amount: r.amount,
    steps: STEPS.encrypt,
    run: async (step) => {
      await holdsFee("encrypt", r.scope, r.ou);
      await ensureEngine(r.walletId, r.scope);
      return privacyService.encryptBalance(r.scope, r.amount, r.walletId, r.ou, step);
    },
  };
}

export function decryptJob(r: Reviewed): JobSpec {
  return {
    kind: "decrypt",
    scope: r.scope,
    amount: r.amount,
    steps: STEPS.decrypt,
    run: async (step) => {
      await holdsFee("decrypt", r.scope, r.ou);
      await ensureEngine(r.walletId, r.scope);
      return privacyService.decryptBalance(r.scope, r.amount, r.walletId, r.ou, step);
    },
  };
}

export function claimJob(r: Omit<Reviewed, "amount"> & { output: ClaimableOutput }): JobSpec {
  return {
    kind: "claim",
    scope: r.scope,
    amount: r.output.amount,
    to: r.output.sender,
    steps: STEPS.claim,
    run: async (step) => {
      await holdsFee("claim", r.scope, r.ou);
      await ensureEngine(r.walletId, r.scope);
      return privacyService.claimOutput(r.scope, r.output, r.walletId, r.ou, undefined, step);
    },
  };
}

export function sendJob(r: Reviewed & { recipient: string; name?: string | null }): JobSpec {
  return {
    kind: "send",
    scope: r.scope,
    amount: r.amount,
    to: r.recipient,
    steps: STEPS.send,
    run: async (step) => {
      await holdsFee("stealth", r.scope, r.ou);
      await ensureEngine(r.walletId, r.scope);
      if (r.name) await holdName(r.name, r.recipient, r.scope.networkId);
      return privacyService.sendStealth({
        scope: r.scope,
        recipient: r.recipient,
        amount: r.amount,
        walletId: r.walletId,
        ou: r.ou,
        onProgress: step,
      });
    },
  };
}
