import { useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "src/shared/ui/icons";
import NftCard from "src/features/nft/components/NftCard";
import type { Listing } from "src/features/nft/services/xpectrum/market";
import { MICRO_OCT } from "src/features/nft/services/xpectrum/config";
import {
  type NftCollection,
  type NftTokenDetail,
  nftDisplayName,
} from "src/features/nft/services/data";

export interface GalleryPiece {
  detail: NftTokenDetail;
  collection: NftCollection;
  /** 0 = already held on the wallet's first scan. */
  seen: number;
}

export const pieceId = (p: GalleryPiece) => `${p.collection.contractAddress}:${p.detail.tokenId}`;

const DAY_MS = 86_400_000;

function arrivedLabel(seen: number, now = Date.now()): string | null {
  if (!seen) return null;
  const days = Math.floor((now - seen) / DAY_MS);
  if (days <= 0) return "Arrived today";
  if (days === 1) return "Arrived yesterday";
  return `Arrived ${days} days ago`;
}

function priceLabel(listing: Listing, octUsd: number | null) {
  const oct = listing.price / MICRO_OCT;
  return {
    oct: `${parseFloat(oct.toFixed(6))} OCT`,
    usd: octUsd ? `$${(oct * octUsd).toFixed(2)}` : null,
  };
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function DotsMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={label}
        aria-expanded={open}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
          open
            ? "bg-surface-highlight text-content"
            : "text-content-secondary hover:text-content hover:bg-surface-card"
        }`}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 min-w-48 py-1.5 rounded-xl bg-surface-card shadow-[0_16px_40px_rgba(0,0,0,0.35)] animate-in fade-in zoom-in-95 duration-150 origin-top-right">
            {items.map((it) => (
              <button
                key={it.label}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onSelect();
                }}
                className={`block w-full text-left px-3.5 py-2 text-meta transition-colors cursor-pointer hover:bg-surface-highlight ${
                  it.danger ? "text-danger" : "text-content"
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NewestHero({
  piece,
  market,
  listing,
  octUsd,
  onOpen,
  onListingKnown,
}: {
  piece: GalleryPiece;
  market: string | null;
  listing: Listing | null | undefined;
  octUsd: number | null;
  onOpen: () => void;
  onListingKnown: (contract: string, tokenId: string, listing: Listing | null) => void;
}) {
  const arrived = arrivedLabel(piece.seen);
  const price = listing ? priceLabel(listing, octUsd) : null;
  return (
    <div
      onClick={onOpen}
      className="flex gap-6.5 p-3.5 rounded-[20px] cursor-pointer transition-colors duration-200 ease-out hover:bg-surface-card"
    >
      <div className="w-50 shrink-0">
        <NftCard
          variant="art"
          detail={piece.detail}
          collectionName={piece.collection.name}
          contractAddress={piece.collection.contractAddress}
          market={market}
          onClick={onOpen}
          onListingKnown={onListingKnown}
        />
      </div>
      <div className="flex-1 min-w-0 flex flex-col py-1.5 pr-2">
        <p className="text-meta text-content-secondary">Newest</p>
        <h2 className="text-[1.375rem] font-semibold text-content tracking-tight mt-1 truncate">
          {nftDisplayName(piece.detail)}
        </h2>
        <p className="text-meta text-content-secondary mt-0.5 truncate">{piece.collection.name}</p>
        <div className="mt-auto flex items-end justify-between gap-4">
          <span className="text-meta text-content-secondary">{arrived}</span>
          {price && (
            <span className="text-meta font-semibold text-content whitespace-nowrap">
              Listed at {price.oct}
              {price.usd && (
                <span className="ml-2 font-normal text-content-secondary">{price.usd}</span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const TILE_STEP = 182; // tile width plus gap

export function Shelf({
  title,
  count,
  menu,
  children,
}: {
  title: string;
  count: number;
  menu: MenuItem[];
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const step = Math.max(TILE_STEP, Math.floor(el.clientWidth / TILE_STEP) * TILE_STEP);
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };
  return (
    <section>
      <div className="flex items-center gap-2.5 mb-3">
        <h3 className="text-body font-semibold text-content truncate">{title}</h3>
        <span className="text-micro text-content-secondary shrink-0">
          {count} {count === 1 ? "item" : "items"}
        </span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => scroll(1)}
            aria-label="Scroll right"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer"
          >
            <ChevronRight size={16} />
          </button>
          <DotsMenu items={menu} label={`${title} options`} />
        </div>
      </div>
      <div
        ref={row}
        className="flex gap-3.5 overflow-x-auto scrollbar-hide snap-x snap-mandatory scroll-smooth"
      >
        {children}
      </div>
    </section>
  );
}

export function ShelfTile({ children }: { children: ReactNode }) {
  return <div className="w-42 shrink-0 snap-start">{children}</div>;
}

export interface UndoState {
  key: number;
  label: string;
  undo: () => void;
}

export function UndoBar({ state, onDone }: { state: UndoState; onDone: () => void }) {
  return (
    <div
      key={state.key}
      onAnimationEnd={(e) => e.animationName === "nft-undo-out" && onDone()}
      className="fixed bottom-7 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 pl-4 pr-1.5 py-1.5 rounded-xl bg-surface-card shadow-[0_16px_40px_rgba(0,0,0,0.4)] nft-undo"
    >
      <span className="text-meta text-content whitespace-nowrap">{state.label}</span>
      <button
        onClick={() => {
          state.undo();
          onDone();
        }}
        className="h-8 px-3.5 rounded-lg bg-surface-highlight text-meta font-semibold text-content hover:opacity-90 transition-opacity cursor-pointer"
      >
        Undo
      </button>
    </div>
  );
}
