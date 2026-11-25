import { useQuery, useQueryClient } from "src/lib/query";
import { NETWORKS } from "src/services/network/config";
import { getNetwork, jsonRpcCall } from "src/services/network/networkService";
import { resolveXpectrumToken } from "src/features/nft/services/xpectrum";
import {
  bytesToB64,
  resolveCircleAsset,
  type CircleAssetReply,
} from "src/features/circles/services/circleAsset";
import { isLivingProgramUri } from "src/features/nft/services/euint/protocol";
import {
  isInlineJsonUri,
  isRevertError,
  ownedIdsFromPage,
  OWNERS_PAGE_SIZE,
  parseInlineJsonUri,
} from "src/features/nft/services/euint/chainState";
import { fetchHoldings, knownNftContracts } from "src/features/nft/services/discovery";
import { appFetch, readByApp } from "src/features/nft/services/remote";
import { pieceKey, stampFirstSeen } from "src/features/nft/services/firstSeen";
import {
  hiddenCollections,
  hiddenPieces,
  setCollectionHidden,
  setPieceHidden,
} from "src/features/nft/services/hidden";
import { logger } from "src/lib/logger";
import { namesOf, onsContractFor } from "src/services/names/onsService";
import {
  ONS_SUFFIX,
  onsErrorCode,
  parseName,
  parseNameInfo,
  parseStatus,
} from "src/services/names/ons";
import type { Listing } from "src/features/nft/services/xpectrum/market";

export interface NftCollection {
  contractAddress: string;
  name: string;
  symbol: string;
  totalSupply: string | null;
  ownedCount: number;
  ownedTokenIds: string[];
  /** 0 = already held on the wallet's first scan. */
  firstSeen?: Record<string, number>;
  imported?: boolean;
}

export interface NftTokenDetail {
  tokenId: string;
  uri: string | null;
  image: string | null;
  metaName: string | null;
  metaDescription: string | null;
  animationUrl: string | null;
  metaFetched: boolean;
  biontAttrs?: { isAlive?: boolean; archetype?: number };
  burned?: boolean;
  inactive?: boolean;
  expired?: boolean;
  expires?: number;
}

export interface NftTrait {
  k: string;
  v: string;
}

const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
];

function resolveIpfsUrl(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://")) return `${IPFS_GATEWAYS[0]}${uri.slice(7)}`;
  if (uri.startsWith("Qm") || uri.startsWith("baf")) return `${IPFS_GATEWAYS[0]}${uri}`;
  return uri;
}

function parseOctUri(uri: string): { circleId: string; path: string } | null {
  if (!uri || !uri.toLowerCase().startsWith("oct://")) return null;
  const rest = uri.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return null;
  const si = rest.indexOf("/");
  if (si === -1) return { circleId: rest, path: "/index.html" };
  const circleId = rest.slice(0, si);
  const path = rest.slice(si) || "/index.html";
  return circleId ? { circleId, path } : null;
}

async function fetchOctAsset(
  uri: string,
): Promise<{ contentType: string; dataB64: string } | null> {
  const parsed = parseOctUri(uri);
  if (!parsed) return null;
  try {
    const asset = await resolveCircleAsset(
      (p) => jsonRpcCall<CircleAssetReply>("circle_asset", [parsed.circleId, p]),
      parsed.path,
    );
    if (!asset?.bytes.length) {
      logger.warn(
        "nft",
        `circle_asset ${parsed.circleId.slice(0, 12)}...${parsed.path} returned no body`,
      );
      return null;
    }
    return { contentType: asset.contentType, dataB64: bytesToB64(asset.bytes) };
  } catch (e) {
    logger.warn(
      "nft",
      `circle_asset ${parsed.circleId.slice(0, 12)}...${parsed.path} failed: ${e}`,
    );
    return null;
  }
}

// An <img> can't fetch oct://, so it becomes a data URL; so does an https host outside the
// window policy, read by the app.
async function resolveImageUri(uri: string | null): Promise<string | null> {
  if (!uri) return null;
  if (uri.toLowerCase().startsWith("oct://")) {
    const a = await fetchOctAsset(uri);
    return a ? `data:${a.contentType};base64,${a.dataB64}` : null;
  }
  const url = resolveIpfsUrl(uri);
  if (!readByApp(url)) return url;
  try {
    return await appFetch(url, "image");
  } catch (e) {
    logger.warn("nft", `image fetch failed: ${e}`);
    return null;
  }
}

async function fetchMetadataJson(rawUri: string): Promise<Record<string, unknown> | null> {
  // Parsed in place: the window policy has no data: in connect-src, so fetch() could never read it.
  if (isInlineJsonUri(rawUri)) return parseInlineJsonUri(rawUri);
  if (rawUri.toLowerCase().startsWith("oct://")) {
    const a = await fetchOctAsset(rawUri);
    if (!a) return null;
    try {
      return JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(a.dataB64), (c) => c.charCodeAt(0))),
      );
    } catch {
      return null;
    }
  }
  const httpUri = resolveIpfsUrl(rawUri);
  const tryFetch = async (url: string) => {
    if (readByApp(url)) return JSON.parse(await appFetch(url, "metadata"));
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return resp.json();
  };
  let json = await tryFetch(httpUri).catch(() => null);
  if (!json && rawUri.startsWith("ipfs://")) {
    const cid = rawUri.slice(7);
    for (let i = 1; i < IPFS_GATEWAYS.length && !json; i++) {
      logger.debug("nft", `metadata gateway ${i} fallback for ${cid.slice(0, 20)}...`);
      json = await tryFetch(`${IPFS_GATEWAYS[i]}${cid}`).catch(() => null);
    }
  }
  if (!json) logger.warn("nft", `metadata fetch failed: ${rawUri.slice(0, 80)}`);
  return json;
}

async function resolveNftMetadata(rawUri: string | null): Promise<{
  image: string | null;
  name: string | null;
  description: string | null;
  animationUrl: string | null;
}> {
  if (!rawUri) return { image: null, name: null, description: null, animationUrl: null };

  if (rawUri.trim().startsWith("<svg") || rawUri.trim().startsWith("<?xml")) {
    const svgDataUri = `data:image/svg+xml;base64,${btoa(encodeURIComponent(rawUri).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))))}`;
    return { image: svgDataUri, name: null, description: null, animationUrl: null };
  }

  if (rawUri.startsWith("data:image/")) {
    return { image: rawUri, name: null, description: null, animationUrl: null };
  }

  const json = (await fetchMetadataJson(rawUri)) as {
    image?: string;
    image_url?: string;
    imageUrl?: string;
    animation_url?: string;
    name?: string;
    description?: string;
  } | null;
  if (!json) return { image: null, name: null, description: null, animationUrl: null };

  const imageRaw: string | null = json.image ?? json.image_url ?? json.imageUrl ?? null;
  const animRaw: string | null = typeof json.animation_url === "string" ? json.animation_url : null;
  // A living program renders in the sandbox, not as an <img>: image stays null so the detail
  // picks the live frame.
  const animationUrl = isLivingProgramUri(animRaw)
    ? animRaw
    : isLivingProgramUri(imageRaw)
      ? imageRaw
      : null;
  const image = isLivingProgramUri(imageRaw) ? null : await resolveImageUri(imageRaw);
  logger.debug(
    "nft",
    `resolved ${rawUri.slice(0, 48)}... -> image=${image ? "yes" : "no"} living=${animationUrl ? "yes" : "no"}` +
      (!image && !animationUrl
        ? ` (raw image=${String(imageRaw).slice(0, 48)}, anim=${String(animRaw).slice(0, 48)})`
        : ""),
  );
  return { image, name: json.name ?? null, description: json.description ?? null, animationUrl };
}

export interface NftRarity {
  rank: number | null;
  total: number | null;
  score: number | null;
  traitPct: Record<string, number>;
}

export async function resolveNftTraits(
  rawUri: string | null,
): Promise<{ traits: NftTrait[]; rarity: NftRarity | null }> {
  if (
    !rawUri ||
    (rawUri.startsWith("data:") && !isInlineJsonUri(rawUri)) ||
    rawUri.trim().startsWith("<")
  )
    return { traits: [], rarity: null };
  const json = (await fetchMetadataJson(rawUri)) as {
    attributes?: { trait_type?: string; traitType?: string; value?: unknown }[];
    rarity?: { rank?: number; total?: number; score?: number; traits?: Record<string, number> };
  } | null;
  if (!json) return { traits: [], rarity: null };
  const traits = Array.isArray(json.attributes)
    ? json.attributes
        .map((a) => ({
          k: String(a.trait_type ?? a.traitType ?? "").trim(),
          v: a.value == null ? "" : String(a.value),
        }))
        .filter((t) => t.k && t.v)
    : [];
  const r = json.rarity;
  const rarity =
    r && (r.rank != null || r.traits)
      ? {
          rank: typeof r.rank === "number" ? r.rank : null,
          total: typeof r.total === "number" ? r.total : null,
          score: typeof r.score === "number" ? r.score : null,
          traitPct:
            r.traits && typeof r.traits === "object"
              ? Object.fromEntries(
                  Object.entries(r.traits).filter(([, v]) => typeof v === "number"),
                )
              : {},
        }
      : null;
  return { traits, rarity };
}

const IMPORTED_NFTS_KEY = (networkId: string) => `0xio_imported_nfts_${networkId}`;
const NFT_CACHE_KEY = (networkId: string, address: string) =>
  `0xio_nft_cache_v2_${networkId}_${address}`;
const NFT_TOKEN_CACHE_KEY = (networkId: string) => `0xio_nft_tokens_v3_${networkId}`;

function getCachedCollections(networkId: string, address: string): NftCollection[] | null {
  try {
    const raw = localStorage.getItem(NFT_CACHE_KEY(networkId, address));
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

function setCachedCollections(networkId: string, address: string, data: NftCollection[]) {
  try {
    localStorage.setItem(
      NFT_CACHE_KEY(networkId, address),
      JSON.stringify({ data, ts: Date.now() }),
    );
  } catch {}
}

// Inline data-URI images can push the blob past the storage quota and the write fails silently;
// memory keeps the session instant regardless.
let memTokenDetails: { networkId: string; data: Record<string, NftTokenDetail[]> } | null = null;

export function getCachedTokenDetails(networkId: string): Record<string, NftTokenDetail[]> {
  if (memTokenDetails?.networkId === networkId) return memTokenDetails.data;
  try {
    const raw = localStorage.getItem(NFT_TOKEN_CACHE_KEY(networkId));
    if (!raw) return {};
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return {};
    memTokenDetails = { networkId, data };
    return data;
  } catch {
    return {};
  }
}

export function setCachedTokenDetails(networkId: string, data: Record<string, NftTokenDetail[]>) {
  memTokenDetails = { networkId, data };
  try {
    localStorage.setItem(NFT_TOKEN_CACHE_KEY(networkId), JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // Over quota: persist a copy without inline images; they re-resolve in the background.
    try {
      const slim = Object.fromEntries(
        Object.entries(data).map(([addr, list]) => [
          addr,
          list.map((d) => (d.image?.startsWith("data:") ? { ...d, image: null } : d)),
        ]),
      );
      localStorage.setItem(
        NFT_TOKEN_CACHE_KEY(networkId),
        JSON.stringify({ data: slim, ts: Date.now() }),
      );
    } catch {}
  }
}

export function getCachedTokenDetailsTs(networkId: string): number | null {
  try {
    const raw = localStorage.getItem(NFT_TOKEN_CACHE_KEY(networkId));
    if (!raw) return null;
    const { ts } = JSON.parse(raw);
    return typeof ts === "number" ? ts : null;
  } catch {
    return null;
  }
}

const NFT_MARKET_CACHE_KEY = (networkId: string) => `0xio_nft_market_v1_${networkId}`;
interface MarketSnapshot {
  listing: Listing | null;
  approved: boolean;
  ts: number;
}
export const MARKET_REVALIDATE_MS = 60_000;

export function getCachedMarketState(
  networkId: string,
  contract: string,
  tokenId: string,
): { listing: Listing | null; approved: boolean; ts: number } | null {
  try {
    const raw = localStorage.getItem(NFT_MARKET_CACHE_KEY(networkId));
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, MarketSnapshot>;
    const snap = map[`${contract}:${tokenId}`];
    if (!snap || Date.now() - snap.ts > 24 * 60 * 60 * 1000) return null;
    return { listing: snap.listing, approved: snap.approved, ts: snap.ts };
  } catch {
    return null;
  }
}
export function setCachedMarketState(
  networkId: string,
  contract: string,
  tokenId: string,
  snap: { listing: Listing | null; approved: boolean },
) {
  try {
    const raw = localStorage.getItem(NFT_MARKET_CACHE_KEY(networkId));
    const map = raw ? (JSON.parse(raw) as Record<string, MarketSnapshot>) : {};
    map[`${contract}:${tokenId}`] = { ...snap, ts: Date.now() };
    localStorage.setItem(NFT_MARKET_CACHE_KEY(networkId), JSON.stringify(map));
  } catch {}
}

export function invalidateMarketState(networkId: string, contract: string, tokenId: string) {
  try {
    const raw = localStorage.getItem(NFT_MARKET_CACHE_KEY(networkId));
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, MarketSnapshot>;
    delete map[`${contract}:${tokenId}`];
    localStorage.setItem(NFT_MARKET_CACHE_KEY(networkId), JSON.stringify(map));
  } catch {}
}

const NFT_TRAITS_CACHE_KEY = "0xio_nft_traits_v1";
interface TraitSnapshot {
  traits: NftTrait[] | null;
  rarity: NftRarity | null;
  ts: number;
}
export function getCachedTraits(
  uri: string,
): { traits: NftTrait[] | null; rarity: NftRarity | null } | null {
  try {
    const raw = localStorage.getItem(NFT_TRAITS_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, TraitSnapshot>;
    const snap = map[uri];
    if (!snap || Date.now() - snap.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return { traits: snap.traits, rarity: snap.rarity };
  } catch {
    return null;
  }
}
export function setCachedTraits(
  uri: string,
  data: { traits: NftTrait[] | null; rarity: NftRarity | null },
) {
  try {
    const raw = localStorage.getItem(NFT_TRAITS_CACHE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, TraitSnapshot>) : {};
    map[uri] = { ...data, ts: Date.now() };
    localStorage.setItem(NFT_TRAITS_CACHE_KEY, JSON.stringify(map));
  } catch {}
}

export function getImportedNftAddresses(networkId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(IMPORTED_NFTS_KEY(networkId)) || "[]");
  } catch {
    return [];
  }
}

function saveImportedNftAddresses(networkId: string, addrs: string[]) {
  localStorage.setItem(IMPORTED_NFTS_KEY(networkId), JSON.stringify(addrs));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BUSY_BACKOFF_MS = [300, 700, 1500];
const isBusyError = (e: unknown) =>
  /program view busy|-32005/i.test(e instanceof Error ? e.message : String(e));

// Throws when the read fails, so a revert is not mistaken for an empty value. "Program view busy"
// means the node is running another view: it is asked again, never read as an answer.
async function callViewStrict(
  contract: string,
  method: string,
  params: unknown[] = [],
): Promise<string | null> {
  let raw: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await jsonRpcCall<unknown>("contract_call", [
        contract,
        method,
        params.length > 0 ? params : "",
        contract,
      ]);
      break;
    } catch (e) {
      if (!isBusyError(e) || attempt >= BUSY_BACKOFF_MS.length) throw e;
      await sleep(BUSY_BACKOFF_MS[attempt]);
    }
  }
  const r =
    raw && typeof raw === "object" && "result" in raw
      ? (raw as Record<string, unknown>).result
      : raw;
  return r != null ? String(r) : null;
}

async function callView(
  contract: string,
  method: string,
  params: unknown[] = [],
): Promise<string | null> {
  try {
    return await callViewStrict(contract, method, params);
  } catch {
    return null;
  }
}

const abiMethodsCache = new Map<string, Promise<string[]>>();
function contractMethods(address: string): Promise<string[]> {
  const key = `${getNetwork()}:${address}`;
  const hit = abiMethodsCache.get(key);
  if (hit) return hit;
  const p = jsonRpcCall<{ methods?: ({ name?: string } | string)[] } | null>("octra_contractAbi", [
    address,
  ]).then((abi) => (abi?.methods ?? []).map((m) => (typeof m === "string" ? m : (m?.name ?? ""))));
  abiMethodsCache.set(key, p);
  p.catch(() => abiMethodsCache.delete(key));
  return p;
}

type NftContractInfo = { name: string; symbol: string; totalSupply: string | null };

// Name and symbol never change and supply rarely does, while the gallery re-reads every minute.
const INFO_TTL_MS = 30 * 60_000;
const infoCache = new Map<string, { at: number; info: NftContractInfo }>();

export async function validateNftContract(address: string): Promise<NftContractInfo | null> {
  const key = `${getNetwork()}:${address}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
  // EUINT contracts revert collection_name/symbol/total_supply and answer the get_ views.
  const [collectionName, plainName, getName, plainSymbol, getSymbol, totalSupply, getTotalSupply] =
    await Promise.all([
      callView(address, "collection_name"),
      callView(address, "name"),
      callView(address, "get_name"),
      callView(address, "symbol"),
      callView(address, "get_symbol"),
      callView(address, "total_supply"),
      callView(address, "get_total_supply"),
    ]);
  const name = collectionName || plainName || getName;
  const symbol = plainSymbol || getSymbol;
  let info: NftContractInfo | null = null;
  if (name || symbol) {
    info = {
      name: name || symbol || "Unknown",
      symbol: symbol || "???",
      totalSupply: totalSupply || getTotalSupply || null,
    };
  } else {
    // No name view answered: an ABI with owner_of is still an NFT contract.
    const methods = await contractMethods(address).catch(() => [] as string[]);
    if (!methods.includes("owner_of")) return null;
    info = {
      name: `${address.slice(0, 6)}...${address.slice(-4)}`,
      symbol: "???",
      totalSupply: totalSupply || getTotalSupply || null,
    };
  }
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

// 0 for a contract without the view, null when the node did not answer.
async function readBalanceOf(contract: string, wallet: string): Promise<number | null> {
  try {
    const raw = await callViewStrict(contract, "balance_of", [wallet]);
    const s = raw != null ? raw.trim() : "";
    return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
  } catch (e) {
    return isRevertError(e) ? 0 : null;
  }
}

async function batchMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

const MAX_IDS = 50;
// owners_page reads 50 ids per call, owner_of one; past these the scan stops and says so.
const PAGE_SCAN_CAP = 2000;
const OWNER_OF_SCAN_CAP = 400;

class IncompleteScan extends Error {
  constructor(readonly partial: string[]) {
    super("owned id scan incomplete");
  }
}

// Reused while the owned count is unchanged; re-read at least every 10 minutes in case a send and
// a receive cancelled out.
const IDS_TTL_MS = 10 * 60_000;
const idsCache = new Map<string, { at: number; count: number; ids: string[] }>();

const NO_SUCH_VIEW = /method not found|unknown method|-32601/i;
const SCAN_GIVES_UP_AFTER = 3;

async function storageOwnedIds(contract: string, walletAddress: string): Promise<string[] | null> {
  // The node returns the whole storage map with a contract_call; EUINT contracts revert
  // total_supply and answer get_total_supply.
  let unread = false;
  for (const method of ["total_supply", "get_total_supply"]) {
    try {
      const raw = (await jsonRpcCall<{ storage?: Record<string, string> }>("contract_call", [
        contract,
        method,
        "",
        walletAddress,
      ])) as { storage?: Record<string, string> } | null;
      const storage = raw && typeof raw === "object" ? raw.storage : undefined;
      if (!storage || typeof storage !== "object") continue;
      const ids = Object.keys(storage)
        .filter(
          (k) => k.startsWith("tokens:") && k.endsWith(":owner") && storage[k] === walletAddress,
        )
        .map((k) => k.split(":")[1])
        .filter((id) => /^\d+$/.test(id))
        .sort((a, b) => parseInt(a) - parseInt(b))
        .slice(0, MAX_IDS);
      if (ids.length > 0) return ids;
    } catch (e) {
      if (!isRevertError(e) && !NO_SUCH_VIEW.test(e instanceof Error ? e.message : String(e)))
        unread = true;
    }
  }
  if (unread) throw new IncompleteScan([]);
  return null;
}

// Burns leave ids far past the live supply, so the supply alone is no ceiling.
async function scanCeiling(contract: string, totalSupply: string | null): Promise<number> {
  const next = await callView(contract, "get_next_id");
  const n = next != null && /^\d+$/.test(next.trim()) ? parseInt(next.trim(), 10) : 0;
  if (n > 0) return n;
  const declared = totalSupply != null ? parseInt(totalSupply) || 0 : 0;
  return Math.max(declared, 200);
}

const RECHECK_AT_MOST = 10;

// With the owned count unchanged, the ids known before are asked for again instead of scanning the
// whole collection: a send and a receive that cancelled out shows as an id no longer held.
export async function stillOwned(
  contract: string,
  walletAddress: string,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0 || ids.length > RECHECK_AT_MOST) return false;
  if ((await onsContractFor(getNetwork())) === contract) return false;
  for (const id of ids) {
    try {
      if ((await callViewStrict(contract, "owner_of", [id])) !== walletAddress) return false;
    } catch (e) {
      if (isRevertError(e)) return false;
      throw new IncompleteScan(ids);
    }
  }
  return true;
}

// Throws IncompleteScan when it could not finish, so the caller keeps what it knew.
export async function fetchOwnedTokenIds(
  contract: string,
  walletAddress: string,
  totalSupply: string | null,
  ownedCount: number,
): Promise<string[]> {
  if (ownedCount === 0) return [];
  const target = Math.min(ownedCount, MAX_IDS);

  if ((await onsContractFor(getNetwork())) === contract) {
    const held = await namesOf(walletAddress, { networkId: getNetwork() });
    if (held.ok !== true) throw new IncompleteScan([]);
    return held.names.map((n) => n.tokenId).slice(0, MAX_IDS);
  }

  const stored = await storageOwnedIds(contract, walletAddress);
  if (stored) return stored;

  const ceil = await scanCeiling(contract, totalSupply);
  const paged = await ownedIdsByPage(contract, walletAddress, ceil, target);
  if (paged) return paged;

  // A reverting owner_of is a burned or gapped id and must not hide the ids after it; any other
  // failure (the node did not answer) leaves the scan incomplete.
  const limit = Math.min(ceil, OWNER_OF_SCAN_CAP);
  const found: string[] = [];
  let failures = 0;
  let unanswered = 0;
  for (let i = 0; i < limit && found.length < target; i++) {
    try {
      const owner = await callViewStrict(contract, "owner_of", [String(i)]);
      if (owner != null && owner === walletAddress) found.push(String(i));
      unanswered = 0;
    } catch (e) {
      if (isRevertError(e)) {
        unanswered = 0;
        continue;
      }
      failures += 1;
      if (++unanswered >= SCAN_GIVES_UP_AFTER) throw new IncompleteScan(found);
    }
  }
  if (found.length < target && (failures > 0 || ceil > limit)) throw new IncompleteScan(found);
  return found;
}

async function ownedIdsByPage(
  contract: string,
  walletAddress: string,
  ceil: number,
  target: number,
): Promise<string[] | null> {
  const methods = await contractMethods(contract).catch(() => [] as string[]);
  if (!methods.includes("owners_page")) return null;
  const limit = Math.min(ceil, PAGE_SCAN_CAP);
  const found: string[] = [];
  for (let start = 0; start < limit && found.length < target; start += OWNERS_PAGE_SIZE) {
    let ids: string[] | null = null;
    try {
      const page = await callViewStrict(contract, "owners_page", [start, OWNERS_PAGE_SIZE]);
      ids = ownedIdsFromPage(page, start, OWNERS_PAGE_SIZE, walletAddress);
    } catch {
      ids = null;
    }
    if (!ids) throw new IncompleteScan(found);
    found.push(...ids);
  }
  if (found.length < target && ceil > limit) throw new IncompleteScan(found);
  return found.slice(0, target);
}

// A wallet that holds none of a known collection is asked again after 10 minutes, not every minute.
const PROBE_CAP = 60;
const PROBE_TTL_MS = 10 * 60_000;
const probeCache = new Map<string, { at: number; count: number }>();

async function probeKnown(
  networkId: string,
  walletAddress: string,
  addrs: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await batchMap(addrs.slice(0, PROBE_CAP), 4, async (addr) => {
    const key = `${networkId}:${walletAddress}:${addr.toLowerCase()}`;
    const hit = probeCache.get(key);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS && hit.count === 0) return;
    const n = await readBalanceOf(addr, walletAddress);
    if (n === null) return;
    probeCache.set(key, { at: Date.now(), count: n });
    if (n > 0) out.set(addr.toLowerCase(), n);
  });
  return out;
}

const NFT_VIEWS = ["owner_of", "owners_page"];

export async function readNameToken(
  contract: string,
  tokenId: string,
): Promise<{ name: string | null; inactive?: boolean; expired?: boolean; expires?: number }> {
  let lapsed = false;
  try {
    await callViewStrict(contract, "owner_of", [tokenId]);
  } catch (e) {
    lapsed = onsErrorCode(e instanceof Error ? e.message : String(e)) === "name_lapsed";
  }
  const name = parseName((await callView(contract, "name_of_token", [tokenId])) ?? "") || null;
  if (!name) return lapsed ? { name: null, inactive: true, expired: true } : { name: null };
  const info = parseNameInfo((await callView(contract, "get_name_info", [name])) ?? "");
  const expires = info?.name === name && info.tokenId === tokenId ? info.expires : undefined;
  if (lapsed) return { name, inactive: true, expired: true, expires };
  const status = parseStatus((await callView(contract, "status_of", [name])) ?? "");
  if (status === null) return { name, expires };
  const inactive = status !== "active";
  const past = inactive && expires !== undefined && expires * 1000 <= Date.now();
  return { name, inactive, expired: status === "grace" || past, expires };
}

export async function readNameFacts(
  contract: string,
  tokenId: string,
): Promise<Pick<NftTokenDetail, "metaName" | "inactive" | "expired" | "expires">> {
  const named = await readNameToken(contract, tokenId);
  return {
    metaName: named.name ? `${named.name}${ONS_SUFFIX}` : null,
    inactive: named.inactive,
    expired: named.expired,
    expires: named.expires,
  };
}

async function looksLikeNft(contract: string): Promise<boolean> {
  try {
    const methods = await contractMethods(contract);
    return methods.length === 0 || methods.some((m) => NFT_VIEWS.includes(m));
  } catch {
    return true;
  }
}

// A read that did not answer keeps the last known collection: a busy node is not "owns nothing".
async function fetchGalleryCollections(
  networkId: string,
  walletAddress: string,
): Promise<NftCollection[]> {
  const [holdings, known] = await Promise.all([
    fetchHoldings(networkId, walletAddress).catch((e) => {
      logger.debug("nft", `holdings unavailable: ${e}`);
      return null;
    }),
    knownNftContracts(networkId),
  ]);
  const lower = (a: string) => a.toLowerCase();
  const listed = new Map((holdings ?? []).map((h) => [lower(h.contractAddress), h]));
  const imported = getImportedNftAddresses(networkId);
  const importedSet = new Set(imported.map(lower));

  const candidates = new Map<string, string>();
  for (const h of holdings ?? []) {
    if (h.decimals === 0 && h.balance > 0)
      candidates.set(lower(h.contractAddress), h.contractAddress);
  }
  for (const a of imported) candidates.set(lower(a), a);
  const ons = await onsContractFor(networkId);
  const unlisted = [...known.map((k) => k.address), ...(ons ? [ons] : [])].filter(
    (a, i, all) => all.indexOf(a) === i && !candidates.has(lower(a)) && !listed.has(lower(a)),
  );
  const probed = await probeKnown(networkId, walletAddress, unlisted);
  for (const a of unlisted) if (probed.has(lower(a))) candidates.set(lower(a), a);

  const previous = getCachedCollections(networkId, walletAddress) ?? [];
  const last = (addr: string) =>
    previous.find((c) => lower(c.contractAddress) === lower(addr)) ?? null;

  const collections = await batchMap([...candidates.values()], 4, async (addr) => {
    const isImported = importedSet.has(lower(addr));
    const entry = listed.get(lower(addr));
    if (!isImported && !(await looksLikeNft(addr))) return null;

    let info = await validateNftContract(addr);
    if (!info && entry) {
      info = {
        name: entry.name || entry.symbol || "Unknown",
        symbol: entry.symbol || "???",
        totalSupply: entry.totalSupply,
      };
    }
    if (!info) return last(addr);

    let ownedCount: number;
    if (entry) {
      ownedCount = entry.balance;
    } else if (probed.has(lower(addr))) {
      ownedCount = probed.get(lower(addr))!;
    } else {
      const held = await readBalanceOf(addr, walletAddress);
      if (held === null) return last(addr);
      ownedCount = held;
    }
    if (ownedCount === 0 && !isImported) return null;

    const idsKey = `${networkId}:${walletAddress}:${lower(addr)}`;
    const cached = idsCache.get(idsKey);
    const earlier = last(addr);
    const known =
      cached?.count === ownedCount
        ? cached.ids
        : earlier?.ownedCount === ownedCount
          ? (earlier.ownedTokenIds ?? [])
          : [];
    const whole = known.length === Math.min(ownedCount, MAX_IDS);
    let ownedTokenIds: string[];
    if (cached && cached.count === ownedCount && Date.now() - cached.at < IDS_TTL_MS) {
      ownedTokenIds = cached.ids;
    } else {
      try {
        ownedTokenIds =
          whole && (await stillOwned(addr, walletAddress, known))
            ? known
            : await fetchOwnedTokenIds(addr, walletAddress, info.totalSupply, ownedCount);
        idsCache.set(idsKey, { at: Date.now(), count: ownedCount, ids: ownedTokenIds });
      } catch (e) {
        // Keep the ids known before, plus any the unfinished scan found, up to the owned count.
        const partial = e instanceof IncompleteScan ? e.partial : [];
        const prev = last(addr)?.ownedTokenIds ?? [];
        ownedTokenIds = [...new Set([...prev, ...partial])].slice(0, Math.min(ownedCount, MAX_IDS));
        logger.debug(
          "nft",
          `owned ids incomplete for ${addr.slice(0, 10)}, kept ${ownedTokenIds.length}`,
        );
      }
    }

    return {
      contractAddress: addr,
      ...info,
      ownedCount,
      ownedTokenIds,
      imported: isImported,
    } as NftCollection;
  });

  const result = collections.filter((c): c is NftCollection => c !== null);
  // Without the holdings list a collection that did not come back may still be held: keep it.
  if (holdings === null) {
    for (const p of previous) {
      if (!result.some((c) => lower(c.contractAddress) === lower(p.contractAddress)))
        result.push(p);
    }
  }

  const pieces = result.flatMap((c) =>
    c.ownedTokenIds.map((tokenId) => ({ contract: c.contractAddress, tokenId })),
  );
  const seen = stampFirstSeen(networkId, walletAddress, pieces);
  return result.map((c) => ({
    ...c,
    firstSeen: Object.fromEntries(
      c.ownedTokenIds.map((id) => [
        id,
        seen[pieceKey(networkId, walletAddress, c.contractAddress, id)] ?? 0,
      ]),
    ),
  }));
}

// is_alive and current_archetype are contract-level: concurrent tokens share one in-flight call.
const biontAttrsCache = new Map<
  string,
  Promise<{ isAlive?: boolean; archetype?: number } | undefined>
>();

function getContractBiontAttrs(
  contractAddress: string,
): Promise<{ isAlive?: boolean; archetype?: number } | undefined> {
  const hit = biontAttrsCache.get(contractAddress);
  if (hit) return hit;

  const p = (async () => {
    const abi = (await jsonRpcCall("octra_contractAbi", [contractAddress])) as {
      methods?: { name: string }[];
    } | null;
    const methods: string[] = (abi?.methods || []).map(
      (m) => (m as { name?: string }).name || String(m),
    );
    if (!methods.includes("is_alive") && !methods.includes("current_archetype")) return undefined;

    const attrs: { isAlive?: boolean; archetype?: number } = {};
    if (methods.includes("is_alive")) {
      const v = await callView(contractAddress, "is_alive", []);
      if (v != null) attrs.isAlive = v === "1" || v === "true";
    }
    if (methods.includes("current_archetype")) {
      const v = await callView(contractAddress, "current_archetype", []);
      if (v != null) attrs.archetype = parseInt(String(v), 10);
    }
    return Object.keys(attrs).length > 0 ? attrs : undefined;
  })().catch((e) => {
    biontAttrsCache.delete(contractAddress);
    throw e;
  });

  biontAttrsCache.set(contractAddress, p);
  return p;
}

export async function fetchTokenDetails(
  contractAddress: string,
  tokenIds: string[],
): Promise<NftTokenDetail[]> {
  const names = (await onsContractFor(getNetwork())) === contractAddress;
  return batchMap(tokenIds, 4, async (tokenId) => {
    const named = names ? await readNameFacts(contractAddress, tokenId) : null;
    let uri: string | null = null;
    try {
      uri = await callViewStrict(contractAddress, "token_uri", [parseInt(tokenId)]);
    } catch (e) {
      // A name whose token_uri reverts has lapsed, not burned: it stays, on its plate.
      if (named && isRevertError(e)) {
        named.inactive = true;
        named.expired = true;
      } else if (isRevertError(e)) {
        logger.debug("nft", `token_uri #${tokenId} reverted, burned`);
        return {
          tokenId,
          uri: null,
          image: null,
          metaName: null,
          metaDescription: null,
          animationUrl: null,
          metaFetched: true,
          burned: true,
        };
      }
      logger.warn("nft", `token_uri #${tokenId} failed: ${e}`);
    }
    if (!uri) logger.warn("nft", `token_uri #${tokenId} is empty - no media to resolve`);
    const [meta, biontAttrs] = await Promise.all([
      (async () => (await resolveXpectrumToken(uri)) ?? (await resolveNftMetadata(uri)))(),
      (async (): Promise<{ isAlive?: boolean; archetype?: number } | undefined> => {
        if (named) return undefined;
        try {
          return await getContractBiontAttrs(contractAddress);
        } catch {
          return undefined;
        }
      })(),
    ]);
    const animationUrl = named
      ? null
      : ((meta as { animationUrl?: string | null }).animationUrl ?? null);
    if (!meta.image && !animationUrl) {
      logger.warn("nft", `#${tokenId} resolved to NO media (uri=${String(uri).slice(0, 64)})`);
    }
    return {
      tokenId,
      uri,
      image: meta.image,
      metaName: named?.metaName ?? meta.name,
      metaDescription: meta.description,
      animationUrl,
      metaFetched: true,
      biontAttrs,
      ...(named && { inactive: named.inactive, expired: named.expired, expires: named.expires }),
    } as NftTokenDetail;
  });
}

export function useNftCollections(walletAddress: string | undefined, networkId: string) {
  return useQuery({
    queryKey: ["nftCollections", walletAddress, networkId],
    queryFn: async () => {
      const result = await fetchGalleryCollections(networkId, walletAddress!);
      setCachedCollections(networkId, walletAddress!, result);
      return result;
    },
    enabled: !!walletAddress && !!networkId,
    staleTime: 60_000,
    refetchInterval: 60_000,
    // No cross-key placeholder: the previous network's collections would fire metadata reads for
    // contracts that don't exist on the new node.
    initialData: () => {
      if (!walletAddress || !networkId) return undefined;
      return getCachedCollections(networkId, walletAddress) ?? undefined;
    },
  });
}

interface NftHidden {
  collections: string[];
  pieces: string[];
}

const hiddenKey = (walletAddress: string | undefined, networkId: string) => [
  "nftHidden",
  walletAddress,
  networkId,
];

export function useNftHidden(walletAddress: string | undefined, networkId: string) {
  return useQuery<NftHidden>({
    queryKey: hiddenKey(walletAddress, networkId),
    queryFn: () => ({
      collections: hiddenCollections(networkId, walletAddress!),
      pieces: hiddenPieces(networkId, walletAddress!),
    }),
    enabled: !!walletAddress && !!networkId,
    staleTime: Infinity,
    // Read synchronously so a hidden piece never flashes on the shelf before the query runs.
    initialData: () =>
      walletAddress && networkId
        ? {
            collections: hiddenCollections(networkId, walletAddress),
            pieces: hiddenPieces(networkId, walletAddress),
          }
        : undefined,
  });
}

export function useNftActions(walletAddress: string | undefined, networkId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["nftCollections", walletAddress, networkId] });
  };
  const refreshHidden = () => {
    if (!walletAddress) return;
    queryClient.setQueryData<NftHidden>(hiddenKey(walletAddress, networkId), {
      collections: hiddenCollections(networkId, walletAddress),
      pieces: hiddenPieces(networkId, walletAddress),
    });
  };

  const importCollection = (address: string) => {
    const addrs = getImportedNftAddresses(networkId);
    if (!addrs.some((a) => a.toLowerCase() === address.toLowerCase())) {
      saveImportedNftAddresses(networkId, [...addrs, address]);
    }
    // Importing shows a hidden collection again.
    if (walletAddress) setCollectionHidden(networkId, walletAddress, address, false);
    refreshHidden();
    invalidate();
  };

  const removeCollection = (address: string) => {
    saveImportedNftAddresses(
      networkId,
      getImportedNftAddresses(networkId).filter((a) => a.toLowerCase() !== address.toLowerCase()),
    );
    invalidate();
  };

  const setCollectionShown = (address: string, shown: boolean) => {
    if (!walletAddress) return;
    setCollectionHidden(networkId, walletAddress, address, !shown);
    refreshHidden();
  };

  const setPieceShown = (address: string, tokenId: string, shown: boolean) => {
    if (!walletAddress) return;
    setPieceHidden(networkId, walletAddress, address, tokenId, !shown);
    refreshHidden();
  };

  return { importCollection, removeCollection, setCollectionShown, setPieceShown, invalidate };
}

// Empty when the network has no explorer, rather than a link for a chain the user is not on.
export function octrascanAddressUrl(networkId: string, addr: string): string {
  const base = NETWORKS[networkId]?.explorerAddressUrl;
  return base ? `${base}${addr}` : "";
}

const NAME_CHAIN_FACTS = new Set(["expires", "expiry", "points to", "owner", "status"]);

export const nameTraits = (traits: NftTrait[] | null): NftTrait[] =>
  (traits ?? []).filter((t) => !NAME_CHAIN_FACTS.has(t.k.trim().toLowerCase()));

export function keepArt(old: NftTokenDetail | null, fresh: NftTokenDetail): NftTokenDetail {
  if (!old || fresh.image || fresh.animationUrl) return fresh;
  return {
    ...old,
    metaName: fresh.metaName ?? old.metaName,
    inactive: fresh.inactive ?? old.inactive,
    expired: fresh.expired ?? old.expired,
    expires: fresh.expires ?? old.expires,
  };
}

export function nftDisplayName(d: NftTokenDetail): string {
  return d.metaName || `#${d.tokenId}`;
}

// IndexedDB, not localStorage: a poster frame is tens to hundreds of KB.

const POSTER_DB = "octra-nft-posters";
const POSTER_STORE = "posters";
let posterDbPromise: Promise<IDBDatabase> | null = null;

function openPosterDb(): Promise<IDBDatabase> {
  if (posterDbPromise) return posterDbPromise;
  posterDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(POSTER_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(POSTER_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return posterDbPromise;
}

const posterKey = (networkId: string, contract: string, tokenId: string) =>
  `${networkId}:${contract}:${tokenId}`;

export async function getNftPoster(
  networkId: string,
  contract: string,
  tokenId: string,
): Promise<string | null> {
  try {
    const db = await openPosterDb();
    return await new Promise((resolve) => {
      const r = db
        .transaction(POSTER_STORE, "readonly")
        .objectStore(POSTER_STORE)
        .get(posterKey(networkId, contract, tokenId));
      r.onsuccess = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export function setNftPoster(
  networkId: string,
  contract: string,
  tokenId: string,
  dataUrl: string,
): void {
  void (async () => {
    try {
      const db = await openPosterDb();
      db.transaction(POSTER_STORE, "readwrite")
        .objectStore(POSTER_STORE)
        .put(dataUrl, posterKey(networkId, contract, tokenId));
    } catch (e) {
      logger.warn("nft", `poster store write failed: ${e}`);
    }
  })();
}

async function clearNftPoster(networkId: string, contract: string, tokenId: string): Promise<void> {
  try {
    const db = await openPosterDb();
    await new Promise<void>((resolve) => {
      const r = db
        .transaction(POSTER_STORE, "readwrite")
        .objectStore(POSTER_STORE)
        .delete(posterKey(networkId, contract, tokenId));
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    });
  } catch {}
}

export async function invalidateNftMetadata(
  networkId: string,
  contract: string,
  tokenId: string,
  uri: string | null,
): Promise<void> {
  try {
    const raw = localStorage.getItem(NFT_TOKEN_CACHE_KEY(networkId));
    if (raw) {
      const parsed = JSON.parse(raw) as { data?: Record<string, NftTokenDetail[]>; ts?: number };
      const list = parsed.data?.[contract];
      if (parsed.data && Array.isArray(list)) {
        parsed.data[contract] = list.filter((d) => d.tokenId !== tokenId);
        localStorage.setItem(NFT_TOKEN_CACHE_KEY(networkId), JSON.stringify(parsed));
      }
    }
  } catch {}
  if (uri) {
    try {
      const raw = localStorage.getItem(NFT_TRAITS_CACHE_KEY);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, unknown>;
        if (map[uri] !== undefined) {
          delete map[uri];
          localStorage.setItem(NFT_TRAITS_CACHE_KEY, JSON.stringify(map));
        }
      }
    } catch {}
  }
  await clearNftPoster(networkId, contract, tokenId);
}
