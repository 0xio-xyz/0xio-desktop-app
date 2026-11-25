import { jsonRpcCallOn, nonceState, type TxScope } from "src/services/network/networkService";
import { faultMessage } from "src/services/network/rpcRetry";
import { RpcError } from "src/services/network/submitErrors";
import type { SignedTransaction } from "src/types/transaction";
import { logger } from "src/lib/logger";

// The wallet's own claims per network and address, as webcli tx_journal claim rows.

type OutputState = "unspent" | "spent" | "unknown";
type ClaimStatus = "pending" | "confirmed" | "rejected" | "dropped" | "unknown";

interface ClaimRow {
  output: number;
  hash: string;
  status: ClaimStatus;
  at: number;
  nonce?: number;
  stagedAt?: number;
  conflictAt?: number;
  missing?: boolean;
}

type ClaimSlot =
  | { kind: "fresh" }
  | { kind: "blocked" }
  | { kind: "previous"; hash: string }
  | { kind: "recovery"; hash: string; tx: SignedTransaction };

type Scope = Pick<TxScope, "networkId" | "address">;

export const STAGING_LIFETIME_MS = 600_000;
const WATCH_CONFIRMED_MS = 24 * 3_600_000;
const MAX_ROWS = 200;
const MAX_WATCH = 8;
const KEY_PREFIX = "0xio_claims_v1_";

const CLAIM_SPENT = "Claim output is spent. Nothing was sent.";
const CLAIM_UNREADABLE = "Claim output state is unavailable. Nothing was sent.";
export const CLAIM_CONFLICT =
  "Confirmed claim conflicts with current output state. Nothing was sent.";

type ClaimErrorCode =
  | "CLAIM_OUTPUT_SPENT"
  | "CLAIM_OUTPUT_UNREADABLE"
  | "CLAIM_CONFLICT"
  | "RATE_LIMIT_EXCEEDED"
  | "NETWORK_ERROR";

export class ClaimRefusedError extends Error {
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaimRefusedError";
  }
}

export const outputRefusal = (state: "spent" | "unknown") =>
  state === "spent"
    ? new ClaimRefusedError("CLAIM_OUTPUT_SPENT", CLAIM_SPENT)
    : new ClaimRefusedError("CLAIM_OUTPUT_UNREADABLE", CLAIM_UNREADABLE);

export function claimErrorCode(err: unknown): ClaimErrorCode | null {
  if (err instanceof ClaimRefusedError) return err.code;
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith(faultMessage("capacity")) || message.startsWith(faultMessage("busy")))
    return "RATE_LIMIT_EXCEEDED";
  if (
    message.startsWith(faultMessage("network")) ||
    message.startsWith(faultMessage("deadline")) ||
    message.startsWith("Network timed out")
  )
    return "NETWORK_ERROR";
  return null;
}

const scopeId = (scope: Scope) => `${scope.networkId}:${scope.address}`;
const keyOf = (scope: Scope) => `${KEY_PREFIX}${scopeId(scope)}`;

// The signed claim stays in memory only: it carries the claim secret and a large proof.
const savedTxs = new Map<string, SignedTransaction>();
const txKey = (scope: Scope, hash: string) => `${scopeId(scope)}:${hash}`;

export function outputStateOf(reply: { ok: boolean; claimed?: unknown }): OutputState {
  if (!reply.ok || !Number.isInteger(reply.claimed)) return "unknown";
  return reply.claimed === 0 ? "unspent" : "spent";
}

function load(scope: Scope): ClaimRow[] {
  try {
    const rows = JSON.parse(localStorage.getItem(keyOf(scope)) || "[]");
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.hash === "string") : [];
  } catch {
    return [];
  }
}

function save(scope: Scope, rows: ClaimRow[]): void {
  try {
    localStorage.setItem(keyOf(scope), JSON.stringify(rows.slice(-MAX_ROWS)));
  } catch {}
}

export function claimRows(scope: Scope): ClaimRow[] {
  return load(scope);
}

const settledMissing = (row: ClaimRow) => row.status === "confirmed" && !!row.missing;
const rank = (row: ClaimRow) =>
  settledMissing(row) ? 0 : row.status === "confirmed" ? 2 : row.status === "pending" ? 1 : 0;

function bestRow(scope: Scope, output: number): ClaimRow | null {
  let best: ClaimRow | null = null;
  for (const row of load(scope)) {
    if (row.output !== output) continue;
    if (!best || rank(row) > rank(best) || (rank(row) === rank(best) && row.at >= best.at))
      best = row;
  }
  return best;
}

export function claimSlot(scope: Scope, output: number): ClaimSlot {
  const row = bestRow(scope, output);
  if (!row) return { kind: "fresh" };
  if (row.conflictAt != null && !row.missing) return { kind: "blocked" };
  if (rank(row) > 0) return { kind: "previous", hash: row.hash };
  const tx = savedTxs.get(txKey(scope, row.hash));
  if ((row.status === "unknown" || row.status === "dropped") && tx)
    return { kind: "recovery", hash: row.hash, tx };
  return { kind: "fresh" };
}

type ClaimResend = "resend" | "fresh" | "spent" | "unreadable";

/**
 * Whether a dropped or released claim goes again as its saved bytes: only while the output reads
 * unspent, its nonce is still the next one and its fee is the one just reviewed.
 */
export function claimResend(
  tx: SignedTransaction,
  output: OutputState,
  nextNonce: number | null,
  ou?: string,
): ClaimResend {
  if (output === "spent") return "spent";
  if (output === "unknown") return "unreadable";
  if (ou == null || nextNonce !== tx.nonce || String(tx.ou) !== String(ou)) return "fresh";
  return "resend";
}

export async function claimResendFor(
  scope: Scope,
  output: { id: number; epoch?: number },
  tx: SignedTransaction,
  ou?: string,
): Promise<ClaimResend> {
  const state = await readOutputState(output.id, scope.networkId, output.epoch);
  if (state !== "unspent") return claimResend(tx, state, null, ou);
  const nonce = await nonceState(scope.address, scope.networkId).catch(() => null);
  return claimResend(tx, state, nonce ? nonce.taken + 1 : null, ou);
}

export function recordClaim(
  scope: Scope,
  output: number,
  hash: string,
  tx: SignedTransaction,
  now = Date.now(),
): void {
  const rows = load(scope).filter((r) => r.hash !== hash);
  rows.push({ output, hash, status: "pending", at: now, nonce: tx.nonce, stagedAt: now });
  save(scope, rows);
  savedTxs.set(txKey(scope, hash), tx);
}

export function forgetClaimTx(scope: Scope, hash: string): void {
  savedTxs.delete(txKey(scope, hash));
}

export function forgetSavedClaims(): void {
  savedTxs.clear();
}

interface ClaimLookup {
  status?: string;
  missing: boolean;
}

function missStable(
  row: ClaimRow,
  nonce: { confirmed: number; taken: number },
  now: number,
): boolean {
  const expired = row.stagedAt != null && now - row.stagedAt > STAGING_LIFETIME_MS;
  if (row.nonce == null) return expired;
  return nonce.confirmed >= row.nonce || (nonce.taken < row.nonce && expired);
}

/** webcli observe_own_tx for one saved claim. */
export function observeClaim(
  scope: Scope,
  hash: string,
  lookup: ClaimLookup,
  output: OutputState,
  nonce: { confirmed: number; taken: number } | null,
  now = Date.now(),
): ClaimRow | null {
  const rows = load(scope);
  const row = rows.find((r) => r.hash === hash);
  if (!row) return null;
  if (output === "unspent" && lookup.missing && row.status === "confirmed" && !row.missing) {
    if (row.conflictAt == null) row.conflictAt = now;
    else if (now - row.conflictAt > STAGING_LIFETIME_MS) row.missing = true;
  }
  const status = lookup.status;
  if (
    !lookup.missing &&
    (status === "pending" ||
      status === "confirmed" ||
      status === "rejected" ||
      status === "dropped")
  ) {
    row.status = status;
    if (status === "pending" && row.stagedAt == null) row.stagedAt = now;
    if (status === "confirmed") {
      delete row.conflictAt;
      delete row.missing;
    }
  } else if (lookup.missing && row.status === "pending" && output === "unspent" && nonce) {
    if (missStable(row, nonce, now)) row.status = "unknown";
    else if (row.stagedAt == null) row.stagedAt = now;
  } else if (output === "spent" && row.conflictAt != null && !row.missing) {
    delete row.conflictAt;
  }
  save(scope, rows);
  return row;
}

const methodMissing = new Set<string>();

const isMethodMissing = (e: unknown) =>
  e instanceof RpcError && (e.code === -32601 || /method not found/i.test(e.message));

/**
 * octra_stealthOutputsById where the node has it, else the one-shot octra_stealthOutputs from the
 * output's epoch; an output the fallback does not list is unknown, never unspent.
 */
export async function readOutputState(
  id: number,
  networkId: string,
  epoch?: number,
  lane: "user" | "poll" = "user",
): Promise<OutputState> {
  type Outputs = { outputs?: Array<{ id?: unknown; claimed?: unknown }> };
  const pick = (r: Outputs | null | undefined) => {
    const found = Array.isArray(r?.outputs) ? r.outputs.find((o) => Number(o?.id) === id) : null;
    return found ? outputStateOf({ ok: true, claimed: found.claimed }) : "unknown";
  };
  if (!methodMissing.has(networkId)) {
    try {
      return pick(
        await jsonRpcCallOn<Outputs>(networkId, "octra_stealthOutputsById", [[id]], {
          timeoutMs: 5000,
          lane,
        }),
      );
    } catch (e) {
      if (!isMethodMissing(e)) return "unknown";
      methodMissing.add(networkId);
    }
  }
  if (epoch == null || !Number.isSafeInteger(epoch) || epoch < 0) return "unknown";
  try {
    return pick(
      await jsonRpcCallOn<Outputs>(networkId, "octra_stealthOutputs", [epoch], {
        timeoutMs: 60_000,
        lane,
      }),
    );
  } catch {
    return "unknown";
  }
}

async function lookupClaim(hash: string, networkId: string): Promise<ClaimLookup | null> {
  try {
    const t = await jsonRpcCallOn<{ status?: unknown } | null>(
      networkId,
      "octra_transaction",
      [hash],
      { lane: "poll" },
    );
    return { status: typeof t?.status === "string" ? t.status : undefined, missing: false };
  } catch (e) {
    if (e instanceof RpcError && (e.code === 112 || /not found/i.test(e.message)))
      return { missing: true };
    return null;
  }
}

function watched(row: ClaimRow, now: number): boolean {
  if (row.status === "pending") return true;
  if (row.status === "confirmed")
    return !row.missing && (row.conflictAt != null || now - row.at < WATCH_CONFIRMED_MS);
  return false;
}

export async function watchClaims(
  scope: Scope,
  epochs: Map<number, number | undefined> = new Map(),
  now: () => number = Date.now,
): Promise<void> {
  const rows = load(scope)
    .filter((r) => watched(r, now()))
    .slice(-MAX_WATCH);
  let nonce: { confirmed: number; taken: number } | null | undefined;
  for (const row of rows) {
    const lookup = await lookupClaim(row.hash, scope.networkId);
    if (!lookup) continue;
    let output: OutputState = "unknown";
    if (lookup.missing) {
      output = await readOutputState(row.output, scope.networkId, epochs.get(row.output), "poll");
      if (row.status === "pending" && output === "unspent" && nonce === undefined)
        nonce = await nonceState(scope.address, scope.networkId).catch(() => null);
    }
    const next = observeClaim(scope, row.hash, lookup, output, nonce ?? null, now());
    if (next && (next.status !== row.status || next.conflictAt !== row.conflictAt))
      logger.info("privacy", `claim ${row.hash.slice(0, 12)}: ${row.status} -> ${next.status}`);
  }
}
