import { FOCUS } from "src/features/settings/components/parts";

const DECIMAL = /^\d*\.?\d{0,6}$/;
const WHOLE = /^\d*$/;

const FIELD = `h-8 rounded-full bg-surface-highlight px-3.5 text-[0.8125rem] text-content placeholder:text-content-muted ${FOCUS}`;

export function NumField({
  value,
  onChange,
  label,
  unit,
  whole,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  unit?: string;
  whole?: boolean;
  placeholder?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="text"
        inputMode={whole ? "numeric" : "decimal"}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          if ((whole ? WHOLE : DECIMAL).test(e.target.value)) onChange(e.target.value);
        }}
        className={`w-28 text-right tabular-nums ${FIELD}`}
      />
      {unit !== undefined && (
        <span className="w-8 text-[0.8125rem] text-content-muted">{unit}</span>
      )}
    </span>
  );
}

export function TextField({
  value,
  onChange,
  label,
  placeholder,
  mono,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      className={`w-72 ${mono ? "font-mono" : ""} ${FIELD}`}
    />
  );
}
