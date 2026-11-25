import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import FeePicker from "src/shared/ui/FeePicker";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Btn, EASE, ErrorLine, FOCUS, KV } from "src/shared/ui/look";
import type { useReviewFee } from "src/hooks/transactions/useFees";

const LINES = ["w-[82%]", "w-[64%]", "w-[74%]", "", "w-[88%]", "w-[70%]", "w-[79%]", "w-[52%]"];
const CELLS = Array.from({ length: 180 }, (_, i) => ((i * 7919 + (i >> 2) * 31) % 5 < 2 ? 1 : 0));

function Preview({ sealed }: { sealed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="flex min-h-0 flex-1 flex-col gap-2.25 overflow-hidden rounded-[11px] bg-surface px-4 py-3.5"
    >
      <span className="font-mono text-micro font-normal text-content-muted">oct://</span>
      {sealed ? (
        <span className="grid grid-cols-18 gap-1">
          {CELLS.map((on, i) => (
            <i
              key={i}
              className={`block h-2 rounded-xs ${on ? "bg-content-muted" : "bg-(--bg-3)"}`}
            />
          ))}
        </span>
      ) : (
        <>
          <i className="block h-2.25 w-[44%] shrink-0 rounded-full bg-content-secondary" />
          {LINES.map((w, i) => (
            <i
              key={i}
              className={`block h-1.5 shrink-0 rounded-full ${w ? `${w} bg-content-muted opacity-55` : ""}`}
            />
          ))}
        </>
      )}
    </span>
  );
}

function Passphrase({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <div className="flex h-11.5 items-center gap-2 rounded-[14px] bg-surface-highlight pr-2 pl-4">
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={label}
        aria-label={label}
        autoComplete="new-password"
        className="min-w-0 flex-1 bg-transparent text-body text-content outline-none placeholder:text-content-muted"
      />
      <button
        type="button"
        disabled={disabled}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        className={`h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content-secondary hover:text-content disabled:cursor-default ${EASE} ${FOCUS}`}
      >
        {t(shown ? "activity.hide" : "circles.show")}
      </button>
    </div>
  );
}

export default function NewCirclePane({
  wallet,
  fee,
  busy,
  onReview,
}: {
  wallet: { name: string; address: string };
  fee: ReturnType<typeof useReviewFee>;
  busy: boolean;
  onReview: (choice: { sealed: boolean; passphrase: string }) => void;
}) {
  const { t } = useTranslation();
  const [sealed, setSealed] = useState(false);
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const mismatch = sealed && !!pass && !!repeat && pass !== repeat;
  const ready = !sealed || (!!pass && pass === repeat);

  const tile = (value: boolean) => (
    <button
      type="button"
      aria-pressed={sealed === value}
      onClick={() => setSealed(value)}
      className={`flex min-h-0 cursor-pointer flex-col gap-3 rounded-2xl px-3 pt-3 pb-3.5 text-left text-lead ${
        sealed === value
          ? "bg-(--bg-3) font-semibold text-content"
          : "bg-surface-highlight font-medium text-content-secondary hover:text-content"
      } ${EASE} ${FOCUS}`}
    >
      <Preview sealed={value} />
      {t(value ? "circlesPage.encrypted" : "circlesPage.public")}
    </button>
  );

  return (
    <>
      <h2 className="flex h-9 shrink-0 items-center text-[1.375rem] font-semibold tracking-[-0.01em] text-content">
        {t("circles.newCircle")}
      </h2>
      <div className="mt-3.5 grid max-h-75 min-h-36 flex-3 grid-cols-2 gap-2.5">
        {tile(false)}
        {tile(true)}
      </div>
      <div
        className={`mt-2.5 grid shrink-0 grid-cols-2 gap-2.5 transition-opacity duration-200 ease-out motion-reduce:transition-none ${sealed ? "" : "opacity-40"}`}
      >
        <Passphrase
          label={t("circles.sealed.passphrase")}
          value={pass}
          onChange={setPass}
          disabled={!sealed}
        />
        <Passphrase
          label={t("circles.repeatPassphrase")}
          value={repeat}
          onChange={setRepeat}
          disabled={!sealed}
        />
      </div>
      <div className="mt-2 shrink-0 px-1">
        <ErrorLine text={mismatch ? t("circles.passphraseMismatch") : null} />
      </div>
      <span className="min-h-2 flex-1" />
      <div className="shrink-0">
        <KV label={t("sendFlow.from")}>
          <WalletAvatar address={wallet.address} size={22} />
          {wallet.name}
        </KV>
        <KV label={t("sendFlow.networkFee")}>
          <FeePicker quote={fee.quote} ou={fee.ou} onChange={fee.setOU} />
        </KV>
        <div className="mt-3.5 flex justify-end">
          <Btn
            weight="primary"
            className="look-key w-60"
            disabled={busy || !ready}
            onClick={() => onReview({ sealed, passphrase: sealed ? pass : "" })}
          >
            {t("circlesPage.reviewDeploy")}
          </Btn>
        </div>
      </div>
    </>
  );
}
