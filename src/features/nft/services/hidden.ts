// The older per-network "ignored" list (from the detected banner) still hides its collections.
const COLLS = (networkId: string, wallet: string) => `0xio_nft_hidden_colls_${networkId}_${wallet}`;
const PIECES = (networkId: string, wallet: string) =>
  `0xio_nft_hidden_pieces_${networkId}_${wallet}`;
const LEGACY_IGNORED = (networkId: string) => `0xio_ignored_nfts_${networkId}`;

const read = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const write = (key: string, list: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(list)]));
  } catch {}
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function hiddenCollections(networkId: string, wallet: string): string[] {
  return [...read(COLLS(networkId, wallet)), ...read(LEGACY_IGNORED(networkId))];
}

export function setCollectionHidden(
  networkId: string,
  wallet: string,
  contract: string,
  hidden: boolean,
) {
  const list = read(COLLS(networkId, wallet)).filter((a) => !same(a, contract));
  write(COLLS(networkId, wallet), hidden ? [...list, contract] : list);
  // Showing also lifts an old banner "ignore", or the collection would stay hidden.
  if (!hidden)
    write(
      LEGACY_IGNORED(networkId),
      read(LEGACY_IGNORED(networkId)).filter((a) => !same(a, contract)),
    );
}

export function hiddenPieces(networkId: string, wallet: string): string[] {
  return read(PIECES(networkId, wallet));
}

export function setPieceHidden(
  networkId: string,
  wallet: string,
  contract: string,
  tokenId: string,
  hidden: boolean,
) {
  const key = `${contract}:${tokenId}`;
  const list = read(PIECES(networkId, wallet)).filter((k) => k !== key);
  write(PIECES(networkId, wallet), hidden ? [...list, key] : list);
}
