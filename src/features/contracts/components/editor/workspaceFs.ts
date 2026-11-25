// addressed by relative paths. The folder is theirs - movable, git-able; we
// remember only its location.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface WorkspaceEntry {
  rel: string;
  is_dir: boolean;
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const dir = await openDialog({ directory: true, multiple: false, title: "Open contract folder" });
  return typeof dir === "string" ? dir : null;
}

export function listWorkspace(dir: string): Promise<WorkspaceEntry[]> {
  return invoke("workspace_list", { dir });
}

export function readWorkspaceFile(dir: string, rel: string): Promise<string> {
  return invoke("workspace_read", { dir, rel });
}

export function writeWorkspaceFile(dir: string, rel: string, content: string): Promise<void> {
  return invoke("workspace_write", { dir, rel, content });
}

export function mkdirWorkspace(dir: string, rel: string): Promise<void> {
  return invoke("workspace_mkdir", { dir, rel });
}

export function deleteWorkspaceEntry(dir: string, rel: string): Promise<void> {
  return invoke("workspace_delete", { dir, rel });
}

export function renameWorkspaceEntry(dir: string, from: string, to: string): Promise<void> {
  return invoke("workspace_rename", { dir, from, to });
}
