import { useEffect, useSyncExternalStore } from "react";
import * as networkService from "src/services/network/networkService";
import { abiParamNames } from "./callArgs";
import { BoundedCache, knownOctraContract } from "./callReading";
import type { TokenFacts } from "./tokenNames";

const RETRY_MS = 60_000;

// Per network + contract: the same address can be another contract elsewhere.
export const contractKey = (network: string, contract: string) => `${network}:${contract}`;

type Entry<V> = { value: V | null; at: number };

function factStore<V>(max: number, read: (network: string, contract: string) => Promise<V | null>) {
  const cache = new BoundedCache<Entry<V>>(max);
  const running = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0;

  const peek = (network: string, contract: string): V | null | undefined => {
    const hit = cache.get(contractKey(network, contract));
    if (!hit) return undefined;
    if (hit.value === null && Date.now() - hit.at > RETRY_MS) return undefined;
    return hit.value;
  };

  const load = (network: string, contract: string): Promise<void> => {
    const key = contractKey(network, contract);
    if (peek(network, contract) !== undefined) return Promise.resolve();
    const inFlight = running.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      let value: V | null = null;
      try {
        value = await read(network, contract);
      } catch {
        value = null;
      }
      cache.set(key, { value, at: Date.now() });
      version++;
      listeners.forEach((fn) => fn());
    })().finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };

  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  const reset = () => {
    cache.clear();
    running.clear();
    version++;
  };

  return { peek, load, subscribe, snapshot: () => version, reset };
}

const abis = factStore<Record<string, string[]>>(50, async (network, contract) =>
  abiParamNames(await networkService.jsonRpcCallOn(network, "octra_contractAbi", [contract])),
);

const tokens = factStore<TokenFacts>(200, async (network, contract) => {
  const [symbol, name] = await Promise.all([
    networkService.getContractStorage(contract, "symbol", network),
    networkService.getContractStorage(contract, "name", network),
  ]);
  const clean = (s: string | null) => (s && s !== "0" ? s.trim().slice(0, 64) : null);
  const facts = { symbol: clean(symbol), name: clean(name) };
  return facts.symbol || facts.name ? facts : null;
});

export function useAbiNames(
  network: string,
  contract: string | null,
  method: string | null,
): { names: string[] | null; loading: boolean } {
  useSyncExternalStore(abis.subscribe, abis.snapshot);
  const peek = contract ? abis.peek(network, contract) : null;

  // effect:audited - reads one contract's ABI (external RPC) the cache lacks; the store re-renders on arrival
  useEffect(() => {
    if (contract && peek === undefined) void abis.load(network, contract);
  }, [network, contract, peek]);

  return {
    names: method && peek ? (peek[method] ?? null) : null,
    loading: !!contract && peek === undefined,
  };
}

// The raw names: the caller runs them through the spam rules.
export function useTokenFacts(
  contracts: readonly { network: string; address: string }[],
): Record<string, TokenFacts | null> {
  useSyncExternalStore(tokens.subscribe, tokens.snapshot);
  const unique = [
    ...new Map(
      contracts
        .filter((c) => c.address && !knownOctraContract(c.network, c.address))
        .map((c) => [contractKey(c.network, c.address), c]),
    ).values(),
  ];
  const missing = unique
    .filter((c) => tokens.peek(c.network, c.address) === undefined)
    .map((c) => contractKey(c.network, c.address))
    .join(",");

  // effect:audited - reads contract storage (external RPC) for names the cache lacks, one at a time; cleanup stops it
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    void (async () => {
      for (const key of missing.split(",")) {
        if (cancelled) break;
        const at = key.lastIndexOf(":");
        await tokens.load(key.slice(0, at), key.slice(at + 1));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missing]);

  const out: Record<string, TokenFacts | null> = {};
  for (const c of unique) {
    out[contractKey(c.network, c.address)] = tokens.peek(c.network, c.address) ?? null;
  }
  return out;
}

export function resetContractFacts(): void {
  abis.reset();
  tokens.reset();
}
