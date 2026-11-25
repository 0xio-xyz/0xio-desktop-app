export interface HashableTx {
  from: string;
  to_: string;
  amount: string | number;
  nonce: number;
  ou: string | number;
  timestamp: number;
  signature?: string;
  op_type?: string;
  public_key?: string | null;
  message?: string | null;
  encrypted_data?: string | null;
}

export function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1).replace(/\x7f/g, "\\u007f");
}

export function plainDigits(v: string | number | bigint): string {
  if (typeof v === "number" && !Number.isSafeInteger(v)) {
    throw new Error("transaction amount and fee must use decimal whole units");
  }
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error("transaction amount and fee must use decimal whole units");
  return s.replace(/^0+(?=\d)/, "");
}

function general(x: number, precision: number): string {
  const [mantissa, e] = x.toExponential(precision - 1).split("e");
  const exp = Number(e);
  const trim = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
  if (exp < -4 || exp >= precision) {
    return `${trim(mantissa)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return trim(x.toFixed(precision - 1 - exp));
}

/** The node's timestamp text: shortest of 16 or 17 significant digits that reads back exactly,
 *  with ".0" on a whole number. */
export function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts)) throw new Error("transaction time is not finite");
  let text = general(ts, 16);
  if (Number(text) !== ts) text = general(ts, 17);
  if (!/[.eE]/.test(text)) text += ".0";
  return text;
}

/** The node hashes a field it was sent as that string, even ""; only a missing or null one is null. */
const optional = (v: string | null | undefined) => (v == null ? "null" : `"${jsonEscape(v)}"`);

export function txHashJson(tx: HashableTx): string {
  return (
    `{"from":"${jsonEscape(tx.from)}","to_":"${jsonEscape(tx.to_)}","amount":"${plainDigits(tx.amount)}"` +
    `,"nonce":${tx.nonce},"ou":"${plainDigits(tx.ou)}","timestamp":${formatTimestamp(tx.timestamp)}` +
    `,"signature":"${jsonEscape(tx.signature ?? "")}","op_type":"${jsonEscape(tx.op_type || "standard")}"` +
    `,"public_key":${optional(tx.public_key)},"message":${optional(tx.message)}` +
    `,"encrypted_data":${optional(tx.encrypted_data)}}`
  );
}

export async function computeTxHash(tx: HashableTx): Promise<string> {
  const bytes = new TextEncoder().encode(txHashJson(tx));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
