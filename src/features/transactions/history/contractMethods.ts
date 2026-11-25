import { useEffect, useSyncExternalStore } from "react";
import * as networkService from "src/services/network/networkService";
import { RpcError } from "src/services/network/submitErrors";

const CACHE_KEY = "0xio_contract_methods_v2";
// Keyed by hash alone, so a method read on one network named a call on the other.
const LEGACY_KEY = "0xio_contract_methods";
export const MAX_METHODS = 400;
const PER_PASS = 10;
const MAX_PASSES = 5;
const PASS_PAUSE_MS = 800;
const RETRY_MS = 60_000;

// Per network + hash: the same hash can exist on another network.
export const methodKey = (network: string, hash: string) => `${network}:${hash}`;

interface MethodCall {
  network: string;
  hash: string;
}

let methods: Record<string, string> | null = null;
const inFlight = new Set<string>();
const failedAt = new Map<string, number>();
const noReceipt = new Set<string>();
const listeners = new Set<() => void>();

function store(): Record<string, string> {
  if (methods) return methods;
  methods = {};
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string" && k.includes(":")) methods[k] = v;
      }
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
  return methods;
}

export function rememberMethod(network: string, hash: string, method: string): void {
  const key = methodKey(network, hash);
  const next = { ...store() };
  delete next[key];
  next[key] = method;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_METHODS))) delete next[old];
  methods = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((fn) => fn());
}

export const peekMethod = (network: string, hash: string): string | undefined =>
  store()[methodKey(network, hash)];

async function readMethod(network: string, hash: string): Promise<string | null> {
  const receipt = await networkService.jsonRpcCallOn<{ method?: unknown } | null>(
    network,
    "contract_receipt",
    [hash],
  );
  return typeof receipt?.method === "string" && receipt.method ? receipt.method : null;
}

const receiptNotFound = (e: unknown) =>
  e instanceof RpcError && e.httpStatus === undefined && /not found/i.test(e.message);

export async function loadMethods(
  calls: readonly MethodCall[],
  cancelled: () => boolean = () => false,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES && !cancelled(); pass++) {
    const now = Date.now();
    const known = store();
    const missing = calls
      .filter(({ network, hash }) => {
        const key = methodKey(network, hash);
        return (
          !!hash &&
          !(key in known) &&
          !inFlight.has(key) &&
          !noReceipt.has(key) &&
          now - (failedAt.get(key) ?? -Infinity) > RETRY_MS
        );
      })
      .slice(0, PER_PASS);
    if (!missing.length) return;
    let named = 0;
    for (const { network, hash } of missing) {
      if (cancelled()) return;
      const key = methodKey(network, hash);
      inFlight.add(key);
      try {
        const method = await readMethod(network, hash);
        if (method) {
          rememberMethod(network, hash, method);
          named++;
        } else noReceipt.add(key);
      } catch (e) {
        if (receiptNotFound(e)) noReceipt.add(key);
        else failedAt.set(key, Date.now());
      } finally {
        inFlight.delete(key);
      }
    }
    if (!named) return;
    await pause(PASS_PAUSE_MS);
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function useContractMethods(calls: readonly MethodCall[]): Record<string, string> {
  const current = useSyncExternalStore(subscribe, store);
  const wanted = calls
    .filter((c) => c.hash && !(methodKey(c.network, c.hash) in current))
    .map((c) => methodKey(c.network, c.hash))
    .join(",");

  // effect:audited - reads receipts (external RPC) for calls the store lacks; cleanup stops the passes
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const list = wanted.split(",").map((key) => {
      const at = key.lastIndexOf(":");
      return { network: key.slice(0, at), hash: key.slice(at + 1) };
    });
    void loadMethods(list, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  return current;
}

export function resetContractMethods(): void {
  methods = null;
  inFlight.clear();
  failedAt.clear();
  noReceipt.clear();
}
