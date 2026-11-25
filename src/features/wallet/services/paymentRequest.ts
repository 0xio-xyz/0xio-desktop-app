// What the Receive code carries: the bare address, or a request for an amount as
// octra:<address>?amount=<decimal OCT>, the same payload the mobile app's Receive builds and its
// Send scanner reads.

const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MAX_WHOLE = 9;

/** "007.50" -> "7.5", "12." -> "12"; zero, too large or anything not a plain decimal -> "". */
export function requestAmount(raw: string): string {
  const v = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (!DECIMAL.test(v)) return "";
  const [whole, fraction = ""] = v.split(".");
  const w = whole.replace(/^0+/, "") || "0";
  const f = fraction.replace(/0+$/, "");
  if (w.length > MAX_WHOLE || (w === "0" && !f)) return "";
  return f ? `${w}.${f}` : w;
}

export function buildPaymentRequest(address: string, amount: string): string {
  const a = requestAmount(amount);
  return a ? `octra:${address}?amount=${a}` : address;
}
