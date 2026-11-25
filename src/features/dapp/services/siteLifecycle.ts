import { invoke } from "@tauri-apps/api/core";
import type { ApprovalAnswer } from "src/features/dapp/services/dappRequest";
import {
  getTransactionDetails,
  getViewPubkey,
  jsonRpcCallOn,
} from "src/services/network/networkService";
import type { TransactionDetail } from "src/types/transaction";

export interface SiteWatch {
  id: string;
  method: string;
  hashes: string[];
  network: string;
  address: string | null;
}

interface ContractReceipt {
  contract: unknown;
  method: unknown;
  success: boolean;
  effort: unknown;
  events: unknown[];
  error: unknown;
}

type ReceiptUnavailable = "not_contract" | "refused" | "error";

type SiteProgress =
  | { status: "signing" }
  | {
      status: "confirmed";
      epoch?: number;
      receipt?: ContractReceipt;
      receiptUnavailable?: ReceiptUnavailable;
      result?: { status: "registered"; view_pubkey: string | null; pvac: true };
    }
  | { status: "failed"; code: string; message: string }
  | { status: "unwatched" };

type ReportProgress = (id: string, progress: SiteProgress) => Promise<unknown>;

export const reportProgress: ReportProgress = (id, progress) =>
  invoke("site_progress", { id, progress });

/** False when the request ended meanwhile (page closed, expired): then nothing runs for it. */
export async function startSigning(id: string, report: ReportProgress = reportProgress) {
  try {
    await report(id, { status: "signing" });
    return true;
  } catch {
    return false;
  }
}

/** Approved only after Rust took the request as running. */
export function approveOnce(
  holder: { resolve: ((a: ApprovalAnswer) => void) | null } | undefined,
  id: string,
  start: (id: string) => Promise<boolean> = startSigning,
): Promise<void> | null {
  const resolve = holder?.resolve;
  if (!holder || !resolve) return null;
  holder.resolve = null;
  return start(id).then((approved) => resolve({ approved }));
}

const FAST_MS = 2_500;
const FAST_FOR_MS = 60_000;
const SLOW_MS = 10_000;
export const WATCH_FOR_MS = 600_000;

export const nextPollMs = (elapsed: number): number => (elapsed < FAST_FOR_MS ? FAST_MS : SLOW_MS);

const CONTRACT_METHODS = new Set([
  "call_contract",
  "callContract",
  "send_contract_transaction",
  "deploy_contract",
  "deployContract",
]);

const FAILED = new Set(["rejected", "dropped", "failed"]);

interface ChainDeps {
  read(hash: string, network: string): Promise<TransactionDetail | null>;
  receipt(hash: string, network: string): Promise<unknown>;
  viewPubkey(address: string, network: string): Promise<string | null>;
}

export interface WatchDeps extends ChainDeps {
  scopeHolds(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function asReceipt(r: unknown): ContractReceipt | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.success !== "boolean") return null;
  return {
    contract: o.contract ?? null,
    method: o.method ?? null,
    success: o.success,
    effort: o.effort ?? null,
    events: Array.isArray(o.events) ? o.events : [],
    error: o.error ?? null,
  };
}

async function readReceipt(
  hash: string,
  network: string,
  deps: ChainDeps,
): Promise<{ receipt?: ContractReceipt; receiptUnavailable?: ReceiptUnavailable }> {
  try {
    const receipt = asReceipt(await deps.receipt(hash, network));
    return receipt ? { receipt } : { receiptUnavailable: "error" };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return {
      receiptUnavailable: /single scanner read|not allowed|refused|forbidden/i.test(text)
        ? "refused"
        : "error",
    };
  }
}

export async function checkOnce(w: SiteWatch, deps: ChainDeps): Promise<SiteProgress | null> {
  if (!w.hashes.length) return null;
  let epoch: number | undefined;
  for (const hash of w.hashes) {
    const d = await deps.read(hash, w.network).catch(() => null);
    const status = d?.status;
    if (status && FAILED.has(status)) {
      const why = d?.reject_reason || d?.reject_type;
      const what = status === "dropped" ? "Dropped by the chain" : "Rejected on chain";
      return {
        status: "failed",
        code: "EXECUTION_FAILED",
        message: why ? `${what} (${why})` : what,
      };
    }
    if (status !== "confirmed") return null;
    if (typeof d?.epoch === "number") epoch = Math.max(epoch ?? 0, d.epoch);
  }
  const single = w.hashes.length === 1 && CONTRACT_METHODS.has(w.method);
  const receipt = single
    ? await readReceipt(w.hashes[0], w.network, deps)
    : { receiptUnavailable: "not_contract" as const };
  const result =
    w.method === "register_private_view_key" && w.address
      ? {
          result: {
            status: "registered" as const,
            view_pubkey: await deps.viewPubkey(w.address, w.network).catch(() => null),
            pvac: true as const,
          },
        }
      : {};
  return { status: "confirmed", ...(epoch !== undefined ? { epoch } : {}), ...receipt, ...result };
}

/** Stops when the site no longer runs on the network and wallet that signed. */
export async function watchSiteTx(w: SiteWatch, deps: WatchDeps): Promise<SiteProgress> {
  const start = deps.now();
  while (deps.now() - start < WATCH_FOR_MS) {
    await deps.sleep(nextPollMs(deps.now() - start));
    if (!deps.scopeHolds()) return { status: "unwatched" };
    const verdict = await checkOnce(w, deps);
    if (verdict) return verdict;
  }
  return { status: "unwatched" };
}

export const chainDeps: ChainDeps = {
  read: (hash, network) => getTransactionDetails(hash, network),
  receipt: (hash, network) => jsonRpcCallOn(network, "contract_receipt", [hash]),
  viewPubkey: (address, network) => getViewPubkey(address, network),
};

export const liveWatchDeps = (scopeHolds: () => boolean): WatchDeps => ({
  ...chainDeps,
  scopeHolds,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});
