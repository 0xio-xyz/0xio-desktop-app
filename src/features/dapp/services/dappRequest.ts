import { holdBackgroundReads } from "src/services/app/backgroundReads";
import * as networkService from "src/services/network/networkService";
import * as contractService from "src/services/contracts/contractService";
import * as dappService from "src/features/dapp/services/dappService";
import {
  WATCH_ONLY_ERROR,
  GONE_ERROR,
  canSignWallet,
  type SiteWalletInfo,
} from "src/features/dapp/services/dappService";
import { publishDappEvent, type DappEventType } from "src/features/dapp/services/dappEvents";
import type { DappSite, UsableWallet } from "src/features/dapp/services/siteModel";
import * as privacyService from "src/features/privacy/services/privacyService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { walletBridge } from "src/services/wallet/walletBridge";
import {
  buildTransferTx,
  buildSignaturePayload,
  canonicalTx,
  broadcastSignedTx,
} from "src/services/network/transactionBuilder";
import { NETWORKS } from "src/services/network/config";
import type { SignedTransaction } from "src/types/transaction";
import { logger } from "src/lib/logger";
import { frameSignedMessage } from "src/services/crypto/signedMessage";
import { txTimestamp } from "src/services/network/txTimestamp";
import {
  deployFee,
  deployReviewError,
  parseDeployRequest,
  type DeployReview,
} from "src/features/dapp/services/deployRequest";
import { parseBaseUnits, rawOctLabel, siteFeeOu } from "src/features/dapp/services/siteAmounts";
import { grantedScopes } from "src/features/dapp/services/siteScopes";
import { UnclearSubmitError } from "src/services/network/submitErrors";
import { claimErrorCode, claimSlot } from "src/features/privacy/services/claimLedger";

export interface SdkRequest {
  id: string;
  method: string;
  params: any;
  timestamp: number;
  rid?: string;
}

export interface SdkResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any };
  timestamp: number;
  rid?: string;
  status?: string;
}

export type ApprovalType = "connect" | "transaction" | "sign" | "network" | "deploy";

export interface PendingApproval {
  type: ApprovalType;
  origin: string;
  request: SdkRequest;
  networkId: string;
  signer?: SiteWalletInfo;
  connect?: { open: SiteWalletInfo; choices: SiteWalletInfo[]; permissions: string[] };
  deploy?: DeployReview;
  details?: {
    to: string;
    amount: string;
    method?: string;
    message?: string;
    contract?: string;
    args?: string;
    steps?: SequenceStep[];
    networkMismatch?: string;
    ou?: string;
    fromName?: string;
    toName?: string;
    claims?: ClaimSummary;
  };
}

interface SequenceStep {
  contract: string;
  method: string;
  args: string;
  amount: string;
}

/** A longer text is refused, never cut. */
const MAX_REVIEW_TEXT = 4000;
const TOO_LONG = `Message is too long to review. The limit is ${MAX_REVIEW_TEXT} characters.`;

interface ClaimSummary {
  count: number;
  totalRaw: string;
  remaining: number;
  outputs?: { id: number; amountRaw: string }[];
}

const MAX_SITE_CLAIMS = 25;
const CLAIM_LIST_MAX = 5;

function claimSummary<T extends { id: number; amount: number }>(
  outputs: T[],
  cap: number,
): { selected: T[]; summary: ClaimSummary } {
  const selected = outputs.slice(0, Math.max(1, Math.min(cap, MAX_SITE_CLAIMS)));
  const total = selected.reduce((sum, o) => sum + o.amount, 0);
  return {
    selected,
    summary: {
      count: selected.length,
      totalRaw: String(total),
      remaining: outputs.length - selected.length,
      outputs:
        selected.length <= CLAIM_LIST_MAX
          ? selected.map((o) => ({ id: o.id, amountRaw: String(o.amount) }))
          : undefined,
    },
  };
}

async function siteFee(
  op: networkService.FeeOpType,
  networkId: string,
  asked: unknown,
): Promise<string> {
  const ou = siteFeeOu(asked, await networkService.getRecommendedFeeStrict(op, networkId));
  if (!ou) throw new networkService.FeeUnavailableError();
  return ou;
}

/** Answered without unlocking 0xio: they tell nothing about an account. */
const PRE_CONNECT = new Set([
  "ping",
  "register_dapp",
  "declareIntegration",
  "getConnectionStatus",
  "get_network_info",
  "getNetworkInfo",
  "get_private_capabilities",
  "contract_call_view",
  "contractCallView",
  "get_contract_storage",
  "getContractStorage",
  "rpc_call",
]);

const BAD_AMOUNT = "Amount must be whole micro-OCT (a non-negative integer).";
const BAD_ARGS = "Contract params must be an array.";
const ONLY_STANDARD =
  'Sites can sign standard transfers only: op_type "standard" and no encrypted_data.';

function reviewTextError(text: unknown): string | null {
  if (text == null || text === "") return null;
  if (typeof text !== "string") return "Message must be text";
  return text.length > MAX_REVIEW_TEXT ? TOO_LONG : null;
}

export interface SiteBook {
  migrateLegacy(open: { id: string; address: string } | null): void;
  resolveSite(
    networkId: string,
    origin: string,
    open: string | null,
    usable: UsableWallet,
  ): { site: DappSite | null; address: string | null };
  connectWallet(
    networkId: string,
    origin: string,
    wallet: SiteWalletInfo,
    open: string | null,
    opts: { permissions?: string[] },
  ): void;
  disconnectSite(networkId: string, origin: string, reason?: string): void;
  carrySite(fromNetwork: string, toNetwork: string, origin: string): void;
  getSite(networkId: string, origin: string): DappSite | null;
  siteScopeCurrent(scope: networkService.TxScope): boolean;
  scopeFor(address: string, origin: string, networkId: string): networkService.TxScope;
  publish(type: DappEventType, data: unknown, origin: string): void;
}

const walletSites: SiteBook = {
  migrateLegacy: (open) => void dappService.migrateLegacy(open),
  resolveSite: dappService.resolveSite,
  connectWallet: (n, o, w, open, opts) => void dappService.connectWallet(n, o, w, open, opts),
  disconnectSite: dappService.disconnectSite,
  carrySite: dappService.carrySite,
  getSite: dappService.getSite,
  siteScopeCurrent: dappService.siteScopeCurrent,
  scopeFor: (address, origin) => networkService.captureSiteScope(address, origin),
  publish: (type, data, origin) => publishDappEvent(type, data, [origin]),
};

export interface ApprovalAnswer {
  approved: boolean;
  selectedAddress?: string;
}

export interface DappRequestDeps {
  getOpenWallet(): SiteWalletInfo | null;
  getWallets(): SiteWalletInfo[];
  getNetworkId(): string;
  isLocked(): boolean;
  waitForUnlock(): Promise<boolean>;
  requestApproval(approval: Omit<PendingApproval, "networkId">): Promise<ApprovalAnswer>;
  requestAuth(title: string): Promise<boolean>;
  setNetworkId(id: string): void;
  sites?: SiteBook;
}

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * networkService.getBalance gives micro-OCT; the SDK's Balance expects OCT, as the extension
 * reports it.
 */
const microToOct = (micro: number): number => Number((micro / 1_000_000).toFixed(6));

// rpc_call is a passthrough to the node RPC: read-only public methods only.
const RPC_CALL_ALLOWED_METHODS = new Set<string>([
  "octra_balance",
  "octra_account",
  "octra_transaction",
  "octra_transactionsByAddress",
  "octra_transactionsByEpoch",
  "octra_recentTransactions",
  "octra_supply",
  "octra_recommendedFee",
  "octra_tokensByAddress",
  "octra_contractAbi",
  "octra_computeContractAddress",
  "octra_stealthOutputs",
  "contract_call",
  "contract_receipt",
  "staging_view",
]);

// Scope each sign_transaction signature was made for, so broadcast_only can refuse it elsewhere.
const signedTxScopes = new Map<string, networkService.TxScope>();
function rememberSignedScope(signature: string, scope: networkService.TxScope): void {
  signedTxScopes.set(signature, scope);
  if (signedTxScopes.size > 64) {
    const oldest = signedTxScopes.keys().next().value;
    if (oldest !== undefined) signedTxScopes.delete(oldest);
  }
}

const KEY_MISMATCH = "Another private key is registered for this account. Update it in 0xio first.";

const NETWORK_MOVED =
  "0xio switched wallet or network while this request was open. Nothing was signed.";

export async function walletPayload(
  wallet: SiteWalletInfo,
): Promise<{ address: string; publicKey: string | null; canSign: boolean }> {
  let publicKey: string | null = null;
  if (canSignWallet(wallet)) {
    try {
      publicKey = await walletBridge.getPublicKey(wallet.id);
    } catch {}
  }
  return { address: wallet.address, publicKey, canSign: canSignWallet(wallet) };
}

const BALANCE_TAIL_MS = 60_000;

/** Tells only the site that asked, while it is still connected on that network and wallet. */
export async function watchTxConfirmation(
  hash: string,
  origin: string,
  signer: { address: string; networkId: string },
  meta: Record<string, unknown> = {},
  opts: { intervalMs?: number; timeoutMs?: number } = {},
  book: SiteBook = walletSites,
): Promise<void> {
  if (!hash) return;
  const release = holdBackgroundReads();
  try {
    const interval = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const detail = await networkService
        .getTransactionDetails(hash, signer.networkId)
        .catch(() => null);
      const status = detail?.status;
      if (!status || status === "pending") continue;
      const site = book.getSite(signer.networkId, origin);
      if (!site || site.inUse !== signer.address) return;
      book.publish(
        "transactionConfirmed",
        {
          txHash: hash,
          hash,
          status,
          confirmed: status === "confirmed",
          from: detail?.from,
          to: detail?.to,
          amount: detail?.amount_raw,
          epoch: detail?.epoch,
          rejectReason: detail?.reject_reason,
          ...meta,
        },
        origin,
      );
      return;
    }
  } finally {
    setTimeout(release, BALANCE_TAIL_MS);
  }
}

const isScopeError = (err: unknown) => err instanceof Error && err.name === "ScopeChanged";

export function createDappRequestHandler(deps: DappRequestDeps) {
  const book = deps.sites ?? walletSites;
  return async function handleRequest(req: SdkRequest, origin: string): Promise<SdkResponse> {
    const ok = (data: any): SdkResponse => ({
      id: req.id,
      success: true,
      data,
      timestamp: Date.now(),
    });
    const fail = (
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ): SdkResponse => ({
      id: req.id,
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      timestamp: Date.now(),
    });
    const refuse = (e: { code: string; message: string }) => fail(e.code, e.message);
    const rawInt = (v: unknown): number => (typeof v === "string" ? parseInt(v, 10) : Number(v));

    try {
      const locked = deps.isLocked();
      const unknownSite = !book.getSite(deps.getNetworkId(), origin);
      if (locked && unknownSite && !PRE_CONNECT.has(req.method) && req.method !== "connect") {
        // A site that is not connected never learns the lock: no wait, no prompt.
        if (req.method === "disconnect") return ok({ disconnected: true });
        return fail("NOT_CONNECTED", "DApp not connected");
      }
      if (locked && !PRE_CONNECT.has(req.method)) {
        const unlocked = await deps.waitForUnlock();
        if (!unlocked) return fail("WALLET_LOCKED", "Wallet is locked");
      }

      const networkId = deps.getNetworkId();
      const open = deps.getOpenWallet();
      const wallets = deps.getWallets();
      const byAddress = (a: string | null | undefined) =>
        a ? (wallets.find((w) => w.address === a) ?? null) : null;
      const usable = (a: string) => wallets.some((w) => w.address === a);
      if (open) book.migrateLegacy(open);
      const resolved = book.resolveSite(networkId, origin, open?.address ?? null, usable);
      const site = resolved.site;
      const siteWallet = byAddress(resolved.address);
      const netConfig = NETWORKS[networkId] || NETWORKS.mainnet;
      const networkInfo = { ...netConfig, isTestnet: networkId !== "mainnet" };

      const requireSite = (): SiteWalletInfo => {
        if (!site) throw new BridgeError("NOT_CONNECTED", "DApp not connected");
        if (!open) throw new BridgeError("WALLET_LOCKED", "No active wallet");
        if (!siteWallet) throw new BridgeError(GONE_ERROR.code, GONE_ERROR.message);
        return siteWallet;
      };
      const requireSigner = (): SiteWalletInfo => {
        const w = requireSite();
        if (!canSignWallet(w))
          throw new BridgeError(WATCH_ONLY_ERROR.code, WATCH_ONLY_ERROR.message);
        return w;
      };
      /** Private requests run on the open wallet only, and only for a site that uses it. */
      const requirePrivate = (): SiteWalletInfo => {
        const w = requireSigner();
        if (w.address !== open?.address) {
          throw new BridgeError(
            "WALLET_CHANGED",
            "This site is on another wallet. Open that wallet in 0xio, then send the request again.",
          );
        }
        if (networkId !== networkService.getNetwork()) {
          throw new BridgeError(
            "NOT_AVAILABLE",
            `Private requests run on the network 0xio is on. Switch 0xio to ${netConfig.name}, then send the request again.`,
          );
        }
        return w;
      };
      const requirePermission = (...any: string[]) => {
        const granted = site?.permissions ?? [];
        if (!any.some((p) => granted.includes(p))) {
          throw new BridgeError("PERMISSION_DENIED", `${any.join(" or ")} permission required`);
        }
      };
      const ensurePvac = async (w: SiteWalletInfo) => {
        if (!pvacBridge.isInitializedFor(w.address)) await privacyService.initPvac(w.id, w.address);
      };
      const siteScope = (w: SiteWalletInfo) => book.scopeFor(w.address, origin, networkId);
      const stillCurrent = (scope: networkService.TxScope) => networkService.isScopeCurrent(scope);
      const balanceOf = async (w: SiteWalletInfo) => {
        const b = await networkService.getBalance(w.address, networkId);
        return {
          public: microToOct(b.balance),
          private: 0,
          total: microToOct(b.balance),
          currency: "OCT",
        };
      };
      const connectPayload = async (w: SiteWalletInfo, permissions: string[]) => {
        const who = await walletPayload(w);
        let balance = { public: 0, private: 0, total: 0, currency: "OCT" };
        try {
          balance = await balanceOf(w);
        } catch {}
        return {
          address: who.address,
          // Both spellings, like the extension: the SDK reads `publicKey`.
          publicKey: who.publicKey,
          public_key: who.publicKey,
          canSign: who.canSign,
          networkId,
          balance,
          networkInfo,
          permissions,
          wallet: "0xio-desktop",
          version: "0.2.3",
        };
      };

      switch (req.method) {
        case "ping":
          // Availability only; whether a wallet is unlocked is told to connected sites alone.
          return ok({ pong: true, available: true, hasActiveWallet: !!site && !!open });

        case "register_dapp":
        case "declareIntegration":
          return ok({ registered: true });

        case "connect": {
          if (!open) return fail("WALLET_LOCKED", "No active wallet");
          // A site already connected stays on its own wallet, whichever one is open.
          if (site && siteWallet) return ok(await connectPayload(siteWallet, site.permissions));

          const granted = grantedScopes(req.params);
          const answer = await deps.requestApproval({
            type: "connect",
            origin,
            request: req,
            signer: open,
            connect: {
              open,
              choices: wallets.filter((w) => canSignWallet(w)),
              permissions: granted,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the connection.");
          const pick = byAddress(answer.selectedAddress ?? open.address);
          if (!pick) return fail("INVALID_PARAMS", "Unknown wallet picked.");
          // The open wallet may connect as it is (the site hears canSign: false); a wallet
          // picked instead of it must be one that signs.
          if (pick.address !== open.address && !canSignWallet(pick))
            return refuse(WATCH_ONLY_ERROR);
          if (deps.getNetworkId() !== networkId) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          book.connectWallet(networkId, origin, pick, deps.getOpenWallet()?.address ?? null, {
            permissions: granted,
          });
          return ok(await connectPayload(pick, granted));
        }

        case "disconnect":
          if (origin !== "unknown") book.disconnectSite(networkId, origin, "dapp");
          return ok({ disconnected: true });

        case "getConnectionStatus": {
          const known = locked ? book.resolveSite(networkId, origin, null, () => true) : null;
          if (known?.site && known.address) {
            // Locked: the record alone says whether the site is connected; nothing is read.
            return ok({
              connected: !!known.site && !!known.address,
              isConnected: !!known.site && !!known.address,
              address: known.site ? known.address : null,
              publicKey: null,
              public_key: null,
              networkId,
              networkInfo,
              balance: null,
              permissions: known.site?.permissions ?? [],
              locked: true,
            });
          }
          const connected = !locked && !!open && !!site && !!siteWallet;
          if (!connected) {
            return ok({
              connected: false,
              isConnected: false,
              networkId,
              networkInfo,
              permissions: [],
            });
          }
          const who = await walletPayload(siteWallet!);
          let balance: Awaited<ReturnType<typeof balanceOf>> | null = null;
          try {
            balance = await balanceOf(siteWallet!);
          } catch {}
          return ok({
            connected: true,
            isConnected: true,
            address: who.address,
            publicKey: who.publicKey,
            public_key: who.publicKey,
            canSign: who.canSign,
            networkId,
            networkInfo,
            balance,
            permissions: site!.permissions,
          });
        }

        case "getAddress":
          return ok({ address: requireSite().address });

        case "getBalance":
        case "get_balance": {
          const w = requireSite();
          const bal = await networkService.getBalance(w.address, networkId);
          return ok({
            balance: String(microToOct(bal.balance)),
            nonce: bal.nonce,
            privateBalance: "0",
          });
        }

        case "get_network_info":
        case "getNetworkInfo":
          return ok(networkInfo);

        case "getWalletInfo": {
          const w = requireSite();
          const bal = await networkService.getBalance(w.address, networkId);
          return ok({
            address: w.address,
            canSign: canSignWallet(w),
            balance: microToOct(bal.balance),
          });
        }

        case "getPublicKey": {
          const w = requireSite();
          if (!canSignWallet(w)) return refuse(WATCH_ONLY_ERROR);
          return ok({ publicKey: await walletBridge.getPublicKey(w.id) });
        }

        case "get_transaction_history": {
          const w = requireSite();
          const { page = 1, limit = 20 } = req.params || {};
          return ok(
            await networkService.getTransactionHistory(
              w.address,
              limit,
              (page - 1) * limit,
              networkId,
            ),
          );
        }

        case "getTransactionHistory": {
          // The extension's spelling and shape: a page of the site wallet's transactions.
          const page = Number(req.params?.page) || 1;
          const limit = Number(req.params?.limit) || 20;
          if (!site || !siteWallet)
            return ok({ transactions: [], totalCount: 0, page, hasMore: false });
          const txs = await networkService
            .getTransactionHistory(siteWallet.address, limit, (page - 1) * limit, networkId)
            .catch(() => []);
          const list = Array.isArray(txs) ? txs : [];
          return ok({
            transactions: list,
            totalCount: list.length,
            page,
            hasMore: list.length >= limit,
          });
        }

        case "signMessage": {
          const w = requireSigner();
          const raw = req.params?.message ?? req.params?.data;
          if (!raw) return fail("INVALID_PARAMS", "Message content is required");
          if (typeof raw !== "string") return fail("INVALID_PARAMS", "Message must be text");
          if (raw.length > MAX_REVIEW_TEXT) return fail("INVALID_PARAMS", TOO_LONG);
          const scope = siteScope(w);
          const answer = await deps.requestApproval({
            type: "sign",
            origin,
            request: req,
            signer: w,
            details: { to: w.address, amount: "0", message: raw },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected message signing.");
          // A signature is not tied to a network: only the wallet behind it is re-checked.
          if (!book.siteScopeCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            // The 0xio Signed Message frame: the same bytes the extension, app and SDK verify.
            const signature = await walletBridge.signMessage(w.id, frameSignedMessage(raw));
            return ok({ signature, address: w.address });
          } catch (err: any) {
            return fail("SIGNATURE_FAILED", err?.message || "Failed to sign message");
          }
        }

        case "send_transaction":
        case "sendTransaction": {
          const w = requireSigner();
          const { to, amount, message } = req.params || {};
          if (!to) return fail("INVALID_PARAMS", "Missing 'to' address");
          const memoError = reviewTextError(message);
          if (memoError) return fail("INVALID_PARAMS", memoError);
          const raw = parseBaseUnits(amount);
          if (raw == null || raw > BigInt(Number.MAX_SAFE_INTEGER))
            return fail("INVALID_PARAMS", BAD_AMOUNT);
          const amountMicro = Number(raw);
          const scope = siteScope(w);
          let sendOu: string;
          try {
            sendOu = await siteFee("standard", scope.networkId, req.params?.ou);
          } catch (err: any) {
            return fail("TRANSACTION_FAILED", err?.message);
          }
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: { to, amount: rawOctLabel(raw), message, ou: sendOu },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the transaction.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            const tx = await buildTransferTx({
              from: w.address,
              to,
              amount: amountMicro,
              walletId: w.id,
              ou: sendOu,
              message: message || undefined,
              scope,
            });
            const hash = await broadcastSignedTx(tx, scope);
            void watchTxConfirmation(hash, origin, scope, { method: "send_transaction" }, {}, book);
            return ok({ txHash: hash });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              void watchTxConfirmation(
                err.hash,
                origin,
                scope,
                { method: "send_transaction" },
                {},
                book,
              );
              return ok({ txHash: err.hash, status: "submitted" });
            }
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            return fail("TRANSACTION_FAILED", err?.message || "Transaction failed");
          }
        }

        case "call_contract":
        case "callContract":
        case "send_contract_transaction": {
          const w = requireSigner();
          const {
            contract,
            method: cMethod,
            params: cParams,
            amount: cAmount,
            networkId: dappNet,
          } = req.params || {};
          if (!contract || !cMethod) return fail("INVALID_PARAMS", "Missing contract or method");
          if (cParams != null && !Array.isArray(cParams)) return fail("INVALID_PARAMS", BAD_ARGS);
          const callArgs: unknown[] = cParams ?? [];
          const callRaw = parseBaseUnits(cAmount);
          if (callRaw == null) return fail("INVALID_PARAMS", BAD_AMOUNT);
          const scope = siteScope(w);
          let callOu: string;
          try {
            callOu = await siteFee("call", scope.networkId, req.params?.ou);
          } catch (err: any) {
            return fail("CONTRACT_CALL_FAILED", err?.message);
          }
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to: contract,
              amount: rawOctLabel(callRaw),
              method: cMethod,
              contract,
              args: contractService.callMessage(callArgs),
              ou: callOu,
              networkMismatch:
                dappNet && dappNet !== networkId
                  ? `The site uses ${dappNet}. 0xio is on ${networkId}.`
                  : undefined,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the contract call.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            const hash = await contractService.callContract({
              contract,
              method: cMethod,
              params: callArgs,
              from: w.address,
              walletId: w.id,
              amount: callRaw.toString(),
              ou: callOu,
              scope,
            });
            void watchTxConfirmation(hash, origin, scope, { method: req.method }, {}, book);
            return ok({ txHash: hash, hash, status: "pending" });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              void watchTxConfirmation(err.hash, origin, scope, { method: req.method }, {}, book);
              return ok({ txHash: err.hash, hash: err.hash, status: "submitted" });
            }
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            return fail("CONTRACT_CALL_FAILED", err?.message || "Contract call failed");
          }
        }

        case "deploy_contract":
        case "deployContract": {
          const w = requireSigner();
          const parsed = parseDeployRequest(req.params);
          if (parsed.ok === false) return fail("INVALID_PARAMS", parsed.error);
          const dp = parsed.request;
          const scope = siteScope(w);
          let review: DeployReview;
          let preview: { nonce: number; contractAddress: string };
          try {
            const ou =
              dp.ou ??
              deployFee(
                dp.bytecodeB64,
                await networkService.liveMinimumOu("program_deploy", scope.networkId, {
                  encrypted_data_len: dp.bytecodeB64.length,
                }),
              );
            preview = await contractService.previewDeploy(dp.bytecodeB64, scope);
            review = {
              codeBytes: dp.codeBytes,
              contractAddress: preview.contractAddress,
              constructorParams: dp.constructorParams,
              ou: ou.toString(),
            };
          } catch (err) {
            return fail(
              "DEPLOY_FAILED",
              `Could not prepare the deploy. Nothing was sent. ${err instanceof Error ? err.message : ""}`.trim(),
            );
          }
          const invalid = deployReviewError(review);
          if (invalid) return fail("DEPLOY_FAILED", `${invalid}. Nothing was sent.`);
          const answer = await deps.requestApproval({
            type: "deploy",
            origin,
            request: req,
            signer: w,
            deploy: review,
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the deploy.");
          if (answer.selectedAddress && answer.selectedAddress !== w.address) {
            return fail("INVALID_PARAMS", "A deploy signs with the wallet its review showed.");
          }
          if (!(await deps.requestAuth("Confirm deploy"))) {
            return fail("USER_REJECTED", "User rejected the deploy.");
          }
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            const result = await contractService.deployContract({
              bytecodeB64: dp.bytecodeB64,
              from: w.address,
              walletId: w.id,
              constructorParams: dp.constructorParams || undefined,
              ou: review.ou,
              scope,
              reviewed: preview,
            });
            void watchTxConfirmation(
              result.txHash,
              origin,
              scope,
              { method: "deploy_contract", contractAddress: result.contractAddress },
              {},
              book,
            );
            return ok({
              txHash: result.txHash,
              hash: result.txHash,
              contractAddress: result.contractAddress,
              success: true,
            });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              const contractAddress = err.contractAddress;
              void watchTxConfirmation(
                err.hash,
                origin,
                scope,
                { method: "deploy_contract", contractAddress },
                {},
                book,
              );
              return ok({ txHash: err.hash, hash: err.hash, contractAddress, status: "submitted" });
            }
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            if (err instanceof contractService.DeployChangedError) {
              return fail(err.code, err.message);
            }
            return fail("DEPLOY_FAILED", err?.message || "Deploy failed");
          }
        }

        case "contract_call_view":
        case "contractCallView": {
          const { contract, method: viewMethod, params: viewParams, caller } = req.params || {};
          if (!contract || !viewMethod) return fail("INVALID_PARAMS", "Missing contract or method");
          const result = await contractService.viewContract(
            contract,
            viewMethod,
            viewParams || [],
            caller || (site ? siteWallet?.address : undefined) || "",
            networkId,
          );
          return ok({ contract, method: viewMethod, result, stale: false });
        }

        case "get_contract_storage":
        case "getContractStorage": {
          const { contract, key } = req.params || {};
          if (!contract || !key) return fail("INVALID_PARAMS", "Missing contract or key");
          return ok(await networkService.getContractStorage(contract, key, networkId));
        }

        case "switch_network": {
          requireSite();
          const targetNet = req.params?.networkId || req.params?.network;
          if (!targetNet || !NETWORKS[targetNet])
            return fail("INVALID_PARAMS", `Unknown network: ${targetNet}`);
          // The SDK reads exactly `network` and `switched`.
          if (targetNet === networkId)
            return ok({ network: targetNet, networkId: targetNet, switched: false });
          const answer = await deps.requestApproval({
            type: "network",
            origin,
            request: req,
            details: {
              to: "",
              amount: "0",
              fromName: NETWORKS[networkId]?.name ?? networkId,
              toName: NETWORKS[targetNet].name,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the network switch");
          if (deps.getNetworkId() !== networkId) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          // The site asked for this network, so it stays connected there.
          book.carrySite(networkId, targetNet, origin);
          deps.setNetworkId(targetNet);
          return ok({
            ...NETWORKS[targetNet],
            network: targetNet,
            networkId: targetNet,
            switched: true,
          });
        }

        case "sign_transaction":
        case "signTransaction": {
          const w = requireSigner();
          const stParams = req.params || {};
          // The review shows the recipient, amount, fee and memo only, so nothing else is signed.
          const standard =
            (stParams.op_type == null || stParams.op_type === "standard") &&
            (stParams.encrypted_data == null || stParams.encrypted_data === "");
          if (!standard) return fail("INVALID_PARAMS", ONLY_STANDARD);
          const signTo = stParams.to || stParams.to_ || "";
          if (typeof signTo !== "string") return fail("INVALID_PARAMS", "Recipient must be text");
          const memoError = reviewTextError(stParams.message);
          if (memoError) return fail("INVALID_PARAMS", memoError);
          const memo: string | undefined = stParams.message || undefined;
          const signRaw = parseBaseUnits(stParams.amount);
          if (signRaw == null) return fail("INVALID_PARAMS", BAD_AMOUNT);
          const scope = siteScope(w);
          let signOu: string;
          try {
            signOu = await siteFee("standard", scope.networkId, stParams.ou);
          } catch (err: any) {
            return fail("TRANSACTION_FAILED", err?.message);
          }
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to: signTo,
              amount: rawOctLabel(signRaw),
              method: "sign_only",
              message: memo,
              ou: signOu,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the signature.");
          try {
            networkService.assertScope(scope);
            const nonce = await networkService.getNextNonce(w.address, scope.networkId);
            const tx: SignedTransaction = canonicalTx({
              from: w.address,
              to_: signTo,
              amount: signRaw.toString(),
              nonce,
              ou: signOu,
              timestamp: txTimestamp(),
              op_type: "standard",
            });
            if (memo) tx.message = memo;

            networkService.assertScope(scope);
            const canonical = buildSignaturePayload(tx);
            const [signature, publicKey] = await Promise.all([
              walletBridge.signMessage(w.id, canonical),
              walletBridge.getPublicKey(w.id),
            ]);
            rememberSignedScope(signature, scope);
            return ok({ signedTx: { ...tx, signature, public_key: publicKey } });
          } catch (err: any) {
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            return fail("TRANSACTION_FAILED", err?.message || "Failed to sign transaction");
          }
        }

        case "broadcast_only": {
          const w = requireSite();
          const signedTx = req.params?.signedTx;
          if (!signedTx || !signedTx.signature) {
            return fail("INVALID_PARAMS", "signedTx with signature is required");
          }
          // The wallet relays only its own transactions.
          if (signedTx.from !== w.address) {
            return fail("INVALID_PARAMS", "signedTx.from must be the connected address.");
          }
          const scope = signedTxScopes.get(String(signedTx.signature)) ?? siteScope(w);
          try {
            const hash = await networkService.submitTransaction(signedTx, scope);
            void watchTxConfirmation(hash, origin, scope, { method: "broadcast_only" }, {}, book);
            return ok({ txHash: hash });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              void watchTxConfirmation(
                err.hash,
                origin,
                scope,
                { method: "broadcast_only" },
                {},
                book,
              );
              return ok({ txHash: err.hash, status: "submitted" });
            }
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            return fail("TRANSACTION_FAILED", err?.message || "Broadcast failed");
          }
        }

        case "get_private_capabilities":
          if (!site) return fail("NOT_CONNECTED", "DApp not connected");
          return ok({
            wallet: "0xio-desktop",
            version: "0.2.3",
            supports: {
              accounts: true,
              public_transactions: true,
              contract_calls: true,
              contract_views: true,
              contract_deploy: true,
              raw_amounts: true,
              private_transfers: true,
              private_balance_read: true,
              private_claims: true,
              encrypt_value: true,
              decrypt_value: true,
              zero_proofs: true,
              range_proofs: true,
            },
            methods: [
              "octra_requestAccounts",
              "octra_getPrivateCapabilities",
              "octra_sendTransaction",
              "octra_signTransaction",
              "octra_signMessage",
              "octra_callContractView",
              "octra_sendContractTransaction",
              "octra_sendContractTransactionSequence",
              "octra_deployContract",
              "octra_encryptValue",
              "octra_decryptValue",
              "octra_makeZeroProof",
              "octra_makeRangeProof",
              "octra_getPrivateBalance",
              "octra_sendPrivateTransfer",
              "octra_claimPrivateTransfer",
              "octra_registerPrivateViewKey",
            ],
            required_permissions: {
              contract_views: ["contract_calls"],
              private_transfers: ["private_transfers"],
              private_balance_read: ["private_balance_read"],
              zero_proofs: ["private_proofs"],
              range_proofs: ["private_proofs"],
              private_claims: ["private_claims"],
            },
          });

        case "get_private_balance_info":
          requireSite();
          return ok({
            encrypted: null,
            message: "Private balance info not available via desktop bridge",
          });

        case "encrypt_value": {
          const w = requirePrivate();
          const n = rawInt(req.params?.value_raw ?? req.params?.value);
          if (!Number.isFinite(n) || n < 0)
            return fail("INVALID_PARAMS", "Missing/invalid value_raw");
          try {
            await ensurePvac(w);
            const { cipher } = await privacyService.encryptValue(n);
            return ok({ cipher, encoding: "hfhe_v1" });
          } catch (err: any) {
            return fail("PRIVATE_PROOF_FAILED", err?.message || "Encrypt failed");
          }
        }

        case "decrypt_value": {
          const w = requirePrivate();
          requirePermission("private_balance_read");
          const cipher = req.params?.cipher;
          if (!cipher) return fail("INVALID_PARAMS", "Missing cipher");
          try {
            await ensurePvac(w);
            const r = await privacyService.decryptCipher(w.address, cipher);
            if (r.value == null) return fail("PRIVATE_PROOF_FAILED", "Decrypt failed");
            return ok({ value_raw: String(r.value), display: String(r.value), decimals: 6 });
          } catch (err: any) {
            return fail("PRIVATE_PROOF_FAILED", err?.message || "Decrypt failed");
          }
        }

        case "make_zero_proof": {
          const w = requirePrivate();
          requirePermission("private_proofs");
          const cipher = req.params?.cipher;
          if (!cipher) return fail("INVALID_PARAMS", "Missing cipher");
          const n = rawInt(req.params?.value_raw ?? "0");
          try {
            await ensurePvac(w);
            const { proof, commitment, blinding } = await privacyService.makeZeroProof(
              cipher,
              Number.isFinite(n) ? n : 0,
              { address: w.address, networkId },
            );
            return ok({ proof, commitment, blinding, encoding: "zkzp_v2" });
          } catch (err: any) {
            return fail("PRIVATE_PROOF_FAILED", err?.message || "Zero proof failed");
          }
        }

        case "make_range_proof": {
          const w = requirePrivate();
          requirePermission("private_proofs");
          const cipher = req.params?.cipher;
          if (!cipher) return fail("INVALID_PARAMS", "Missing cipher");
          const n = rawInt(req.params?.value_raw);
          if (!Number.isFinite(n) || n < 0)
            return fail("INVALID_PARAMS", "Missing/invalid value_raw");
          try {
            await ensurePvac(w);
            const { proof } = await privacyService.makeRangeProof(cipher, n);
            return ok({ proof, encoding: "rp_v1" });
          } catch (err: any) {
            return fail("PRIVATE_PROOF_FAILED", err?.message || "Range proof failed");
          }
        }

        case "get_private_balance": {
          const w = requirePrivate();
          requirePermission("private_balance_read");
          try {
            await ensurePvac(w);
            const r = await privacyService.getPrivateBalance(w.address, w.id, networkId);
            const raw = r.value ?? 0;
            return ok({
              address: w.address,
              private_oct_raw: String(raw),
              private_oct: raw / 1_000_000,
              tokens: [],
            });
          } catch (err: any) {
            return fail("PRIVATE_PROOF_FAILED", err?.message || "Private balance read failed");
          }
        }

        case "encrypt_balance":
        case "decrypt_balance":
          return fail(
            "UNSUPPORTED_METHOD",
            "Use encrypt_value / decrypt_value (RFP primitives) for dapp encryption.",
          );

        case "send_private_transfer": {
          const w = requirePrivate();
          const { to, amount, amount_raw } = req.params || {};
          if (!to) return fail("INVALID_PARAMS", "Missing 'to' address");
          const given = amount_raw != null && amount_raw !== "" ? parseBaseUnits(amount_raw) : null;
          if (amount_raw != null && amount_raw !== "" && given == null)
            return fail("INVALID_PARAMS", BAD_AMOUNT);
          const amtRaw =
            given != null ? Number(given) : Math.round(Number(amount || 0) * 1_000_000);
          if (!Number.isSafeInteger(amtRaw) || amtRaw <= 0)
            return fail("INVALID_PARAMS", "Invalid amount");
          const scope = networkService.captureScope(w.address);
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to,
              amount: `${rawOctLabel(BigInt(amtRaw))} (private)`,
              method: "private_transfer",
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the private transfer.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            await ensurePvac(w);
            const { txHash } = await privacyService.sendStealth({
              scope,
              recipient: to,
              amount: amtRaw,
              walletId: w.id,
            });
            void watchTxConfirmation(
              txHash,
              origin,
              scope,
              { method: "send_private_transfer" },
              {},
              book,
            );
            return ok({
              txHash,
              hash: txHash,
              to,
              amount_raw: String(amtRaw),
              asset: "OCT",
              status: "submitted",
            });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              void watchTxConfirmation(
                err.hash,
                origin,
                scope,
                { method: "send_private_transfer" },
                {},
                book,
              );
              return ok({
                txHash: err.hash,
                hash: err.hash,
                to,
                amount_raw: String(amtRaw),
                asset: "OCT",
                status: "submitted",
              });
            }
            const msg = err?.message || "Private transfer failed";
            if (/view ?pubkey|not registered/i.test(msg))
              return fail("RECIPIENT_NOT_REGISTERED", "Recipient has no view key registered");
            return fail("PRIVATE_TRANSFER_FAILED", msg);
          }
        }

        case "claim_private_transfer": {
          const w = requirePrivate();
          requirePermission("private_claims", "private_transfers");
          const cap = rawInt(req.params?.max_claims ?? MAX_SITE_CLAIMS) || MAX_SITE_CLAIMS;
          const scope = networkService.captureScope(w.address);
          let outputs: privacyService.ClaimableOutput[];
          let claimOu: string;
          try {
            await ensurePvac(w);
            outputs = await privacyService.getStealthOutputs(w.id, w.address, scope.networkId);
            if (!outputs.length)
              return ok({
                claimed_count: 0,
                claimed_total_raw: "0",
                tx_hashes: [],
                status: "none",
              });
            claimOu = await siteFee("claim", scope.networkId, req.params?.ou);
          } catch (err: any) {
            return fail(
              claimErrorCode(err) ?? "PRIVATE_TRANSFER_FAILED",
              err?.message || "Claim failed",
            );
          }
          const { selected, summary } = claimSummary(outputs, cap);
          const earlier = selected.map((o) => claimSlot(scope, o.id));
          if (earlier.every((slot) => slot.kind === "previous"))
            return ok({
              claimed_count: selected.length,
              claimed_total_raw: String(selected.reduce((sum, o) => sum + o.amount, 0)),
              tx_hashes: earlier.flatMap((slot) => (slot.kind === "previous" ? [slot.hash] : [])),
              status: "submitted",
            });
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to: w.address,
              amount: `${rawOctLabel(BigInt(summary.totalRaw))} (private)`,
              method: "claim_private",
              ou: claimOu,
              claims: summary,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the claim.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            const txs: string[] = [];
            let total = 0;
            let stopped = false;
            for (const out of selected) {
              try {
                const { txHash } = await privacyService.claimOutput(scope, out, w.id, claimOu);
                txs.push(txHash);
                total += out.amount;
              } catch (err) {
                if (err instanceof UnclearSubmitError) {
                  txs.push(err.hash);
                  total += out.amount;
                  stopped = txs.length < selected.length;
                  break;
                }
                if (
                  txs.length > 0 &&
                  err instanceof Error &&
                  (err.name === "PvacCompactNeeded" || claimErrorCode(err))
                ) {
                  stopped = true;
                  break;
                }
                throw err;
              }
            }
            return ok({
              claimed_count: txs.length,
              claimed_total_raw: String(total),
              tx_hashes: txs,
              status: stopped ? "partial" : "submitted",
            });
          } catch (err: any) {
            return fail(
              claimErrorCode(err) ?? "PRIVATE_TRANSFER_FAILED",
              err?.message || "Claim failed",
            );
          }
        }

        case "register_private_view_key": {
          const w = requirePrivate();
          const target = req.params?.address || w.address;
          if (target !== w.address)
            return fail("INVALID_PARAMS", "Can only register the connected wallet's view key");
          const scope = siteScope(w);
          const [viewPubkey, pvac] = await Promise.all([
            networkService.getViewPubkey(w.address, networkId),
            privacyService.getPvacKeyOwnership(w.address, networkId),
          ]);
          if (viewPubkey && pvac === "registered")
            return ok({ status: "registered", view_pubkey: viewPubkey, pvac: true });
          if (pvac === "foreign") return fail("PVAC_KEY_MISMATCH", KEY_MISMATCH);
          if (pvac === "pending")
            return fail(
              "REGISTRATION_PENDING",
              "The registration is confirming. Try again shortly.",
            );
          let fee: string;
          try {
            await ensurePvac(w);
            const mode = await privacyService.resolveKeySwitchMode(w.address, w.id, networkId);
            if (mode.mode !== "empty_key_switch") return fail("PVAC_KEY_MISMATCH", KEY_MISMATCH);
            fee = String((await privacyService.getKeySwitchFeeLive("recommended", networkId)).ou);
          } catch (err: any) {
            return fail("TRANSACTION_FAILED", err?.message || "Network fee unavailable.");
          }
          const funds = await networkService.getBalance(w.address, networkId).catch(() => null);
          if (!funds) return fail("TRANSACTION_FAILED", "Could not read the balance. Try again.");
          if (BigInt(Math.trunc(funds.balance)) < BigInt(fee))
            return fail("INSUFFICIENT_BALANCE", "Not enough OCT for the network fee.");
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to: w.address,
              amount: rawOctLabel(0n),
              method: "register_view_key",
              ou: fee,
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the registration.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          try {
            const { txHash } = await privacyService.keySwitchBalance(scope, w.id, {
              ou: fee,
              expect: { mode: "empty_key_switch", amountMicro: 0 },
            });
            return ok({ txHash, hash: txHash, status: "submitted" });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError)
              return ok({ txHash: err.hash, hash: err.hash, status: "submitted" });
            if (isScopeError(err)) return fail("NETWORK_CHANGED", err.message);
            return fail("PRIVATE_TRANSFER_FAILED", err?.message || "Registration failed");
          }
        }

        case "send_contract_transaction_sequence": {
          const w = requireSigner();
          const txns = req.params?.transactions;
          if (!Array.isArray(txns) || txns.length === 0)
            return fail("INVALID_PARAMS", "Missing transactions[]");
          // Every step is read and shown before the review, and signed exactly as shown.
          const steps: { contract: string; method: string; args: unknown[]; raw: bigint }[] = [];
          for (let i = 0; i < txns.length; i++) {
            const t = txns[i] ?? {};
            if (typeof t.contract !== "string" || !t.contract)
              return fail("INVALID_PARAMS", `Step ${i}: missing contract/method`);
            if (typeof t.method !== "string" || !t.method)
              return fail("INVALID_PARAMS", `Step ${i}: missing contract/method`);
            if (t.params != null && !Array.isArray(t.params))
              return fail("INVALID_PARAMS", `Step ${i}: ${BAD_ARGS}`);
            const raw = parseBaseUnits(t.amount);
            if (raw == null) return fail("INVALID_PARAMS", BAD_AMOUNT);
            steps.push({ contract: t.contract, method: t.method, args: t.params ?? [], raw });
          }
          const scope = siteScope(w);
          let stepOus: string[];
          try {
            const quote = await networkService.getRecommendedFeeStrict("call", scope.networkId);
            const ous = txns.map((t: any) => siteFeeOu(t?.ou, quote));
            if (ous.some((o: string | null) => o == null))
              throw new networkService.FeeUnavailableError();
            stepOus = ous as string[];
          } catch (err: any) {
            return fail("CONTRACT_CALL_FAILED", err?.message);
          }
          const total = steps.reduce((sum, st) => sum + st.raw, 0n);
          const answer = await deps.requestApproval({
            type: "transaction",
            origin,
            request: req,
            signer: w,
            details: {
              to: "",
              amount: rawOctLabel(total),
              steps: steps.map((st) => ({
                contract: st.contract,
                method: st.method,
                args: contractService.callMessage(st.args),
                amount: rawOctLabel(st.raw),
              })),
              ou: String(stepOus.reduce((sum, o) => sum + Number(o), 0)),
            },
          });
          if (!answer.approved) return fail("USER_REJECTED", "User rejected the sequence.");
          if (!stillCurrent(scope)) return fail("NETWORK_CHANGED", NETWORK_MOVED);
          const results: { index: number; txHash: string }[] = [];
          try {
            for (let i = 0; i < steps.length; i++) {
              const st = steps[i];
              const hash = await contractService.callContract({
                contract: st.contract,
                method: st.method,
                params: st.args,
                from: w.address,
                walletId: w.id,
                amount: st.raw.toString(),
                ou: stepOus[i],
                scope,
              });
              results.push({ index: i, txHash: hash });
            }
            return ok({ sequence_id: req.params?.sequence_id, status: "submitted", results });
          } catch (err: any) {
            if (err instanceof UnclearSubmitError) {
              results.push({ index: results.length, txHash: err.hash });
              const all = results.length === steps.length;
              return ok({
                sequence_id: req.params?.sequence_id,
                status: all ? "submitted" : "partial",
                results,
              });
            }
            return fail(
              isScopeError(err) ? "NETWORK_CHANGED" : "CONTRACT_CALL_FAILED",
              `${err?.message || "Sequence failed"} (completed ${results.length}/${txns.length})`,
            );
          }
        }

        case "get_pending_private_transfers":
          requireSite();
          return fail(
            "UNSUPPORTED_METHOD",
            "Use get_private_balance with include_claimable, or claim_private_transfer.",
          );

        case "rpc_call": {
          const rpcMethod = req.params?.method;
          const rpcParams = req.params?.params || [];
          if (!rpcMethod) return fail("INVALID_PARAMS", "Missing RPC method");
          if (!RPC_CALL_ALLOWED_METHODS.has(rpcMethod))
            return fail("METHOD_NOT_ALLOWED", `rpc_call does not permit '${rpcMethod}'`);
          try {
            return ok(
              await networkService.jsonRpcCallOn(
                networkId,
                rpcMethod,
                Array.isArray(rpcParams) ? rpcParams : [rpcParams],
              ),
            );
          } catch (err: any) {
            return fail("NETWORK_ERROR", err?.message || "RPC call failed");
          }
        }

        default:
          return fail("UNSUPPORTED_METHOD", `Unknown method: ${req.method}`);
      }
    } catch (err: any) {
      if (err instanceof BridgeError) return fail(err.code, err.message, err.details);
      logger.error("[DappBridge] Error handling request:", req.method, err);
      return fail("INTERNAL_ERROR", err?.message || "Internal error");
    }
  };
}
