import { invoke } from "@tauri-apps/api/core";

/** window.open inside the app window opens nothing; the shell plugin's open is allowed for http(s). */
export async function openInSystemBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    await invoke("plugin:shell|open", { path: url });
  } catch {
    window.open(url, "_blank");
  }
}
