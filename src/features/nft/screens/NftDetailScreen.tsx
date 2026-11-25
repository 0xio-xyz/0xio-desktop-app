import { openInSystemBrowser } from "src/lib/openExternal";
import { useState, useEffect } from "react";
import { useTranslation } from "src/i18n/react";
import { useParams, useNavigate } from "src/lib/router";
import { ChevronLeft, ImageOff, Loader } from "src/shared/ui/icons";
import ConfirmDialog from "src/shared/ui/ConfirmDialog";
import { Screen, PageTitle } from "src/shared/ui/flat";
import { Btn, Caps, FOCUS, KV } from "src/shared/ui/look";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import NamePlate from "src/features/nft/components/NamePlate";
import { NameStatusTag } from "src/features/nft/components/NftCard";
import NftSendDrawer from "src/features/nft/components/NftSendDrawer";
import NftMarketDrawer, { type MarketMode } from "src/features/nft/components/NftMarketDrawer";
import { DotsMenu, type MenuItem } from "src/features/nft/components/NftShelf";
import type { GalleryUndoHint } from "src/features/nft/screens/NftGalleryScreen";
import { useOnsContract } from "src/hooks/wallet/useOns";
import { useWallet } from "src/contexts/useWallet";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { useFee } from "src/hooks/transactions/useFees";
import { xpectrumConfig, MICRO_OCT } from "src/features/nft/services/xpectrum/config";
import {
  getActiveListing,
  isApprovedFor,
  type Listing,
} from "src/features/nft/services/xpectrum/market";
import {
  resolveListability,
  cachedListability,
  type Listability,
} from "src/features/nft/services/listability";
import { LivingNftFrame } from "src/features/nft/services/euint/LivingNftFrame";
import { isLivingProgramUri } from "src/features/nft/services/euint/protocol";
import { isMutableToken } from "src/features/nft/services/euint/chainState";
import {
  type NftTokenDetail,
  type NftTrait,
  type NftRarity,
  useNftCollections,
  useNftActions,
  fetchTokenDetails,
  readNameFacts,
  getCachedTokenDetails,
  resolveNftTraits,
  getCachedTraits,
  setCachedTraits,
  invalidateNftMetadata,
  invalidateMarketState,
  octrascanAddressUrl,
  nftDisplayName,
  nameTraits,
  keepArt,
  setNftPoster,
} from "src/features/nft/services/data";
import { truncateAddress } from "src/lib/format";
import { fullDate, toMs } from "src/lib/dates";

export default function NftDetailScreen() {
  const { contract = "", tokenId = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, networkId, showMessage } = useWallet();
  const callFee = useFee("call");
  const { getPrice } = useTokenPrice();
  const octUsdPrice = getPrice("OCT") ?? null;
  const recommendedCallOU = callFee.fee?.recommended ?? "";

  const { data: collections = [] } = useNftCollections(activeWallet?.address, networkId);
  const nftActions = useNftActions(activeWallet?.address, networkId);
  const collection = collections.find((c) => c.contractAddress === contract);
  const named = useOnsContract() === contract;
  const collectionName = named
    ? t("ons.collection")
    : (collection?.name ?? truncateAddress(contract));

  const [detail, setDetail] = useState<NftTokenDetail | null>(() => {
    const cached = getCachedTokenDetails(networkId)[contract];
    return cached?.find((d) => d.tokenId === tokenId) ?? null;
  });
  // A piece whose metadata moves (chain-state art, inline JSON, unrevealed) is read again on every
  // open, and its live frame waits for that read so the program starts once, on fresh state.
  const [liveReady, setLiveReady] = useState(() => !detail || !isMutableToken(detail));
  const [factsRead, setFactsRead] = useState(false);
  // effect:audited - one-shot metadata fetch for direct navigation or a moving piece; not
  // derivable at render. A burned piece (token_uri reverted) leaves for the gallery.
  useEffect(() => {
    if (detail && !isMutableToken(detail) && !named) return;
    let cancelled = false;
    const read =
      named && detail?.image
        ? readNameFacts(contract, tokenId).then((facts) => [{ ...detail, image: null, ...facts }])
        : fetchTokenDetails(contract, [tokenId]);
    void read
      .then(([d]) => {
        if (cancelled || !d) return;
        if (d.burned) {
          void invalidateNftMetadata(networkId, contract, tokenId, detail?.uri ?? null);
          navigate("/nfts", { replace: true });
          return;
        }
        if (d.image || d.animationUrl || !detail) setDetail(d);
        else if (named) setDetail(keepArt(detail, d));
      })
      .finally(() => {
        if (cancelled) return;
        setLiveReady(true);
        setFactsRead(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, tokenId, named]);

  const [traits, setTraits] = useState<NftTrait[] | null>(() =>
    detail?.uri ? (getCachedTraits(detail.uri)?.traits ?? null) : null,
  );
  const [rarity, setRarity] = useState<NftRarity | null>(() =>
    detail?.uri ? (getCachedTraits(detail.uri)?.rarity ?? null) : null,
  );
  // effect:audited - lazy trait resolution once the token's uri is known; refreshes the cache.
  useEffect(() => {
    if (!detail?.uri) return;
    const uri = detail.uri;
    let cancelled = false;
    void resolveNftTraits(uri).then(({ traits: t, rarity: r }) => {
      if (cancelled) return;
      setTraits(t);
      setRarity(r);
      // A transient empty result (rate-limited node) must not blank the traits for the whole TTL.
      if ((t && t.length) || r) setCachedTraits(uri, { traits: t, rarity: r });
    });
    return () => {
      cancelled = true;
    };
  }, [detail?.uri]);

  const [refreshingMeta, setRefreshingMeta] = useState(false);
  const handleRefreshMetadata = async () => {
    if (refreshingMeta) return;
    setRefreshingMeta(true);
    try {
      await invalidateNftMetadata(networkId, contract, tokenId, detail?.uri ?? null);
      const [d] = await fetchTokenDetails(contract, [tokenId]);
      if (d) {
        const next = named ? keepArt(detail, d) : d;
        setDetail(next);
        setBroken(null);
        setTraits(null);
        setRarity(null);
        if (next.uri) {
          const { traits: t, rarity: r } = await resolveNftTraits(next.uri);
          setTraits(t);
          setRarity(r);
          if ((t && t.length) || r) setCachedTraits(next.uri, { traits: t, rarity: r });
        }
      }
    } finally {
      setRefreshingMeta(false);
    }
  };

  const market = named ? null : (xpectrumConfig(networkId)?.market ?? null);
  const [listing, setListing] = useState<Listing | null>(null);
  // A timed-out listing read must never show as a false "Not listed".
  const [listingUnavailable, setListingUnavailable] = useState(false);
  const [listable, setListable] = useState<Listability>(() =>
    cachedListability(`${networkId}:${contract}`),
  );
  const [marketMode, setMarketMode] = useState<MarketMode | null>(null);
  const [marketApproved, setMarketApproved] = useState<boolean | null>(null);

  // effect:audited - listing status load on open.
  useEffect(() => {
    if (!market) return;
    let cancelled = false;
    setListing(null);
    setListingUnavailable(false);
    void getActiveListing(market, contract, parseInt(tokenId))
      .then((l) => {
        if (!cancelled) setListing(l);
      })
      .catch(() => {
        if (!cancelled) setListingUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [market, contract, tokenId]);

  // effect:audited - read the collection ABI once so List hides for a proven-incompatible collection.
  useEffect(() => {
    if (!market) return;
    let cancelled = false;
    void resolveListability(networkId, contract)
      .then((v) => {
        if (!cancelled) setListable(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market, networkId, contract]);

  // effect:audited - probe approval (get_approved === market) for the market row when unlisted.
  useEffect(() => {
    if (!market || listing) return;
    let cancelled = false;
    void isApprovedFor(contract, parseInt(tokenId), market)
      .then((a) => {
        if (!cancelled) setMarketApproved(a);
      })
      .catch(() => {
        if (!cancelled) setMarketApproved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [market, listing, contract, tokenId, networkId]);

  const canList = listable !== "incompatible" || !!listing;

  const [liveError, setLiveError] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copyValue = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const refreshListing = async (): Promise<Listing | null> => {
    // The gallery tile trusts its cached snapshot for a minute; the user's own action must show now.
    if (networkId && contract && tokenId) {
      invalidateMarketState(networkId, contract, tokenId);
    }
    if (!market) return null;
    const l = await getActiveListing(market, contract, parseInt(tokenId)).catch(() => null);
    setListing(l);
    return l;
  };

  const living = !named && !!detail && isLivingProgramUri(detail.animationUrl) && !liveError;
  const pictured = !!detail?.image && broken !== detail.image;
  const nameStatus =
    detail?.inactive === false ? t("ons.active") : detail?.expired ? t("ons.expired") : null;
  const shownTraits = named ? nameTraits(traits) : (traits ?? []);
  const displayName = detail ? nftDisplayName(detail) : `#${tokenId}`;
  const price = listing ? listing.price / MICRO_OCT : null;
  const priceText = price != null ? `${parseFloat(price.toFixed(6))} OCT` : "";
  const priceUsd = price != null && octUsdPrice ? `$${(price * octUsdPrice).toFixed(2)}` : null;

  const hideAndLeave = (kind: "piece" | "collection") => {
    if (kind === "piece") nftActions.setPieceShown(contract, tokenId, false);
    else nftActions.setCollectionShown(contract, false);
    const undo: GalleryUndoHint = {
      kind,
      contract,
      tokenId,
      label: t("nft.detail.hidden", { name: kind === "piece" ? displayName : collectionName }),
    };
    navigate("/nfts", { state: { undo } });
  };

  const menu: MenuItem[] = [
    { label: t("nft.detail.hidePiece"), onSelect: () => hideAndLeave("piece") },
    {
      label: t("nft.detail.hideCollection", { name: collectionName }),
      onSelect: () => hideAndLeave("collection"),
    },
    {
      label: t("nft.detail.copyContract"),
      onSelect: () => void navigator.clipboard.writeText(contract),
    },
    {
      label: t("nft.detail.octrascan"),
      onSelect: () =>
        navigate(`/browser?url=${encodeURIComponent(octrascanAddressUrl(networkId, contract))}`),
    },
    {
      label: refreshingMeta ? t("nft.detail.refreshing") : t("nft.detail.refresh"),
      onSelect: () => void handleRefreshMetadata(),
    },
  ];

  return (
    <Screen>
      <PageTitle
        title={displayName}
        leading={
          <button
            type="button"
            onClick={() => navigate("/nfts")}
            aria-label={t("nav.nfts")}
            className={`grid size-9 cursor-pointer place-items-center rounded-full text-content-secondary hover:bg-surface-highlight hover:text-content ${FOCUS}`}
          >
            <ChevronLeft size={18} />
          </button>
        }
        right={<DotsMenu items={menu} label={t("nft.detail.more")} />}
      />

      <div className="mt-5.5 grid min-h-0 flex-1 gap-7 overflow-y-auto scrollbar-hide @3xl:grid-cols-[minmax(0,27.5rem)_minmax(0,1fr)] @3xl:overflow-hidden">
        <div
          className={`relative aspect-square w-full max-w-110 overflow-hidden rounded-[22px] bg-surface-highlight ${named && !pictured && detail?.inactive === false ? "look-raise" : ""}`}
        >
          {!detail ? (
            <div className="absolute inset-0 grid place-items-center">
              <Loader size={24} className="animate-spin text-content-muted" />
            </div>
          ) : living ? (
            liveReady ? (
              <LivingNftFrame
                uri={detail.animationUrl!}
                networkId={networkId}
                inputs={{ token: tokenId, contract }}
                onError={() => setLiveError(true)}
                onSnapshot={(dataUrl) => setNftPoster(networkId, contract, tokenId, dataUrl)}
                audioEnabled
                className="absolute inset-0 h-full w-full border-0"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                <Loader size={24} className="animate-spin text-content-muted" />
              </div>
            )
          ) : pictured ? (
            <img
              src={detail.image!}
              alt={displayName}
              className="absolute inset-0 h-full w-full object-cover"
              onError={() => setBroken(detail.image)}
            />
          ) : named ? (
            <NamePlate name={detail.metaName} inactive={detail.inactive} size="page" />
          ) : (
            <div className="absolute inset-0 grid place-items-center opacity-40">
              <ImageOff size={36} className="text-content-muted" />
            </div>
          )}
          {named && <NameStatusTag detail={detail} />}
        </div>

        <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
          <KV label={t("nft.detail.collection")}>
            <span className="truncate">{collectionName}</span>
          </KV>
          {named ? (
            <>
              <KV label={t("ons.owner")}>
                {activeWallet && (
                  <>
                    <WalletAvatar address={activeWallet.address} size={18} />
                    <span className="truncate">{activeWallet.name}</span>
                  </>
                )}
              </KV>
              <KV label={detail?.expired ? t("ons.expired") : t("ons.expires")}>
                <span className="tabular-nums">
                  {detail?.expires ? fullDate(toMs(detail.expires)) : ""}
                </span>
              </KV>
              {nameStatus === null && factsRead ? (
                <div className="min-h-11" aria-hidden />
              ) : (
                <KV label={t("nft.detail.status")}>{nameStatus ?? ""}</KV>
              )}
            </>
          ) : (
            <>
              {rarity?.rank != null && (
                <KV label={t("nft.detail.rank")}>
                  {rarity.total != null
                    ? t("nft.detail.rankOf", { rank: rarity.rank, total: rarity.total })
                    : rarity.rank}
                </KV>
              )}
              {detail?.biontAttrs?.isAlive !== undefined && (
                <KV label={t("nft.detail.status")}>
                  <span className={detail.biontAttrs.isAlive ? "" : "text-danger"}>
                    {detail.biontAttrs.isAlive ? t("nft.alive") : t("nft.dead")}
                  </span>
                </KV>
              )}
              {detail?.biontAttrs?.archetype !== undefined &&
                !isNaN(detail.biontAttrs.archetype) && (
                  <KV label={t("nft.detail.archetype")}>
                    {t("nft.type", { n: detail.biontAttrs.archetype })}
                  </KV>
                )}
              {market && (
                <KV label={t("nft.detail.market")}>
                  {listingUnavailable ? (
                    <span className="text-content-muted">{t("nft.detail.unknown")}</span>
                  ) : listing ? (
                    <>
                      {t("nft.market.listedAt", { price: priceText })}
                      {priceUsd && <span className="text-content-muted">{priceUsd}</span>}
                    </>
                  ) : (
                    t("nft.detail.notListed")
                  )}
                </KV>
              )}
              <KV label={t("nft.detail.heldBy")}>
                {listing ? t("nft.detail.heldByMarket") : t("nft.detail.heldByYou")}
              </KV>
              {living && <KV label={t("nft.detail.living")}>{t("nft.detail.livingValue")}</KV>}
              <KV label={t("nft.detail.standard")}>
                <StandardLink />
              </KV>
              <KV label={t("nft.detail.contract")}>
                <button
                  type="button"
                  onClick={() => copyValue("contract", contract)}
                  className={`cursor-pointer rounded-full font-mono text-meta text-content hover:text-content-secondary ${FOCUS}`}
                >
                  {copied === "contract" ? t("common.copied") : truncateAddress(contract, 6, 6)}
                </button>
              </KV>
            </>
          )}

          <div className="mt-4 flex min-h-11.5 gap-2.5">
            {named ? (
              detail?.inactive === false && (
                <Btn weight="primary" className="look-key flex-1" onClick={() => setSendOpen(true)}>
                  {t("nft.transfer")}
                </Btn>
              )
            ) : market && listing ? (
              <>
                <Btn
                  weight="primary"
                  className="look-key flex-1"
                  onClick={() => setMarketMode("reprice")}
                  disabled={!activeWallet}
                >
                  {t("nft.market.reprice")}
                </Btn>
                <Btn
                  className="flex-1"
                  onClick={() => setMarketMode("cancel")}
                  disabled={!activeWallet}
                >
                  {t("nft.market.cancel")}
                </Btn>
              </>
            ) : (
              <>
                {market && !listingUnavailable && canList && (
                  <Btn
                    weight="primary"
                    className="look-key flex-1"
                    onClick={() => setMarketMode("list")}
                    disabled={!detail || !activeWallet}
                  >
                    {t("nft.market.list")}
                  </Btn>
                )}
                <Btn
                  weight={market && !listingUnavailable && canList ? "secondary" : "primary"}
                  className="flex-1"
                  onClick={() => setSendOpen(true)}
                  disabled={!detail}
                >
                  {t("nft.transfer")}
                </Btn>
              </>
            )}
          </div>

          {!named && detail?.metaDescription && (
            <p className="mt-6 text-meta leading-relaxed text-content-secondary">
              {detail.metaDescription}
            </p>
          )}

          {shownTraits.length > 0 && (
            <div className="mt-6">
              <Caps>{t("nft.detail.traits")}</Caps>
              <div className="mt-3 grid grid-cols-2 gap-2 @md:grid-cols-3">
                {shownTraits.map((tr) => {
                  const pct = rarity?.traitPct[tr.k];
                  return (
                    <div key={tr.k} className="rounded-xl bg-surface-highlight px-3.25 py-2.75">
                      <p className="truncate text-micro text-content-muted">{tr.k}</p>
                      <p
                        className="mt-0.5 truncate text-meta font-semibold text-content"
                        title={tr.v}
                      >
                        {tr.v}
                      </p>
                      {pct != null && (
                        <p className="mt-0.5 text-micro text-content-muted tabular-nums">{pct}%</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      </div>

      {detail && activeWallet && (named ? detail.inactive === false : !detail.inactive) && (
        <NftSendDrawer
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          detail={detail}
          collectionName={collectionName}
          contractAddress={contract}
          walletAddress={activeWallet.address}
          walletId={activeWallet.id}
          onSent={() => navigate("/nfts")}
        />
      )}

      {detail && activeWallet && market && !detail.inactive && (
        <NftMarketDrawer
          mode={marketMode}
          onClose={() => setMarketMode(null)}
          detail={detail}
          thumb={detail.image}
          collectionName={collectionName}
          contract={contract}
          tokenId={tokenId}
          market={market}
          listing={listing}
          approved={marketApproved}
          octUsd={octUsdPrice}
          wallet={{ address: activeWallet.address, id: activeWallet.id }}
          ou={recommendedCallOU}
          feeQuote={callFee}
          refreshListing={refreshListing}
          onApproved={() => setMarketApproved(true)}
          onDone={(msg) => showMessage("success", msg)}
        />
      )}
    </Screen>
  );
}

// Opens in the system browser after a confirm: the site cannot be framed.
const XNS1_DOCS_URL = "https://docs.xpectrum.xyz/standards/xns-1";

function StandardLink() {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className={`cursor-pointer rounded-full text-content underline decoration-content-muted decoration-dotted underline-offset-2 hover:text-content-secondary ${FOCUS}`}
      >
        XNS-1
      </button>
      <ConfirmDialog
        isOpen={confirmOpen}
        title={t("nft.detail.openDocs")}
        details={[{ label: t("nft.detail.opens"), value: "docs.xpectrum.xyz" }]}
        confirmLabel={t("nft.detail.openDocsVerb")}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void openInSystemBrowser(XNS1_DOCS_URL);
        }}
      />
    </>
  );
}
