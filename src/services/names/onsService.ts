import { getJson } from "src/features/nft/services/discovery";
import { getNetwork, jsonRpcCallOn } from "src/services/network/networkService";
import {
  ONS_PAGE_SIZE,
  ONS_YEARS_MAX,
  ONS_YEARS_MIN,
  emptyTargetReason,
  isOnsAddress,
  isNameService,
  isOnsRevert,
  normalizeName,
  onsErrorCode,
  onsListNetwork,
  parseCount,
  parseName,
  parseNameInfo,
  parseNameList,
  parseNames,
  parsePrice,
  parseResolve,
  parseStatus,
  type OnsErrorCode,
  type OnsFailure,
  type OnsNameInfo,
  type OnsStatus,
  type OnsTarget,
} from "src/services/names/ons";

export const ONS_LIST_URL =
  "https://raw.githubusercontent.com/0xio-xyz/Token-lists/main/octra.namelist.json";
export const ONS_LIST_TTL_MS = 600_000;
export const ONS_RETRY_MS = 60_000;
export const ONS_LAST_GOOD_PREFIX = "0xio_ons_contract_";
export const ONS_FORWARD_TTL_MS = 60_000;
export const ONS_PRIMARY_TTL_MS = 600_000;
const CACHE_MAX = 256;

export const onsBusyRetry = { delaysMs: [1000, 2000] };

interface OnsFailed {
  ok: false;
  reason: OnsFailure;
}
export type OnsWallet = { ok: true; name: string; address: string; contract: string } | OnsFailed;
type OnsCircle = { ok: true; name: string; circleId: string; contract: string } | OnsFailed;
type OnsPrimary = { ok: true; name: string | null } | OnsFailed;
type OnsPrice = { ok: true; name: string; years: number; microOct: string } | OnsFailed;
interface OnsOwnedName extends OnsNameInfo {
  status: OnsStatus;
}
type OnsNames = { ok: true; names: OnsOwnedName[] } | OnsFailed;

interface OnsReadOptions {
  networkId?: string;
  fresh?: boolean;
}

class OnsReadError extends Error {
  constructor(readonly code: OnsErrorCode | "bad_reply") {
    super(code);
    this.name = "OnsReadError";
  }
}

const failed = (reason: OnsFailure): OnsFailed => ({ ok: false, reason });

const failureOf = (e: unknown): OnsFailed => {
  if (!(e instanceof OnsReadError)) throw e;
  return failed(e.code === "busy" || e.code === "bad_reply" ? e.code : "unavailable");
};

async function view(
  networkId: string,
  contract: string,
  method: string,
  params: string[],
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let reply: unknown;
    try {
      reply = await jsonRpcCallOn<unknown>(networkId, "contract_call", [
        contract,
        method,
        params,
        contract,
      ]);
    } catch (e) {
      const code = onsErrorCode(
        e instanceof Error ? e.message : String(e),
        (e as { code?: number } | null)?.code,
      );
      const delay = onsBusyRetry.delaysMs[attempt];
      if (code !== "busy" || delay === undefined) throw new OnsReadError(code);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const raw =
      reply && typeof reply === "object" && "result" in reply
        ? (reply as { result: unknown }).result
        : reply;
    if (typeof raw !== "string") throw new OnsReadError("bad_reply");
    return raw;
  }
}

function parsed<T>(value: T | null): T {
  if (value === null) throw new OnsReadError("bad_reply");
  return value;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age >= 0 && age < ttlMs) return hit.value;
  cache.delete(key);
  return null;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}

type TargetRead = { ok: true; name: string; value: string; contract: string } | OnsFailed;

const forwardCache = new Map<string, CacheEntry<TargetRead>>();
const primaryCache = new Map<string, CacheEntry<OnsPrimary>>();
const pickedOn = new Map<string, CacheEntry<string>>();
const inFlight = new Map<string, Promise<unknown>>();

export function clearOnsCache(): void {
  forwardCache.clear();
  primaryCache.clear();
  pickedOn.clear();
}

type OnsContractRead = { state: "on"; address: string } | { state: "off" } | { state: "unknown" };

interface NameList {
  at: number;
  ttlMs: number;
  byNetwork: Record<string, string> | null;
}

let nameList: NameList | null = null;
let listLoading: Promise<NameList> | null = null;
const checked = new Map<string, string>();
const settled = new Map<string, { at: number; ttlMs: number; read: OnsContractRead }>();
const contractLoading = new Map<string, Promise<OnsContractRead>>();
const contractListeners = new Set<() => void>();

export function onsContract(networkId: string): string | null {
  return checked.get(networkId) ?? null;
}

export function subscribeOnsContract(listener: () => void): () => void {
  contractListeners.add(listener);
  return () => contractListeners.delete(listener);
}

export function forgetOnsContracts(): void {
  nameList = null;
  listLoading = null;
  checked.clear();
  settled.clear();
  contractLoading.clear();
  for (const listener of contractListeners) listener();
}

function setChecked(networkId: string, address: string | null): void {
  if ((checked.get(networkId) ?? null) === address) return;
  if (address) checked.set(networkId, address);
  else checked.delete(networkId);
  for (const listener of contractListeners) listener();
}

function lastGood(networkId: string): string | null {
  try {
    const kept = localStorage.getItem(`${ONS_LAST_GOOD_PREFIX}${networkId}`);
    return kept !== null && isOnsAddress(kept) ? kept : null;
  } catch {
    return null;
  }
}

function keepLastGood(networkId: string, address: string): void {
  try {
    localStorage.setItem(`${ONS_LAST_GOOD_PREFIX}${networkId}`, address);
  } catch {}
}

async function loadNameList(): Promise<NameList> {
  const age = nameList ? Date.now() - nameList.at : -1;
  if (nameList && age >= 0 && age < nameList.ttlMs) return nameList;
  listLoading ??= (async (): Promise<NameList> => {
    let byNetwork: Record<string, string> | null = null;
    try {
      byNetwork = parseNameList(await getJson(ONS_LIST_URL));
    } catch {
      byNetwork = null;
    }
    nameList = byNetwork
      ? { at: Date.now(), ttlMs: ONS_LIST_TTL_MS, byNetwork }
      : { at: Date.now(), ttlMs: ONS_RETRY_MS, byNetwork: nameList?.byNetwork ?? null };
    return nameList;
  })().finally(() => {
    listLoading = null;
  });
  return listLoading;
}

async function readContract(networkId: string, listedAs: string): Promise<OnsContractRead> {
  const list = await loadNameList();
  const address = list.byNetwork ? (list.byNetwork[listedAs] ?? null) : lastGood(networkId);
  const keep = (read: OnsContractRead): OnsContractRead => {
    const ttlMs = read.state === "unknown" ? ONS_RETRY_MS : list.ttlMs;
    settled.set(networkId, { at: Date.now(), ttlMs, read });
    return read;
  };
  if (!address) {
    setChecked(networkId, null);
    return keep({ state: "off" });
  }
  if (checked.get(networkId) === address) return keep({ state: "on", address });
  setChecked(networkId, null);
  let info: string;
  try {
    info = await view(networkId, address, "get_contract_info", []);
  } catch (e) {
    if (!(e instanceof OnsReadError)) throw e;
    const refused = e.code !== "bad_reply" && isOnsRevert(e.code);
    return keep({ state: refused ? "off" : "unknown" });
  }
  if (!isNameService(info)) return keep({ state: "off" });
  setChecked(networkId, address);
  keepLastGood(networkId, address);
  return keep({ state: "on", address });
}

export function loadOnsContract(networkId: string): Promise<OnsContractRead> {
  const listedAs = onsListNetwork(networkId);
  if (!listedAs) return Promise.resolve({ state: "off" });
  const hit = settled.get(networkId);
  const age = hit ? Date.now() - hit.at : -1;
  if (hit && age >= 0 && age < hit.ttlMs) return Promise.resolve(hit.read);
  const pending = contractLoading.get(networkId);
  if (pending) return pending;
  const run = readContract(networkId, listedAs).finally(() => contractLoading.delete(networkId));
  contractLoading.set(networkId, run);
  return run;
}

export async function onsContractFor(networkId: string): Promise<string | null> {
  const read = await loadOnsContract(networkId);
  return read.state === "on" ? read.address : null;
}

async function contractOr(networkId: string): Promise<string | OnsFailed> {
  const read = await loadOnsContract(networkId);
  if (read.state === "on") return read.address;
  return failed(read.state === "off" ? "not_available" : "unavailable");
}

const TRANSIENT = new Set<OnsFailure>(["busy", "unavailable", "bad_reply"]);

async function cached<T extends { ok: true } | OnsFailed>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  fresh: boolean | undefined,
  read: () => Promise<T>,
): Promise<T> {
  if (!fresh) {
    const hit = cacheGet(cache, key, ttlMs);
    if (hit) return hit;
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const run = read().then((value) => {
    if (value.ok === true || !TRANSIENT.has(value.reason)) cacheSet(cache, key, value);
    return value;
  });
  if (fresh) return run;
  const shared = run.finally(() => inFlight.delete(key));
  inFlight.set(key, shared);
  return shared;
}

async function resolveTarget(
  target: OnsTarget,
  input: string,
  opts: OnsReadOptions,
): Promise<TargetRead> {
  const networkId = opts.networkId ?? getNetwork();
  const contract = await contractOr(networkId);
  if (typeof contract !== "string") return contract;
  const name = normalizeName(input);
  if (!name.ok) return failed("invalid");
  return cached(
    forwardCache,
    `${networkId}|${contract}|${target}|${name.name}`,
    ONS_FORWARD_TTL_MS,
    opts.fresh,
    async () => {
      try {
        const found = parsed(parseResolve(await view(networkId, contract, "resolve", [name.name])));
        if (found.kind === target && found.target)
          return { ok: true, name: name.name, value: found.target, contract };
        const status = await view(networkId, contract, "status_of", [name.name]);
        return failed(emptyTargetReason(target, status, found.kind));
      } catch (e) {
        return failureOf(e);
      }
    },
  );
}

export async function resolveWallet(input: string, opts: OnsReadOptions = {}): Promise<OnsWallet> {
  const r = await resolveTarget("wallet", input, opts);
  if (r.ok !== true) return r;
  const key = `${opts.networkId ?? getNetwork()}|${r.name}|${r.value}`;
  const first = pickedOn.get(key)?.value;
  if (first === undefined) cacheSet(pickedOn, key, r.contract);
  else if (first !== r.contract && opts.fresh) {
    cacheSet(pickedOn, key, r.contract);
    return failed("service_changed");
  }
  return { ok: true, name: r.name, address: r.value, contract: r.contract };
}

export async function resolveCircle(input: string, opts: OnsReadOptions = {}): Promise<OnsCircle> {
  const r = await resolveTarget("circle", input, opts);
  return r.ok === true ? { ok: true, name: r.name, circleId: r.value, contract: r.contract } : r;
}

export async function openCircle(input: string, opts: OnsReadOptions = {}): Promise<OnsCircle> {
  const r = await resolveCircle(input, opts);
  if (r.ok === true || r.reason !== "not_set") return r;
  const networkId = opts.networkId ?? getNetwork();
  const contract = await contractOr(networkId);
  const name = normalizeName(input);
  if (typeof contract !== "string" || !name.ok) return r;
  const waiting = await cached(
    forwardCache,
    `${networkId}|${contract}|waiting|${name.name}`,
    ONS_FORWARD_TTL_MS,
    opts.fresh,
    async () => {
      try {
        const info = parsed(
          parseNameInfo(await view(networkId, contract, "get_name_info", [name.name])),
        );
        return failed(info.circleStatus === "waiting" ? "circle_waiting" : "not_set");
      } catch (e) {
        return failureOf(e);
      }
    },
  );
  return waiting.ok === true ? r : waiting;
}

export async function primaryName(address: string, opts: OnsReadOptions = {}): Promise<OnsPrimary> {
  const networkId = opts.networkId ?? getNetwork();
  const contract = await contractOr(networkId);
  if (typeof contract !== "string") return contract;
  if (!isOnsAddress(address)) return failed("invalid");
  return cached(
    primaryCache,
    `${networkId}|${contract}|${address}`,
    ONS_PRIMARY_TTL_MS,
    opts.fresh,
    async () => {
      try {
        const name = parsed(parseName(await view(networkId, contract, "primary_of", [address])));
        return { ok: true, name: name || null };
      } catch (e) {
        return failureOf(e);
      }
    },
  );
}

export async function priceOf(
  input: string,
  years: number,
  opts: Pick<OnsReadOptions, "networkId"> = {},
): Promise<OnsPrice> {
  const networkId = opts.networkId ?? getNetwork();
  const contract = await contractOr(networkId);
  if (typeof contract !== "string") return contract;
  const name = normalizeName(input);
  if (!name.ok || !Number.isInteger(years) || years < ONS_YEARS_MIN || years > ONS_YEARS_MAX)
    return failed("invalid");
  try {
    const raw = await view(networkId, contract, "price_of", [name.name, String(years)]);
    return { ok: true, name: name.name, years, microOct: parsed(parsePrice(raw)) };
  } catch (e) {
    return failureOf(e);
  }
}

export async function namesOf(
  address: string,
  opts: Pick<OnsReadOptions, "networkId"> = {},
): Promise<OnsNames> {
  const networkId = opts.networkId ?? getNetwork();
  const contract = await contractOr(networkId);
  if (typeof contract !== "string") return contract;
  if (!isOnsAddress(address)) return failed("invalid");
  try {
    const count = parsed(parseCount(await view(networkId, contract, "balance_of", [address])));
    const held: string[] = [];
    while (held.length < count) {
      const page = parsed(
        parseNames(
          await view(networkId, contract, "names_of", [
            address,
            String(held.length),
            String(ONS_PAGE_SIZE),
          ]),
        ),
      );
      held.push(...page);
      if (page.length < ONS_PAGE_SIZE) break;
    }
    const names: OnsOwnedName[] = [];
    for (const name of held) {
      try {
        const info = parsed(
          parseNameInfo(await view(networkId, contract, "get_name_info", [name])),
        );
        if (info.name !== name) throw new OnsReadError("bad_reply");
        if (info.owner !== address) continue;
        const status = parsed(parseStatus(await view(networkId, contract, "status_of", [name])));
        names.push({ ...info, status });
      } catch (e) {
        if (e instanceof OnsReadError && e.code !== "bad_reply" && isOnsRevert(e.code)) continue;
        throw e;
      }
    }
    return { ok: true, names };
  } catch (e) {
    return failureOf(e);
  }
}
