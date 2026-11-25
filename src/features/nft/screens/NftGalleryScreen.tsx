import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "src/lib/router";
import { ChevronRight } from "src/shared/ui/icons";
import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import { Btn, Caps, EASE, FOCUS, KV } from "src/shared/ui/look";
import NftCard from "src/features/nft/components/NftCard";
import NftImportDrawer from "src/features/nft/components/NftImportDrawer";
import {
  DotsMenu,
  NewestHero,
  Shelf,
  ShelfTile,
  UndoBar,
  pieceId,
  type GalleryPiece,
  type MenuItem,
  type UndoState,
} from "src/features/nft/components/NftShelf";
import { useOnsContract } from "src/hooks/wallet/useOns";
import { useWallet } from "src/contexts/useWallet";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { Screen, PageTitle, Action, ScrollArea } from "src/shared/ui/flat";
import { xpectrumConfig } from "src/features/nft/services/xpectrum/config";
import type { Listing } from "src/features/nft/services/xpectrum/market";
import { useTokenDetails } from "src/features/nft/hooks/useTokenDetails";
import {
  type NftCollection,
  useNftCollections,
  useNftHidden,
  useNftActions,
  nftDisplayName,
  octrascanAddressUrl,
} from "src/features/nft/services/data";

export interface GalleryUndoHint {
  kind: "piece" | "collection";
  contract: string;
  tokenId?: string;
  label: string;
}

const lower = (a: string) => a.toLowerCase();

const FIND = [
  { name: "Xpectrum", url: "https://app.xpectrum.xyz" },
  { name: "Euints", url: "https://euints.com" },
  { name: "Biont Network", url: "https://biont.network" },
];

export default function NftGalleryScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address;
  const market = xpectrumConfig(networkId)?.market ?? null;
  const { getPrice } = useTokenPrice();
  const octUsd = getPrice("OCT") ?? null;

  const { data: held = [], isLoading, isFetching } = useNftCollections(address, networkId);
  const names = useOnsContract();
  const collections = useMemo(
    () => held.map((c) => (c.contractAddress === names ? { ...c, name: t("ons.collection") } : c)),
    [held, names, t],
  );
  const { data: hidden = { collections: [], pieces: [] } } = useNftHidden(address, networkId);
  const actions = useNftActions(address, networkId);
  const { details, reset } = useTokenDetails(collections, networkId);
  const [importOpen, setImportOpen] = useState(false);

  const [listings, setListings] = useState<Record<string, Listing | null>>({});
  const onListingKnown = (contract: string, tokenId: string, listing: Listing | null) =>
    setListings((prev) =>
      prev[`${contract}:${tokenId}`] === listing
        ? prev
        : { ...prev, [`${contract}:${tokenId}`]: listing },
    );

  const undoKey = useRef(0);
  const [undo, setUndo] = useState<UndoState | null>(() => {
    const hint = (location.state as { undo?: GalleryUndoHint } | null)?.undo;
    if (!hint || !address) return null;
    return {
      key: ++undoKey.current,
      label: hint.label,
      undo: () =>
        hint.kind === "piece" && hint.tokenId
          ? actions.setPieceShown(hint.contract, hint.tokenId, true)
          : actions.setCollectionShown(hint.contract, true),
    };
  });
  const offerUndo = (label: string, run: () => void) =>
    setUndo({ key: ++undoKey.current, label, undo: run });

  const hiddenColls = useMemo(() => new Set(hidden.collections.map(lower)), [hidden]);
  const hiddenPieces = useMemo(() => new Set(hidden.pieces.map((k) => lower(k))), [hidden]);

  const pieces = useMemo(() => {
    const out: GalleryPiece[] = [];
    for (const c of collections) {
      const list = details[c.contractAddress];
      for (const id of c.ownedTokenIds) {
        const d = list?.find((x) => x.tokenId === id);
        if (d?.burned) continue;
        out.push({
          detail: d ?? {
            tokenId: id,
            uri: null,
            image: null,
            metaName: null,
            metaDescription: null,
            animationUrl: null,
            metaFetched: false,
          },
          collection: c,
          seen: c.firstSeen?.[id] ?? 0,
        });
      }
    }
    // Newest first; pieces already held on the first scan keep their collection order.
    return out.sort((a, b) => b.seen - a.seen);
  }, [collections, details]);

  const isHidden = (p: GalleryPiece) =>
    hiddenColls.has(lower(p.collection.contractAddress)) || hiddenPieces.has(lower(pieceId(p)));
  const shown = pieces.filter((p) => !isHidden(p));
  const hiddenList = pieces.filter(isHidden);
  const hero = shown[0] ?? null;

  const shelves = collections
    .filter((c) => !hiddenColls.has(lower(c.contractAddress)))
    .map((c) => ({
      collection: c,
      items: shown.filter((p) => p.collection.contractAddress === c.contractAddress),
    }))
    .filter((s) => s.items.length > 0 || s.collection.imported);

  const showSkeleton = collections.length === 0 && (isLoading || isFetching);
  const isEmpty = !showSkeleton && shelves.length === 0 && hiddenList.length === 0;

  const open = (p: GalleryPiece) =>
    navigate(`/nfts/${p.collection.contractAddress}/${p.detail.tokenId}`);

  const hideCollection = (c: NftCollection) => {
    actions.setCollectionShown(c.contractAddress, false);
    offerUndo(`${c.name} hidden`, () => actions.setCollectionShown(c.contractAddress, true));
  };

  const shelfMenu = (c: NftCollection): MenuItem[] => [
    { label: "Hide collection", onSelect: () => hideCollection(c) },
    {
      label: "Copy contract",
      onSelect: () => void navigator.clipboard.writeText(c.contractAddress),
    },
    {
      label: "View on Octrascan",
      onSelect: () =>
        navigate(
          `/browser?url=${encodeURIComponent(octrascanAddressUrl(networkId, c.contractAddress))}`,
        ),
    },
    ...(c.imported
      ? [
          {
            label: "Remove import",
            danger: true,
            onSelect: () => actions.removeCollection(c.contractAddress),
          },
        ]
      : []),
  ];

  const handleRefresh = () => {
    reset();
    actions.invalidate();
  };

  return (
    <Screen onRefresh={handleRefresh} refreshing={isFetching}>
      <PageTitle
        title="NFTs"
        right={
          <Action weight="primary" onClick={() => setImportOpen(true)}>
            {t("nftPage.import")}
          </Action>
        }
      />

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(16.25rem,0.5fr)] gap-7">
        {isEmpty ? (
          <section className="flex min-h-0 flex-col items-center justify-center px-8 text-center">
            <Mascot id="nfts-empty" phase="ok" size={84} />
            <h3 className="mt-5.5 text-title font-semibold text-content">
              {t("nftPage.emptyTitle")}
            </h3>
            <div className="mt-5.5 flex gap-2">
              <Btn
                size="sm"
                weight="primary"
                className="look-key"
                onClick={() => setImportOpen(true)}
              >
                {t("nftPage.import")}
              </Btn>
              <Btn size="sm" onClick={() => address && void navigator.clipboard.writeText(address)}>
                {t("nftPage.copyAddress")}
              </Btn>
            </div>
          </section>
        ) : (
          <ScrollArea fade>
            {showSkeleton ? (
              <GallerySkeleton />
            ) : (
              <div className="flex flex-col gap-8 pb-16">
                {hero && (
                  <NewestHero
                    piece={hero}
                    market={market}
                    listing={listings[pieceId(hero)]}
                    octUsd={octUsd}
                    onOpen={() => open(hero)}
                    onListingKnown={onListingKnown}
                  />
                )}

                {shelves.map(({ collection: c, items }) => (
                  <Shelf
                    key={c.contractAddress}
                    title={c.name}
                    count={items.length}
                    menu={shelfMenu(c)}
                  >
                    {items.length === 0 ? (
                      <p className="text-meta text-content-secondary py-6">
                        This wallet holds none from this collection.
                      </p>
                    ) : (
                      items.map((p) => (
                        <ShelfTile key={pieceId(p)}>
                          <NftCard
                            variant="shelf"
                            detail={p.detail}
                            collectionName={c.name}
                            contractAddress={c.contractAddress}
                            market={market}
                            onClick={() => open(p)}
                            onListingKnown={onListingKnown}
                          />
                        </ShelfTile>
                      ))
                    )}
                  </Shelf>
                ))}

                {hiddenList.length > 0 && (
                  <HiddenShelf
                    items={hiddenList}
                    hiddenColls={hiddenColls}
                    market={market}
                    onOpen={open}
                    onShowCollection={(addr) => actions.setCollectionShown(addr, true)}
                    onShowPiece={(addr, id) => actions.setPieceShown(addr, id, true)}
                  />
                )}
              </div>
            )}
          </ScrollArea>
        )}
        <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
          {isEmpty ? (
            <>
              <Caps>{t("nftPage.whereToFind")}</Caps>
              <div className="-mx-3 mt-2.5">
                {FIND.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => navigate(`/browser?url=${encodeURIComponent(f.url)}`)}
                    className={`flex h-14 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-body font-medium text-content">
                      {f.name}
                    </span>
                    <ChevronRight size={14} className="shrink-0 text-content-muted" />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Caps>{t("nftPage.collection")}</Caps>
              <KV label={t("nftPage.pieces")}>{showSkeleton ? "" : shown.length}</KV>
              <KV label={t("nftPage.collections")}>{showSkeleton ? "" : shelves.length}</KV>
              <KV label={t("nftPage.listed")}>{Object.values(listings).filter(Boolean).length}</KV>
              <KV label={t("nftPage.hidden")}>{hiddenList.length}</KV>
              <Caps className="mt-5 mb-1">{t("nftPage.newest")}</Caps>
              {shown.slice(0, 3).map((p) => (
                <button
                  key={pieceId(p)}
                  type="button"
                  onClick={() => open(p)}
                  className={`-mx-3 flex h-12 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
                >
                  <span className="truncate text-body font-medium text-content">
                    {nftDisplayName(p.detail)}
                  </span>
                  <span className="shrink-0 truncate text-meta text-content-muted">
                    {p.collection.name}
                  </span>
                </button>
              ))}
            </>
          )}
        </aside>
      </div>

      {undo && <UndoBar state={undo} onDone={() => setUndo(null)} />}

      <NftImportDrawer
        open={importOpen}
        onClose={() => setImportOpen(false)}
        networkId={networkId}
        walletAddress={address}
        onImport={actions.importCollection}
      />
    </Screen>
  );
}

function HiddenShelf({
  items,
  hiddenColls,
  market,
  onOpen,
  onShowCollection,
  onShowPiece,
}: {
  items: GalleryPiece[];
  hiddenColls: Set<string>;
  market: string | null;
  onOpen: (p: GalleryPiece) => void;
  onShowCollection: (contract: string) => void;
  onShowPiece: (contract: string, tokenId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <div className="flex items-center gap-2.5 mb-3">
        <h3 className="text-body font-semibold text-content-secondary">Hidden</h3>
        <span className="text-micro text-content-secondary">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto h-8 px-3 rounded-lg text-meta font-medium text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer"
        >
          {open ? "Close" : "View"}
        </button>
      </div>
      {open && (
        <div className="flex gap-3.5 overflow-x-auto scrollbar-hide animate-in fade-in duration-200">
          {items.map((p) => {
            const byCollection = hiddenColls.has(lower(p.collection.contractAddress));
            return (
              <ShelfTile key={pieceId(p)}>
                <div className="relative opacity-60 hover:opacity-100 transition-opacity">
                  <NftCard
                    variant="shelf"
                    detail={p.detail}
                    collectionName={p.collection.name}
                    contractAddress={p.collection.contractAddress}
                    market={market}
                    onClick={() => onOpen(p)}
                  />
                  <div className="absolute top-2 right-1.5">
                    <DotsMenu
                      label={`${nftDisplayName(p.detail)} options`}
                      items={[
                        byCollection
                          ? {
                              label: `Show ${p.collection.name}`,
                              onSelect: () => onShowCollection(p.collection.contractAddress),
                            }
                          : {
                              label: "Show piece",
                              onSelect: () =>
                                onShowPiece(p.collection.contractAddress, p.detail.tokenId),
                            },
                      ]}
                    />
                  </div>
                </div>
              </ShelfTile>
            );
          })}
        </div>
      )}
    </section>
  );
}

function GallerySkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-6.5 p-3.5">
        <div className="w-50 aspect-square rounded-[14px] bg-surface-highlight animate-pulse" />
        <div className="flex-1 py-2 space-y-2.5">
          <div className="h-3 w-16 rounded bg-surface-highlight animate-pulse" />
          <div className="h-5 w-48 rounded bg-surface-highlight animate-pulse" />
        </div>
      </div>
      <div className="flex gap-3.5 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-42 shrink-0">
            <div className="aspect-square rounded-[14px] bg-surface-highlight animate-pulse" />
            <div className="h-3 w-[60%] mt-3 rounded bg-surface-highlight animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
