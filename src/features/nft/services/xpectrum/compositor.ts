// Composites persist in IndexedDB, not localStorage: the WebView's localStorage quota is tight.

import {
  fetchCircleBytes,
  layerPath,
  sniffImageType,
} from "src/features/nft/services/xpectrum/circle";
import type { Manifest, TokenAttr } from "src/features/nft/services/xpectrum/types";

const DB_NAME = "xpectrum-nft";
const STORE = "composites";
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function loadComposite(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
function saveComposite(key: string, dataUrl: string): void {
  void (async () => {
    try {
      const db = await openDb();
      db.transaction(STORE, "readwrite").objectStore(STORE).put(dataUrl, key);
    } catch {}
  })();
}

const bitmapCache = new Map<string, Promise<ImageBitmap | null>>();
function loadLayerBitmap(circleId: string, path: string): Promise<ImageBitmap | null> {
  const key = `${circleId}|${path}`;
  const hit = bitmapCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const bytes = await fetchCircleBytes(circleId, path);
    if (!bytes) return null;
    try {
      return await createImageBitmap(
        new Blob([bytes as unknown as BlobPart], { type: sniffImageType(bytes) }),
      );
    } catch {
      return null;
    }
  })();
  bitmapCache.set(key, p);
  return p;
}

const compositeCache = new Map<string, Promise<string | null>>();

export function compositeToken(
  circleId: string,
  manifest: Manifest,
  attributes: TokenAttr[],
): Promise<string | null> {
  const traitTypes = manifest?.trait_types;
  if (!circleId || !Array.isArray(traitTypes) || !Array.isArray(attributes))
    return Promise.resolve(null);

  const ordered = [...traitTypes].sort((a, b) => (a.layer_order ?? 0) - (b.layer_order ?? 0));
  const valueFor = (name: string) =>
    attributes.find((a) => (a.trait_type ?? a.traitType) === name)?.value;
  const paths = ordered
    .map((tt) => layerPath(tt.name, valueFor(tt.name)))
    .filter((p): p is string => !!p);
  if (!paths.length) return Promise.resolve(null);

  const key = `${circleId}|${paths.join("|")}`;
  const hit = compositeCache.get(key);
  if (hit) return hit;

  const p = (async () => {
    const persisted = await loadComposite(key);
    if (persisted) return persisted;

    const bitmaps = (await Promise.all(paths.map((pp) => loadLayerBitmap(circleId, pp)))).filter(
      (b): b is ImageBitmap => !!b,
    );
    if (!bitmaps.length) return null;

    const w = bitmaps[0].width;
    const h = bitmaps[0].height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    for (const bm of bitmaps) ctx.drawImage(bm, 0, 0, w, h);

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/webp", 0.9);
    } catch {
      dataUrl = canvas.toDataURL("image/png");
    }
    saveComposite(key, dataUrl);
    return dataUrl;
  })();
  compositeCache.set(key, p);
  return p;
}
