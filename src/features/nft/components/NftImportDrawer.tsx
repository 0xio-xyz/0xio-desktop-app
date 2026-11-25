import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import { Btn, KV } from "src/shared/ui/look";
import NftDrawer from "src/features/nft/components/NftDrawer";
import { validateNftContract, getImportedNftAddresses } from "src/features/nft/services/data";
import { getTokensByAddress } from "src/services/network/networkService";
import { truncateAddress } from "src/lib/format";

type Step = "input" | "scanning" | "preview";

interface Preview {
  address: string;
  name: string;
  symbol: string;
  totalSupply: string | null;
  ownedCount: number | null;
}

interface NftImportDrawerProps {
  open: boolean;
  onClose: () => void;
  networkId: string;
  walletAddress: string | undefined;
  onImport: (address: string) => void;
}

export default function NftImportDrawer({
  open,
  onClose,
  networkId,
  walletAddress,
  onImport,
}: NftImportDrawerProps) {
  const [step, setStep] = useState<Step>("input");
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  const reset = () => {
    setStep("input");
    setAddress("");
    setError("");
    setPreview(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const scan = async (addrOverride?: string) => {
    const addr = (addrOverride ?? address).trim();
    if (!addr) return;
    setError("");
    if (getImportedNftAddresses(networkId).some((a) => a.toLowerCase() === addr.toLowerCase())) {
      setError(t("nft.import.already"));
      return;
    }
    setStep("scanning");
    try {
      const [info, listed] = await Promise.all([
        validateNftContract(addr),
        (async () => {
          if (!walletAddress) return null;
          try {
            const tokens = await getTokensByAddress(walletAddress);
            return (
              tokens.find((t) => t.contractAddress.toLowerCase() === addr.toLowerCase()) ?? null
            );
          } catch {
            return null;
          }
        })(),
      ]);
      // EUINT contracts (e.g. Geodesics) revert the collection_name/symbol/total_supply views:
      // fall back to the node's token-list entry so they still scan and import.
      const resolved =
        info ??
        (listed
          ? {
              name: listed.name || listed.symbol || "Unknown",
              symbol: listed.symbol || "???",
              totalSupply: null,
            }
          : null);
      if (!resolved) {
        setError(t("nft.import.notFound"));
        setStep("input");
        return;
      }
      setPreview({
        address: addr,
        ...resolved,
        ownedCount: listed ? parseInt(listed.balance) || 0 : walletAddress ? 0 : null,
      });
      setStep("preview");
    } catch {
      setError(t("nft.import.scanFailed"));
      setStep("input");
    }
  };

  const confirm = () => {
    if (!preview) return;
    onImport(preview.address);
    close();
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setAddress(text.trim());
        setError("");
      }
    } catch {}
  };

  return (
    <NftDrawer open={open} title={t("nft.import.title")} onClose={close}>
      {step === "input" && (
        <div>
          <div className="flex h-11.5 items-center gap-1 rounded-xl bg-surface-highlight pr-1.5 pl-4">
            <input
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && scan()}
              placeholder={t("nft.import.placeholder")}
              aria-label={t("nft.import.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[0.8125rem] text-content placeholder:text-content-muted focus:outline-none"
            />
            <Btn size="sm" onClick={paste}>
              {t("nft.paste")}
            </Btn>
          </div>
          <p role="alert" className="mt-2 min-h-5 text-[0.8125rem] text-danger">
            {error}
          </p>
          <Btn
            weight="primary"
            className="look-key mt-2 w-full"
            onClick={() => scan()}
            disabled={!address.trim()}
          >
            {t("nft.import.scan")}
          </Btn>
        </div>
      )}

      {step === "scanning" && (
        <div className="flex flex-col items-center py-17.5 text-center">
          <Mascot id="nft-scan" phase="ld" size={64} />
          <p className="mt-5 text-lead font-semibold text-content">{t("nft.import.scanning")}</p>
        </div>
      )}

      {step === "preview" && preview && (
        <div>
          <div className="flex items-center gap-3.5">
            <div className="grid size-13 shrink-0 place-items-center rounded-xl bg-surface-highlight">
              <span className="font-mono text-lead font-semibold text-content">
                {preview.symbol.slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-lead font-semibold text-content">{preview.name}</p>
              <p className="truncate font-mono text-meta text-content-muted">
                {preview.symbol} {truncateAddress(preview.address)}
              </p>
            </div>
          </div>
          <div className="mt-4">
            <KV label={t("nft.import.supply")}>{preview.totalSupply ?? "-"}</KV>
            <KV label={t("nft.import.youOwn")}>{preview.ownedCount ?? "-"}</KV>
          </div>
          <Btn weight="primary" className="look-key mt-4 w-full" onClick={confirm}>
            {t("nft.import.add")}
          </Btn>
          <Btn
            weight="text"
            size="sm"
            className="mt-2 w-full"
            onClick={() => {
              setStep("input");
              setPreview(null);
            }}
          >
            {t("nft.import.another")}
          </Btn>
        </div>
      )}
    </NftDrawer>
  );
}
