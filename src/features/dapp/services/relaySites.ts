/**
 * Rust keeps the one record; this copy follows the `relay-sites` event, and changes go back to
 * Rust with the answer, so the record changes before the site hears it.
 */

import { invoke } from "@tauri-apps/api/core";
import type { DappEventType } from "src/features/dapp/services/dappEvents";
import type { PendingApproval, SiteBook } from "src/features/dapp/services/dappRequest";
import type { DappSite } from "src/features/dapp/services/siteModel";
import {
  setRelayScopeCheck,
  type FeeOpType,
  type TxScope,
} from "src/services/network/networkService";
import type { RelayReview } from "src/tray/siteQueue";
import { logger } from "src/lib/logger";

export const DIRECT = "direct";

export interface RelayRecord {
  origin: string;
  network: string;
  address: string;
  client_id: string;
  browser: string;
  wallet_id: string;
  wallet_name: string;
  permissions: string[];
  connected_at: number;
  last_request?: number | null;
}

export interface RelayRequest {
  id: string;
  origin: string;
  topOrigin: string | null;
  framed: boolean;
  browser: "chrome" | "firefox" | "web";
  clientId: string;
  network: string;
  method: string;
  params: unknown;
}

export type RelayEffect =
  | {
      type: "connect";
      address: string;
      walletId: string;
      walletName: string;
      permissions: string[];
    }
  | { type: "disconnect" }
  | { type: "switch"; to: string };

let records: RelayRecord[] = [];
let version = 0;
const listeners = new Set<() => void>();

const isRecord = (v: unknown): v is RelayRecord => {
  const r = v as RelayRecord;
  return (
    !!r &&
    typeof r.origin === "string" &&
    typeof r.network === "string" &&
    typeof r.address === "string" &&
    typeof r.client_id === "string"
  );
};

export function setRelaySites(list: unknown): void {
  records = Array.isArray(list) ? list.filter(isRecord) : [];
  version++;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

export const relaySites = (): RelayRecord[] => records;
export const relaySitesVersion = (): number => version;

export function subscribeRelaySites(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function loadRelaySites(): Promise<void> {
  try {
    setRelaySites(await invoke<RelayRecord[]>("site_list"));
  } catch (err) {
    logger.warn("sites", "could not read the relayed sites", err);
  }
}

export function relayRecord(
  network: string,
  origin: string,
  clientId: string,
): RelayRecord | undefined {
  return records.find(
    (r) => r.network === network && r.origin === origin && r.client_id === clientId,
  );
}

export function relaySitesOn(network: string, list: RelayRecord[] = records): RelayRecord[] {
  return list.filter((r) => r.network === network).sort((a, b) => b.connected_at - a.connected_at);
}

export function relayScopeCurrent(scope: TxScope): boolean {
  if (!scope.relay || !scope.site) return false;
  return relayRecord(scope.networkId, scope.site, scope.relay)?.address === scope.address;
}

setRelayScopeCheck(relayScopeCurrent);

const asSite = (r: RelayRecord): DappSite => ({
  origin: r.origin,
  accounts: { [r.address]: { walletId: r.wallet_id, connectedAt: r.connected_at } },
  inUse: r.address,
  permissions: r.permissions ?? [],
});

export function relayEvent(
  type: DappEventType,
  data: unknown,
): { kind: string; data: unknown } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (type) {
    case "transactionConfirmed":
      return { kind: "tx", data: { ...d, hash: d.hash ?? d.txHash } };
    case "accountChanged":
      return {
        kind: "accountsChanged",
        data: {
          accounts: typeof d.address === "string" ? [d.address] : [],
          ...(typeof d.publicKey === "string" ? { publicKey: d.publicKey } : {}),
          ...(typeof d.canSign === "boolean" ? { canSign: d.canSign } : {}),
        },
      };
    case "disconnect":
      return { kind: "accountsChanged", data: { accounts: [] } };
    case "networkChanged":
      return { kind: "networkChanged", data };
    case "extensionLocked":
      return { kind: "lock", data: {} };
    default:
      return null;
  }
}

export function sendRelayEvent(
  origin: string,
  clientId: string,
  type: DappEventType,
  data: unknown,
) {
  const ev = relayEvent(type, data);
  if (!ev) return;
  void invoke("site_send_event", { origin, clientId, kind: ev.kind, data: ev.data }).catch((err) =>
    logger.warn("sites", "could not send a site event", err),
  );
}

/** Rust sends the site its own `accountsChanged` when it is disconnected. */
export function relayBook(req: RelayRequest, effects: RelayEffect[]): SiteBook {
  return {
    migrateLegacy: () => {},
    resolveSite: (networkId, origin, _open, usable) => {
      const r = relayRecord(networkId, origin, req.clientId);
      if (!r) return { site: null, address: null };
      return { site: asSite(r), address: usable(r.address) ? r.address : null };
    },
    connectWallet: (_networkId, _origin, wallet, _open, opts) => {
      effects.push({
        type: "connect",
        address: wallet.address,
        walletId: wallet.id,
        walletName: wallet.name,
        permissions: opts.permissions ?? [],
      });
    },
    disconnectSite: () => {
      effects.push({ type: "disconnect" });
    },
    carrySite: (_from, to) => {
      effects.push({ type: "switch", to });
    },
    getSite: (networkId, origin) => {
      const r = relayRecord(networkId, origin, req.clientId);
      return r ? asSite(r) : null;
    },
    siteScopeCurrent: relayScopeCurrent,
    scopeFor: (address, origin, networkId) => ({
      networkId,
      address,
      site: origin,
      relay: req.clientId,
    }),
    publish: (type, data, origin) => sendRelayEvent(origin, req.clientId, type, data),
  };
}

/** Never the raw request: everything signed or granted, in full. */
export function relayReview(a: Omit<PendingApproval, "networkId">, error?: string): RelayReview {
  const d = a.details;
  return {
    type: a.type,
    wallet: a.signer ? { name: a.signer.name, address: a.signer.address } : null,
    ...(d
      ? {
          to: d.to || undefined,
          amount: d.amount,
          method: d.method,
          message: typeof d.message === "string" ? d.message : undefined,
          contract: d.contract,
          args: d.args,
          steps: d.steps,
          ou: d.ou,
          fromName: d.fromName,
          toName: d.toName,
          networkMismatch: d.networkMismatch,
          claims: d.claims
            ? { count: d.claims.count, totalRaw: d.claims.totalRaw, remaining: d.claims.remaining }
            : undefined,
        }
      : {}),
    ...(a.deploy
      ? {
          deploy: {
            codeBytes: a.deploy.codeBytes,
            contractAddress: a.deploy.contractAddress,
            ou: a.deploy.ou,
            constructorParams: a.deploy.constructorParams,
          },
        }
      : {}),
    ...(a.type === "connect" && a.connect ? { scopes: [...a.connect.permissions] } : {}),
    ...(error ? { error } : {}),
  };
}

export function reviewFeeOp(method: string, review: RelayReview): FeeOpType | null {
  if (review.deploy) return "deploy";
  if (!review.ou) return null;
  if (review.method === "claim_private") return "claim";
  if (review.method === "register_view_key") return "key_switch";
  if (review.method === "sign_only") return null;
  if (review.contract || method === "send_contract_transaction_sequence") return "call";
  return "standard";
}

export const reviewedOu = (review: RelayReview): string | null =>
  review.deploy?.ou ?? review.ou ?? null;
