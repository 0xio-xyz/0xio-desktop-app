import { invoke } from "@tauri-apps/api/core";

/** A reload keeps the Rust session, so a fresh webview locks it before showing anything. */
export async function endStaleSession(): Promise<void> {
  await Promise.all([
    invoke("wallet_lock").catch(() => {}),
    invoke("pvac_destroy").catch(() => {}),
  ]);
}

let vault: Promise<boolean> | null = null;

export function bootVault(): Promise<boolean> {
  vault ??= invoke<boolean>("wallet_is_initialized").then(async (initialized) => {
    if (initialized) await endStaleSession();
    return initialized;
  });
  return vault;
}
