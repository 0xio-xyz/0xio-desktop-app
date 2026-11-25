import { useCallback, useMemo, useState } from "react";
import { networkCapabilities } from "src/services/network/config";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import * as contractService from "src/services/contracts/contractService";
import { getContractStorage, getTokensByAddress } from "src/services/network/networkService";
import type { TokenInfo } from "src/types/contract";
import { logger } from "src/lib/logger";
import { keepWithinScope } from "src/lib/query/queryScope";

const TOKEN_LIST_URL = "https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/octra.tokenlist.json";

const IMPORTED_KEY_PREFIX = "0xio_imported_tokens_";

function getImportedAddresses(networkId: string): string[] {
  try {
    const raw = localStorage.getItem(`${IMPORTED_KEY_PREFIX}${networkId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveImportedAddresses(networkId: string, addrs: string[]) {
  localStorage.setItem(`${IMPORTED_KEY_PREFIX}${networkId}`, JSON.stringify(addrs));
}

export interface DiscoveredTokenInfo extends TokenInfo {
  source: "listed" | "imported" | "discovered";
}

interface UseTokensReturn {
  tokens: DiscoveredTokenInfo[];
  isLoading: boolean;
  failed: boolean;
  updatedAt: number | null;
  refetch: () => void;
  addImportedToken: (address: string) => void;
  removeImportedToken: (address: string) => void;
}

async function batchMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function getTokenBalance(
  contractAddr: string,
  walletAddr: string,
  networkId: string,
): Promise<string> {
  try {
    const raw = await contractService.viewContract(
      contractAddr,
      "balance_of",
      [walletAddr],
      walletAddr,
      networkId,
    );
    const val =
      raw && typeof raw === "object" && "result" in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>).result
        : raw;
    return val != null ? String(val) : "0";
  } catch {
    return "0";
  }
}

interface TokenListEntry {
  network?: string;
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
  logoURI?: string;
  tags?: string[];
}

// Token metadata is immutable per contract, so a refetch reads only the balance.
const importedMetaCache = new Map<string, { symbol: string; name: string; decimals: number }>();

async function fetchImportedTokenInfo(
  contractAddr: string,
  walletAddr: string,
  networkId: string,
): Promise<TokenInfo | null> {
  const metaKey = `${networkId}:${contractAddr}`;
  const cachedMeta = importedMetaCache.get(metaKey);
  if (cachedMeta) {
    const balance = await getTokenBalance(contractAddr, walletAddr, networkId);
    return { contractAddress: contractAddr, ...cachedMeta, balance: balance || "0" };
  }
  const [symbol, name, decimalsRaw, balance] = await Promise.all([
    getContractStorage(contractAddr, "symbol", networkId),
    getContractStorage(contractAddr, "name", networkId),
    getContractStorage(contractAddr, "decimals", networkId),
    getTokenBalance(contractAddr, walletAddr, networkId),
  ]);
  if (!symbol) return null;
  const meta = {
    symbol,
    name: name || symbol,
    decimals: parseInt(decimalsRaw || "0") || 0,
  };
  importedMetaCache.set(metaKey, meta);
  return { contractAddress: contractAddr, ...meta, balance: balance || "0" };
}

let cachedTokenList: TokenListEntry[] | null = null;
let cachedTokenListNetwork: string | null = null;

/** The token list as last fetched (every network's entries), for lookups that must not fetch. */
export function peekTokenList(): readonly TokenListEntry[] | null {
  return cachedTokenList;
}

async function discoverTokens(
  walletAddr: string,
  excludeAddrs: Set<string>,
  networkId: string,
): Promise<DiscoveredTokenInfo[]> {
  try {
    const contracts = await contractService.listContracts(networkId);
    if (!contracts.length) return [];
    const candidates = contracts.map((c) => c.address).filter((a) => a && !excludeAddrs.has(a));
    logger.debug("tokens", `discovery: scanning ${candidates.length} contracts`);
    const results = await batchMap(
      candidates,
      6,
      async (addr): Promise<DiscoveredTokenInfo | null> => {
        try {
          const symbol = await getContractStorage(addr, "symbol", networkId);
          if (!symbol || symbol === "0") return null;
          const sym = symbol.length > 10 ? symbol.slice(0, 10) : symbol;
          const balance = await getTokenBalance(addr, walletAddr, networkId);
          if (!balance || balance === "0") return null;
          const [name, decimalsRaw] = await Promise.all([
            getContractStorage(addr, "name", networkId),
            getContractStorage(addr, "decimals", networkId),
          ]);
          return {
            contractAddress: addr,
            symbol: sym,
            name: name && name.length <= 32 ? name : sym,
            decimals: parseInt(decimalsRaw || "0") || 0,
            balance,
            source: "discovered" as const,
          };
        } catch {
          return null;
        }
      },
    );
    return results.filter((r): r is DiscoveredTokenInfo => r !== null);
  } catch (err) {
    logger.error("tokens", "Token discovery failed:", err);
    return [];
  }
}

export function useTokens(): UseTokensReturn {
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address ?? "";
  const [importedVersion, setImportedVersion] = useState(0);
  const importedAddrs = useMemo(
    () => getImportedAddresses(networkId),
    [networkId, importedVersion],
  );

  const {
    data: tokens = [],
    isLoading,
    isError,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: ["tokens", address, networkId, importedAddrs],
    queryFn: async (): Promise<DiscoveredTokenInfo[]> => {
      if (!address) return [];

      let listedTokens: TokenListEntry[] = [];
      try {
        if (cachedTokenList && cachedTokenListNetwork === networkId) {
          listedTokens = cachedTokenList;
        } else {
          const response = await fetch(TOKEN_LIST_URL);
          if (response.ok) {
            const data = await response.json();
            if (data.tokens && Array.isArray(data.tokens)) {
              listedTokens = data.tokens;
              cachedTokenList = listedTokens;
              cachedTokenListNetwork = networkId;
            }
          }
        }
      } catch (err) {
        logger.error("tokens", "Failed to fetch token list:", err);
      }

      // undefined on a custom node: its tokens are unknown, and mainnet's list is not it.
      const targetNetwork = networkCapabilities(networkId).tokenListTag;
      const networkTokens = targetNetwork
        ? listedTokens.filter(
            (t) => t.network === targetNetwork && !t.tags?.includes("native") && t.symbol !== "OCT",
          )
        : [];
      logger.debug("tokens", `${networkTokens.length} listed tokens for ${targetNetwork}`);

      const onChainTokens = await getTokensByAddress(address, networkId);
      const balanceMap = new Map(onChainTokens.map((t) => [t.contractAddress, t]));

      const listedWithBalance: DiscoveredTokenInfo[] = [];
      for (const token of networkTokens) {
        const onChain = balanceMap.get(token.address);
        const balance = onChain?.balance || "0";
        if (!balance || balance === "0") continue;
        listedWithBalance.push({
          contractAddress: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals ?? 0,
          balance,
          logoURI: token.logoURI,
          source: "listed" as const,
        });
      }

      // Storage reads only for imports the by-address call did not return or holds at zero.
      const listedAddrs = new Set(networkTokens.map((t) => t.address));
      const imported = importedAddrs.filter((a) => !listedAddrs.has(a));
      const importedFromChain: DiscoveredTokenInfo[] = [];
      const needsRead: string[] = [];
      for (const addr of imported) {
        const onChain = balanceMap.get(addr);
        if (onChain && onChain.balance && onChain.balance !== "0") {
          importedFromChain.push({ ...onChain, source: "imported" as const });
        } else {
          needsRead.push(addr);
        }
      }
      const readImported = await batchMap(needsRead, 6, (addr) =>
        fetchImportedTokenInfo(addr, address, networkId),
      );
      const validImported: DiscoveredTokenInfo[] = [
        ...importedFromChain,
        ...readImported
          .filter((r): r is TokenInfo => r !== null)
          .map((t) => ({ ...t, source: "imported" as const })),
      ];

      let discovered: DiscoveredTokenInfo[] = [];
      if (localStorage.getItem("0xio_token_discovery") === "true") {
        const knownAddrs = new Set([...networkTokens.map((t) => t.address), ...importedAddrs]);
        discovered = await discoverTokens(address, knownAddrs, networkId);
      }

      const all = [...listedWithBalance, ...validImported, ...discovered];
      logger.info(
        "tokens",
        `found ${all.length} tokens (${listedWithBalance.length} listed, ${validImported.length} imported, ${discovered.length} discovered)`,
      );
      return all;
    },
    enabled: !!address,
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepWithinScope(address, networkId),
  });

  const addImportedToken = useCallback(
    (tokenAddr: string) => {
      const current = getImportedAddresses(networkId);
      if (!current.includes(tokenAddr)) {
        const updated = [...current, tokenAddr];
        saveImportedAddresses(networkId, updated);
        setImportedVersion((v) => v + 1);
      }
    },
    [networkId],
  );

  const removeImportedToken = useCallback(
    (tokenAddr: string) => {
      const current = getImportedAddresses(networkId);
      const updated = current.filter((a: string) => a !== tokenAddr);
      saveImportedAddresses(networkId, updated);
      setImportedVersion((v) => v + 1);
    },
    [networkId],
  );

  return {
    tokens,
    isLoading,
    failed: isError,
    updatedAt: dataUpdatedAt || null,
    refetch,
    addImportedToken,
    removeImportedToken,
  };
}
