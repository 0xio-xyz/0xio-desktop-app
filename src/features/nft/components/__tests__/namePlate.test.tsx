// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const ONS = "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN";
const OTHER = `oct${"B".repeat(44)}`;
const MARKET = `oct${"M".repeat(44)}`;

const m = vi.hoisted(() => ({ listing: vi.fn(), approved: vi.fn(), listable: vi.fn() }));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: "devnet" }) }));
vi.mock("src/features/nft/services/xpectrum/market", () => ({
  getActiveListing: (...a: unknown[]) => m.listing(...a),
  isApprovedFor: (...a: unknown[]) => m.approved(...a),
}));
vi.mock("src/features/nft/services/listability", () => ({
  resolveListability: (...a: unknown[]) => m.listable(...a),
  cachedListability: () => "unknown",
}));
vi.mock("src/features/nft/services/xpectrum/config", () => ({ MICRO_OCT: 1_000_000 }));
vi.mock("src/features/nft/services/euint/protocol", () => ({ isLivingProgramUri: () => false }));
vi.mock("src/features/nft/services/euint/LivingNftFrame", () => ({ LivingNftFrame: () => null }));
vi.mock("src/hooks/wallet/useOns", () => ({
  useOnsContract: () => "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN",
}));
vi.mock("src/features/nft/services/data", () => ({
  nftDisplayName: (d: { metaName: string | null; tokenId: string }) =>
    d.metaName || `#${d.tokenId}`,
  getNftPoster: async () => null,
  setNftPoster: vi.fn(),
  getCachedMarketState: () => null,
  setCachedMarketState: vi.fn(),
  MARKET_REVALIDATE_MS: 60_000,
}));

import "src/i18n";
import NamePlate from "src/features/nft/components/NamePlate";
import NftCard from "src/features/nft/components/NftCard";
import type { NftTokenDetail } from "src/features/nft/services/data";

const LONG = "abcdefghijklmnopqrstuvwxyz012345";
const NAMES = ["0xio.oct", `${LONG}.oct`, "my-old-shop-2026.oct"];

const piece = (over: Partial<NftTokenDetail>): NftTokenDetail => ({
  tokenId: "7",
  uri: null,
  image: null,
  metaName: null,
  metaDescription: null,
  animationUrl: null,
  metaFetched: true,
  ...over,
});

const plateText = (root: HTMLElement) =>
  root.querySelector("[data-name-plate] p")?.textContent ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  m.listing.mockResolvedValue(null);
  m.approved.mockResolvedValue(false);
  m.listable.mockResolvedValue("listable");
});
afterEach(cleanup);

describe("name plate", () => {
  it("has a 32 character name to draw", () => {
    expect(LONG).toHaveLength(32);
  });

  it.each(NAMES)("draws %s whole at tile and page size", (name) => {
    for (const size of ["tile", "page"] as const) {
      const { container, unmount } = render(<NamePlate name={name} size={size} />);
      expect(plateText(container)).toBe(name);
      expect(container.textContent).not.toMatch(/…|\.\.\./);
      expect(container.querySelector(".truncate")).toBeNull();
      expect(container.querySelector("img, svg image, iframe")).toBeNull();
      unmount();
    }
  });

  it("is the same markup for the same name", () => {
    const a = render(<NamePlate name="0xio.oct" />).container.innerHTML;
    cleanup();
    expect(render(<NamePlate name="0xio.oct" />).container.innerHTML).toBe(a);
  });

  it("steps the type down for a long name instead of cutting it", () => {
    const size = (name: string) =>
      (
        render(<NamePlate name={name} />).container.querySelector("p") as HTMLElement
      ).style.getPropertyValue("--plate-type");
    expect(size("0xio.oct")).toBe("9.5cqw");
    expect(size("my-old-shop-2026.oct")).toBe("8cqw");
    expect(size(`${LONG}.oct`)).toBe("7cqw");
  });

  it("holds its place while the name is read and dims when it is no longer active", () => {
    const loading = render(<NamePlate name={null} />).container;
    expect(loading.querySelector("[data-name-plate]")).not.toBeNull();
    expect(plateText(loading)).toBe("");
    cleanup();
    const off = render(<NamePlate name="oldshop.oct" inactive />).container;
    expect(plateText(off)).toBe("oldshop.oct");
    expect(off.textContent).toBe("oldshop.oct");
    expect(off.querySelector(".look-plate-off")).not.toBeNull();
  });
});

describe("gallery tile", () => {
  const tile = (contract: string, detail: NftTokenDetail) =>
    render(
      <NftCard
        variant="shelf"
        detail={detail}
        collectionName="Any"
        contractAddress={contract}
        market={MARKET}
        onClick={() => {}}
      />,
    ).container;

  const ART = "data:image/svg+xml;base64,PHN2Zy8+";
  const media = (root: HTMLElement) => root.querySelector(".aspect-square") as HTMLElement;

  it.each(NAMES)("shows the artwork of the name %s with the name under it", (name) => {
    const root = tile(ONS, piece({ metaName: name, image: ART }));
    expect(root.querySelector("img")?.getAttribute("src")).toBe(ART);
    expect(root.querySelector("img")?.getAttribute("alt")).toBe(name);
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    expect(media(root).textContent).toBe("");
    expect(root.querySelector(".aspect-square + p")?.textContent).toBe(name);
    expect(m.listing).not.toHaveBeenCalled();
    expect(m.listable).not.toHaveBeenCalled();
  });

  it("shows the loading state of any piece while a name loads, in the same square", () => {
    const root = tile(ONS, piece({ metaFetched: false, image: ART }));
    expect(root.querySelector(".aspect-square .animate-spin")).not.toBeNull();
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });

  it("falls back to the plate when a name has no artwork", () => {
    const root = tile(ONS, piece({ metaName: "0xio.oct" }));
    expect(plateText(root)).toBe("0xio.oct");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".look-plate")).not.toBeNull();
    expect(media(root).textContent).toBe("0xio.oct");
  });

  it("falls back to the plate when the image of a name does not load", () => {
    const root = tile(ONS, piece({ metaName: "0xio.oct", image: ART }));
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    fireEvent.error(root.querySelector("img") as HTMLImageElement);
    expect(plateText(root)).toBe("0xio.oct");
    expect(root.querySelector("img")).toBeNull();
  });

  it("tags an expired name Expired at the bottom right of the artwork, same square", () => {
    const active = tile(ONS, piece({ metaName: "0xio.oct", image: ART, inactive: false }));
    const square = media(active).className;
    cleanup();
    const root = tile(
      ONS,
      piece({ metaName: "oldshop.oct", image: ART, inactive: true, expired: true }),
    );
    expect(root.querySelector("img")?.getAttribute("src")).toBe(ART);
    const tag = media(root).querySelector("span") as HTMLElement;
    expect(tag.textContent).toBe("Expired");
    expect(tag.className).toContain("absolute");
    expect(tag.className).toContain("right-2.25");
    expect(tag.className).toContain("bottom-2.25");
    expect(tag.className).toContain("bg-black/55");
    expect(media(root).className).toBe(square);
  });

  it("tags an expired name on its plate too, dimmed", () => {
    const root = tile(ONS, piece({ metaName: "oldshop.oct", inactive: true, expired: true }));
    expect(root.querySelector(".look-plate-off")).not.toBeNull();
    expect(media(root).querySelector("span.absolute")?.textContent).toBe("Expired");
  });

  it.each([
    ["active", { inactive: false, expired: false }],
    ["not read yet", {}],
    ["not active for a reason that is not an expiry", { inactive: true, expired: false }],
  ])("tags nothing on a name that is %s", (_, state) => {
    const root = tile(ONS, piece({ metaName: "0xio.oct", image: ART, ...state }));
    expect(media(root).textContent).toBe("");
    expect(root.textContent).toBe("0xio.oct");
  });

  it("never tags another collection", () => {
    const root = tile(
      OTHER,
      piece({ metaName: "Shape", image: ART, inactive: true, expired: true }),
    );
    expect(root.textContent).not.toContain("Expired");
  });

  it("leaves other collections as they were", () => {
    const root = tile(OTHER, piece({ metaName: "Shape", image: "https://art.example/1.png" }));
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    expect(root.querySelector("img")?.getAttribute("src")).toBe("https://art.example/1.png");
    expect(root.querySelector("p")?.textContent).toBe("Shape");
    expect(m.listing).toHaveBeenCalledWith(MARKET, OTHER, 7);
    expect(m.listable).toHaveBeenCalled();
  });
});
