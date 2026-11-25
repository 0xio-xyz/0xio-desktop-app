import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useQuery } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import {
  ONS_FORWARD_TTL_MS,
  ONS_LIST_TTL_MS,
  ONS_PRIMARY_TTL_MS,
  ONS_RETRY_MS,
  loadOnsContract,
  onsContract,
  primaryName,
  resolveWallet,
  subscribeOnsContract,
  type OnsWallet,
} from "src/services/names/onsService";
import {
  ONS_SUFFIX,
  isNameInput,
  isOnsAddress,
  normalizeName,
  onsListNetwork,
  type OnsFailure,
} from "src/services/names/ons";

const ONS_CONTRACT_QUERY = "onsContract";
const ONS_PRIMARY_QUERY = "onsPrimary";
const ONS_RESOLVE_QUERY = "onsResolve";

export const RETRYABLE = new Set<OnsFailure>(["busy", "unavailable", "bad_reply"]);

export const onsDisplay = (name: string): string => `${name}${ONS_SUFFIX}`;

export const onsReasonKey = (reason: OnsFailure): string =>
  reason === "service_changed" ? "ons.checkAgain" : `ons.reason.${reason}`;

export function useOnsContract(networkId?: string): string | null {
  const { networkId: active } = useWallet();
  const id = networkId ?? active;
  useQuery({
    queryKey: [ONS_CONTRACT_QUERY, id],
    queryFn: async () => (await loadOnsContract(id)).state,
    enabled: onsListNetwork(id) !== null,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data === "unknown" ? ONS_RETRY_MS : ONS_LIST_TTL_MS),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return useSyncExternalStore(subscribeOnsContract, () => onsContract(id));
}

export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

export function usePrimaryName(
  address: string | null | undefined,
  opts: { networkId?: string; enabled?: boolean } = {},
): string | null {
  const { networkId: active } = useWallet();
  const networkId = opts.networkId ?? active;
  const contract = useOnsContract(networkId);
  const on = opts.enabled !== false && !!address && isOnsAddress(address) && contract !== null;
  const { data } = useQuery({
    queryKey: [ONS_PRIMARY_QUERY, networkId, contract, address],
    queryFn: async () => {
      const r = await primaryName(address!, { networkId });
      if (r.ok !== true) throw new Error(r.reason);
      return r.name;
    },
    enabled: on,
    staleTime: ONS_PRIMARY_TTL_MS,
    gcTime: ONS_PRIMARY_TTL_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return on && data ? onsDisplay(data) : null;
}

export type NameLookup =
  | { state: "resolving"; label: string }
  | { state: "found"; label: string; name: string; address: string }
  | { state: "refused"; label: string; reason: OnsFailure }
  | { state: "failed"; label: string; reason: OnsFailure; retry: () => void };

export function useNameLookup(text: string): NameLookup | null {
  const { networkId } = useWallet();
  const typed = text.trim();
  const contract = useOnsContract(networkId);
  const isName = isNameInput(typed) && contract !== null;
  const parsed = isName ? normalizeName(typed) : null;
  const name = parsed?.ok ? parsed.name : null;
  const query = useQuery<OnsWallet>({
    queryKey: [ONS_RESOLVE_QUERY, networkId, contract, name],
    queryFn: () => resolveWallet(name!, { networkId }),
    enabled: name !== null,
    staleTime: 0,
    gcTime: ONS_FORWARD_TTL_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!isName) return null;
  if (name === null) return { state: "refused", label: typed.toLowerCase(), reason: "invalid" };
  const label = onsDisplay(name);
  const r = query.data;
  if (query.isFetching || (!r && !query.isError)) return { state: "resolving", label };
  if (!r)
    return { state: "failed", label, reason: "unavailable", retry: () => void query.refetch() };
  if (r.ok === true) return { state: "found", label, name: r.name, address: r.address };
  if (RETRYABLE.has(r.reason))
    return { state: "failed", label, reason: r.reason, retry: () => void query.refetch() };
  return { state: "refused", label, reason: r.reason };
}

const NAME_TAKE_PAUSE_MS = 1000;

export function useFoundName(
  lookup: NameLookup | null,
  text: string,
  onFound: (address: string, label: string) => void,
): void {
  const address = lookup?.state === "found" ? lookup.address : null;
  const label = lookup?.label ?? null;
  const latest = useRef(onFound);
  latest.current = onFound;
  const changedAt = useRef(0);
  // effect:audited - the pause before a typed name is taken is counted from the last edit
  useEffect(() => {
    changedAt.current = Date.now();
  }, [text]);
  // effect:audited - a typed name is taken once the chain answered and the typing paused
  useEffect(() => {
    if (!address || !label) return;
    const wait = Math.max(0, NAME_TAKE_PAUSE_MS - (Date.now() - changedAt.current));
    const timer = setTimeout(() => latest.current(address, label), wait);
    return () => clearTimeout(timer);
  }, [address, label, text]);
}
