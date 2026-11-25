import { NETWORKS, DEFAULT_NETWORK } from "src/services/network/config";
import { walletBridge } from "src/services/wallet/walletBridge";
import type { RpcResponse, AccountInfo } from "src/types/network";
import type {
  Transaction,
  TransactionDetail,
  TokenTransfer,
  SignedTransaction,
} from "src/types/transaction";
import { logger } from "src/lib/logger";
import { markSlow, clearSlow } from "src/services/network/networkHealth";
import { flooredFeeQuote } from "src/services/network/feePolicy";
import { computeTxHash, type HashableTx } from "src/services/network/txHash";
import { postRpc, type RpcExchange } from "src/services/network/rpcTransport";
import {
  GATE_MAX_REQUEST_S,
  RpcGate,
  classify,
  faultMessage,
  isWrite,
  pauseSeconds,
  retryAfterHeader,
  retryWindowSeconds,
  shouldRepeat,
  type RpcLane,
  type RpcStep,
} from "src/services/network/rpcRetry";
import {
  RpcError,
  TxSubmitError,
  UnclearSubmitError,
  submitErrorKind,
} from "src/services/network/submitErrors";
import {
  FEE_UNAVAILABLE,
  TX_NONCE_USED,
  TX_NOT_ACCEPTED,
  TX_REJECTED,
  TX_TOO_LARGE,
} from "src/services/transactions/feeCopy";

let currentNetwork = localStorage.getItem("0xio_network") || DEFAULT_NETWORK;

const RPC_PROXY_URL = "https://rpc-proxy.0xio.xyz";

function getRpcTimeoutMs(): number {
  const saved = localStorage.getItem("0xio_rpc_timeout_seconds");
  return (saved ? parseInt(saved, 10) : 30) * 1000;
}

export function getTxTimeoutMs(): number {
  const saved = localStorage.getItem("0xio_tx_timeout_seconds");
  return (saved ? parseInt(saved, 10) : 120) * 1000;
}

export function getBaseUrl(): string {
  return NETWORKS[currentNetwork]?.rpcUrl || NETWORKS[DEFAULT_NETWORK].rpcUrl;
}

export function rpcUrlFor(networkId: string): string {
  const net = NETWORKS[networkId];
  return net?.rpcEndpoint ?? `${net?.rpcUrl || NETWORKS[DEFAULT_NETWORK].rpcUrl}/rpc`;
}

export function getRpcUrl(): string {
  return rpcUrlFor(currentNetwork);
}

export function setNetwork(networkId: string) {
  currentNetwork = networkId;
  localStorage.setItem("0xio_network", networkId);
  pendingNonces.clear();
  clearPvacPubkeyCache();
  // A fresh network cannot be slow yet: the old node's flag must not carry over.
  clearSlow();
}

export function getNetwork() {
  return currentNetwork;
}

/** Signed txs carry no chain id, so this scope is the only guard against a switch mid flow. */
export interface TxScope {
  readonly networkId: string;
  readonly address: string;
  readonly site?: string;
  readonly relay?: string;
}

let activeAddress: string | null = null;

export function setActiveAddress(address: string | null): void {
  if (address !== activeAddress) clearPvacPubkeyCache();
  activeAddress = address;
}

export function captureScope(address: string): TxScope {
  return { networkId: currentNetwork, address };
}

let siteScopeCheck: ((scope: TxScope) => boolean) | null = null;

export function setSiteScopeCheck(fn: (scope: TxScope) => boolean): void {
  siteScopeCheck = fn;
}

let relayScopeCheck: ((scope: TxScope) => boolean) | null = null;

export function setRelayScopeCheck(fn: (scope: TxScope) => boolean): void {
  relayScopeCheck = fn;
}

export function captureSiteScope(address: string, site: string): TxScope {
  return { networkId: currentNetwork, address, site };
}

export function scopeKey(address: string, networkId: string = currentNetwork): string {
  return `${networkId}:${address}`;
}

export function isScopeCurrent(scope: TxScope): boolean {
  if (scope.relay) return !!scope.site && !!relayScopeCheck && relayScopeCheck(scope);
  if (scope.networkId !== currentNetwork) return false;
  if (scope.site) return !!siteScopeCheck && siteScopeCheck(scope);
  return scope.address === activeAddress;
}

export function assertScope(scope: TxScope): void {
  if (isScopeCurrent(scope)) return;
  const e = new Error(
    scope.networkId !== currentNetwork && !scope.relay
      ? "The network changed while this transaction was being prepared. Nothing was sent."
      : "The wallet changed while this transaction was being prepared. Nothing was sent.",
  );
  e.name = "ScopeChanged";
  throw e;
}

let rpcId = 0;

interface RpcOptions {
  timeoutMs?: number;
  lane?: RpcLane;
  /** One attempt and no gate, for flows that already retry. */
  once?: boolean;
}

type RpcOpts = number | RpcOptions | undefined;

const optionsOf = (o: RpcOpts): RpcOptions =>
  typeof o === "number" ? { timeoutMs: o } : (o ?? {});

const rpcGate = new RpcGate();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RPC_TIMING_LIMIT = 24;
const NO_TIMINGS: readonly number[] = [];
const rpcTimings = new Map<string, readonly number[]>();
const timingListeners = new Set<() => void>();

function recordRpcTiming(url: string, ms: number): void {
  rpcTimings.set(url, [...(rpcTimings.get(url) ?? NO_TIMINGS), ms].slice(-RPC_TIMING_LIMIT));
  timingListeners.forEach((l) => l());
}

export function rpcTimingsFor(url: string): readonly number[] {
  return rpcTimings.get(url) ?? NO_TIMINGS;
}

export function subscribeRpcTimings(cb: () => void): () => void {
  timingListeners.add(cb);
  return () => {
    timingListeners.delete(cb);
  };
}

const nodeStatusMissing = new Set<string>();

/** node_status where the node has it, else the newest epoch among the recent transactions. */
export async function getChainHead(networkId: string): Promise<number> {
  const url = rpcUrlFor(networkId);
  const num = (v: unknown) => {
    const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  if (!nodeStatusMissing.has(url)) {
    try {
      const s = await rpcCall<Record<string, unknown>>(url, "node_status", [], { lane: "poll" });
      const head = num(s?.current_epoch) ?? num(s?.epoch);
      if (head) return head;
    } catch (e) {
      if (/-32601|not found|unknown method|HTTP error: 40[34]/i.test(String(e))) {
        nodeStatusMissing.add(url);
      } else {
        throw e;
      }
    }
  }
  const r = await rpcCall<{ transactions?: Array<{ epoch?: unknown }> }>(
    url,
    "octra_recentTransactions",
    [1],
    { lane: "poll" },
  );
  const head = Math.max(0, ...(r?.transactions ?? []).map((t) => num(t.epoch) ?? 0));
  if (!head) throw new Error("Chain head unavailable");
  return head;
}

export async function pingNetwork(networkId: string, timeoutMs = 8000): Promise<number | null> {
  const start = performance.now();
  try {
    await rpcCall(rpcUrlFor(networkId), "octra_recommendedFee", [], { timeoutMs, once: true });
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

export function jsonRpcCall<T>(method: string, params: unknown[] = [], opts?: RpcOpts): Promise<T> {
  return rpcCall<T>(getRpcUrl(), method, params, opts);
}

export function jsonRpcCallOn<T>(
  networkId: string | undefined,
  method: string,
  params: unknown[] = [],
  opts?: RpcOpts,
): Promise<T> {
  const url = networkId ? rpcUrlFor(networkId) : getRpcUrl();
  return rpcCall<T>(url, method, params, opts);
}

/** A node call on an explicit RPC endpoint, through the same exchange as every other call. */
export function jsonRpcCallAt<T>(
  url: string,
  method: string,
  params: unknown[] = [],
  opts?: RpcOpts,
): Promise<T> {
  return rpcCall<T>(url, method, params, opts);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The one exchange every node call goes through (webcli rpc_client exchange): the user and poll
 * gate, then attempts classified by rpcRetry, repeated within the retry window only when the
 * method is a read or the request provably never left.
 */
async function exchange(
  url: string,
  method: string,
  body: string,
  opts: RpcOptions,
  timeoutMs: number,
): Promise<{ ex: RpcExchange; step: RpcStep; unsent: boolean; attempts: number }> {
  const write = isWrite(method);
  const lane = opts.lane ?? "user";
  const gated = !opts.once && timeoutMs <= GATE_MAX_REQUEST_S * 1000;
  const start = Date.now();
  const windowEnd = opts.once ? start : start + retryWindowSeconds(timeoutMs / 1000) * 1000;
  const tag = url.startsWith(RPC_PROXY_URL) ? "desktop" : undefined;
  let unsent = true;
  for (let attempt = 1; ; attempt++) {
    if (gated && !(await rpcGate.enter(lane, windowEnd))) {
      const step: RpcStep = { fault: "busy", unsent, status: "busy" };
      return {
        ex: { link: "unopened", status: 0, retryAfter: null },
        step,
        unsent,
        attempts: attempt,
      };
    }
    let ex: RpcExchange;
    try {
      const left = start + timeoutMs - Date.now();
      ex = await postRpc(url, body, Math.max(Math.min(timeoutMs, 1000), left), tag);
    } finally {
      if (gated) rpcGate.leave(lane);
    }
    const step = classify(ex.link, ex.status, ex.data);
    unsent = unsent && step.unsent;
    if (!shouldRepeat(step, write)) return { ex, step, unsent, attempts: attempt };
    const wait = pauseSeconds(attempt, retryAfterHeader(ex.retryAfter), Math.random()) * 1000;
    if (Date.now() + wait >= windowEnd) return { ex, step, unsent, attempts: attempt };
    logger.warn(
      "rpc",
      `rpc_retry method=${method} attempt=${attempt} status=${step.status} wait=${(wait / 1000).toFixed(2)}`,
    );
    await sleep(wait);
  }
}

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  rawOpts?: RpcOpts,
): Promise<T> {
  const opts = optionsOf(rawOpts);
  const start = performance.now();
  const callId = ++rpcId;
  const bodyStr = JSON.stringify({ jsonrpc: "2.0", id: callId, method, params });
  const timeoutMs = opts.timeoutMs ?? getRpcTimeoutMs();

  // Lazy import: a static one is circular.
  let debugLogId = 0;
  const paramsStr = JSON.stringify(params).slice(0, 500);
  try {
    const { logRpc, getNextRpcLogId } = await import("src/shared/dev/debugLogs");
    debugLogId = getNextRpcLogId();
    logRpc({
      timestamp: Date.now(),
      method,
      url,
      status: "pending",
      requestSize: bodyStr.length,
      params: paramsStr,
    });
  } catch {}
  const logFailure = async (error: string, responseSize?: number) => {
    try {
      const { updateRpcLog } = await import("src/shared/dev/debugLogs");
      updateRpcLog(debugLogId, {
        status: "error",
        duration: performance.now() - start,
        responseSize,
        error,
      });
    } catch {}
  };

  const { ex, step, unsent, attempts } = await exchange(url, method, bodyStr, opts, timeoutMs);
  const elapsed = performance.now() - start;
  const nothingSent = isWrite(method) && unsent ? "; nothing was sent" : "";
  if (attempts > 1 && step.fault === "none")
    logger.warn("rpc", `#${callId} ${method} recovered on ${url} (attempt ${attempts})`);

  if (step.fault === "busy" || ex.link !== "answered") {
    const message =
      step.fault === "busy"
        ? faultMessage("busy")
        : ex.link === "expired"
          ? `Network timed out: ${hostOf(url)} did not respond within ${Math.round(timeoutMs / 1000)}s. Check your connection or switch RPC endpoint in Settings.`
          : ex.link === "untrusted"
            ? "node certificate rejected"
            : faultMessage("network");
    if (step.fault !== "busy") markSlow();
    logger.error(
      "rpc",
      `#${callId} ${method} failed on ${url} (${elapsed.toFixed(0)}ms): ${message}`,
    );
    await logFailure(message);
    throw new RpcError(message + nothingSent, { unsent: isWrite(method) && unsent });
  }

  const data = ex.data as RpcResponse<T> | undefined;
  const rpcCode =
    data && typeof data === "object" && data.error && Number.isInteger(data.error.code)
      ? data.error.code
      : undefined;
  if (step.fault !== "none") {
    const message = faultMessage(step.fault) + nothingSent;
    logger.error(
      "rpc",
      `#${callId} ${method} ${step.status} (${elapsed.toFixed(0)}ms): ${message}`,
    );
    await logFailure(message);
    throw new RpcError(message, {
      httpStatus: ex.status,
      code: rpcCode,
      unsent: isWrite(method) && unsent,
    });
  }

  if (ex.status < 200 || ex.status >= 300) {
    logger.error("rpc", `#${callId} ${method} HTTP ${ex.status} (${elapsed.toFixed(0)}ms)`);
    await logFailure(`HTTP ${ex.status}`);
    throw new RpcError(`RPC HTTP error: ${ex.status}`, { httpStatus: ex.status });
  }

  if (!data || typeof data !== "object") {
    logger.error("rpc", `#${callId} ${method} body read failed (${elapsed.toFixed(0)}ms)`);
    await logFailure("Body read failed");
    throw new Error(`RPC body read failed: ${method}`);
  }
  const responseSize = JSON.stringify(data).length;

  if (data.error) {
    const expected = /execution reverted|program view busy/i.test(data.error.message || "");
    (expected ? logger.debug : logger.error)(
      "rpc",
      `#${callId} ${method} error: ${data.error.message} (${elapsed.toFixed(0)}ms) full: ${JSON.stringify(data.error).slice(0, 500)}`,
    );
    await logFailure(data.error.message, responseSize);
    const errMsg = data.error.data
      ? `${data.error.message}: ${data.error.data}`
      : data.error.message;
    throw new RpcError(errMsg, { code: rpcCode });
  }

  recordRpcTiming(url, Math.round(elapsed));
  logger.info("rpc", `#${callId} ${method} OK (${elapsed.toFixed(0)}ms)`);
  const preview = JSON.stringify(data.result).slice(0, 300);
  try {
    const { updateRpcLog } = await import("src/shared/dev/debugLogs");
    updateRpcLog(debugLogId, {
      status: "ok",
      duration: elapsed,
      responseSize,
      responsePreview: preview,
    });
  } catch {}
  return data.result as T;
}

async function getAccountInfo(
  address: string,
  networkId?: string,
  lane?: RpcLane,
): Promise<AccountInfo> {
  return jsonRpcCallOn<AccountInfo>(networkId, "octra_balance", [address], { lane });
}

type DetectedChain = "mainnet" | "devnet" | "unknown";

// Two endpoints on the same chain give the same fingerprint for an address.
async function accountFingerprint(rpcBase: string, address: string): Promise<string | null> {
  try {
    const r = await rpcCall<{
      nonce?: number;
      balance_raw?: string;
      balance?: string;
      has_public_key?: boolean;
    }>(`${rpcBase}/rpc`, "octra_balance", [address], { timeoutMs: 12000 });
    if (!r) return null;
    return `${r.nonce ?? "?"}|${r.balance_raw ?? r.balance ?? "?"}|${r.has_public_key ?? "?"}`;
  } catch {
    return null;
  }
}

// Octra exposes no chain id, so the user's own address is fingerprinted on the endpoint and
// compared to the known chains. An unused address looks the same everywhere: "unknown".
export async function detectChain(rpcBase: string, address: string): Promise<DetectedChain> {
  if (!address) return "unknown";
  const [custom, main, dev] = await Promise.all([
    accountFingerprint(rpcBase, address),
    accountFingerprint(NETWORKS.mainnet.rpcUrl, address),
    accountFingerprint(NETWORKS.devnet.rpcUrl, address),
  ]);
  if (!custom) return "unknown";
  if (/^0\|(0|\?)\|/.test(custom)) return "unknown";
  if (custom === main) return "mainnet";
  if (custom === dev) return "devnet";
  return "unknown";
}

// Mirrors webcli sanitize_display: strips control and homoglyph spoof characters so a hostile
// token name or symbol cannot impersonate another.
export function sanitizeDisplay(s: string, maxLen: number): string {
  return (s || "").replace(/[^a-zA-Z0-9._\- ]/g, "").slice(0, maxLen);
}

export async function getTokensByAddress(
  address: string,
  networkId?: string,
): Promise<
  { contractAddress: string; symbol: string; name: string; decimals: number; balance: string }[]
> {
  try {
    const result = await jsonRpcCallOn<{ tokens?: any[] }>(
      networkId,
      "octra_tokensByAddress",
      [address],
      { lane: "poll" },
    );
    const tokens = result?.tokens;
    if (!Array.isArray(tokens)) return [];
    return tokens.map((t: any) => ({
      contractAddress: t.contract_address || t.contractAddress || t.address || "",
      symbol: sanitizeDisplay(t.symbol || "", 16),
      name: sanitizeDisplay(t.name || t.symbol || "", 32),
      decimals: parseInt(t.decimals || "0") || 0,
      balance: t.balance != null ? String(t.balance) : "0",
    }));
  } catch {
    return [];
  }
}

export async function getBalance(
  address: string,
  networkId?: string,
  lane?: RpcLane,
): Promise<{ balance: number; nonce: number }> {
  logger.info("balance", `getBalance -> ${address.slice(0, 12)}...`);
  let info: AccountInfo;
  try {
    info = await getAccountInfo(address, networkId, lane);
  } catch (e) {
    // "sender not found" (RPC code 100) is a never funded account: a real zero balance and nonce 0,
    // not a failure.
    if (/sender not found/i.test(e instanceof Error ? e.message : String(e))) {
      logger.info("balance", "address has no on-chain state yet -> 0 balance");
      return { balance: 0, nonce: 0 };
    }
    // The scanner answers a never-used address with a policy error: empty only when it has no history.
    if (/scanner policy check unavailable/i.test(e instanceof Error ? e.message : String(e))) {
      const page = await jsonRpcCallOn<{ total?: number }>(
        networkId,
        "octra_transactionsByAddress",
        [address, 1, 0],
        { lane },
      ).catch(() => null);
      if (page?.total === 0) return { balance: 0, nonce: 0 };
    }
    throw e;
  }
  logger.info("balance", `octra_balance response: ${JSON.stringify(info).slice(0, 300)}`);
  // As webcli: balance_raw (micro-OCT), else balance (OCT string).
  let microOCT = 0;
  if (info.balance_raw != null) {
    microOCT =
      typeof info.balance_raw === "number" ? info.balance_raw : parseInt(info.balance_raw) || 0;
  } else if (info.balance != null) {
    const balanceOCT = parseFloat(info.balance) || 0;
    microOCT = Math.round(balanceOCT * 1_000_000);
  }
  logger.info("balance", `parsed: ${microOCT} µOCT (nonce=${info.nonce})`);
  return { balance: microOCT, nonce: info.nonce };
}

function rpcNonce(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid account nonce from the node");
  }
  return value;
}

/**
 * As webcli get_nonce_balance_for: octra_balance's pending_nonce when the node sends it, else the
 * highest of the confirmed nonce and this account's transactions in staging_view.
 */
export async function nonceState(
  address: string,
  networkId?: string,
): Promise<{ confirmed: number; taken: number }> {
  const info = await getAccountInfo(address, networkId);
  const confirmed = rpcNonce(info?.nonce);
  if (info.pending_nonce !== undefined && info.pending_nonce !== null) {
    const pending = rpcNonce(info.pending_nonce);
    if (pending < confirmed) throw new Error("Pending nonce precedes the confirmed nonce");
    return { confirmed, taken: pending };
  }
  const view = await jsonRpcCallOn<{ transactions?: unknown }>(networkId, "staging_view", []);
  if (!view || !Array.isArray(view.transactions)) {
    throw new Error("Cannot read pending transactions");
  }
  let taken = confirmed;
  for (const tx of view.transactions as Array<{ from?: unknown; nonce?: unknown }>) {
    if (!tx || typeof tx !== "object" || typeof tx.from !== "string") {
      throw new Error("Invalid pending transaction");
    }
    if (tx.from === address) taken = Math.max(taken, rpcNonce(tx.nonce));
  }
  return { confirmed, taken };
}

export async function getNonce(address: string, networkId?: string): Promise<number> {
  return (await nonceState(address, networkId)).taken;
}

function submittedRecord(tx: SignedTransaction): HashableTx {
  const payload: HashableTx = {
    from: tx.from,
    to_: tx.to_,
    amount: tx.amount,
    nonce: tx.nonce,
    ou: tx.ou,
    timestamp: tx.timestamp,
    signature: tx.signature,
    public_key: tx.public_key,
  };
  if (tx.op_type) payload.op_type = tx.op_type;
  if (tx.encrypted_data != null) payload.encrypted_data = tx.encrypted_data;
  if (tx.message != null) payload.message = tx.message;
  return payload;
}

/** The hash of the record exactly as submitTransaction posts it; null when it cannot be made. */
export async function localTxHash(tx: SignedTransaction): Promise<string | null> {
  try {
    return await computeTxHash(submittedRecord(tx));
  } catch (e) {
    logger.warn("tx", `local tx hash unavailable: ${e}`);
    return null;
  }
}

export async function submitTransaction(tx: SignedTransaction, scope: TxScope): Promise<string> {
  if (tx.from !== scope.address) {
    const e = new Error("This transaction is not from the active wallet. Nothing was sent.");
    e.name = "ScopeChanged";
    throw e;
  }
  assertScope(scope);
  const payload = submittedRecord(tx);

  const diag = { ...payload };
  if (typeof diag.encrypted_data === "string" && (diag.encrypted_data as string).length > 200) {
    diag.encrypted_data =
      (diag.encrypted_data as string).slice(0, 200) +
      `...(${(diag.encrypted_data as string).length} chars)`;
  }
  logger.info("tx", `submitTransaction payload: ${JSON.stringify(diag)}`);

  const localHash = await localTxHash(tx);

  // HFHE payloads reach about 4 MB (key_switch carries the whole pubkey), past the 30 s read
  // budget, so writes get the tx budget.
  const bodySize = (tx.encrypted_data?.length ?? 0) + (tx.message?.length ?? 0);
  const timeoutMs = bodySize > 256_000 ? getTxTimeoutMs() : undefined;
  for (let attempt = 1; ; attempt++) {
    let result: { hash?: string; tx_hash?: string };
    try {
      result = await jsonRpcCallOn<{ hash?: string; tx_hash?: string }>(
        scope.networkId,
        "octra_submit",
        [payload],
        timeoutMs,
      );
    } catch (err) {
      const kind = submitErrorKind(err);
      if (kind === "resend" && attempt < SUBMIT_ATTEMPTS) {
        logger.warn(
          "tx",
          `submit not accepted (${err}), resending (${attempt}/${SUBMIT_ATTEMPTS})`,
        );
        await sleep(1000 * 2 ** (attempt - 1));
        assertScope(scope);
        continue;
      }
      const failure = submitFailure(err, tx, scope);
      if (err instanceof RpcError && err.unsent) throw err;
      if (!(failure instanceof TxSubmitError) && localHash) {
        logger.warn("tx", `submit outcome unclear (${err}), tracking ${localHash}`);
        throw new UnclearSubmitError(localHash, failure);
      }
      throw failure;
    }
    return trackedHash(result?.hash || result?.tx_hash || "", localHash);
  }
}

const SUBMIT_ATTEMPTS = 3;

/** The local exact hash (webcli formula); the node's only when the local one could not be computed. */
export function trackedHash(node: string, local: string | null): string {
  if (!local) return node;
  if (node && node.toLowerCase() !== local)
    logger.warn("tx", `node tx hash ${node} differs from local ${local}, tracking local`);
  return local;
}

function submitFailure(err: unknown, tx: SignedTransaction, scope: TxScope): unknown {
  const kind = submitErrorKind(err);
  if (!kind) return err;
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn("tx", `submit refused (${kind}): ${detail}`);
  switch (kind) {
    case "nonce_used":
      resetPendingNonce(tx.from, scope.networkId);
      return new TxSubmitError(kind, TX_NONCE_USED);
    case "rejected":
      return new TxSubmitError(kind, detail ? `${TX_REJECTED} (${detail})` : TX_REJECTED);
    case "too_large":
      return new TxSubmitError(kind, TX_TOO_LARGE);
    case "resend":
      return new TxSubmitError("not_accepted", TX_NOT_ACCEPTED);
  }
}

// Locally issued nonces per network and address, so rapid sequential txs do not collide.
const pendingNonces = new Map<string, number>();

export async function getNextNonce(
  address: string,
  networkId: string = currentNetwork,
): Promise<number> {
  const key = scopeKey(address, networkId);
  const { confirmed, taken } = await nonceState(address, networkId);
  const confirmedNext = confirmed + 1;
  const localPrev = pendingNonces.get(key) ?? 0;

  if (taken <= confirmed) {
    pendingNonces.set(key, confirmedNext);
    logger.info(
      "tx",
      `getNextNonce: confirmed=${confirmed}, taken=${taken}, localWas=${localPrev}, reset -> ${confirmedNext}`,
    );
    return confirmedNext;
  }

  const nonce = Math.max(taken + 1, localPrev + 1);
  pendingNonces.set(key, nonce);
  logger.info(
    "tx",
    `getNextNonce: confirmed=${confirmed}, taken=${taken}, local=${localPrev}, using=${nonce}`,
  );
  return nonce;
}

export function resetPendingNonce(address: string, networkId: string = currentNetwork): void {
  pendingNonces.delete(scopeKey(address, networkId));
}

export function releaseNonce(
  address: string,
  nonce: number,
  networkId: string = currentNetwork,
): void {
  const key = scopeKey(address, networkId);
  if (pendingNonces.get(key) === nonce) pendingNonces.set(key, nonce - 1);
}

interface RawTxHistoryItem {
  hash: string;
  from: string;
  to: string;
  amount: string;
  // The node's tx list carries the fee as `ou`, not `fee`.
  ou?: string;
  timestamp: number;
  block_height?: number;
  type?: string;
  status?: string;
  nonce?: number;
  op_type?: string;
  encrypted_data?: string;
  message?: string;
  reason?: string;
  detail?: string;
  error_type?: string;
}

export interface TxHistoryResult {
  transactions: Transaction[];
  hasMore: boolean;
}

const TX_CACHE_PREFIX = "0xio_tx_cache_v3_";
const TX_TOTAL_PREFIX = "0xio_tx_total_v3_";
const MAX_CACHED_TXS = 500;

// The network is a parameter, never read from module state: a fetch can resolve after a switch.
function cacheKey(address: string, net: string = currentNetwork): string {
  return `${TX_CACHE_PREFIX}${address}_${net}`;
}

function totalKey(address: string, net: string = currentNetwork): string {
  return `${TX_TOTAL_PREFIX}${address}_${net}`;
}

function loadCachedTxs(address: string, net?: string): Transaction[] {
  try {
    const raw = localStorage.getItem(cacheKey(address, net));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCachedTxs(address: string, txs: Transaction[], net?: string): void {
  try {
    const trimmed = txs.slice(0, MAX_CACHED_TXS);
    localStorage.setItem(cacheKey(address, net), JSON.stringify(trimmed));
  } catch {}
}

function setCachedTotal(address: string, total: number, net?: string): void {
  try {
    localStorage.setItem(totalKey(address, net), String(total));
  } catch {}
}

function detectTokenTransfer(tx: RawTxHistoryItem): TokenTransfer | undefined {
  if (tx.op_type === "call" && tx.encrypted_data === "transfer" && tx.message) {
    try {
      const parsed = JSON.parse(tx.message);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return {
          recipient: String(parsed[0]),
          raw_amount: String(parsed[1]),
          contract_address: tx.to,
        };
      }
    } catch {}
  }
  return undefined;
}

function mapTxType(
  raw: string,
  opType: string | undefined,
  from: string,
  to: string,
  walletAddr: string,
): Transaction["type"] {
  const opMap: Record<string, Transaction["type"]> = {
    call: "contract_call",
    deploy: "contract_deploy",
    encrypt: "encrypt",
    decrypt: "decrypt",
    claim: "claim",
    private_transfer: "stealth_send",
    key_switch: "key_switch",
  };
  if (opType && opType in opMap) return opMap[opType];

  const map: Record<string, Transaction["type"]> = {
    transfer: "send",
    receive: "receive",
    encrypt: "encrypt",
    decrypt: "decrypt",
    private_transfer: "stealth_send",
    claim: "claim",
  };
  const mapped = map[raw] || "send";
  // Every regular tx is "transfer": the direction comes from the address.
  if (mapped === "send" && to === walletAddr && from !== walletAddr) return "receive";
  return mapped;
}

function mapRawTx(
  tx: RawTxHistoryItem,
  status: Transaction["status"],
  walletAddr = "",
  network?: string,
): Transaction {
  return {
    hash: tx.hash,
    type: mapTxType(tx.type ?? "", tx.op_type, tx.from, tx.to, walletAddr),
    amount: parseInt(tx.amount) || 0,
    fee: parseInt(tx.ou ?? "0") || 0,
    from: tx.from,
    to: tx.to,
    timestamp: tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp,
    status,
    block_height: tx.block_height,
    nonce: tx.nonce,
    op_type: tx.op_type,
    encrypted_data: tx.encrypted_data,
    message: tx.message,
    reject_reason: tx.reason,
    token_transfer: detectTokenTransfer(tx),
    methodName: callMethodName(tx),
    ...(network ? { network } : {}),
    ...(status === "failed" && tx.status ? { chain_status: tx.status } : {}),
    ...(status === "failed" && tx.detail ? { drop_detail: tx.detail } : {}),
  };
}

/**
 * A contract call carries its method name in `encrypted_data` (the params sit in `message`), which
 * saves a `contract_receipt` round trip per row.
 */
function callMethodName(tx: RawTxHistoryItem): string | undefined {
  if (tx.op_type !== "call") return undefined;
  const raw = typeof tx.encrypted_data === "string" ? tx.encrypted_data.trim() : "";
  // Only a bare identifier is a method name.
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw) ? raw : undefined;
}

interface AddressTxs {
  transactions?: RawTxHistoryItem[];
  rejected?: RawTxHistoryItem[];
  dropped?: RawTxHistoryItem[];
  total?: number;
  has_more?: boolean;
}

const addressTxsInFlight = new Map<string, Promise<AddressTxs>>();

function readAddressTxs(address: string, count: number, networkId: string): Promise<AddressTxs> {
  const key = `${scopeKey(address, networkId)}:${count}`;
  const inFlight = addressTxsInFlight.get(key);
  if (inFlight) return inFlight;
  const read = jsonRpcCallOn<AddressTxs>(
    networkId,
    "octra_transactionsByAddress",
    [address, count, 0],
    { lane: "poll" },
  ).finally(() => {
    if (addressTxsInFlight.get(key) === read) addressTxsInFlight.delete(key);
  });
  addressTxsInFlight.set(key, read);
  return read;
}

export async function getTransactionHistory(
  address: string,
  limit = 20,
  offset = 0,
  networkId: string = currentNetwork,
): Promise<TxHistoryResult> {
  // A recent window straight from the node, merged into the cache by hash: the node's `total` can
  // be stale, so a delta on it can miss new txs.
  const RECENT_WINDOW = 25;
  const net = networkId;
  let cached = loadCachedTxs(address, net);
  try {
    const fetchN = Math.max(limit + offset, RECENT_WINDOW);
    const result = await readAddressTxs(address, fetchN, net);

    const raw = result?.transactions || [];
    const rejectedRaw: RawTxHistoryItem[] = [
      ...(result?.rejected || []).map((r) => ({
        ...r,
        status: r.status || "rejected",
        op_type: r.op_type || (r.error_type === "contract_call_failed" ? "call" : undefined),
      })),
      ...(result?.dropped || []).map((r) => ({ ...r, status: r.status || "dropped" })),
    ];

    if (raw.length > 0) {
      const byHash = new Map(cached.map((tx) => [tx.hash, tx]));
      for (const r of raw) byHash.set(r.hash, mapRawTx(r, "confirmed", address, net));
      cached = [...byHash.values()].sort((a, b) => b.timestamp - a.timestamp);
      saveCachedTxs(address, cached, net);
      setCachedTotal(address, result?.total ?? cached.length, net);
    }

    const paged = cached.slice(offset, offset + limit).map((tx) => ({ ...tx, network: net }));
    // The node can list one failed tx several times.
    const listed = new Set(paged.map((tx) => tx.hash));
    const rejected = rejectedRaw
      .filter((tx) => !listed.has(tx.hash) && !!listed.add(tx.hash))
      .map((tx) => mapRawTx(tx, "failed", address, net));
    // Rejected txs show on the first page only, merged into the timeline by timestamp.
    const transactions =
      offset === 0 ? [...paged, ...rejected].sort((a, b) => b.timestamp - a.timestamp) : paged;
    const hasMore = (result?.has_more ?? false) || cached.length > offset + limit;
    return { transactions, hasMore };
  } catch {
    // Served from the cache when the node does not answer.
    const paged = cached.slice(offset, offset + limit).map((tx) => ({ ...tx, network: net }));
    return { transactions: paged, hasMore: cached.length > offset + limit };
  }
}

export async function getTransactionDetails(
  hash: string,
  networkId?: string,
): Promise<TransactionDetail | null> {
  try {
    const t = await jsonRpcCallOn<Record<string, unknown>>(networkId, "octra_transaction", [hash]);
    if (!t) return null;
    const err = t.error as Record<string, unknown> | undefined;
    return {
      hash: (t.tx_hash as string) || hash,
      from: (t.from as string) || "",
      to: (t.to as string) || (t.to_ as string) || "",
      amount_raw: (t.amount_raw as string) || (t.amount as string) || "0",
      op_type: (t.op_type as string) || "standard",
      status: (t.status as string) || "pending",
      timestamp: (t.timestamp as number) || 0,
      nonce: (t.nonce as number) || 0,
      epoch: (t.epoch as number) || (t.epoch_id as number) || undefined,
      block_height: (t.block_height as number) || undefined,
      ou: (t.ou as string) || undefined,
      signature: (t.signature as string) || undefined,
      public_key: (t.public_key as string) || undefined,
      message: typeof t.message === "string" && t.message !== "" ? t.message : undefined,
      encrypted_data:
        typeof t.encrypted_data === "string" && t.encrypted_data !== ""
          ? t.encrypted_data
          : undefined,
      reject_reason: err?.reason ? String(err.reason) : undefined,
      reject_type: err?.type ? String(err.type) : undefined,
    };
  } catch {
    return null;
  }
}

export async function getContractStorage(
  contractAddress: string,
  key: string,
  networkId?: string,
): Promise<string | null> {
  try {
    const result = await jsonRpcCallOn<{ value?: unknown }>(networkId, "octra_contractStorage", [
      contractAddress,
      key,
    ]);
    return result?.value != null ? String(result.value) : null;
  } catch {
    return null;
  }
}

const getEncryptedBalanceInFlight = new Map<string, Promise<string | null>>();

export async function getEncryptedBalance(
  address: string,
  walletId: string,
  networkId: string = currentNetwork,
): Promise<string | null> {
  const dedupKey = `${scopeKey(address, networkId)}_${walletId}`;
  const inFlight = getEncryptedBalanceInFlight.get(dedupKey);
  if (inFlight) {
    logger.debug("rpc", `getEncryptedBalance deduplicated for ${address.slice(0, 8)}...`);
    return inFlight;
  }

  const promise = _getEncryptedBalanceInternal(address, walletId, networkId);
  getEncryptedBalanceInFlight.set(dedupKey, promise);
  try {
    return await promise;
  } finally {
    if (getEncryptedBalanceInFlight.get(dedupKey) === promise) {
      getEncryptedBalanceInFlight.delete(dedupKey);
    }
  }
}

async function _getEncryptedBalanceInternal(
  address: string,
  walletId: string,
  networkId: string,
): Promise<string | null> {
  const authMessage = `octra_encryptedBalance|${address}`;
  const [signature, publicKey] = await Promise.all([
    walletBridge.signMessage(walletId, authMessage),
    walletBridge.getPublicKey(walletId),
  ]);

  const result = await jsonRpcCallOn<{
    cipher?: string;
    encrypted_balance?: string;
    has_pvac_pubkey?: boolean;
  }>(networkId, "octra_encryptedBalance", [address, signature, publicKey]);
  // Null only for a real 0; a thrown error must propagate.
  return result?.cipher || result?.encrypted_balance || null;
}

export interface FeeRecommendation {
  minimum: string;
  recommended: string;
  fast?: string;
}

export type FeeOpType =
  | "standard"
  | "encrypt"
  | "decrypt"
  | "stealth"
  | "claim"
  | "deploy"
  | "program_deploy"
  | "call"
  | "key_switch"
  | "deploy_circle"
  | "circle_asset_put"
  | "circle_asset_put_encrypted";

export interface FeeHint {
  encrypted_data_len: number;
}

export class FeeUnavailableError extends Error {
  constructor() {
    super(FEE_UNAVAILABLE);
    this.name = "FeeUnavailable";
  }
}

function parseFee(op: FeeOpType, result: unknown): FeeRecommendation | null {
  return flooredFeeQuote(op, result);
}

export async function getRecommendedFeeStrict(
  opType: FeeOpType,
  networkId: string,
  hint?: FeeHint,
): Promise<FeeRecommendation | null> {
  try {
    const params: unknown[] = hint ? [opType, hint] : [opType];
    return parseFee(
      opType,
      await jsonRpcCallOn<unknown>(networkId, "octra_recommendedFee", params),
    );
  } catch (e) {
    logger.warn("fee", `${opType} fee read failed on ${networkId}: ${e}`);
    return null;
  }
}

export async function liveRecommendedOu(
  opType: FeeOpType,
  networkId: string,
  hint?: FeeHint,
): Promise<string> {
  const fee = await getRecommendedFeeStrict(opType, networkId, hint);
  if (!fee) throw new FeeUnavailableError();
  return fee.recommended;
}

export async function liveMinimumOu(
  opType: FeeOpType,
  networkId: string,
  hint?: FeeHint,
): Promise<string> {
  const fee = await getRecommendedFeeStrict(opType, networkId, hint);
  if (!fee) throw new FeeUnavailableError();
  return fee.minimum;
}

const PVAC_PUBKEY_TTL_MS = 30_000;
const pvacPubkeyInFlight = new Map<string, Promise<string | null>>();
let pvacPubkeyCached: { key: string; pubkey: string | null; at: number } | null = null;
let pvacPubkeyGeneration = 0;

export function clearPvacPubkeyCache(): void {
  pvacPubkeyGeneration++;
  pvacPubkeyCached = null;
  pvacPubkeyInFlight.clear();
}

async function readPvacPubkey(address: string, networkId: string): Promise<string | null> {
  // Only a missing pvac_pubkey is null. A transport or RPC failure propagates, so an unreachable
  // node is never read as an unregistered key that would then be registered again.
  const generation = pvacPubkeyGeneration;
  const result = await jsonRpcCallOn<{ pvac_pubkey?: string }>(networkId, "octra_pvacPubkey", [
    address,
  ]);
  const pubkey = result?.pvac_pubkey || null;
  if (generation === pvacPubkeyGeneration)
    pvacPubkeyCached = { key: scopeKey(address, networkId), pubkey, at: Date.now() };
  return pubkey;
}

export function getPvacPubkey(
  address: string,
  networkId: string = currentNetwork,
  opts: { fresh?: boolean } = {},
): Promise<string | null> {
  if (opts.fresh) return readPvacPubkey(address, networkId);
  const key = scopeKey(address, networkId);
  if (pvacPubkeyCached?.key === key && Date.now() - pvacPubkeyCached.at < PVAC_PUBKEY_TTL_MS)
    return Promise.resolve(pvacPubkeyCached.pubkey);
  const inFlight = pvacPubkeyInFlight.get(key);
  if (inFlight) return inFlight;
  const read = readPvacPubkey(address, networkId).finally(() => {
    if (pvacPubkeyInFlight.get(key) === read) pvacPubkeyInFlight.delete(key);
  });
  pvacPubkeyInFlight.set(key, read);
  return read;
}

interface PvacLegacyReplay {
  total?: number;
  scanned?: number;
  complete?: boolean;
  audit_class?: string;
  can_public_migrate?: boolean;
  public_net?: string | number | null;
  public_net_raw?: string | null;
  commitment_net?: string | null;
  blockers?: string[];
  reason?: string;
}

interface PvacMigrationStatus {
  cipher_class?: string;
  key_class?: string;
  can_key_switch?: boolean;
  can_v3_migrate?: boolean;
  needs_legacy_public_replay?: boolean;
  reason?: string;
  legacy_public_replay?: PvacLegacyReplay;
  cipher_format?: string;
  cipher_proof_rule?: string;
  can_cipher_proof_migrate?: boolean;
}

const migrationStatusUnsupported = new Set<string>();

export function isMigrationStatusUnsupported(networkId: string = currentNetwork): boolean {
  return migrationStatusUnsupported.has(networkId);
}

const migrationStatusInFlight = new Map<string, Promise<PvacMigrationStatus | null>>();

export function getPvacMigrationStatus(
  address: string,
  networkId: string = currentNetwork,
): Promise<PvacMigrationStatus | null> {
  const key = scopeKey(address, networkId);
  const inFlight = migrationStatusInFlight.get(key);
  if (inFlight) return inFlight;
  const read = readPvacMigrationStatus(address, networkId).finally(() => {
    if (migrationStatusInFlight.get(key) === read) migrationStatusInFlight.delete(key);
  });
  migrationStatusInFlight.set(key, read);
  return read;
}

async function readPvacMigrationStatus(
  address: string,
  net: string,
): Promise<PvacMigrationStatus | null> {
  if (migrationStatusUnsupported.has(net)) return null;
  try {
    return await jsonRpcCallOn<PvacMigrationStatus>(net, "octra_pvacMigrationStatus", [address]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/method not found/i.test(message)) {
      migrationStatusUnsupported.add(net);
      logger.debug("rpc", `pvacMigrationStatus unsupported on ${net} - not asking again`);
      return null;
    }
    logger.warn("rpc", `pvacMigrationStatus failed: ${e}`);
    return null;
  }
}

export async function getViewPubkey(address: string, networkId?: string): Promise<string | null> {
  try {
    const result = await jsonRpcCallOn<{ view_pubkey?: string }>(networkId, "octra_viewPubkey", [
      address,
    ]);
    return result?.view_pubkey || null;
  } catch {
    return null;
  }
}

const STEALTH_PAGE_LIMIT = 256;
const stealthPageLimits = new Map<string, number>();

type StealthOutput = {
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
  claimed: number;
  epoch_id: number;
  // Stealth outputs hide the sender: octra_stealthOutputsPage does not return it.
  sender_addr?: string;
};

export async function getStealthOutputs(
  fromEpoch: number = 0,
  networkId: string = currentNetwork,
): Promise<StealthOutput[]> {
  return (await scanStealthOutputs(fromEpoch, networkId)).outputs;
}

/** `complete` is false when a page failed and the list stops short. */
export async function scanStealthOutputs(
  fromEpoch: number = 0,
  networkId: string = currentNetwork,
): Promise<{ outputs: StealthOutput[]; complete: boolean }> {
  // Pages via octra_stealthOutputsPage (webcli fetch_stealth_outputs); the page size shrinks on -32013.
  type Output = StealthOutput;
  const all: Output[] = [];
  const MAX_PAGES = 4096;
  const overallStart = performance.now();
  let before = 9_000_000_000_000; // above any current id: the newest page
  const url = rpcUrlFor(networkId);
  let limit = stealthPageLimits.get(url) ?? STEALTH_PAGE_LIMIT;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const r = await rpcCall<{
        outputs?: Output[];
        has_more?: boolean;
        next_before_id?: number | null;
      }>(url, "octra_stealthOutputsPage", [fromEpoch, before, limit], {
        timeoutMs: 60_000,
        lane: "poll",
      });
      const outputs: Output[] = Array.isArray(r?.outputs) ? r.outputs : [];
      all.push(...outputs);
      if (!r?.has_more) {
        logger.info(
          "rpc",
          `octra_stealthOutputsPage: ${all.length} output(s), ${page + 1} page(s), ${(performance.now() - overallStart).toFixed(0)}ms`,
        );
        return { outputs: all, complete: true };
      }
      if (r.next_before_id == null) return { outputs: all, complete: false };
      before = r.next_before_id;
    } catch (err) {
      // Still over the byte limit: halve the page and retry the same cursor.
      if (err instanceof RpcError && err.code === -32013 && limit > 4) {
        limit = Math.max(4, Math.floor(limit / 2));
        stealthPageLimits.set(url, limit);
        page--;
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("rpc", `octra_stealthOutputsPage failed: ${msg}`);
      return { outputs: all, complete: false };
    }
  }
  logger.warn(
    "rpc",
    `octra_stealthOutputsPage: hit page cap (${MAX_PAGES}), returning ${all.length}`,
  );
  return { outputs: all, complete: false };
}

export interface StagingTransaction {
  hash: string;
  from: string;
  to: string;
  amount: string;
  amount_raw?: string;
  nonce: number;
  op_type?: string;
  timestamp?: number;
}

export async function getStagingView(networkId?: string): Promise<StagingTransaction[]> {
  try {
    const result = await jsonRpcCallOn<{ transactions?: StagingTransaction[] }>(
      networkId,
      "staging_view",
      [],
      { lane: "poll" },
    );
    // staging_view gives `amount` in OCT and micro-OCT in `amount_raw`, whereas
    // octra_transactionsByAddress puts micro-OCT in `amount`: normalized to micro-OCT.
    return (result?.transactions || []).map((t) => ({
      ...t,
      amount: t.amount_raw ?? t.amount,
    }));
  } catch {
    return [];
  }
}
