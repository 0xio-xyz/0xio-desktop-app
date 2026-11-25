import { useEffect, useRef, useState } from "react";
import {
  type NftCollection,
  type NftTokenDetail,
  fetchTokenDetails,
  getCachedTokenDetails,
  getCachedTokenDetailsTs,
  setCachedTokenDetails,
} from "src/features/nft/services/data";

// Changed info (a living NFT going Alive to Dead, a rename) refreshes instead of sitting for 24h.
const METADATA_REVALIDATE_MS = 10 * 60 * 1000;

function seedFetchedAt(networkId: string): Record<string, number> {
  const ts = getCachedTokenDetailsTs(networkId);
  if (!ts) return {};
  const seeded: Record<string, number> = {};
  for (const addr of Object.keys(getCachedTokenDetails(networkId))) seeded[addr] = ts;
  return seeded;
}

export function useTokenDetails(collections: NftCollection[], networkId: string) {
  const [details, setDetails] = useState<Record<string, NftTokenDetail[]>>(() =>
    networkId ? getCachedTokenDetails(networkId) : {},
  );
  const inflight = useRef<Set<string>>(new Set());
  const fetchedAt = useRef<Record<string, number> | null>(null);
  if (fetchedAt.current === null) fetchedAt.current = networkId ? seedFetchedAt(networkId) : {};

  const prevNetwork = useRef(networkId);
  if (prevNetwork.current !== networkId) {
    prevNetwork.current = networkId;
    inflight.current.clear();
    fetchedAt.current = networkId ? seedFetchedAt(networkId) : {};
    setDetails(networkId ? getCachedTokenDetails(networkId) : {});
  }

  useEffect(() => {
    const now = Date.now();
    for (const c of collections) {
      const addr = c.contractAddress;
      if (!c.ownedTokenIds.length || inflight.current.has(addr)) continue;
      const have = details[addr] ?? [];
      const complete = c.ownedTokenIds.every((id) => have.some((d) => d.tokenId === id));
      const fresh = now - (fetchedAt.current![addr] ?? 0) < METADATA_REVALIDATE_MS;
      if (complete && fresh) continue;
      inflight.current.add(addr);
      const startedOn = networkId;
      void fetchTokenDetails(addr, c.ownedTokenIds)
        .then((fetched) => {
          if (prevNetwork.current !== startedOn) return;
          fetchedAt.current![addr] = Date.now();
          setDetails((prev) => {
            if (prevNetwork.current !== startedOn) return prev;
            // A degraded re-fetch (rate-limited node, null image or name) must not blank a token
            // that already resolved: a null in the new result is a fetch miss. A burned token is
            // the one real removal and never gets its old art back.
            const prevList = prev[addr] ?? [];
            const merged = fetched.map((d) => {
              const old = prevList.find((p) => p.tokenId === d.tokenId);
              return old && !d.burned
                ? {
                    ...d,
                    metaFetched: d.metaFetched || old.metaFetched,
                    image: d.image ?? old.image,
                    uri: d.uri ?? old.uri,
                    metaName: d.metaName ?? old.metaName,
                    metaDescription: d.metaDescription ?? old.metaDescription,
                    animationUrl: d.animationUrl ?? old.animationUrl,
                    biontAttrs: d.biontAttrs ?? old.biontAttrs,
                    inactive: d.inactive ?? old.inactive,
                    expired: d.expired ?? old.expired,
                    expires: d.expires ?? old.expires,
                  }
                : d;
            });
            const next = { ...prev, [addr]: merged };
            setCachedTokenDetails(startedOn, next);
            return next;
          });
        })
        .finally(() => inflight.current.delete(addr));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, networkId]);

  const reset = () => {
    inflight.current.clear();
    fetchedAt.current = {};
    setDetails({});
  };

  return { details, reset };
}
