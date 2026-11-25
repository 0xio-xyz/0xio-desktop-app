// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "src/lib/router";

const ONS = "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN";
const OTHER = `oct${"B".repeat(44)}`;
const EXPIRES = Date.UTC(2028, 2, 12, 12) / 1000;

const m = vi.hoisted(() => ({
  cached: {} as Record<string, unknown[]>,
  fetch: vi.fn(),
  facts: vi.fn(),
  invalidate: vi.fn(),
  traits: vi.fn(),
  listing: vi.fn(),
  approved: vi.fn(),
  listable: vi.fn(),
}));

vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: { id: "w1", name: "Spending", address: `oct${"A".repeat(44)}` },
    networkId: "devnet",
    showMessage: vi.fn(),
  }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getPrice: () => null }),
}));
vi.mock("src/hooks/transactions/useFees", () => ({
  useFee: () => ({ fee: { recommended: "1700" } }),
}));
vi.mock("src/lib/openExternal", () => ({ openInSystemBrowser: vi.fn() }));
vi.mock("src/shared/ui/ConfirmDialog", () => ({ default: () => null }));
vi.mock("src/shared/ui/flat", () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ title, right }: { title: string; right?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {right}
    </header>
  ),
}));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/features/nft/components/NftSendDrawer", () => ({
  default: ({ open, detail }: { open: boolean; detail: { tokenId: string } }) => (
    <div data-testid="send-drawer" data-open={String(open)} data-token={detail.tokenId} />
  ),
}));
vi.mock("src/features/nft/components/NftMarketDrawer", () => ({
  default: () => <div data-testid="market-drawer" />,
}));
vi.mock("src/features/nft/components/NftShelf", () => ({
  DotsMenu: ({ items }: { items: { label: string; onSelect: () => void }[] }) => (
    <nav>
      {items.map((item) => (
        <button key={item.label} type="button" onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("src/features/nft/components/NftCard", () => ({
  NameStatusTag: ({ detail }: { detail: { expired?: boolean } | null }) =>
    detail?.expired ? <span data-testid="tag">Expired</span> : null,
}));
vi.mock("src/features/nft/services/xpectrum/config", () => ({
  xpectrumConfig: () => ({ market: `oct${"M".repeat(44)}` }),
  MICRO_OCT: 1_000_000,
}));
vi.mock("src/features/nft/services/xpectrum/market", () => ({
  getActiveListing: (...a: unknown[]) => m.listing(...a),
  isApprovedFor: (...a: unknown[]) => m.approved(...a),
}));
vi.mock("src/features/nft/services/listability", () => ({
  resolveListability: (...a: unknown[]) => m.listable(...a),
  cachedListability: () => "listable",
}));
vi.mock("src/features/nft/services/euint/LivingNftFrame", () => ({ LivingNftFrame: () => null }));
vi.mock("src/features/nft/services/euint/protocol", () => ({ isLivingProgramUri: () => false }));
vi.mock("src/features/nft/services/euint/chainState", () => ({ isMutableToken: () => false }));
vi.mock("src/hooks/wallet/useOns", () => ({
  useOnsContract: () => "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN",
}));
vi.mock("src/features/nft/services/data", () => ({
  useNftCollections: () => ({
    data: [
      { contractAddress: "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN", name: "ONS" },
      { contractAddress: `oct${"B".repeat(44)}`, name: "Shapes" },
    ],
  }),
  useNftActions: () => ({ setPieceShown: vi.fn(), setCollectionShown: vi.fn() }),
  fetchTokenDetails: (...a: unknown[]) => m.fetch(...a),
  readNameFacts: (...a: unknown[]) => m.facts(...a),
  nameTraits: (traits: { k: string; v: string }[] | null) =>
    (traits ?? []).filter((t) => !["Expires", "Points to", "Owner", "Status"].includes(t.k)),
  keepArt: (old: Record<string, unknown> | null, fresh: Record<string, unknown>) =>
    !old || fresh.image
      ? fresh
      : {
          ...old,
          metaName: fresh.metaName ?? old.metaName,
          inactive: fresh.inactive ?? old.inactive,
          expired: fresh.expired ?? old.expired,
          expires: fresh.expires ?? old.expires,
        },
  getCachedTokenDetails: () => m.cached,
  resolveNftTraits: (...a: unknown[]) => m.traits(...a),
  getCachedTraits: () => null,
  setCachedTraits: vi.fn(),
  invalidateNftMetadata: (...a: unknown[]) => m.invalidate(...a),
  invalidateMarketState: vi.fn(),
  octrascanAddressUrl: () => "",
  nftDisplayName: (d: { metaName: string | null; tokenId: string }) =>
    d.metaName || `#${d.tokenId}`,
  setNftPoster: vi.fn(),
}));

import "src/i18n";
import NftDetailScreen from "src/features/nft/screens/NftDetailScreen";

const META = "https://names.example/meta/7.json";
const ART = "data:image/svg+xml;base64,PHN2Zy8+";
const name = (over: Record<string, unknown> = {}) => ({
  tokenId: "7",
  uri: META,
  image: ART,
  metaName: "0xio.oct",
  metaDescription: null,
  animationUrl: null,
  metaFetched: true,
  inactive: false,
  expired: false,
  expires: EXPIRES,
  ...over,
});

function open(contract: string) {
  return render(
    <MemoryRouter initialEntries={[`/nfts/${contract}/7`]}>
      <Routes>
        <Route path="/nfts/:contract/:tokenId" element={<NftDetailScreen />} />
        <Route path="/nfts" element={<div>gallery</div>} />
      </Routes>
    </MemoryRouter>,
  ).container;
}

const facts = (root: HTMLElement) => within(root.querySelector("aside") as HTMLElement);
const row = (root: HTMLElement, label: string) =>
  facts(root).getByText(label).parentElement?.lastElementChild?.textContent;
const plate = (root: HTMLElement) => root.querySelector('[data-name-plate="page"]');

beforeEach(() => {
  vi.clearAllMocks();
  m.cached = {};
  m.fetch.mockImplementation(async () => [name()]);
  m.facts.mockImplementation(async () => ({
    metaName: "0xio.oct",
    inactive: false,
    expired: false,
    expires: EXPIRES,
  }));
  m.traits.mockResolvedValue({ traits: null, rarity: null });
  m.listing.mockResolvedValue(null);
  m.approved.mockResolvedValue(false);
  m.listable.mockResolvedValue("listable");
});
afterEach(cleanup);

const art = (root: HTMLElement) => root.querySelector(".aspect-square") as HTMLElement;
const menu = (label: string) => within(screen.getByRole("navigation")).getByText(label);

describe("a name's page", () => {
  it("shows the loading state of any piece before anything is read", () => {
    m.fetch.mockReturnValue(new Promise(() => {}));
    const root = open(ONS);
    expect(art(root).querySelector(".animate-spin")).not.toBeNull();
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    expect(row(root, "Status")).toBe("");
    expect(facts(root).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows an active name with its artwork, its chain rows and Transfer", async () => {
    m.traits.mockResolvedValue({
      traits: [
        { k: "Length", v: "4" },
        { k: "Points to", v: "octOTHER" },
        { k: "Expires", v: "1836432000" },
      ],
      rarity: null,
    });
    const root = open(ONS);
    await waitFor(() => expect(row(root, "Status")).toBe("Active"));
    expect(art(root).querySelector("img")?.getAttribute("src")).toBe(ART);
    expect(art(root).querySelector("img")?.getAttribute("alt")).toBe("0xio.oct");
    expect(plate(root)).toBeNull();
    expect(screen.queryByTestId("tag")).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("0xio.oct");
    expect(row(root, "Collection")).toBe("Octra names");
    expect(row(root, "Owner")).toBe("Spending");
    expect(row(root, "Expires")).toBe("12 Mar 2028");
    for (const gone of ["Market", "Held by", "Standard", "Contract"])
      expect(facts(root).queryByText(gone)).toBeNull();

    await waitFor(() => expect(m.traits).toHaveBeenCalledWith(META));
    await waitFor(() => expect(facts(root).getByText("Length")).toBeTruthy());
    expect(facts(root).queryByText("Points to")).toBeNull();
    expect(facts(root).queryByText("octOTHER")).toBeNull();
    expect(facts(root).queryByText("1836432000")).toBeNull();

    const buttons = facts(root).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Transfer"]);
    expect(screen.getByTestId("send-drawer").dataset.open).toBe("false");
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId("send-drawer").dataset.open).toBe("true");

    expect(screen.queryByTestId("market-drawer")).toBeNull();
    expect(m.listing).not.toHaveBeenCalled();
    expect(m.approved).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain("Not active");
  });

  it("falls back to the plate when a name has no artwork", async () => {
    m.fetch.mockImplementation(async () => [name({ uri: null, image: null })]);
    const root = open(ONS);
    await waitFor(() => expect(plate(root)?.querySelector("p")?.textContent).toBe("0xio.oct"));
    expect(root.querySelector("img")).toBeNull();
    expect(art(root).className).toContain("look-raise");
  });

  it("falls back to the plate when the image does not load", async () => {
    const root = open(ONS);
    await waitFor(() => expect(art(root).querySelector("img")).not.toBeNull());
    expect(plate(root)).toBeNull();
    fireEvent.error(art(root).querySelector("img") as HTMLImageElement);
    expect(plate(root)?.querySelector("p")?.textContent).toBe("0xio.oct");
    expect(root.querySelector("img")).toBeNull();
  });

  it("reads only the chain facts of a name whose artwork is kept, and keeps the artwork", async () => {
    m.cached = { [ONS]: [name()] };
    m.facts.mockImplementation(async () => ({
      metaName: "0xio.oct",
      inactive: true,
      expired: true,
      expires: EXPIRES,
    }));
    const root = open(ONS);
    expect(art(root).querySelector("img")?.getAttribute("src")).toBe(ART);
    await waitFor(() => expect(row(root, "Status")).toBe("Expired"));
    expect(m.facts).toHaveBeenCalledWith(ONS, "7");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(art(root).querySelector("img")?.getAttribute("src")).toBe(ART);
    expect(within(art(root)).getByTestId("tag").textContent).toBe("Expired");
  });

  it.each([
    ["in grace", { expires: Date.UTC(2026, 9, 3, 12) / 1000 }, "3 Oct 2026"],
    ["lapsed", { expires: undefined, uri: null, image: null }, ""],
  ])("marks a name that is %s Expired and offers nothing", async (_, state, expired) => {
    m.fetch.mockImplementation(async () => [
      name({ metaName: "oldshop.oct", inactive: true, expired: true, ...state }),
    ]);
    const root = open(ONS);
    await waitFor(() => expect(row(root, "Status")).toBe("Expired"));
    expect(within(art(root)).getByTestId("tag").textContent).toBe("Expired");
    expect(root.textContent).not.toContain("Not active");
    expect(facts(root).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText("Transfer")).toBeNull();
    expect(screen.queryByText("List for sale")).toBeNull();
    expect(screen.queryByTestId("send-drawer")).toBeNull();
    expect(screen.queryByTestId("market-drawer")).toBeNull();
    expect(facts(root).queryByText("Expires")).toBeNull();
    if ("image" in state) expect(plate(root)?.querySelector(".look-plate-off")).not.toBeNull();
    else expect(art(root).querySelector("img")).not.toBeNull();
    expect(
      facts(root).getAllByText("Expired")[0].parentElement?.lastElementChild?.textContent,
    ).toBe(expired);
  });

  it.each([
    ["not known", { inactive: undefined, expired: undefined }],
    ["not active for a reason that is not an expiry", { inactive: true, expired: false }],
  ])(
    "drops the Status row once the reads are done and the state is %s, in the same space",
    async (_, state) => {
      let done: (v: unknown[]) => void = () => {};
      m.fetch.mockReturnValue(new Promise((resolve) => (done = resolve)));
      const root = open(ONS);
      expect(row(root, "Status")).toBe("");
      const before = facts(root).getByText("Status").parentElement as HTMLElement;
      const slots = (root.querySelector("aside") as HTMLElement).querySelectorAll(
        ".min-h-11",
      ).length;
      expect(before.className).toContain("min-h-11");
      done([name(state)]);
      await waitFor(() => expect(facts(root).queryByText("Status")).toBeNull());
      expect(row(root, "Expires")).toBe("12 Mar 2028");
      expect(
        (root.querySelector("aside") as HTMLElement).querySelectorAll(".min-h-11"),
      ).toHaveLength(slots);
      expect(root.textContent).not.toContain("Not active");
      expect(screen.queryByTestId("tag")).toBeNull();
      expect(facts(root).queryAllByRole("button")).toHaveLength(0);
      expect(screen.queryByTestId("send-drawer")).toBeNull();
    },
  );

  it("offers Refresh metadata on a name and reads its artwork again past the caches", async () => {
    const root = open(ONS);
    await waitFor(() => expect(row(root, "Status")).toBe("Active"));
    const NEW = "data:image/png;base64,AAAA";
    m.fetch.mockClear();
    m.fetch.mockImplementation(async () => [name({ image: NEW })]);
    fireEvent.click(menu("Refresh metadata"));
    await waitFor(() => expect(art(root).querySelector("img")?.getAttribute("src")).toBe(NEW));
    expect(m.invalidate).toHaveBeenCalledWith("devnet", ONS, "7", META);
    expect(m.fetch).toHaveBeenCalledWith(ONS, ["7"]);
    expect(m.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      m.fetch.mock.invocationCallOrder[0],
    );
  });

  it("keeps the artwork shown when a refresh finds none, and takes the fresh status", async () => {
    const root = open(ONS);
    await waitFor(() => expect(row(root, "Status")).toBe("Active"));
    m.fetch.mockImplementation(async () => [
      name({ uri: null, image: null, inactive: true, expired: true }),
    ]);
    fireEvent.click(menu("Refresh metadata"));
    await waitFor(() => expect(row(root, "Status")).toBe("Expired"));
    expect(art(root).querySelector("img")?.getAttribute("src")).toBe(ART);
    expect(plate(root)).toBeNull();
    expect(facts(root).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("another collection's page", () => {
  it("is unchanged: its image, its rows, List for sale and Transfer", async () => {
    const shape = name({
      metaName: "Shape",
      uri: "https://art.example/1.json",
      image: "https://art.example/1.png",
      inactive: undefined,
      expires: undefined,
    });
    m.cached = { [OTHER]: [shape] };
    const root = open(OTHER);
    await waitFor(() => expect(m.listing).toHaveBeenCalled());
    await waitFor(() => expect(m.traits).toHaveBeenCalledWith("https://art.example/1.json"));
    expect(root.querySelector("[data-name-plate]")).toBeNull();
    expect(root.querySelector("img")?.getAttribute("src")).toBe("https://art.example/1.png");
    expect(row(root, "Collection")).toBe("Shapes");
    for (const kept of ["Market", "Held by", "Standard", "Contract"])
      expect(facts(root).getByText(kept)).toBeTruthy();
    for (const absent of ["Owner", "Expires", "Expired"])
      expect(facts(root).queryByText(absent)).toBeNull();
    expect(facts(root).getByText("List for sale")).toBeTruthy();
    expect(facts(root).getByText("Transfer")).toBeTruthy();
    expect(screen.getByTestId("market-drawer")).toBeTruthy();
    expect(m.fetch).not.toHaveBeenCalled();
  });
});
