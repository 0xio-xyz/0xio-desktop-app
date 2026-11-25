// Migrates the older single-buffer key on first load.
// Migrates the older single-buffer key on first load.

interface Workspace {
  files: Record<string, string>;
  active: string;
}

const KEY = "contract_workspace_v1";
const LEGACY_KEY = "contract_editor_source";

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const ws = JSON.parse(raw) as Workspace;
      if (ws && ws.files && Object.keys(ws.files).length > 0) {
        if (!(ws.active in ws.files)) ws.active = Object.keys(ws.files)[0];
        return ws;
      }
    }
  } catch {}
  const legacy = localStorage.getItem(LEGACY_KEY) ?? "";
  return { files: { "main.aml": legacy }, active: "main.aml" };
}

export function saveWorkspace(ws: Workspace): void {
  localStorage.setItem(KEY, JSON.stringify(ws));
}

export function normalizeFileName(name: string, language: "aml" | "assembly"): string {
  const trimmed = name.trim().replace(/[/\\]/g, "_");
  if (!trimmed) return "";
  return /\.(aml|oasm)$/i.test(trimmed)
    ? trimmed
    : `${trimmed}.${language === "assembly" ? "oasm" : "aml"}`;
}
