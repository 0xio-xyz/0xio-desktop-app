import React, { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronLeft } from "src/shared/ui/icons";
import Button from "src/shared/ui/Button";
import useMountEffect from "src/hooks/ui/useMountEffect";

export function StepHeader({ onBack, aside }: { onBack?: () => void; aside?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="h-16 shrink-0 flex items-center justify-between">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 h-9 pl-1 pr-3 rounded-full inline-flex items-center gap-1 text-body font-semibold text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer"
        >
          <ChevronLeft size={16} aria-hidden="true" />
          {t("common.back")}
        </button>
      ) : (
        <span />
      )}
      {aside}
    </div>
  );
}

export function AsideButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-mr-3 h-9 px-3 rounded-full text-body font-semibold text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

export function FlowLayout({
  children,
  footer,
  onSubmit,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  onSubmit?: () => void;
}) {
  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      onKeyDown={(e) => {
        if (!onSubmit || e.key !== "Enter" || e.nativeEvent.isComposing) return;
        if ((e.target as HTMLElement).tagName !== "INPUT") return;
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide flex flex-col pt-14">
        {children}
      </div>
      <div className="shrink-0 flex flex-col gap-2.5 pt-3 pb-8">{footer}</div>
    </div>
  );
}

export function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return <Button fullWidth size="lg" {...props} />;
}

const useStepFocus = (on: boolean) => {
  const ref = useRef<HTMLHeadingElement>(null);
  useMountEffect(() => {
    if (on) ref.current?.focus({ preventScroll: true });
  });
  return ref;
};

export function FlowCopy({
  title,
  sub,
  focusTitle = false,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  focusTitle?: boolean;
}) {
  const ref = useStepFocus(focusTitle);
  return (
    <div className="shrink-0 min-h-30 pb-6">
      <h1
        ref={ref}
        tabIndex={focusTitle ? -1 : undefined}
        className="text-3xl font-black text-content tracking-tight outline-none"
      >
        {title}
      </h1>
      {sub && (
        <p className="text-sm font-medium text-content-secondary mt-2 leading-relaxed">{sub}</p>
      )}
    </div>
  );
}

export function FlowHero({
  art,
  title,
  sub,
  visible = true,
  children,
}: {
  art: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  visible?: boolean;
  children?: React.ReactNode;
}) {
  const ref = useStepFocus(true);
  return (
    <>
      <div className="h-24 flex items-center justify-center">{art}</div>
      <div
        className="mt-6 flex flex-col transition-opacity duration-200 ease-out"
        style={{ opacity: visible ? 1 : 0 }}
      >
        <div className="text-center">
          <h1
            ref={ref}
            tabIndex={-1}
            className="text-3xl font-black text-content tracking-tight outline-none"
          >
            {title}
          </h1>
          {sub && (
            <p className="text-sm font-medium text-content-secondary mt-2 leading-relaxed">{sub}</p>
          )}
        </div>
        {children}
      </div>
    </>
  );
}

export function NoteLine({
  negative = false,
  children,
}: {
  negative?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <p
      aria-live="polite"
      className={`mt-2 min-h-5 text-meta leading-snug ${negative ? "text-danger" : "text-content-secondary"}`}
    >
      {children}
    </p>
  );
}

export function PasswordField({
  value,
  onChange,
  label,
  placeholder,
  invalid = false,
  autoComplete = "new-password",
  autoFocus = true,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  invalid?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`h-12 flex items-center gap-2 pl-4 pr-1.5 rounded-xl bg-surface-input transition-shadow ${
        invalid ? "ring-1 ring-danger" : "focus-within:ring-1 focus-within:ring-content-muted/50"
      }`}
    >
      <input
        ref={input}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? label}
        aria-label={label}
        aria-invalid={invalid}
        autoComplete={autoComplete}
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        className="flex-1 min-w-0 bg-transparent text-body text-content placeholder:text-content-muted outline-none disabled:opacity-60"
      />
      <button
        type="button"
        onClick={() => {
          setShown((v) => !v);
          input.current?.focus();
        }}
        aria-pressed={shown}
        disabled={disabled}
        className="h-9 px-3 rounded-lg text-meta font-semibold text-content-muted hover:text-content hover:bg-surface-highlight transition-colors cursor-pointer disabled:opacity-40"
      >
        {shown ? t("addWallet.hide") : t("addWallet.show")}
      </button>
    </div>
  );
}

export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-h-11 py-3 flex items-center justify-between gap-3 text-body">
      <span className="text-content-secondary shrink-0">{label}</span>
      {children}
    </div>
  );
}

export const middleCut = (address: string, head = 10, tail = 8) =>
  address.length > head + tail + 3
    ? `${address.slice(0, head)}...${address.slice(-tail)}`
    : address;
