// Xmarket_v3 views are pipe-delimited; amounts are micro-OCT.

import {
  callViewStrict,
  splitPipe,
  toNum,
  isContractRevert,
} from "src/features/nft/services/xpectrum/read";

export interface Listing {
  id: number;
  seller: string;
  contract: string;
  tokenId: number;
  price: number; // micro-OCT
  status: number; // 1 active, 2 sold, 0 cancelled
  epoch: number;
}

// Per-token approval only (no operator-for-all). A listing escrows the NFT, so the approval is
// cleared on transfer and must be granted again before each new listing. Strict: a node timeout
// throws so the caller keeps the last known value.
export async function isApprovedFor(
  nftContract: string,
  tokenId: number,
  operator: string,
): Promise<boolean> {
  const spender = await callViewStrict(nftContract, "get_approved", [tokenId]);
  return !!spender && spender.trim() === operator;
}

// get_listing -> id|seller|contract|tokenId|price|status|epoch
async function getListing(market: string, listingId: number): Promise<Listing | null> {
  const f = splitPipe(await callViewStrict(market, "get_listing", [listingId]));
  if (f.length < 7) return null;
  return {
    id: toNum(f[0]),
    seller: f[1],
    contract: f[2],
    tokenId: toNum(f[3]),
    price: toNum(f[4]),
    status: toNum(f[5]),
    epoch: toNum(f[6]),
  };
}

// get_token_listing -> listing_id + 1 (0 = unlisted).
export async function getActiveListing(
  market: string,
  nftContract: string,
  tokenId: number,
): Promise<Listing | null> {
  // A node timeout throws instead of reading as "not listed"; a contract revert is a real answer.
  let raw: string | null;
  try {
    raw = await callViewStrict(market, "get_token_listing", [nftContract, tokenId]);
  } catch (e) {
    if (isContractRevert(e)) return null;
    throw e;
  }
  const idPlus1 = toNum(raw ?? undefined);
  if (!idPlus1) return null;
  const listing = await getListing(market, idPlus1 - 1);
  return listing && listing.status === 1 ? listing : null;
}
