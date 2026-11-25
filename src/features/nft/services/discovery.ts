// octra_tokensByAddress does not list every contract (devnet misses EUINT's newer layout), so known
// collections it left out are asked balance_of directly, as are imported addresses.

import { jsonRpcCallOn, sanitizeDisplay } from "src/services/network/networkService";
import { logger } from "src/lib/logger";

const NFT_LIST_URL =
  "https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@8777147d077e644227a80625ed19c14ed1c79b97/octra.nftlist.json";
const INDEXER_NFT_REGISTRY_URL = "https://indexer.0xio.xyz/api/nft/contracts";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const KNOWN_TTL_MS = 10 * 60_000;

interface HoldingEntry {
  contractAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: number;
  totalSupply: string | null;
}

// Throws when any page fails: a partial list is not "holds nothing" for the missing pages.
export async function fetchHoldings(networkId: string, wallet: string): Promise<HoldingEntry[]> {
  const out: HoldingEntry[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await jsonRpcCallOn<{
      tokens?: Record<string, unknown>[];
      limited?: boolean;
      next_offset?: number;
    }>(networkId, "octra_tokensByAddress", [wallet, offset, PAGE_SIZE]);
    for (const t of r?.tokens ?? []) {
      const addr = String(t.address ?? t.contract_address ?? t.contractAddress ?? "");
      if (!addr) continue;
      out.push({
        contractAddress: addr,
        name: sanitizeDisplay(String(t.name ?? t.symbol ?? ""), 32),
        symbol: sanitizeDisplay(String(t.symbol ?? ""), 16),
        decimals: parseInt(String(t.decimals ?? "0"), 10) || 0,
        balance: parseInt(String(t.balance ?? "0"), 10) || 0,
        totalSupply: t.total_supply != null ? String(t.total_supply) : null,
      });
    }
    // Devnet reports limited on the last page too, so a short page also ends the read.
    if ((r?.tokens?.length ?? 0) < PAGE_SIZE) break;
    if (!r?.limited || typeof r.next_offset !== "number" || r.next_offset <= offset) break;
    offset = r.next_offset;
  }
  return out;
}

// Only addresses are taken from these lists; names come from the contract itself.
type Known = { address: string };
const knownCache = new Map<string, { at: number; list: Known[] }>();

export async function getJson(url: string): Promise<unknown> {
  const { fetch } = await import("@tauri-apps/plugin-http");
  const res = await fetch(url, { method: "GET", connectTimeout: 8000 } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isAddr = (a: unknown): a is string =>
  typeof a === "string" && /^oct[A-Za-z0-9]{40,50}$/.test(a);

export async function knownNftContracts(networkId: string): Promise<Known[]> {
  const hit = knownCache.get(networkId);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.list;
  const list: Known[] = [];
  try {
    const body = (await getJson(NFT_LIST_URL)) as {
      collections?: { network?: string; address?: string; name?: string; symbol?: string }[];
    };
    for (const c of body?.collections ?? []) {
      if (c.network === networkId && isAddr(c.address)) list.push({ address: c.address });
    }
  } catch (e) {
    logger.debug("nft", `NFT list unavailable: ${e}`);
  }
  if (networkId === "mainnet") {
    try {
      const body = (await getJson(INDEXER_NFT_REGISTRY_URL)) as {
        contracts?: { address?: string; name?: string; symbol?: string }[];
      };
      for (const c of body?.contracts ?? [])
        if (isAddr(c.address)) list.push({ address: c.address });
    } catch (e) {
      logger.debug("nft", `NFT registry unavailable: ${e}`);
    }
  }
  const seen = new Set<string>();
  const unique = list.filter((k) => (seen.has(k.address) ? false : (seen.add(k.address), true)));
  knownCache.set(networkId, { at: Date.now(), list: unique });
  return unique;
}
