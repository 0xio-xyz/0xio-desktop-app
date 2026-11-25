import { methodWords, readableMethod } from "./callReading";
import {
  argKind,
  argLabel,
  argLabelWords,
  capCallText,
  networkName,
  plausibleTime,
  type ArgKind,
  type ArgSpec,
} from "./callArgs";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const OCTRA_MAX_ARGS = 8;
export const CALL_DATA_MAX = 32;
const ADDRESS = /^oct[1-9A-HJ-NP-Za-km-z]{40,48}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const INTEGER = /^\d{1,80}$/;

export interface TxDetailRow {
  named?: string;
  label: string;
  value: string;
  tone?: "muted" | "danger";
  mono?: boolean;
  copy?: string;
  pending?: boolean;
}

interface CallArg {
  index: number;
  name?: string;
  label: string;
  type?: string;
  value: string;
  friendly?: string;
}

export interface CallData {
  method: string | null;
  functionName: string | null;
  contract: { address: string; name: string | null } | null;
  args: CallArg[];
}

export const middleOf = (value: string, head = 10, tail = 8) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;

export const whenOf = (timestamp: number) => {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function fromUnits(raw: string, decimals: number): string {
  const digits = raw.replace(/^0+(?=\d)/, "");
  if (decimals <= 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const int = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

const trimAmount = (amount: string) => {
  const [int, frac = ""] = amount.split(".");
  const cut = frac.slice(0, 6).replace(/0+$/, "");
  if (!cut && frac && int === "0") return "< 0.000001";
  return cut ? `${int}.${cut}` : int;
};

// The node carries the arguments as a JSON array in `message`.
export function octraCallArgs(message: unknown): unknown[] | null {
  if (typeof message !== "string" || !message) return null;
  try {
    const parsed = JSON.parse(message);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const argText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : (JSON.stringify(value) ?? String(value));

const isAddressText = (text: string) => ADDRESS.test(text) || EVM_ADDRESS.test(text);

const valueLabel = (index: number, t: Translate) =>
  t("txDetail.valueN", { n: index + 1, defaultValue: "Value {{n}}" });

export function callMethod(
  raw: string | null | undefined,
): Pick<CallData, "method" | "functionName"> {
  const name = readableMethod(raw);
  if (!name) return { method: null, functionName: null };
  const words = methodWords(name);
  const fn = raw!.trim();
  return { method: words, functionName: fn !== words ? fn : null };
}

const plain = (label: string, text: string): TxDetailRow => {
  const long = text.length > 28;
  return {
    label,
    value: long ? middleOf(text) : text,
    mono: long,
    copy: long ? text : undefined,
  };
};

function friendlyOf(
  text: string,
  kind: ArgKind,
  t: Translate,
  unit?: { decimals: number; symbol: string } | null,
): string | null {
  if (kind === "chain") {
    const name = networkName(text);
    return name !== text ? name : null;
  }
  if (kind === "epoch" && INTEGER.test(text)) {
    return t("txDetail.arg.epochValue", { n: text, defaultValue: "Epoch {{n}}" });
  }
  if (kind === "expiry") {
    const ms = plausibleTime(text);
    if (ms) return whenOf(ms);
  }
  if (kind === "amount" && unit && INTEGER.test(text)) {
    return `${trimAmount(fromUnits(text, unit.decimals))} ${unit.symbol}`;
  }
  return null;
}

function formatArgRow(
  label: string,
  value: unknown,
  kind: ArgKind,
  t: Translate,
  unit?: { decimals: number; symbol: string } | null,
): TxDetailRow {
  const text = argText(value);
  if (isAddressText(text)) return { label, value: middleOf(text), mono: true, copy: text };
  if (kind === "chain") return { label, value: networkName(text) };
  const friendly = friendlyOf(text, kind, t, unit);
  if (friendly) return { label, value: friendly };
  if (typeof value === "boolean" || text === "true" || text === "false") {
    return {
      label,
      value:
        text === "true"
          ? t("txDetail.yes", { defaultValue: "Yes" })
          : t("txDetail.no", { defaultValue: "No" }),
    };
  }
  return plain(label, text);
}

function callArg(
  index: number,
  name: string | undefined,
  label: string,
  type: string | undefined,
  raw: string,
  friendly: string | null,
): CallArg {
  return {
    index,
    label,
    value: capCallText(raw),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(friendly && friendly !== raw ? { friendly: capCallText(friendly) } : {}),
  };
}

function octraType(value: unknown): string | undefined {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : undefined;
  if (typeof value === "string") return isAddressText(value) ? "address" : "string";
  return undefined;
}

function specUnit(
  spec: ArgSpec,
  args: readonly unknown[],
): { decimals: number; symbol: string } | null {
  if (!spec.unit) return null;
  if ("symbol" in spec.unit) return spec.unit;
  const symbol = argText(args[spec.unit.assetArg] ?? "")
    .trim()
    .toUpperCase();
  const decimals = spec.unit.decimals[symbol];
  return decimals === undefined ? null : { decimals, symbol };
}

const specLabel = (spec: ArgSpec, t: Translate) =>
  spec.label ? argLabelWords(spec.label, t) : argLabel(spec.name, t);

export function knownArgPlaceholders(specs: readonly ArgSpec[], t: Translate): TxDetailRow[] {
  return specs
    .filter((s) => !s.onlyWhenUnread)
    .map((s) => ({ label: specLabel(s, t), value: "", pending: true }));
}

export function octraArgRows(
  args: readonly unknown[],
  specs: readonly ArgSpec[] | null,
  abiNames: readonly string[] | null,
  t: Translate,
): { rows: TxDetailRow[]; args: CallArg[] } {
  const rows: TxDetailRow[] = [];
  if (specs) {
    const read = new Set<number>();
    for (const spec of specs) {
      if (spec.index >= args.length || !spec.unit) continue;
      if (specUnit(spec, args) && "assetArg" in spec.unit) read.add(spec.unit.assetArg);
    }
    for (const spec of specs) {
      if (spec.index >= args.length) continue;
      if (spec.onlyWhenUnread && read.has(spec.index)) continue;
      rows.push(
        formatArgRow(
          specLabel(spec, t),
          args[spec.index],
          spec.kind ?? argKind(spec.name),
          t,
          specUnit(spec, args),
        ),
      );
    }
  } else if (abiNames) {
    args.forEach((value, index) => {
      const name = abiNames[index]?.trim();
      if (!name || rows.length >= OCTRA_MAX_ARGS) return;
      rows.push(formatArgRow(argLabel(name, t), value, argKind(name), t));
    });
  }
  const bySpec = new Map((specs ?? []).map((spec) => [spec.index, spec]));
  const entries = args.slice(0, CALL_DATA_MAX).map((value, index) => {
    const spec = bySpec.get(index);
    const name = spec?.name ?? (abiNames?.[index]?.trim() || undefined);
    const label = spec ? specLabel(spec, t) : name ? argLabel(name, t) : valueLabel(index, t);
    const text = argText(value);
    const friendly = isAddressText(text)
      ? null
      : friendlyOf(
          text,
          spec?.kind ?? (name ? argKind(name) : "text"),
          t,
          spec ? specUnit(spec, args) : null,
        );
    return callArg(index, name, label, octraType(value), text, friendly);
  });
  return { rows, args: entries };
}

export const ouToOct = (ou: string | number | null | undefined): string | null => {
  const n = Number(ou);
  return ou != null && ou !== "" && Number.isFinite(n) && n > 0
    ? parseFloat((n / 1_000_000).toFixed(6)).toString()
    : null;
};
