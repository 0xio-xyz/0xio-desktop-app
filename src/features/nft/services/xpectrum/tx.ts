// Every write must run behind the review and tx-auth, and its effect be verified (confirm.ts):
// a confirmed tx can still have reverted.

import { callContract } from "src/services/contracts/contractService";
import type { TxScope } from "src/services/network/networkService";

interface XpectrumTxCtx {
  from: string;
  walletId: string;
  ou?: string;
  scope: TxScope;
}

function call(
  ctx: XpectrumTxCtx,
  contract: string,
  method: string,
  params: unknown[],
  amount = "0",
): Promise<string> {
  return callContract({
    contract,
    method,
    params,
    from: ctx.from,
    walletId: ctx.walletId,
    amount,
    ou: ctx.ou,
    scope: ctx.scope,
  });
}
export const approve = (ctx: XpectrumTxCtx, collection: string, spender: string, tokenId: number) =>
  call(ctx, collection, "approve", [spender, tokenId]);

export const listNft = (
  ctx: XpectrumTxCtx,
  market: string,
  nftContract: string,
  tokenId: number,
  priceMicroOct: number,
) => call(ctx, market, "list_nft", [nftContract, tokenId, priceMicroOct]);
export const cancelListing = (ctx: XpectrumTxCtx, market: string, listingId: number) =>
  call(ctx, market, "cancel_listing", [listingId]);
