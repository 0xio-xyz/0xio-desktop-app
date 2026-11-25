import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import CopyButton from "src/shared/ui/CopyButton";
import { Screen, PageTitle } from "src/shared/ui/flat";
import { Btn } from "src/shared/ui/look";
import Mascot from "src/shared/ui/Mascot";
import WatchOnlyBanner from "src/shared/layout/WatchOnlyBanner";
import CipherGraph from "src/features/privacy/components/CipherGraph";
import { useWallet } from "src/contexts/useWallet";
import { pvacBridge, type CipherStructure } from "src/services/pvac/pvacBridge";
import * as networkService from "src/services/network/networkService";
import { NETWORKS } from "src/services/network/config";
import { stripCipherPrefix } from "src/services/pvac/fhe";
import { PRIVATE_SPEND_REFRESH_BASE_LAYERS } from "src/features/privacy/services/pvacUpgradePolicy";

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 shrink-0">
      <div className="text-meta text-content-muted">{label}</div>
      <div className="mt-1 text-[1.375rem] leading-none font-light whitespace-nowrap text-content tabular-nums">
        {children}
      </div>
    </div>
  );
}

export default function CipherMapScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, showMessage, networkId } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const address = activeWallet?.address ?? "";
  const walletId = activeWallet?.id ?? "";
  const isWatchOnly = activeWallet?.wallet_type === "watch";

  const [mapResult, setMapResult] = useState<CipherStructure | null>(null);
  const [wireHash, setWireHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pasteInput, setPasteInput] = useState("");
  const loadedFor = useRef<string | null>(null);

  const runDiagnose = useCallback(async (cipher: string) => {
    const raw = stripCipherPrefix(cipher.trim());
    setNote(null);
    setMapResult(null);
    setWireHash(null);
    setMapResult(await pvacBridge.diagnoseCipher(raw));
    try {
      setWireHash(await sha256Hex(decodeBase64(raw)));
    } catch {
      setWireHash(null);
    }
  }, []);

  const loadBalance = useCallback(async () => {
    if (!address || !walletId) return;
    setLoading(true);
    try {
      const cipher = await networkService.getEncryptedBalance(address, walletId);
      if (!cipher) {
        setMapResult(null);
        setNote(t("cipherMap.noBalance"));
        return;
      }
      await runDiagnose(cipher);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not load encrypted balance");
    } finally {
      setLoading(false);
    }
  }, [address, walletId, runDiagnose, t]);

  // effect:audited - auto-load the active wallet's balance on open and on wallet/network switch.
  useEffect(() => {
    if (!privacyEnabled || isWatchOnly || !address || !walletId) return;
    const key = `${networkId}:${address}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    loadBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, walletId, networkId, privacyEnabled, isWatchOnly]);

  const handlePaste = async () => {
    if (!pasteInput.trim()) {
      showMessage("error", t("cipherMap.pasteFirst"));
      return;
    }
    setLoading(true);
    try {
      await runDiagnose(pasteInput);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not read ciphertext");
    } finally {
      setLoading(false);
    }
  };

  if (isWatchOnly) return <WatchOnlyBanner title={t("cipherMap.title")} />;

  if (!privacyEnabled) {
    return (
      <Screen>
        <PageTitle title={t("cipherMap.unavailableTitle")} />
      </Screen>
    );
  }

  const pressure = mapResult ? mapResult.base_layers >= PRIVATE_SPEND_REFRESH_BASE_LAYERS : false;
  return (
    <Screen>
      <PageTitle title={t("cipherMap.title")} />

      <div className="mt-6 flex shrink-0 items-center gap-2.5">
        <Btn
          size="sm"
          weight="primary"
          className="look-key"
          onClick={loadBalance}
          disabled={loading}
        >
          {t("cipherMap.mine")}
        </Btn>
        <input
          value={pasteInput}
          onChange={(e) => setPasteInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handlePaste()}
          placeholder={t("cipherMap.pastePlaceholder")}
          aria-label={t("cipherMap.pastePlaceholder")}
          className="h-9 min-w-48 flex-1 rounded-full bg-surface-card px-4 font-mono text-xs text-content transition-colors placeholder:text-content-muted focus:bg-surface-highlight focus:outline-none"
        />
        <Btn size="sm" onClick={handlePaste} disabled={loading}>
          {t("cipherMap.inspect")}
        </Btn>
      </div>

      {!mapResult ? (
        <section className="look-raise mt-4.5 flex min-h-0 flex-1 flex-col items-center justify-center rounded-[22px] bg-surface-card px-8 text-center">
          <Mascot id="cipher-empty" phase={loading ? "ld" : "ok"} size={72} />
          <p className="mt-5 h-10.5 max-w-105 text-body leading-normal text-content-muted">
            {note}
          </p>
        </section>
      ) : (
        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-8">
            <Stat label={t("cipherMap.baseLayers")}>{mapResult.base_layers}</Stat>
            <Stat label={t("cipherMap.layers")}>{fmt(mapResult.num_layers)}</Stat>
            <Stat label={t("cipherMap.maxDepth")}>{mapResult.max_depth}</Stat>
            <Stat label={t("cipherMap.edges")}>{fmt(mapResult.num_edges)}</Stat>
            <Stat label={t("cipherMap.size")}>{formatBytes(mapResult.cipher_bytes_len)}</Stat>
            {wireHash && (
              <Stat label={t("cipherMap.hash")}>
                <span className="inline-flex items-center gap-1 font-mono text-body font-normal">
                  {wireHash.slice(0, 8)}...{wireHash.slice(-4)}
                  <CopyButton text={wireHash} />
                </span>
              </Stat>
            )}
            <span className="flex-1" />
            {pressure && (
              <Btn size="sm" onClick={() => navigate("/privacy")}>
                {t("cipherMap.openPrivacy")}
              </Btn>
            )}
          </div>
          <div className="mt-6 flex min-h-0 flex-1 flex-col">
            <CipherGraph structure={mapResult} />
          </div>
        </div>
      )}
    </Screen>
  );
}
