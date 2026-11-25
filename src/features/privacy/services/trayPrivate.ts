import { KEY_SWITCH_MAX_LAYERS } from "src/features/privacy/services/pvacUpgradePolicy";
import type { TxScope } from "src/services/network/networkService";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  INSUFFICIENT_BALANCE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";

import { liveFeeOf, reviewedFeeError, type LiveFee } from "src/services/transactions/reviewedFee";

export { FEE_CHANGED, FEE_SHORT, FEE_UNAVAILABLE, INSUFFICIENT_BALANCE, SCOPE_CHANGED };
export { feeOu } from "src/services/transactions/reviewedFee";
import type { RefreshOutcome } from "src/features/privacy/services/balanceRefresh";
import type { PvacRegistrationState } from "src/features/privacy/services/privacyService";
import type { PvacSetupData } from "src/hooks/privacy/usePvacSetup";
import {
  shouldOfferPrivateSetup,
  type PrivateSetupChecks,
} from "src/features/privacy/services/privateSetupPolicy";
import type { FeeRead, PrivateReadiness } from "src/tray/protocol";
import {
  KEY_UPDATE_MODES,
  keyUpdateMovesBalance,
  type KeyModeSignal,
} from "src/features/privacy/services/keyUpdatePolicy";

export interface ReadinessSignals {
  setup: PvacSetupData | undefined;
  foreign: boolean;
  legacy: boolean;
  refreshPending: boolean;
  staged?: boolean;
  blockedAck?: string | null;
  setupChecks?: PrivateSetupChecks | null;
  setupError?: "fee" | "check" | null;
  publicMicro?: number | null;
  keyMode?: KeyModeSignal | null;
  keyFee?: FeeRead;
}

export const KEY_BLOCKED_LINE =
  "The network moved to a new encryption scheme, but this account can't be updated yet.";
export const KEY_FINE_LINE =
  "Your encryption key is fine. Your private balance waits for a network migration.";

function blockedLine(ack: string | null | undefined, keyFine: boolean): string {
  if (ack && ack !== "key_bound_unavailable") return ack;
  return keyFine ? KEY_FINE_LINE : KEY_BLOCKED_LINE;
}

function setupOffer(s: ReadinessSignals): PrivateReadiness {
  const checks = s.setupChecks;
  const blocked: PrivateReadiness = {
    state: "blocked",
    reason: "keyBlocked",
    detail: blockedLine(s.blockedAck, false),
  };
  if (s.blockedAck) return blocked;
  if (s.setupError)
    return { state: "noKey", setup: { state: "unavailable", reason: s.setupError } };
  if (!checks || s.publicMicro == null) return { state: "noKey", setup: { state: "checking" } };
  if (checks.regState === "pending") return { state: "waiting", reason: "setupPending" };
  if (checks.regState !== "unregistered") return { state: "checking" };
  if (!checks.canKeySwitch) return blocked;
  const feeOu = Number(checks.feeRaw);
  if (!checks.feeRaw || !Number.isFinite(feeOu) || feeOu <= 0)
    return { state: "noKey", setup: { state: "unavailable", reason: "fee" } };
  const offer = shouldOfferPrivateSetup({
    privacy: true,
    canSign: true,
    keyBlocked: false,
    pending: !!s.staged,
    checks,
    publicBalanceRaw: s.publicMicro,
  });
  const floorOu = checks.floorRaw ? liveFeeOf(feeOu, checks.floorRaw)?.floorOu : undefined;
  if (offer)
    return { state: "noKey", setup: { state: "offer", feeOu, ...(floorOu && { floorOu }) } };
  return {
    state: "noKey",
    setup: { state: "short", feeOu, addMicro: Math.max(0, feeOu - s.publicMicro) },
  };
}

export const PAST_CAP_LINE =
  "This private balance is past the layer limit, so no wallet can migrate it.";
export const KEY_CHECK_FAILED_LINE =
  "Could not check this wallet's encryption key. Open the panel again in a moment.";

export function unprovableLine(reason: string | undefined): string {
  return reason
    ? `This private balance can't be proven right now: ${reason}.`
    : "This private balance can't be proven right now.";
}

function keyModeLine(mode: KeyModeSignal): string {
  if (mode.kind === "blocked") return mode.reason;
  return mode.kind === "unavailable" && mode.keyCurrent ? KEY_FINE_LINE : KEY_BLOCKED_LINE;
}

function keyUpdate(s: ReadinessSignals): PrivateReadiness | null {
  const m = s.keyMode;
  if (!m || m.kind !== "update") return null;
  return {
    state: "keyUpdate",
    mode: m.mode,
    amountMicro: m.amountMicro,
    fee: s.keyFee ?? { state: "loading" },
  };
}

export function privateReadiness(s: ReadinessSignals): PrivateReadiness {
  if (s.foreign || s.legacy) {
    if (s.refreshPending) return { state: "waiting", reason: "refreshPending" };
    const update = keyUpdate(s);
    if (update) return update;
    if (s.keyMode === undefined) return { state: "checking" };
    return {
      state: "blocked",
      reason: s.foreign ? "keyMismatch" : "keyBlocked",
      detail: s.keyMode === null ? KEY_CHECK_FAILED_LINE : keyModeLine(s.keyMode),
    };
  }
  // An acknowledged block keeps its tag, which reopens the key dialog: when the node now takes
  // an update, offer it instead of the status line.
  const orKeyUpdate = (r: PrivateReadiness): PrivateReadiness =>
    (s.blockedAck && keyUpdate(s)) || r;
  const setup = s.setup;
  if (!setup) return { state: "checking" };
  if (setup.regState === "unregistered") {
    if (s.staged) return { state: "waiting", reason: "setupPending" };
    return orKeyUpdate(setupOffer(s));
  }
  if (setup.regState === "pending") return { state: "waiting", reason: "setupPending" };
  if (s.refreshPending) return { state: "waiting", reason: "refreshPending" };
  if (setup.baseLayers > KEY_SWITCH_MAX_LAYERS)
    return { state: "stuck", reason: "pastCap", detail: PAST_CAP_LINE };
  if (setup.held)
    return setup.canMigrate
      ? { state: "needsRefresh" }
      : orKeyUpdate({
          state: "blocked",
          reason: "keyBlocked",
          detail: blockedLine(s.blockedAck, setup.holdKeyFine),
        });
  if (setup.notSpendable)
    return orKeyUpdate({
      state: "stuck",
      reason: "unprovable",
      detail: unprovableLine(setup.spendReason),
    });
  if (setup.needsCompact)
    return setup.canRefresh
      ? { state: "needsRefresh" }
      : orKeyUpdate({
          state: "blocked",
          reason: "keyBlocked",
          detail: blockedLine(s.blockedAck, false),
        });
  return { state: "ok" };
}

export class TrayError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "TrayError";
    this.detail = detail;
  }
}

export const GENERIC_FAILURE = "Something went wrong. Try again.";
export const NEEDS_MIGRATION = "Your private balance needs a migration first. Review again.";
export const STUCK = "This private balance can't be spent or migrated right now.";
export const NOT_TURNED_ON = "Turn on your private balance first.";
const KEY_UPDATE_FIRST = "Your private balance needs a key update first. Review again.";
const WAITING = "Your private balance is waiting for the network. Try again in a few minutes.";
export const SETTING_UP = "Your private balance is still being set up. Try again in a moment.";

const RAW_COPY: [RegExp, string][] = [
  [/Review again\.$/, ""],
  [/fee.*(too low|too small|insufficient)|(low|insufficient).*\bfee\b/i, FEE_CHANGED],
  [/insufficient|not enough|exceeds (the )?balance|balance too low/i, INSUFFICIENT_BALANCE],
  [/nonce/i, "Another transaction is still pending. Try again in a moment."],
  [
    /not accepting key updates|key_bound_unavailable|key switch blocked/i,
    "The network is not taking key updates for this account yet. Nothing is lost.",
  ],
  [/recipient has no view pubkey/i, "This address can't receive private transfers yet."],
  [/rejected/i, "The network rejected it."],
  [
    /time(d)? ?out|abort|\b(429|502|503|504)\b|fetch|network error|http|econn|rate.?limit|busy/i,
    "The network did not respond. Try again.",
  ],
  [/cancel/i, "Cancelled"],
];

export function trayErrorCopy(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TrayError" || e.name === "ProofPolicy") return e.message;
    if (e.name === "FeeUnavailable") return FEE_UNAVAILABLE;
    if (e.name === "ScopeChanged") return "The wallet or network changed. Nothing was sent.";
    if (e.name === "PvacCompactNeeded") return NEEDS_MIGRATION;
    if (e.name === "PvacNotSpendable") return STUCK;
    if (e.name === "PvacSetupPending")
      return /confirming|pending|setting up/i.test(e.message) ? SETTING_UP : NOT_TURNED_ON;
  }
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const [re, copy] of RAW_COPY) if (re.test(raw)) return copy || raw;
  return GENERIC_FAILURE;
}

export function trayErrorDetail(e: unknown): string {
  if (e instanceof TrayError) return e.detail ? `${e.message} (${e.detail})` : e.message;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

interface TrayScopeRequest {
  walletId: string;
  network: string;
}

interface TrayLiveScope {
  walletId: string | null;
  address: string | null;
  network: string;
  rpcNetwork: string;
}

export function trayScope(req: TrayScopeRequest, live: TrayLiveScope): TxScope | null {
  if (!live.walletId || !live.address || live.walletId !== req.walletId) return null;
  if (live.network !== req.network || live.rpcNetwork !== req.network) return null;
  return { networkId: req.network, address: live.address };
}

export function trayFeeError(reviewedOu: number, live: LiveFee | null): string | null {
  return reviewedFeeError(reviewedOu, live);
}

export function feeRead(q: {
  data?: number | LiveFee | null;
  status: string;
  fetchStatus?: string;
}): FeeRead {
  const d = q.data;
  if (q.status === "success" && typeof d === "number" && d > 0) return { state: "ok", ou: d };
  if (q.status === "success" && d && typeof d === "object" && d.ou > 0)
    return { state: "ok", ou: d.ou, floor: Math.min(d.floorOu, d.ou) };
  if (q.status === "error" && q.fetchStatus !== "fetching") return { state: "error" };
  return { state: "loading" };
}

interface TrayApproval {
  hasPassword: boolean;
  biometric: boolean;
  promptBiometric: () => Promise<unknown>;
  isPending: () => boolean;
  /** Runs the request as the main window sees it now, never as it was when the request came. */
  run: () => void;
  approving: () => void;
  needPassword: () => void;
}

/** Approval for a reviewed request: Touch ID when it is on, the password when it is off or was
 *  cancelled. A request cancelled meanwhile never runs. */
export async function approveTrayRequest(a: TrayApproval): Promise<void> {
  if (!a.hasPassword) return a.run();
  if (a.biometric) {
    a.approving();
    try {
      await a.promptBiometric();
      if (a.isPending()) a.run();
      return;
    } catch {}
  }
  if (a.isPending()) a.needPassword();
}

interface TrayFeeRequest {
  walletId: string;
  network: string;
  feeOu: number;
}

interface TrayLiveRequest {
  walletId: string | null;
  network: string;
  fee: LiveFee | null;
}

export function trayRequestError(req: TrayFeeRequest, live: TrayLiveRequest): string | null {
  if (!Number.isSafeInteger(req.feeOu) || req.feeOu <= 0)
    return "That request does not look right.";
  if (!live.walletId || live.walletId !== req.walletId || live.network !== req.network)
    return SCOPE_CHANGED;
  return reviewedFeeError(req.feeOu, live.fee);
}

interface TrayMigrateRequest extends TrayFeeRequest {
  mode: string;
  amountMicro: number;
  confirmed?: unknown;
}

export function trayMigrateRequestError(
  req: TrayMigrateRequest,
  live: TrayLiveRequest,
): string | null {
  if (req.confirmed !== true) return "Confirm the update first.";
  const mode = KEY_UPDATE_MODES.find((m) => m === req.mode);
  if (
    !mode ||
    !Number.isSafeInteger(req.amountMicro) ||
    req.amountMicro < 0 ||
    (!keyUpdateMovesBalance(mode) && req.amountMicro !== 0)
  )
    return "That request does not look right.";
  return trayRequestError(req, live);
}

export interface FreshReadiness {
  ready: boolean;
  needsCompact: boolean;
}

interface PrivateOpDeps {
  readiness: () => Promise<FreshReadiness>;
  refresh: () => Promise<RefreshOutcome>;
  op: (onStep: (n: number) => void) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

type PrivateOpEvent = { phase: "refresh" } | { phase: "op"; step: number };

/**
 * Refresh-then-continue for an encrypt or decrypt the user reviewed. The refresh runs only when
 * the review showed it; after it lands, waits until the node serves the refreshed balance before
 * the op. Any refresh failure stops before the op.
 */
export async function runPrivateOp(params: {
  reviewedRefresh: boolean;
  deps: PrivateOpDeps;
  onEvent?: (e: PrivateOpEvent) => void;
  pollMs?: number;
  serveTimeoutMs?: number;
}): Promise<void> {
  const { reviewedRefresh, deps, onEvent, pollMs = 3000, serveTimeoutMs = 90_000 } = params;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let fresh: FreshReadiness | null = null;
  try {
    fresh = await deps.readiness();
  } catch {
    // Without a planned refresh the op's own guard re-checks; with one, never guess.
    if (reviewedRefresh) throw new TrayError("Could not read your private balance. Try again.");
  }
  if (fresh && !fresh.ready && !fresh.needsCompact) throw new TrayError(STUCK);
  if (fresh?.needsCompact && !reviewedRefresh) throw new TrayError(NEEDS_MIGRATION);

  if (fresh?.needsCompact) {
    onEvent?.({ phase: "refresh" });
    await refreshAndServe(deps, sleep, pollMs, serveTimeoutMs);
  }

  onEvent?.({ phase: "op", step: 0 });
  await deps.op((n) => onEvent?.({ phase: "op", step: n }));
}

async function refreshAndServe(
  deps: Pick<PrivateOpDeps, "readiness" | "refresh">,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  serveTimeoutMs: number,
  onServe?: () => void,
): Promise<void> {
  const outcome = await deps.refresh();
  if (outcome.status === "rejected")
    throw new TrayError("The network rejected the refresh.", outcome.reason || "unknown reason");
  if (outcome.status === "pending")
    throw new TrayError("The refresh is still confirming. Try again in a few minutes.");
  onServe?.();
  const deadline = Date.now() + serveTimeoutMs;
  for (;;) {
    let now: FreshReadiness | null = null;
    try {
      now = await deps.readiness();
    } catch {}
    if (now?.ready) return;
    if (now && !now.needsCompact) throw new TrayError(STUCK);
    if (Date.now() >= deadline)
      throw new TrayError(
        "The refresh landed but the network still serves the old balance. Try again in a moment.",
      );
    await sleep(pollMs);
  }
}

type PrivateRefreshEvent = { phase: "refresh" } | { phase: "serve" };

export async function runPrivateRefresh(params: {
  deps: Pick<PrivateOpDeps, "readiness" | "refresh" | "sleep">;
  onEvent?: (e: PrivateRefreshEvent) => void;
  pollMs?: number;
  serveTimeoutMs?: number;
}): Promise<void> {
  const { deps, onEvent, pollMs = 3000, serveTimeoutMs = 90_000 } = params;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let fresh: FreshReadiness;
  try {
    fresh = await deps.readiness();
  } catch {
    throw new TrayError("Could not read your private balance. Try again.");
  }
  if (fresh.ready && !fresh.needsCompact)
    throw new TrayError("Your private balance does not need a refresh right now.");
  if (!fresh.needsCompact) throw new TrayError(STUCK);
  onEvent?.({ phase: "refresh" });
  await refreshAndServe(deps, sleep, pollMs, serveTimeoutMs, () => onEvent?.({ phase: "serve" }));
}

export interface FreshSendReadiness extends FreshReadiness {
  registration: PvacRegistrationState;
  keyUpdate: boolean;
  waiting: boolean;
}

/**
 * A private send the user reviewed. No migration rides along with a send, so it runs only while a
 * fresh read says the balance is registered and spendable; anything else, or a read that fails,
 * stops before any proof work.
 */
export async function runPrivateSend(deps: {
  readiness: () => Promise<FreshSendReadiness>;
  op: () => Promise<unknown>;
}): Promise<void> {
  let fresh: FreshSendReadiness;
  try {
    fresh = await deps.readiness();
  } catch {
    throw new TrayError("Could not read your private balance. Try again.");
  }
  if (fresh.registration === "pending") throw new TrayError(SETTING_UP);
  if (fresh.registration !== "registered") throw new TrayError(NOT_TURNED_ON);
  if (fresh.keyUpdate) throw new TrayError(KEY_UPDATE_FIRST);
  if (fresh.waiting) throw new TrayError(WAITING);
  if (fresh.needsCompact) throw new TrayError(NEEDS_MIGRATION);
  if (!fresh.ready) throw new TrayError(STUCK);
  await deps.op();
}
