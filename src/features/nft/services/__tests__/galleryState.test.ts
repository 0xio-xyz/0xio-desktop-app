import { describe, it, expect, beforeEach } from "vitest";
import { BASELINE_WINDOW_MS, pieceKey, stampPieces } from "src/features/nft/services/firstSeen";
import {
  hiddenCollections,
  hiddenPieces,
  setCollectionHidden,
  setPieceHidden,
} from "src/features/nft/services/hidden";

const W = "oct1wallet";
const A = { contract: "octA", tokenId: "1" };
const B = { contract: "octA", tokenId: "2" };

describe("stampPieces", () => {
  it("stamps the first scan as time unknown", () => {
    const m = stampPieces({}, "devnet", W, [A], 1000);
    expect(m[pieceKey("devnet", W, "octA", "1")]).toBe(0);
  });

  it("stamps a piece that arrives after the baseline window", () => {
    const first = stampPieces({}, "devnet", W, [A], 1000);
    const later = 1000 + BASELINE_WINDOW_MS + 1;
    const m = stampPieces(first, "devnet", W, [A, B], later);
    expect(m[pieceKey("devnet", W, "octA", "1")]).toBe(0);
    expect(m[pieceKey("devnet", W, "octA", "2")]).toBe(later);
  });

  it("keeps network and wallet apart", () => {
    const m = stampPieces({}, "devnet", W, [A], 1000);
    const later = 1000 + BASELINE_WINDOW_MS + 1;
    const other = stampPieces(m, "mainnet", W, [A], later);
    expect(other[pieceKey("mainnet", W, "octA", "1")]).toBe(0);
  });

  it("returns the same map when nothing is new", () => {
    const m = stampPieces({}, "devnet", W, [A], 1000);
    expect(stampPieces(m, "devnet", W, [A], 2000)).toBe(m);
  });
});

describe("hidden", () => {
  beforeEach(() => localStorage.clear());

  it("hides and shows a collection per network and wallet", () => {
    setCollectionHidden("devnet", W, "octA", true);
    expect(hiddenCollections("devnet", W)).toEqual(["octA"]);
    expect(hiddenCollections("mainnet", W)).toEqual([]);
    expect(hiddenCollections("devnet", "oct1other")).toEqual([]);
    setCollectionHidden("devnet", W, "OCTA", false);
    expect(hiddenCollections("devnet", W)).toEqual([]);
  });

  it("showing lifts an old per-network ignore", () => {
    localStorage.setItem("0xio_ignored_nfts_devnet", JSON.stringify(["octA"]));
    expect(hiddenCollections("devnet", W)).toEqual(["octA"]);
    setCollectionHidden("devnet", W, "octA", false);
    expect(hiddenCollections("devnet", W)).toEqual([]);
  });

  it("hides a single piece", () => {
    setPieceHidden("devnet", W, "octA", "7", true);
    expect(hiddenPieces("devnet", W)).toEqual(["octA:7"]);
    setPieceHidden("devnet", W, "octA", "7", false);
    expect(hiddenPieces("devnet", W)).toEqual([]);
  });
});
