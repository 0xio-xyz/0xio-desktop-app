import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { Screen, PageTitle } from "src/shared/ui/flat";
import { Amount, Caps, KV, Skel } from "src/shared/ui/look";
import FeePicker from "src/shared/ui/FeePicker";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { useReviewFee } from "src/hooks/transactions/useFees";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { useWallet } from "src/contexts/useWallet";
import * as networkService from "src/services/network/networkService";
import { NETWORKS } from "src/services/network/config";
import { formatOCT } from "src/lib/format";
import CircleList, { NEW_CIRCLE } from "src/features/circles/components/CircleList";
import CirclePane from "src/features/circles/components/CirclePane";
import NewCirclePane from "src/features/circles/components/NewCirclePane";
import { DeploySheet } from "src/features/circles/components/CircleSheets";
import { readLibrary, useLibrary } from "src/features/circles/services/circleLibrary";
import {
  closeDeploy,
  leavePage,
  runDeploy,
  showDeploy,
  useCircleRun,
} from "src/features/circles/services/circleRun";

const PANE = "look-raise flex min-h-0 min-w-0 flex-col rounded-[22px] bg-surface-card px-6 py-5.5";
const GRID = "mt-5.5 grid min-h-0 flex-1 grid-cols-[18.75rem_minmax(0,1fr)] gap-6";

export default function CirclesScreen() {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const network = NETWORKS[networkId]?.name ?? networkId;
  return (
    <Screen>
      <PageTitle title={t("nav.circles")} />
      {activeWallet ? (
        <Library
          key={`${networkId}:${activeWallet.address}`}
          wallet={activeWallet}
          networkId={networkId}
          network={network}
        />
      ) : (
        <div className={GRID} aria-busy="true">
          <CircleList
            circles={[]}
            picked=""
            onPick={() => {}}
            wallet={null}
            networkId={networkId}
            loading
          />
          <div className={PANE}>
            <div className="flex h-9 items-center">
              <Skel w="w-37" />
            </div>
            <div className="mt-3.5 flex h-11.5 items-center rounded-[14px] bg-surface-highlight px-4">
              <span className="inline-block h-3 w-75 rounded-md bg-(--bg-3)" />
            </div>
            <Caps className="mt-5.5 px-3.5 pb-1.5">{t("circles.publishedHere")}</Caps>
            {["w-36", "w-35", "w-31", "w-42", "w-45", "w-46"].map((w) => (
              <div key={w} className="flex min-h-11 items-center justify-between px-3.5">
                <Skel w={w} />
                <Skel w="w-16" />
              </div>
            ))}
            <span className="flex-1" />
            <div className="mt-3 flex h-16 items-center rounded-2xl bg-surface-highlight px-4.5 opacity-40">
              <span className="text-body text-content-secondary">{t("circles.dropFiles")}</span>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function Library({
  wallet,
  networkId,
  network,
}: {
  wallet: { id: string; name: string; address: string };
  networkId: string;
  network: string;
}) {
  const { t } = useTranslation();
  const { getUsdValue } = useTokenPrice();
  const [scope] = useState(() => ({ networkId, address: wallet.address }));
  const circles = useLibrary(scope);
  const run = useCircleRun();
  const txAuth = useTransactionAuth();
  const fee = useReviewFee("deploy_circle", "circle_create_fee");
  const [picked, setPicked] = useState(() => readLibrary(scope)[0]?.id ?? NEW_CIRCLE);
  const [unlocked, setUnlocked] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{
    scope: networkService.TxScope;
    sealed: boolean;
    passphrase: string;
  } | null>(null);
  useMountEffect(() => leavePage);

  const current = circles.find((c) => c.id === picked) ?? null;
  const deploying = run.deploy?.status === "running";
  const feeMicro = Number(fee.ou) || 0;

  const deploy = async () => {
    const reviewed = review;
    if (!reviewed || deploying || !fee.ou) return;
    if (await fee.recheck.check(reviewed.scope.networkId, fee.ou)) return;
    setReview(null);
    if (!(await txAuth.requestAuth(t("circles.deployCircle")))) return;
    const id = await runDeploy({
      walletId: wallet.id,
      scope: reviewed.scope,
      sealed: reviewed.sealed,
      ou: fee.ou,
    });
    if (!id) return;
    if (reviewed.sealed) setUnlocked((u) => ({ ...u, [id]: reviewed.passphrase }));
    setPicked(id);
  };

  return (
    <div className={GRID}>
      <CircleList
        circles={circles}
        picked={current ? current.id : NEW_CIRCLE}
        onPick={setPicked}
        wallet={wallet}
        networkId={networkId}
      />
      <section className={PANE} aria-label={current ? current.id : t("circles.newCircle")}>
        {current ? (
          <CirclePane
            key={current.id}
            scope={scope}
            wallet={wallet}
            circle={current}
            network={network}
            passphrase={unlocked[current.id]}
            onUnlock={(p) => setUnlocked((u) => ({ ...u, [current.id]: p }))}
            requestAuth={txAuth.requestAuth}
          />
        ) : (
          <NewCirclePane
            wallet={wallet}
            fee={fee}
            busy={deploying}
            onReview={(choice) => {
              fee.recheck.setError("");
              setReview({ scope: networkService.captureScope(wallet.address), ...choice });
            }}
          />
        )}
      </section>

      <ReviewPopup
        open={!!review}
        label={t("circles.deployCircle")}
        caption={t("circles.deployCircle")}
        right={network}
        hero={
          <div className="text-[1.875rem] leading-[1.1] font-light tracking-[-0.03em]">
            {t(review?.sealed ? "circles.encryptedCircle" : "circles.publicCircle")}
          </div>
        }
        verb={t("circles.deploy")}
        onReject={() => !fee.recheck.checking && setReview(null)}
        onConfirm={() => void deploy()}
        confirmDisabled={fee.quote.status !== "ok" || !fee.ou}
        busy={fee.recheck.checking}
        error={fee.recheck.error}
      >
        <KV label={t("sendFlow.from")}>
          <WalletAvatar address={wallet.address} size={22} />
          {wallet.name}
        </KV>
        <KV label={t("circlesPage.visibility")}>
          {t(review?.sealed ? "circlesPage.encrypted" : "circlesPage.public")}
        </KV>
        {review?.sealed && (
          <KV label={t("circles.sealed.passphrase")}>{t("circles.passphraseSet")}</KV>
        )}
        <KV label={t("circles.transaction")}>
          <span className="font-mono text-meta font-normal">deploy_circle</span>
        </KV>
        <KV label={t("sendFlow.networkFee")}>
          <FeePicker
            quote={fee.quote}
            ou={fee.ou}
            onChange={fee.setOU}
            disabled={fee.recheck.checking}
          />
        </KV>
        <KV label={t("sendFlow.total")}>
          {fee.ou ? (
            <Amount
              value={formatOCT(feeMicro)}
              after={getUsdValue("OCT", feeMicro / 1_000_000) ?? ""}
            />
          ) : (
            ""
          )}
        </KV>
        {review?.sealed && (
          <p className="mt-2 rounded-[14px] bg-surface-highlight px-3.5 py-3 text-[0.8125rem] leading-snug text-content-secondary">
            {t("circles.passphraseWarning")}
          </p>
        )}
      </ReviewPopup>

      {run.deploy?.shown && (
        <DeploySheet deploy={run.deploy} onHide={() => showDeploy(false)} onBack={closeDeploy} />
      )}
      <TransactionAuthModal
        isOpen={txAuth.isOpen}
        onResult={txAuth.handleResult}
        title={txAuth.title}
      />
    </div>
  );
}
