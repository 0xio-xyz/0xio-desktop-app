import { logger } from "src/lib/logger";
import { appFetch, readByApp } from "src/features/nft/services/remote";
import {
  parseOctUri,
  fetchCircleBytes,
  fetchCircleJson,
  getManifest,
  sniffImageType,
  bytesToB64,
} from "src/features/nft/services/xpectrum/circle";
import { compositeToken } from "src/features/nft/services/xpectrum/compositor";
import type { Manifest, TokenAttr, XpectrumToken } from "src/features/nft/services/xpectrum/types";

async function resolveMediaUri(uri: string | null): Promise<string | null> {
  if (!uri) return null;
  const t = uri.trim();
  if (t.startsWith("data:")) return t;
  if (t.toLowerCase().startsWith("oct://")) {
    const parsed = parseOctUri(t);
    if (!parsed) return null;
    const bytes = await fetchCircleBytes(parsed.circleId, parsed.path);
    if (!bytes) return null;
    return `data:${sniffImageType(bytes)};base64,${bytesToB64(bytes)}`;
  }
  const url = t.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${t.slice(7)}` : t;
  if (!readByApp(url)) return url;
  return appFetch(url, "image").catch((): null => null);
}

// null = not an Xpectrum collection, so the caller falls back to its generic resolver.
export async function resolveXpectrumToken(tokenUri: string | null): Promise<XpectrumToken | null> {
  if (!tokenUri) return null;
  const parsed = parseOctUri(tokenUri);
  if (!parsed) return null;

  const tokenJson = await fetchCircleJson<{
    name?: string;
    description?: string;
    image?: string;
    attributes?: TokenAttr[];
  }>(parsed.circleId, parsed.path);
  if (!tokenJson) {
    logger.debug(`[Xpectrum] no token json at ${parsed.path} - falling back to generic resolver`);
    return null;
  }

  const manifest = await getManifest(parsed.circleId);
  const rt = manifest?.render_type;
  if (rt !== "composed" && rt !== "prerendered") {
    logger.debug(`[Xpectrum] render_type=${rt ?? "none"} - falling back to generic resolver`);
    return null;
  }

  const name = typeof tokenJson.name === "string" ? tokenJson.name : null;
  const description = typeof tokenJson.description === "string" ? tokenJson.description : null;

  if (rt === "composed") {
    const image = await compositeToken(
      parsed.circleId,
      manifest as Manifest,
      Array.isArray(tokenJson.attributes) ? tokenJson.attributes : [],
    );
    logger.debug(
      `[Xpectrum] composed token ${parsed.path} -> ${image ? "composited" : "no layers"}`,
    );
    return { image, name, description };
  }

  const image = await resolveMediaUri(typeof tokenJson.image === "string" ? tokenJson.image : null);
  logger.debug(
    `[Xpectrum] prerendered token ${parsed.path} -> ${image ? "image" : "NO image"}` +
      (image ? "" : ` (raw=${String(tokenJson.image).slice(0, 60)})`),
  );
  return { image, name, description };
}
