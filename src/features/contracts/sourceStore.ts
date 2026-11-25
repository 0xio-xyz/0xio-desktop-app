import { useCallback, useSyncExternalStore } from "react";
import type { ContractLanguage } from "src/types/contract";

// The chain only checks source (contract_verify); it never hands it back.
interface ContractSource {
  source: string;
  file: string;
  language: ContractLanguage;
  origin: "deployed" | "verified";
  verified: boolean;
  at: number;
}

const PREFIX = "contract_source_v1_";
const listeners = new Set<() => void>();

function keyOf(networkId: string, address: string): string {
  return `${PREFIX}${networkId}_${address}`;
}

function isSource(v: unknown): v is ContractSource {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.source === "string" &&
    typeof o.file === "string" &&
    (o.language === "aml" || o.language === "assembly") &&
    (o.origin === "deployed" || o.origin === "verified") &&
    typeof o.verified === "boolean" &&
    typeof o.at === "number"
  );
}

const cache = new Map<string, { raw: string | null; value: ContractSource | null }>();

export function readContractSource(networkId: string, address: string): ContractSource | null {
  if (!networkId || !address) return null;
  const key = keyOf(networkId, address);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value: ContractSource | null = null;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    value = isSource(parsed) ? parsed : null;
  } catch {
    value = null;
  }
  cache.set(key, { raw, value });
  return value;
}

export function saveContractSource(
  networkId: string,
  address: string,
  entry: Omit<ContractSource, "at">,
): void {
  if (!networkId || !address) return;
  try {
    localStorage.setItem(keyOf(networkId, address), JSON.stringify({ ...entry, at: Date.now() }));
  } catch {
    return;
  }
  listeners.forEach((l) => l());
}

export function markContractVerified(networkId: string, address: string, verified: boolean): void {
  const current = readContractSource(networkId, address);
  if (!current || current.verified === verified) return;
  saveContractSource(networkId, address, { ...current, verified });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useContractSource(networkId: string, address: string): ContractSource | null {
  const get = useCallback(() => readContractSource(networkId, address), [networkId, address]);
  return useSyncExternalStore(subscribe, get, get);
}
