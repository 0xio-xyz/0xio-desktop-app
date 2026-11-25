export type PaletteGroup =
  | "recent"
  | "transaction"
  | "address"
  | "contacts"
  | "actions"
  | "pages"
  | "wallets"
  | "networks"
  | "tokens"
  | "transactions";

/** What a row does on Enter (primary) or Cmd+Enter (secondary). */
export interface PaletteAction {
  label: string;
  run: () => void;
  stay?: boolean;
}

export interface PaletteItem {
  /** Stable across openings, so Recent can find it again. */
  id: string;
  group: PaletteGroup;
  label: string;
  sub?: string;
  keywords?: string;
  hint?: string;
}

const GROUP_ORDER: PaletteGroup[] = [
  "transaction",
  "address",
  "recent",
  "contacts",
  "actions",
  "pages",
  "wallets",
  "networks",
  "tokens",
  "transactions",
];

const PER_GROUP = 6;

/** How well `item` answers `q` (already lower case): 0 when it does not. */
function scoreOf(item: PaletteItem, q: string): number {
  const label = item.label.toLowerCase();
  if (label === q) return 4;
  if (label.startsWith(q)) return 3;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (label.includes(q)) return 1.5;
  const extra = `${item.sub ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return extra.includes(q) ? 1 : 0;
}

/** An empty query keeps the given order, so Recent and the suggestions read as written. */
export function rank<T extends PaletteItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const out: T[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = items.filter((i) => i.group === group);
    if (!q) {
      out.push(...inGroup);
      continue;
    }
    const keep =
      group === "transaction" || group === "address"
        ? inGroup
        : inGroup
            .map((item, at) => ({ item, at, score: scoreOf(item, q) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score || a.at - b.at)
            .slice(0, PER_GROUP)
            .map((r) => r.item);
    out.push(...keep);
  }
  return out;
}

export function looksLikeHash(query: string): boolean {
  return /^(0x)?[0-9a-f]{8,64}$/i.test(query.trim());
}

export function cleanHash(query: string): string {
  return query.trim().replace(/^0x/i, "").toLowerCase();
}

const RECENT_MAX = 4;
const recentKey = (networkId: string, address: string) =>
  `0xio_palette_recent_v1:${networkId}:${address}`;

export function readRecent(networkId: string, address: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentKey(networkId, address)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecent(networkId: string, address: string, id: string): void {
  const next = [id, ...readRecent(networkId, address).filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(recentKey(networkId, address), JSON.stringify(next));
  } catch {}
}
