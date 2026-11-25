import { useState, useEffect, useRef } from "react";
import { useTranslation } from "src/i18n/react";
import { ImageOff, Loader } from "src/shared/ui/icons";
import {
  getActiveListing,
  isApprovedFor,
  type Listing,
} from "src/features/nft/services/xpectrum/market";
import { resolveListability, cachedListability } from "src/features/nft/services/listability";
import { MICRO_OCT } from "src/features/nft/services/xpectrum/config";
import { isLivingProgramUri } from "src/features/nft/services/euint/protocol";
import { LivingNftFrame } from "src/features/nft/services/euint/LivingNftFrame";
import NamePlate from "src/features/nft/components/NamePlate";
import {
  type NftTokenDetail,
  nftDisplayName,
  getNftPoster,
  setNftPoster,
  getCachedMarketState,
  setCachedMarketState,
  MARKET_REVALIDATE_MS,
} from "src/features/nft/services/data";
import { useOnsContract } from "src/hooks/wallet/useOns";
import { useWallet } from "src/contexts/useWallet";

interface NftCardProps {
  detail: NftTokenDetail;
  collectionName: string;
  contractAddress: string;
  market: string | null;
  onClick: () => void;
  onListingKnown?: (contract: string, tokenId: string, listing: Listing | null) => void;
  variant?: "card" | "shelf" | "art";
}

export default function NftCard({
  detail,
  collectionName,
  contractAddress,
  market: collectionMarket,
  onClick,
  onListingKnown,
  variant = "card",
}: NftCardProps) {
  const { t } = useTranslation();
  const shelf = variant !== "card";
  const named = useOnsContract() === contractAddress;
  const market = named ? null : collectionMarket;
  const { networkId } = useWallet();
  const [broken, setBroken] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(() =>
    networkId
      ? (getCachedMarketState(networkId, contractAddress, detail.tokenId)?.listing ?? null)
      : null,
  );
  const [marketApproved, setMarketApproved] = useState<boolean>(() =>
    networkId
      ? (getCachedMarketState(networkId, contractAddress, detail.tokenId)?.approved ?? false)
      : false,
  );
  // Collections the market can't list (reduced interface, not admin-enabled) never show
  // "Approved": approval alone doesn't make them tradeable.
  const [notListable, setNotListable] = useState<boolean>(() =>
    networkId ? cachedListability(`${networkId}:${contractAddress}`) === "incompatible" : false,
  );
  const displayName = nftDisplayName(detail);
  const living = !named && isLivingProgramUri(detail.animationUrl);
  const pictured = !!detail.image && broken !== detail.image;
  const plated = named && detail.metaFetched && !pictured;
  const [poster, setPoster] = useState<string | null>(null);
  const [capture, setCapture] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!living) return;
    let cancelled = false;
    void getNftPoster(networkId, contractAddress, detail.tokenId).then((p) => {
      if (!cancelled) setPoster(p);
    });
    return () => {
      cancelled = true;
    };
  }, [living, networkId, contractAddress, detail.tokenId]);

  useEffect(() => {
    if (!market || !networkId) return;
    let cancelled = false;
    const cached = getCachedMarketState(networkId, contractAddress, detail.tokenId);
    if (cached) onListingKnown?.(contractAddress, detail.tokenId, cached.listing);
    // Skip the node while the snapshot is fresh: every tile reads listing and approval. Actions
    // invalidate it, so the user's own list/approve/cancel still shows at once.
    if (cached && Date.now() - cached.ts < MARKET_REVALIDATE_MS) return;
    void (async () => {
      try {
        const l = await getActiveListing(market, contractAddress, parseInt(detail.tokenId));
        if (cancelled) return;
        setListing(l);
        onListingKnown?.(contractAddress, detail.tokenId, l);
        // A listed token is necessarily approved, so its approval read is skipped. Caching
        // approved:false here would offer a redundant approve once the listing ends.
        let approved = l ? (cached?.approved ?? true) : false;
        if (!l) {
          approved = await isApprovedFor(contractAddress, parseInt(detail.tokenId), market);
          if (cancelled) return;
          setMarketApproved(approved);
        }
        setCachedMarketState(networkId, contractAddress, detail.tokenId, { listing: l, approved });
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, contractAddress, detail.tokenId, networkId]);

  useEffect(() => {
    if (!market || !networkId) return;
    let cancelled = false;
    void resolveListability(networkId, contractAddress).then((l) => {
      if (!cancelled) setNotListable(l === "incompatible");
    });
    return () => {
      cancelled = true;
    };
  }, [market, networkId, contractAddress]);

  // effect:audited - a living tile with no cached poster captures one the first time it scrolls
  // near the viewport; the snapshot unmounts the program.
  useEffect(() => {
    if (!living || poster || !detail.animationUrl) return;
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCapture(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [living, poster, detail.animationUrl]);

  // effect:audited - stop a capture that never snapshots (slow/broken program) so the iframe frees.
  useEffect(() => {
    if (!capture) return;
    const t = setTimeout(() => setCapture(false), 15000);
    return () => clearTimeout(t);
  }, [capture]);

  const handleSnapshot = (dataUrl: string) => {
    setPoster(dataUrl);
    setNftPoster(networkId, contractAddress, detail.tokenId, dataUrl);
    setCapture(false);
  };

  return (
    <div
      ref={cardRef}
      onClick={onClick}
      className={
        shelf
          ? "cursor-pointer group"
          : "group cursor-pointer overflow-hidden rounded-[18px] bg-surface-card transition-transform duration-200 ease-out hover:-translate-y-0.5 motion-reduce:transition-none"
      }
    >
      <div
        className={`relative w-full aspect-square bg-[#0a0a0e] overflow-hidden ${shelf ? "rounded-[14px]" : ""} ${plated && !detail.inactive ? "look-raise" : ""}`}
      >
        {!detail.metaFetched ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader size={20} className="text-content-muted animate-spin" />
          </div>
        ) : living && poster ? (
          <>
            <img
              src={poster}
              alt={displayName}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
            <LiveBadge />
          </>
        ) : living && capture ? (
          <>
            <LivingNftFrame
              uri={detail.animationUrl!}
              networkId={networkId}
              offline
              inputs={{ token: detail.tokenId, contract: contractAddress }}
              onSnapshot={handleSnapshot}
              onError={() => setCapture(false)}
              className="absolute inset-0 w-full h-full border-0"
            />
            <LiveBadge />
          </>
        ) : living ? (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,#1b2340,#08080e)]" />
            <div className="absolute top-[42%] left-1/2 h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-white/20 blur-xl" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-black text-content/80">
                {(detail.metaName || "GE").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <LiveBadge />
          </>
        ) : pictured ? (
          <img
            src={detail.image!}
            alt={displayName}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setBroken(detail.image)}
            loading="lazy"
          />
        ) : named ? (
          <NamePlate name={detail.metaName} inactive={detail.inactive} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-40">
            <ImageOff size={24} className="text-content-muted" />
            <span className="text-[max(0.5625rem,9px)] text-content-muted font-mono">
              #{detail.tokenId}
            </span>
          </div>
        )}

        {!living && listing && (
          <Badge className="top-2.25 right-2.25">{listing.price / MICRO_OCT} OCT</Badge>
        )}

        {named ? null : marketApproved && !listing && !notListable ? (
          <Badge className="bottom-2.25 left-2.25">{t("nft.approved")}</Badge>
        ) : living && listing ? (
          <Badge className="bottom-2.25 left-2.25">{listing.price / MICRO_OCT} OCT</Badge>
        ) : null}

        {named && <NameStatusTag detail={detail} />}

        {!shelf && !named && (
          <Badge className="top-2.25 left-2.25 font-mono">#{detail.tokenId}</Badge>
        )}

        {!shelf && (
          <div className="absolute inset-0 flex items-end p-2.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-linear-to-t from-black/50 to-transparent to-55%">
            <span className="rounded-full bg-black/50 px-2.75 py-1.25 text-micro font-semibold text-white backdrop-blur-xs">
              {t("nft.viewDetails")}
            </span>
          </div>
        )}
      </div>

      {variant === "art" ? null : shelf ? (
        <p className="pt-2.5 text-meta font-medium text-content truncate">{displayName}</p>
      ) : (
        <div className="px-3 pt-2.75 pb-3.25">
          <p className="truncate text-[0.8125rem] font-semibold text-content">{displayName}</p>
          <p className="mt-0.75 truncate text-micro text-content-muted">{collectionName}</p>
          {detail.biontAttrs &&
            (detail.biontAttrs.isAlive !== undefined ||
              (detail.biontAttrs.archetype !== undefined &&
                !isNaN(detail.biontAttrs.archetype))) && (
              <div className="flex flex-wrap items-center gap-1.25 mt-2">
                {detail.biontAttrs?.isAlive !== undefined && (
                  <span
                    className={`text-micro font-medium ${
                      detail.biontAttrs.isAlive ? "text-content" : "text-danger"
                    }`}
                  >
                    {detail.biontAttrs.isAlive ? t("nft.alive") : t("nft.dead")}
                  </span>
                )}
                {detail.biontAttrs?.archetype !== undefined &&
                  !isNaN(detail.biontAttrs.archetype) && (
                    <span className="text-micro text-content-muted">
                      {t("nft.type", { n: detail.biontAttrs.archetype })}
                    </span>
                  )}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function Badge({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`absolute inline-flex items-center rounded-full bg-black/55 px-2 py-0.75 text-micro font-semibold text-white backdrop-blur-sm ${className}`}
    >
      {children}
    </span>
  );
}

export function NameStatusTag({ detail }: { detail: NftTokenDetail | null }) {
  const { t } = useTranslation();
  if (!detail?.expired) return null;
  return <Badge className="right-2.25 bottom-2.25">{t("ons.expired")}</Badge>;
}

function LiveBadge() {
  const { t } = useTranslation();
  return (
    <Badge className="top-2.25 right-2.25 gap-1.5 uppercase tracking-widest">
      <span className="size-1.25 animate-pulse rounded-full bg-white" />
      {t("nft.live")}
    </Badge>
  );
}
