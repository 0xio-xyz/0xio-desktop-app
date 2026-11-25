import { useMemo, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { useQuery } from "src/lib/query";
import { ChevronDown } from "src/shared/ui/icons";
import FeePicker from "src/shared/ui/FeePicker";
import OutlineTag from "src/shared/ui/OutlineTag";
import { Btn, Caps, EASE, FOCUS, Skel } from "src/shared/ui/look";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import { useNow } from "src/hooks/privacy/useProofQueue";
import * as networkService from "src/services/network/networkService";
import { NETWORKS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import { fetchCircleInfo } from "src/features/dapp/services/circleRead";
import { useCircleBatchFee } from "src/features/circles/hooks/useCircleBatchFee";
import { circleAssetB64Len } from "src/features/circles/services/circleDeploy";
import {
  CHOOSES_BOTH,
  chosenFiles,
  droppedFiles,
  type ChooseKind,
} from "src/features/circles/services/circleDrop";
import { circleUrl, cutId, fileDay, fileSize } from "src/features/circles/services/circleFormat";
import {
  circleBytes,
  circleTitle,
  updateCircle,
  type CircleRecord,
  type LibraryScope,
} from "src/features/circles/services/circleLibrary";
import {
  checkAgain,
  CIRCLE_BATCH_MAX,
  CIRCLE_STAGED_MAX,
  circleKey,
  closeBatch,
  runBatch,
  setStagedPath,
  showBatch,
  stagedRows,
  stageFiles,
  unstage,
  useCircleRun,
  type StagedFile,
} from "src/features/circles/services/circleRun";
import { checkPassphrase } from "src/features/circles/services/circleUnlock";
import {
  BatchSheet,
  ReplaceTag,
  RunMark,
  UploadReview,
} from "src/features/circles/components/CircleSheets";

const NONE: StagedFile[] = [];
const STAGED_COLS = "grid-cols-[minmax(0,1fr)_4.5rem_7rem_4.5rem]";
const FILE_COLS = "grid-cols-[minmax(0,1fr)_5.25rem_7rem]";
const ROW = "grid min-h-11 items-center gap-x-4 rounded-xl px-3.5 text-[0.84375rem]";
const BAR = "flex h-16 shrink-0 items-center gap-3.5 rounded-2xl bg-surface-highlight pr-3 pl-4.5";
const BAR_TEXT = "min-w-0 flex-1 truncate text-body text-content-secondary";
const BAR_BTN = "bg-(--bg-3)! hover:opacity-90";

export default function CirclePane({
  scope,
  wallet,
  circle,
  network,
  passphrase,
  onUnlock,
  requestAuth,
}: {
  scope: LibraryScope;
  wallet: { id: string; name: string; address: string };
  circle: CircleRecord;
  network: string;
  passphrase: string | undefined;
  onUnlock: (passphrase: string) => void;
  requestAuth: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const run = useCircleRun();
  const key = circleKey(scope, circle.id);
  const title = circleTitle(circle);
  const sealed = circle.sealed;
  const rpcUrl = NETWORKS[scope.networkId]?.rpcUrl ?? "";

  const info = useQuery({
    queryKey: ["circleInfo", scope.networkId, scope.address, circle.id],
    enabled: sealed === null,
    retry: 1,
    queryFn: async () => {
      const got = await fetchCircleInfo(rpcUrl, circle.id, wallet);
      if (!got) throw new Error("circle info unavailable");
      updateCircle(scope, circle.id, { sealed: got.resource_mode === "sealed_read" });
      return got;
    },
  });

  const staged = run.staged[key] ?? NONE;
  const rows = useMemo(
    () => (sealed === null ? [] : stagedRows(staged, circle, sealed)),
    [staged, circle, sealed],
  );
  const ready = useMemo(() => rows.filter((r) => r.path), [rows]);
  const lens = useMemo(
    () => ready.map((r) => circleAssetB64Len(r.size, !!sealed)),
    [ready, sealed],
  );
  const fee = useCircleBatchFee(sealed ? "circle_asset_put_encrypted" : "circle_asset_put", lens);

  const batch =
    run.batch && circleKey(run.batch.scope, run.batch.circleId) === key ? run.batch : null;
  const running = batch?.status === "running";
  const inRun = new Map(batch?.files.map((f) => [f.key, f]));
  const now = useNow(!!running);
  const unconfirmed = circle.files.filter((f) => f.status === "pending").length;
  const checking = run.checking.includes(key);
  const locked = sealed === true && passphrase === undefined;
  const open =
    sealed !== null && circle.status === "confirmed" && !batch && !unconfirmed && !locked;

  const [review, setReview] = useState<networkService.TxScope | null>(null);
  const [copied, setCopied] = useState(false);
  const [over, setOver] = useState(false);
  const [pass, setPass] = useState("");
  const [unlock, setUnlock] = useState<"" | "busy" | "wrong" | "unchecked">("");
  const chooser = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  useOutsideClose(chooser, menu, () => setMenu(false));

  const copy = () => {
    void navigator.clipboard.writeText(circle.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const add = (files: { file: File; path: string }[]) => {
    if (open && files.length) stageFiles(scope, circle.id, files);
  };

  const choose = (kind: ChooseKind) => {
    setMenu(false);
    void chosenFiles(kind)
      .then(add)
      .catch((e) => logger.error("circles", `choose failed: ${e}`));
  };
  const onChoose = () => (CHOOSES_BOTH ? choose("any") : setMenu((m) => !m));
  const chevron = CHOOSES_BOTH ? null : (
    <ChevronDown size={13} className="ml-1.5 text-content-muted" aria-hidden="true" />
  );
  const chooseMenu = (side: string) =>
    menu && (
      <div
        role="menu"
        className={`absolute bottom-[calc(100%+6px)] ${side} z-30 w-44 rounded-2xl bg-surface-card p-1.5 shadow-[0_30px_70px_-20px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] animate-in fade-in-0 slide-in-from-bottom-1.5 duration-200 ease-out motion-reduce:animate-none`}
      >
        {(["files", "folder"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => choose(kind)}
            className={`flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-body font-medium text-content hover:bg-surface-highlight ${EASE} ${FOCUS}`}
          >
            {t(kind === "files" ? "circles.chooseKindFiles" : "circles.chooseKindFolder")}
          </button>
        ))}
      </div>
    );

  const tryUnlock = async () => {
    if (!pass || unlock === "busy") return;
    setUnlock("busy");
    const result = await checkPassphrase({ rpcUrl, circle, reader: wallet, passphrase: pass });
    if (result !== "ok") return setUnlock(result);
    setUnlock("");
    setPass("");
    onUnlock(pass);
  };

  const openReview = () => {
    fee.recheck.setError("");
    setReview(networkService.captureScope(wallet.address));
  };

  const upload = async () => {
    const reviewed = review;
    const files = ready.map((row, i) => ({ row, ou: fee.parts[i], len: lens[i] }));
    if (!reviewed || sealed === null || files.some((f) => !f.ou)) return;
    if (await fee.recheck.check(reviewed.networkId, fee.parts)) return;
    setReview(null);
    if (!(await requestAuth(t("circles.authUpload")))) return;
    void runBatch({
      scope: reviewed,
      walletId: wallet.id,
      circleId: circle.id,
      sealed,
      passphrase: passphrase ?? "",
      files,
    });
  };

  const bar = () => {
    if (sealed === null)
      return info.isError ? (
        <div className={BAR}>
          <span role="alert" className={BAR_TEXT}>
            {t("circles.infoFailed")}
          </span>
          <Btn size="sm" className={BAR_BTN} onClick={() => void info.refetch()}>
            {t("fee.tryAgain")}
          </Btn>
        </div>
      ) : (
        <div aria-busy="true" className={`${BAR} opacity-40`}>
          <span className={BAR_TEXT}>{t("circles.dropFiles")}</span>
          <Btn size="sm" className={BAR_BTN} disabled>
            {t("circles.chooseFiles")}
          </Btn>
        </div>
      );
    if (batch)
      return (
        <div className={BAR}>
          <span className={`${BAR_TEXT} tabular-nums`}>
            {running
              ? t("circles.uploadingOf", {
                  n: Math.min(
                    batch.files.length,
                    batch.files.filter((f) => f.state !== "waiting").length || 1,
                  ),
                  count: batch.files.length,
                })
              : t("circles.uploadedOf", {
                  done: batch.files.filter((f) => f.state === "confirmed").length,
                  count: batch.files.length,
                })}
          </span>
          <Btn size="sm" className={BAR_BTN} onClick={() => showBatch(true)}>
            {t("activity.showProgress")}
          </Btn>
        </div>
      );
    if (circle.status === "pending" || unconfirmed)
      return (
        <div className={BAR}>
          <span className={BAR_TEXT}>
            {circle.status === "pending"
              ? t("circles.deployPending")
              : t("circles.filesPending", { count: unconfirmed })}
          </span>
          <Btn
            size="sm"
            className={BAR_BTN}
            disabled={checking}
            onClick={() => void checkAgain(scope, circle.id)}
          >
            {t("circles.checkAgain")}
          </Btn>
        </div>
      );
    if (locked)
      return (
        <form
          className={`${BAR} pl-3`}
          onSubmit={(e) => {
            e.preventDefault();
            void tryUnlock();
          }}
        >
          <input
            type="password"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
              if (unlock !== "busy") setUnlock("");
            }}
            disabled={unlock === "busy"}
            placeholder={t("circles.sealed.passphrase")}
            aria-label={t("circles.sealed.passphrase")}
            autoComplete="off"
            className="h-10 min-w-0 flex-1 rounded-xl bg-(--bg-3) px-4 text-body text-content outline-none placeholder:text-content-muted"
          />
          <span role="alert" className="shrink-0 text-meta whitespace-nowrap text-danger">
            {unlock === "wrong"
              ? t("circles.wrongPassphrase")
              : unlock === "unchecked"
                ? t("circles.passphraseUnchecked")
                : ""}
          </span>
          <Btn type="submit" size="sm" className={BAR_BTN} disabled={!pass || unlock === "busy"}>
            {t("circles.unlock")}
          </Btn>
        </form>
      );
    if (!rows.length)
      return (
        <div className={`${BAR} ${over ? "bg-(--bg-3)!" : ""} ${EASE}`}>
          <span className={BAR_TEXT}>{t("circles.dropFiles")}</span>
          <span ref={chooser} className="relative inline-flex">
            <Btn
              size="sm"
              className={over ? "bg-surface-highlight!" : BAR_BTN}
              aria-haspopup={CHOOSES_BOTH ? undefined : "menu"}
              aria-expanded={CHOOSES_BOTH ? undefined : menu}
              onClick={onChoose}
            >
              {t("circles.chooseFiles")}
              {chevron}
            </Btn>
            {chooseMenu("right-0")}
          </span>
        </div>
      );
    return (
      <div className={`${BAR} ${over ? "bg-(--bg-3)!" : ""} ${EASE}`}>
        <span className="text-body whitespace-nowrap text-content-muted">
          {t("circles.files", { count: ready.length })}
          <span className="ml-2 font-medium text-content tabular-nums">
            {fileSize(ready.reduce((n, r) => n + r.size, 0))}
          </span>
        </span>
        <span ref={chooser} className="relative inline-flex">
          <button
            type="button"
            aria-haspopup={CHOOSES_BOTH ? undefined : "menu"}
            aria-expanded={CHOOSES_BOTH ? undefined : menu}
            onClick={onChoose}
            className={`inline-flex h-7.5 cursor-pointer items-center rounded-full px-2.5 text-[0.8125rem] font-medium text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
          >
            {t("circles.addFiles")}
            {chevron}
          </button>
          {chooseMenu("left-0")}
        </span>
        <span className="flex-1" />
        {ready.length > 0 && <FeePicker quote={fee.quote} ou={fee.ou} onChange={fee.setOU} />}
        <Btn
          weight="primary"
          size="sm"
          className="look-key h-10 w-42"
          disabled={!ready.length || fee.quote.status !== "ok" || run.batch?.status === "running"}
          onClick={openReview}
        >
          {t("circles.reviewUpload")}
        </Btn>
      </div>
    );
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        if (open) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (open) void droppedFiles(e.dataTransfer, CIRCLE_STAGED_MAX).then(add);
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-3">
        <h2
          className={`min-w-0 truncate text-[1.375rem] font-semibold tracking-[-0.01em] text-content ${title ? "" : "font-mono"}`}
        >
          {title || cutId(circle.id)}
        </h2>
        {sealed === null ? (
          <Skel w="w-14" still={info.isError} />
        ) : sealed ? (
          <OutlineTag label={t("circlesPage.encrypted")} />
        ) : (
          <span className="text-[0.8125rem] text-content-secondary">{t("circlesPage.public")}</span>
        )}
        <span className="flex-1" />
        <Btn
          size="sm"
          disabled={circle.status !== "confirmed"}
          onClick={() => navigate(`/browser?url=${encodeURIComponent(circleUrl(circle.id))}`)}
        >
          {t("circles.openInBrowser")}
        </Btn>
      </div>

      <div className="mt-3.5 flex h-11.5 shrink-0 items-center gap-3 rounded-[14px] bg-surface-highlight pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-content">
          <span className="text-content-muted">oct://</span>
          {cutId(circle.id, true)}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t("circles.copy")}
          className={`h-7.5 w-17 cursor-pointer rounded-full text-[0.8125rem] font-medium text-content ${EASE} ${FOCUS}`}
        >
          {t(copied ? "common.copied" : "circles.copy")}
        </button>
      </div>

      <div
        className="relative mt-5.5 min-h-0 flex-1 overflow-y-auto scrollbar-hide"
        style={{ maskImage: "linear-gradient(to bottom, black calc(100% - 32px), transparent)" }}
      >
        {rows.length > 0 && (
          <section {...(batch ? { inert: "" } : {})} className="mb-3.5">
            <Caps
              className="px-3.5 pb-1.5"
              right={
                <span className="inline-flex gap-3.5 tabular-nums">
                  <span>{t("circles.files", { count: ready.length })}</span>
                  <span>{fileSize(ready.reduce((n, r) => n + r.size, 0))}</span>
                </span>
              }
            >
              {t("circles.readyToUpload")}
            </Caps>
            {rows.map((r) => {
              const sent = inRun.get(r.key);
              return (
                <div key={r.key} className={`${ROW} ${STAGED_COLS}`}>
                  <input
                    value={r.rawPath}
                    onChange={(e) => setStagedPath(scope, circle.id, r.key, e.target.value)}
                    aria-label={t("circles.path")}
                    aria-invalid={!!r.refusal || undefined}
                    spellCheck={false}
                    className={`h-7.5 min-w-0 rounded-[9px] bg-surface-highlight px-2.5 font-mono text-[0.8125rem] outline-none ${FOCUS} ${r.refusal ? "text-content-muted" : "text-content"}`}
                  />
                  <span className="text-right whitespace-nowrap text-content-secondary tabular-nums">
                    {fileSize(r.size)}
                  </span>
                  <span className="whitespace-nowrap">
                    {sent ? (
                      <RunMark file={sent} now={now} />
                    ) : r.refusal ? (
                      <span role="alert" className="text-[0.8125rem] text-danger">
                        {t(`circles.refuse.${r.refusal}`, { max: CIRCLE_BATCH_MAX })}
                      </span>
                    ) : (
                      <ReplaceTag replace={r.replace} />
                    )}
                  </span>
                  <span className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => unstage(scope, circle.id, r.key)}
                      className={`-mr-2.5 h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
                    >
                      {t("circles.remove")}
                    </button>
                  </span>
                </div>
              );
            })}
          </section>
        )}
        <section
          className={`pb-8 transition-opacity duration-200 ease-out motion-reduce:transition-none ${rows.length ? "opacity-40" : ""}`}
        >
          <Caps
            className="px-3.5 pb-1.5"
            right={
              circle.files.length > 0 && (
                <span className="inline-flex gap-3.5 tabular-nums">
                  <span>{t("circles.files", { count: circle.files.length })}</span>
                  <span>{fileSize(circleBytes(circle))}</span>
                </span>
              )
            }
          >
            {t("circles.publishedHere")}
          </Caps>
          {circle.files.map((f) => {
            const day = fileDay(f.at);
            return (
              <div key={f.path} className={`${ROW} ${FILE_COLS}`}>
                <span className="truncate font-mono text-[0.8125rem] text-content">{f.path}</span>
                <span className="text-right whitespace-nowrap text-content-secondary tabular-nums">
                  {fileSize(f.size)}
                </span>
                <span className="whitespace-nowrap text-content-muted tabular-nums">
                  {f.status === "pending"
                    ? t("circles.state.pending")
                    : day.today
                      ? `${t("history.today")} ${day.text}`
                      : day.text}
                </span>
              </div>
            );
          })}
        </section>
      </div>

      <div className="mt-3 shrink-0">{bar()}</div>

      <UploadReview
        open={!!review}
        network={network}
        wallet={wallet}
        circleId={circle.id}
        title={title}
        sealed={!!sealed}
        rows={ready}
        fee={fee}
        onReject={() => setReview(null)}
        onConfirm={() => void upload()}
      />
      {batch?.shown && (
        <BatchSheet
          batch={batch}
          title={title}
          onHide={() => showBatch(false)}
          onBack={closeBatch}
          onReviewRest={() => {
            closeBatch();
            openReview();
          }}
          onCheck={() => {
            closeBatch();
            void checkAgain(scope, circle.id);
          }}
        />
      )}
    </div>
  );
}
