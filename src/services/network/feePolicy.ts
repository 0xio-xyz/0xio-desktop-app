export const MAX_FEE_RAW = 10_000_000;

/** The lowest fee in OU the wallet signs for each private op, whatever the node quotes. */
export const FEE_FLOORS: Readonly<Record<string, number>> = {
  key_switch: 5_000,
  encrypt: 5_000,
  decrypt: 5_000,
  stealth: 5_000,
  claim: 3_000,
};

export function feeFloor(op: string): number {
  return FEE_FLOORS[op] ?? 0;
}

interface ValidFeeQuote {
  minimum: string;
  recommended: string;
  fast?: string;
}

function quoteValue(value: unknown): bigint | null {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (!text || text.length > 8 || (text.length > 1 && text[0] === "0")) return null;
  if (!/^\d+$/.test(text)) return null;
  const n = BigInt(text);
  return n === 0n || n > BigInt(MAX_FEE_RAW) ? null : n;
}

/** A node fee quote, or null when it is not one. The recommended fee is the first whole OU
 *  amount inside the limit of recommended, base_fee and minimum; a valid minimum may not exceed
 *  it. fast is kept only when valid and not below the recommended fee. */
export function validFeeQuote(source: unknown): ValidFeeQuote | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const r = source as Record<string, unknown>;
  const recommended = quoteValue(r.recommended) ?? quoteValue(r.base_fee) ?? quoteValue(r.minimum);
  if (recommended === null) return null;
  const minimum = quoteValue(r.minimum);
  if (minimum !== null && minimum > recommended) return null;
  const fast = quoteValue(r.fast);
  return {
    minimum: String(minimum ?? recommended),
    recommended: String(recommended),
    ...(fast !== null && fast >= recommended ? { fast: String(fast) } : {}),
  };
}

/** A valid quote raised to the op's floor, or null when the quote is invalid. */
export function flooredFeeQuote(op: string, source: unknown): ValidFeeQuote | null {
  const quote = validFeeQuote(source);
  if (!quote) return null;
  const floor = BigInt(feeFloor(op));
  const lift = (v: string) => {
    const n = BigInt(v);
    return String(n < floor ? floor : n);
  };
  return {
    minimum: lift(quote.minimum),
    recommended: lift(quote.recommended),
    ...(quote.fast ? { fast: lift(quote.fast) } : {}),
  };
}

/** Whether a fee in OU is one the wallet signs for this op: at its floor and inside the limit. */
export function feeAllowed(op: string, raw: number): boolean {
  return Number.isSafeInteger(raw) && raw >= Math.max(feeFloor(op), 1) && raw <= MAX_FEE_RAW;
}
