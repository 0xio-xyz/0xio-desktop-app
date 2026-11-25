import {
  loadWorkspace,
  normalizeFileName,
  saveWorkspace,
} from "src/features/contracts/components/editor/fileStore";
import {
  listWorkspace,
  writeWorkspaceFile,
} from "src/features/contracts/components/editor/workspaceFs";
import { bufferStore, openBuffer } from "src/features/contracts/components/editor/buffers";
import type { ContractLanguage } from "src/types/contract";

export function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; ; i++) {
    const name = `${stem}-${i}${ext}`;
    if (!taken.has(name)) return name;
  }
}

// Never overwrites a file; returns the name it used.
export async function openSourceInBuild(
  contractName: string,
  source: string,
  language: ContractLanguage,
): Promise<string> {
  const stem =
    contractName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "") || "contract";
  const base = normalizeFileName(stem, language);
  const dir = localStorage.getItem("contract_workspace_dir");
  if (dir) {
    const entries = await listWorkspace(dir);
    const name = freeName(base, new Set(entries.map((e) => e.rel)));
    await writeWorkspaceFile(dir, name, source);
    localStorage.setItem("contract_workspace_active", name);
    bufferStore.set((s) => (s.project === `disk:${dir}` ? openBuffer(s, name, source) : s));
    return name;
  }
  const ws = loadWorkspace();
  const name = freeName(base, new Set(Object.keys(ws.files)));
  saveWorkspace({ files: { ...ws.files, [name]: source }, active: name });
  bufferStore.set((s) => (s.project === "local" ? openBuffer(s, name, source) : s));
  return name;
}
