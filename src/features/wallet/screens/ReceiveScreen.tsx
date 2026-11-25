import { useEffect, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { qrToCanvas } from "src/lib/qr";
import { useWallet } from "src/contexts/useWallet";
import { Screen, PageTitle, PillTabs } from "src/shared/ui/flat";
import { Btn, Caps, KV, Num } from "src/shared/ui/look";
import BigAmount from "src/shared/ui/BigAmount";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useAddressName } from "src/hooks/wallet/useAddressName";
import { useClaimableCount } from "src/hooks/privacy/useClaimableCount";
import { useHistoryPages } from "src/features/transactions/hooks/useHistoryPages";
import {
  networkLabel,
  readNetworks,
  sideOf,
  type Side,
} from "src/features/transactions/history/sides";
import { buildPaymentRequest, requestAmount } from "src/features/wallet/services/paymentRequest";
import { NETWORKS } from "src/services/network/config";
import { formatOCT, timeAgo, truncateAddress } from "src/lib/format";

const QR_SIZE = "clamp(140px, 30vh, 232px)";
const RECENT = 5;

const msOf = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

function IncomingRow({ from, amount, at }: { from: string; amount: number; at: number }) {
  const nameOf = useAddressName();
  const who = nameOf(from);
  return (
    <div className="flex h-13 items-center gap-3">
      <WalletAvatar address={from} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-content">
          {who ? who.name : <span className="font-mono">{truncateAddress(from, 10, 6)}</span>}
        </span>
        <span className="block text-meta text-content-muted">{timeAgo(at)}</span>
      </span>
      <span className="text-body font-medium whitespace-nowrap text-(--pos) tabular-nums">
        +<Num value={formatOCT(amount)} /> OCT
      </span>
    </div>
  );
}

export default function ReceiveScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, networkId, setNetworkId } = useWallet();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<Side>(() => sideOf(networkId));
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const address = activeWallet?.address ?? "";
  const watch = activeWallet?.wallet_type === "watch";
  const request = asking && requestAmount(amount) !== "";
  const payload = buildPaymentRequest(address, asking ? amount : "");

  const sideNet = readNetworks(side, networkId)[0];
  const privacy = !!NETWORKS[sideNet]?.supportsPrivacy;
  const onActiveSide = side === sideOf(networkId);
  const waiting = useClaimableCount(sideNet, privacy && !watch);
  const { rows, isLoading } = useHistoryPages(address, networkId, side);
  const incoming = rows.filter((tx) => tx.type === "receive" && tx.to === address).slice(0, RECENT);

  useEffect(() => {
    if (!payload || !canvasRef.current) return;
    // Drawn at 2x so it stays sharp, then sized by CSS.
    const canvas = canvasRef.current;
    qrToCanvas(canvas, payload, { width: 480, margin: 1, dark: "#000000", light: "#ffffff" });
    canvas.style.width = QR_SIZE;
    canvas.style.height = QR_SIZE;
  }, [payload]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async () => {
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const changeAmount = (v: string) => {
    setAmount(v);
    setCopied(false);
  };

  const toggleAmount = () => {
    setAsking((on) => !on);
    changeAmount("");
  };

  const saveQr = () => {
    if (!canvasRef.current) return;
    const link = document.createElement("a");
    link.download = `${address.slice(0, 12)}-qr.png`;
    link.href = canvasRef.current.toDataURL();
    link.click();
  };

  const explorerBase = NETWORKS[sideNet]?.explorerAddressUrl ?? "";
  const privateValue = watch
    ? t("settings.notAvailable")
    : privacy
      ? t("settings.on")
      : t("settings.off");

  return (
    <Screen>
      <PageTitle
        title={t("receive.title")}
        right={
          <PillTabs
            tabs={[
              { id: "mainnet" as Side, label: t("history.mainnet") },
              { id: "testnet" as Side, label: t("history.testnet") },
            ]}
            value={side}
            onChange={setSide}
          />
        }
      />

      <div className="mt-3 grid min-h-0 flex-1 gap-7 @4xl:grid-cols-[minmax(0,1fr)_minmax(17.5rem,0.42fr)]">
        <section className="flex min-h-0 flex-col items-center overflow-y-auto text-center scrollbar-hide">
          <div className="flex items-center gap-2.5">
            <WalletAvatar address={address} size={24} />
            <span className="text-lead font-semibold text-content">{activeWallet?.name}</span>
          </div>

          <div className="mt-4.5 rounded-[20px] bg-white p-4">
            <canvas
              ref={canvasRef}
              aria-label={t("receive.code")}
              className="block"
              style={{ width: QR_SIZE, height: QR_SIZE }}
            />
          </div>

          <div className="mt-3 flex h-24 flex-col items-center justify-center gap-2">
            {asking && (
              <div className="flex items-baseline justify-center gap-2">
                <BigAmount
                  fit
                  size="lg"
                  value={amount}
                  onChange={changeAmount}
                  label={t("receive.amount")}
                />
                <span className="text-lead text-content-muted">OCT</span>
              </div>
            )}
            <span title={address} className="font-mono text-[0.84375rem] text-content select-all">
              {truncateAddress(address, 16, 14)}
            </span>
          </div>

          <div className="mt-3.5 flex items-center gap-2">
            <Btn weight="primary" className="look-key w-40" onClick={() => void copy()}>
              {copied
                ? t("common.copied")
                : request
                  ? t("receive.copyLink")
                  : t("receive.copyAddress")}
            </Btn>
            <Btn className="w-38" onClick={toggleAmount}>
              {asking ? t("receive.clearAmount") : t("receive.addAmount")}
            </Btn>
            <Btn weight="text" onClick={saveQr}>
              {t("receive.saveQr")}
            </Btn>
          </div>
        </section>

        <aside className="look-raise hidden min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide @4xl:flex">
          <Caps>{t("receive.thisAddress")}</Caps>
          <div className="mt-2">
            <KV label={t("receive.type")}>
              {watch ? t("wallet.kindWatch") : t("receive.canSign")}
            </KV>
            <KV label={t("receive.network")}>{networkLabel(sideNet, t)}</KV>
            <KV label={t("receive.privateTransfers")}>{privateValue}</KV>
            {privacy && !watch && (
              <KV label={t("receive.waiting")}>
                <span className="tabular-nums">{waiting}</span>
                {waiting > 0 &&
                  (onActiveSide ? (
                    <Btn size="sm" weight="text" onClick={() => navigate("/privacy")}>
                      {t("receive.openPrivacy")}
                    </Btn>
                  ) : (
                    <Btn size="sm" weight="text" onClick={() => setNetworkId(sideNet)}>
                      {t("receive.switchTo", { network: networkLabel(sideNet, t) })}
                    </Btn>
                  ))}
              </KV>
            )}
          </div>

          <Caps className="mt-5">{t("receive.recentIncoming")}</Caps>
          <div className="mt-1.5 min-h-0">
            {isLoading && incoming.length === 0 ? null : incoming.length === 0 ? (
              <div className="flex h-13 items-center text-body text-content-muted">
                {t("receive.noneYet")}
              </div>
            ) : (
              incoming.map((tx) => (
                <IncomingRow
                  key={`${tx.network}:${tx.hash}`}
                  from={tx.from}
                  amount={tx.amount}
                  at={msOf(tx.timestamp)}
                />
              ))
            )}
          </div>

          <span className="min-h-5 flex-1" />
          {explorerBase && address && (
            <Btn
              size="sm"
              weight="text"
              className="self-start"
              onClick={() =>
                navigate(`/browser?url=${encodeURIComponent(`${explorerBase}${address}`)}`)
              }
            >
              {t("receive.octrascan")}
            </Btn>
          )}
        </aside>
      </div>
    </Screen>
  );
}
