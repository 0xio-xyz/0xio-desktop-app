// Optimistic: an unread ABI stays "unknown" and listable; only a proven-incompatible collection
// hides List.
import { getContractAbi } from "src/services/contracts/contractService";
import { callView, toNum } from "src/features/nft/services/xpectrum/read";
import { xpectrumConfig } from "src/features/nft/services/xpectrum/config";

export type Listability = "unknown" | "ready" | "incompatible";

// A contract with all five is tradeable with no allowlist. A reduced-interface collection (e.g. the
// EUINT living NFTs) is listable only if the market admin enabled it: get_standard_mode > 0.
const XNS1_MARKET_METHODS = [
  "is_approved_or_owner",
  "transfer_from",
  "owner_of",
  "creator_of",
  "royalty_of",
];

function isFullXns1(methods: string[]): boolean {
  return XNS1_MARKET_METHODS.every((m) => methods.includes(m));
}

function deriveStandard(methods: string[]): string | null {
  if (methods.includes("transfer_from") && methods.includes("approve")) return "XNS-1";
  if (methods.includes("transfer_to")) return "Single-token";
  return methods.length ? "NFT" : null;
}

// null on a failed read: a transient miss must not hide List for an enabled collection.
async function marketStandardMode(networkId: string, contract: string): Promise<number | null> {
  const market = xpectrumConfig(networkId)?.market;
  if (!market) return null;
  try {
    const raw = await callView(market, "get_standard_mode", [contract]);
    return raw != null ? toNum(raw) : null;
  } catch {
    return null;
  }
}

function deriveListability(methods: string[]): Listability {
  if (methods.length === 0) return "unknown";
  const canApprove = methods.includes("approve");
  const canSettle = methods.includes("transfer_from") || methods.includes("transfer");
  return canApprove && canSettle ? "ready" : "incompatible";
}

type Verdict = { standard: string | null; listability: Listability };
const STORE_KEY = "0xio_nft_std_cache";
const mem = new Map<string, Verdict>();

function loadStore(): Record<string, Verdict> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") as Record<string, Verdict>;
  } catch {
    return {};
  }
}

export function cachedListability(key: string): Listability {
  const hit = mem.get(key) ?? loadStore()[key];
  if (hit) {
    mem.set(key, hit);
    return hit.listability;
  }
  return "unknown";
}

export async function resolveListability(
  networkId: string,
  contract: string,
): Promise<Listability> {
  const key = `${networkId}:${contract}`;
  const abi = await getContractAbi(contract);
  const methods = (abi ?? []).map((f) => f.name);
  if (methods.length === 0) return cachedListability(key);
  let listability = deriveListability(methods);
  if (listability === "ready" && !isFullXns1(methods)) {
    const mode = await marketStandardMode(networkId, contract);
    if (mode != null && mode <= 0) listability = "incompatible";
  }
  const verdict: Verdict = {
    standard: deriveStandard(methods),
    listability,
  };
  mem.set(key, verdict);
  const store = loadStore();
  store[key] = verdict;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
  return verdict.listability;
}
