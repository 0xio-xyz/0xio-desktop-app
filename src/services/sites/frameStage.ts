import { invoke } from "@tauri-apps/api/core";

// Untrusted HTML and assets are served by the app's loopback frame listener, each under a random
// path with a Content-Security-Policy of its own (src-tauri/src/sites/frame_protocol.rs). A data: or
// srcdoc frame inherits the wallet's policy on Windows, where its inline script never runs.

const origins = new Set<string>();

function staged(url: string): string {
  origins.add(new URL(url).origin);
  return url;
}

/** "chain" may read the `connect` RPC endpoint and nothing else; Rust refuses anything but plain http(s). */
export async function stageFrameDocument(
  html: string,
  kind: "nft" | "chain" | "page",
  connect?: string | null,
): Promise<string> {
  return staged(
    await invoke<string>("stage_frame_document", { html, kind, connect: connect ?? null }),
  );
}

export async function stageFrameAsset(base64: string, contentType: string): Promise<string> {
  return staged(await invoke<string>("stage_frame_asset", { base64, contentType }));
}

export async function stageDataUrl(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const contentType = meta.split(";")[0] || "application/octet-stream";
  const payload = dataUrl.slice(comma + 1);
  if (meta.includes(";base64")) return stageFrameAsset(payload, contentType);
  const bytes = new TextEncoder().encode(decodeURIComponent(payload));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return stageFrameAsset(btoa(bin), contentType);
}

/** A frame URL of ours must stay sandboxed without allow-same-origin. */
export function isStagedFrameUrl(url: string): boolean {
  try {
    return origins.has(new URL(url).origin);
  } catch {
    return false;
  }
}
