function commaFormat(n: number, maxDec: number): string {
  const fixed = n.toFixed(maxDec);
  const clean = fixed.replace(/\.?0+$/, "") || "0";
  const [int, frac] = clean.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${withCommas}.${frac}` : withCommas;
}

export function formatOCT(microOCT: number): string {
  return commaFormat(microOCT / 1_000_000, 6);
}

export function formatOCTShort(microOCT: number): string {
  const oct = microOCT / 1_000_000;
  const maxDecimals = oct >= 1000 ? 2 : oct >= 1 ? 4 : 6;
  return commaFormat(oct, maxDecimals);
}

// Contract methods come off the chain as snake_case identifiers (unlock_trusted, lock_to_eth).
// Read as sentence case with the acronyms left alone, so a history row says what happened.
const METHOD_ACRONYMS: Record<string, string> = {
  nft: "NFT",
  eth: "ETH",
  oct: "OCT",
  fhe: "FHE",
  id: "ID",
  url: "URL",
  uri: "URI",
  oat: "OAT",
};

export function formatMethodName(method: string): string {
  const words = method
    .trim()
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return method;
  return words
    .map((word, i) => {
      const acronym = METHOD_ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      if (i > 0) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function truncateAddress(address: string, startChars = 8, endChars = 6): string {
  if (address.length <= startChars + endChars + 3) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

export function parseOCTInput(input: string): number {
  if (!input || input === ".") return 0;
  const parts = input.split(".");
  const intPart = parseInt(parts[0] || "0", 10);
  if (isNaN(intPart) || intPart < 0) return 0;
  const fracStr = (parts[1] || "").padEnd(6, "0").slice(0, 6);
  const fracPart = parseInt(fracStr, 10);
  if (isNaN(fracPart)) return 0;
  return intPart * 1_000_000 + fracPart;
}

/** A decimal amount in a token's smallest unit as plain digits, digits past `decimals` dropped.
 *  "0" when the text is not a plain decimal amount. */
export function decimalToRaw(input: string, decimals: number): string {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return "0";
  const [int = "", frac = ""] = text.split(".");
  const places = Math.max(0, Math.trunc(decimals));
  const raw = (int + frac.padEnd(places, "0").slice(0, places)).replace(/^0+(?=\d)/, "");
  return raw || "0";
}

/** A plain decimal amount above zero, read as text without floating point. */
export function isPositiveDecimal(input: string): boolean {
  const text = input.trim();
  return /^\d*\.?\d*$/.test(text) && /[1-9]/.test(text);
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTokenAmount(raw: string, decimals: number): string {
  let s = raw.replace(/[^0-9]/g, "");
  if (s === "" || s === "0") return "0";
  if (decimals === 0) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  while (s.length <= decimals) s = "0" + s;
  const intPart = (s.slice(0, s.length - decimals) || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

export function formatTokenCompact(raw: string, decimals: number): string {
  const human = formatTokenAmount(raw, decimals);
  if (human === "0") return "0";
  const n = parseFloat(human);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return human;
}

export function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
