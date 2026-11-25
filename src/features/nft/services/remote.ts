import { invoke } from "@tauri-apps/api/core";

// Must match img-src and connect-src in tauri.conf.json. Any other https address is read by the
// app (nft_fetch) and handed back as data.
export const WINDOW_HOSTS = ["cdn.jsdelivr.net", "*.ipfs.io", "gateway.pinata.cloud", "dweb.link"];

export function readByApp(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const inWindow = WINDOW_HOSTS.some((h) =>
    h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h,
  );
  return !(inWindow && url.port === "");
}

const RETRY_AFTER_MS = 1200;
const WORTH_A_RETRY = /^HTTP (?:404|429|5\d\d)$/;

export async function appFetch(url: string, kind: "metadata" | "image"): Promise<string> {
  try {
    return await invoke<string>("nft_fetch", { url, kind });
  } catch (e) {
    if (!WORTH_A_RETRY.test(typeof e === "string" ? e : e instanceof Error ? e.message : ""))
      throw e;
    await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    return invoke<string>("nft_fetch", { url, kind });
  }
}
