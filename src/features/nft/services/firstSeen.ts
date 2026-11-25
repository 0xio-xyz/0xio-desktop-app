// The chain keeps no arrival time (only owner_of), so "newest" orders by when 0xio first saw each
// piece, as the app and extension do. Pieces held on a wallet's first scan get 0 (time unknown), so
// the gallery never claims everything arrived today.

const KEY = "0xio_nft_first_seen_v1";
export const BASELINE_WINDOW_MS = 5 * 60 * 1000;

type FirstSeenMap = Record<string, number>;

const scopeKey = (networkId: string, wallet: string) => `scope:${networkId}:${wallet}`;
export const pieceKey = (networkId: string, wallet: string, contract: string, tokenId: string) =>
  `${networkId}:${wallet}:${contract}:${tokenId}`;

function load(): FirstSeenMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FirstSeenMap) : {};
  } catch {
    return {};
  }
}

export function stampPieces(
  map: FirstSeenMap,
  networkId: string,
  wallet: string,
  pieces: { contract: string; tokenId: string }[],
  now: number,
): FirstSeenMap {
  const sk = scopeKey(networkId, wallet);
  const baseline = map[sk];
  const inBaseline = baseline === undefined || now - baseline < BASELINE_WINDOW_MS;
  let next: FirstSeenMap | null = null;
  for (const p of pieces) {
    const k = pieceKey(networkId, wallet, p.contract, p.tokenId);
    if (k in map) continue;
    next = next ?? { ...map };
    next[k] = inBaseline ? 0 : now;
  }
  if (baseline === undefined) {
    next = next ?? { ...map };
    next[sk] = now;
  }
  return next ?? map;
}

export function stampFirstSeen(
  networkId: string,
  wallet: string,
  pieces: { contract: string; tokenId: string }[],
): FirstSeenMap {
  const map = load();
  const next = stampPieces(map, networkId, wallet, pieces, Date.now());
  if (next !== map) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  }
  return next;
}
