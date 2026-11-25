/**
 * Amounts and fees a site names, read the way the extension reads them (utils/octra/dappTx.ts):
 * raw amounts are whole micro-OCT, labels are exact decimals, and a site's own fee is kept only
 * when the node takes it.
 */

const OCT_DECIMALS = 6;
const MIN_OU = 1n;
const MAX_OU = 10_000_000n;

export function parseBaseUnits(value: unknown): bigint | null {
  if (value == null || value === "") return 0n;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^\d{1,30}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** A raw micro-OCT amount as exact OCT: 1000000 is "1", 1500000 is "1.5", 1 is "0.000001". */
function formatRawOct(raw: bigint): string {
  const s = raw.toString().padStart(OCT_DECIMALS + 1, "0");
  const whole = s.slice(0, -OCT_DECIMALS);
  const frac = s.slice(-OCT_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export const rawOctLabel = (raw: bigint): string => `${formatRawOct(raw)} OCT`;

function parseOu(value: unknown): bigint | null {
  if (value == null || value === "") return null;
  const ou = parseBaseUnits(value);
  if (ou == null || ou < MIN_OU || ou > MAX_OU) return null;
  return ou;
}

const quoteOu = (value: string): bigint | null => {
  const ou = parseBaseUnits(value);
  return ou != null && ou > 0n ? ou : null;
};

/**
 * The fee a site request is reviewed and signed at: the site's own when it is a whole number the
 * node takes now (at or above the live minimum), else the live recommendation. null when the
 * quote holds no fee.
 */
export function siteFeeOu(
  requested: unknown,
  quote: { minimum: string; recommended: string } | null,
): string | null {
  if (!quote) return null;
  const rec = quoteOu(quote.recommended);
  if (rec == null) return null;
  const min = quoteOu(quote.minimum);
  const floor = min != null && min < rec ? min : rec;
  const own = parseOu(requested);
  return (own != null && own >= floor ? own : rec).toString();
}
