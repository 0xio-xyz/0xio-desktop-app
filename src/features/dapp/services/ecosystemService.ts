import { fetch } from "@tauri-apps/plugin-http";
import { logger } from "src/lib/logger";

/**
 * The Octra ecosystem registry, the same source the mobile app's browser reads. There is
 * deliberately no local fallback: a stale built-in list would present dead entries as the ecosystem.
 */
const ECOSYSTEM_URL = "https://raw.githubusercontent.com/0xio-xyz/ecosystem/main/projects.json";
const FETCH_TIMEOUT_MS = 5000;

interface EcosystemProject {
  id: number;
  publisher: string;
  name: string;
  description: string;
  categories: string[];
  status: string;
  logoUrl: string;
  link: string;
  twitter: string;
}

export interface DApp {
  id: string;
  name: string;
  description: string;
  url: string;
  logoUrl: string;
  category: string;
  publisher: string;
  isOfficial: boolean;
}

const EXCLUDED_CATEGORIES = ["wallet"];

const BLOCKED_HOSTS = [
  "github.com",
  "npmjs.com",
  "t.me",
  "chromewebstore.google.com",
  "play.google.com",
  "apps.apple.com",
  "0xio.xyz/waitlist",
];

function isWebDApp(p: EcosystemProject): boolean {
  if (!p.link || !p.link.startsWith("http")) return false;
  if (BLOCKED_HOSTS.some((host) => p.link.includes(host))) return false;
  const lower = (p.categories ?? []).map((c) => c.toLowerCase());
  if (lower.length > 0 && lower.every((c) => EXCLUDED_CATEGORIES.includes(c))) return false;
  return true;
}

function mapCategory(categories: string[]): string {
  const lower = (categories ?? []).map((c) => c.toLowerCase());
  if (lower.includes("defi")) return "DeFi";
  if (lower.includes("tooling")) return "Tools";
  if (lower.includes("infrastructure")) return "Infrastructure";
  if (lower.includes("wallet")) return "Wallet";
  return categories?.[0] || "Other";
}

function mapProject(p: EcosystemProject): DApp {
  return {
    id: String(p.id),
    name: p.name,
    description: p.description,
    url: p.link,
    logoUrl: p.logoUrl,
    category: mapCategory(p.categories),
    publisher: p.publisher,
    isOfficial: p.publisher === "0xio Labs",
  };
}

let cache: DApp[] | null = null;

export async function getDApps(): Promise<DApp[]> {
  if (cache) return cache;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(ECOSYSTEM_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const projects = (await res.json()) as EcosystemProject[];
    if (!Array.isArray(projects)) throw new Error("registry is not an array");

    cache = projects.filter(isWebDApp).map(mapProject);
    logger.info("ecosystem", `loaded ${cache.length} browseable of ${projects.length} projects`);
    return cache;
  } catch (err) {
    logger.warn("ecosystem", `registry fetch failed: ${err}`);
    return [];
  }
}
