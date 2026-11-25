import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "src/i18n/react";
import { useNavigate } from "src/lib/router";
import { useQuery } from "src/lib/query";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { KV } from "src/shared/ui/look";
import { ChevronDown } from "src/shared/ui/icons";
import { ReviewFee } from "src/features/wallet/components/FeeStatusValue";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useDeployReview } from "src/features/contracts/hooks/useDeployReview";
import AIChatPanel, { type AIChatHandle } from "src/features/contracts/components/AIChatPanel";
import CodeEditor, {
  type CodeEditorHandle,
} from "src/features/contracts/components/editor/CodeEditor";
import { detectContractLanguage } from "src/features/contracts/components/editor/contractLanguages";
import {
  getSuggestion as getAISuggestion,
  getConfig,
  isAiReady,
  useAiConfig,
} from "src/services/ai/aiSuggestionService";
import { useModelCatalog } from "src/services/ai/modelCatalog";
import { editSelection, auditContract, type AuditFinding } from "src/services/ai/aiChatService";
import { getInstantSuggestion } from "src/services/ai/aiSuggestionService";
import { maxLocalsUsed } from "src/features/contracts/components/editor/amlLint";
import { CONTRACT_TEMPLATES } from "src/features/contracts/components/editor/templates";
import { isWholeFile, mergeSnippet } from "src/features/contracts/components/editor/applySnippet";
import { parseOutline } from "src/features/contracts/components/editor/outline";
import { markContractVerified, saveContractSource } from "src/features/contracts/sourceStore";
import FilesPanel from "src/features/contracts/components/editor/FilesPanel";
import {
  loadWorkspace,
  saveWorkspace,
  normalizeFileName,
} from "src/features/contracts/components/editor/fileStore";
import {
  pickWorkspaceFolder,
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  mkdirWorkspace,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  type WorkspaceEntry,
} from "src/features/contracts/components/editor/workspaceFs";
import {
  bufferStore,
  dirtyNames,
  discardAll,
  dropBuffer,
  editBuffer,
  emptyBuffers,
  keepMine,
  leavePlan,
  markSaved,
  openBuffer,
  reloadFromDisk,
  renameBuffer,
  revertBuffer,
  type LeaveChoice,
} from "src/features/contracts/components/editor/buffers";
import {
  dockLayout,
  resizeDock,
  DOCK_MIN,
} from "src/features/contracts/components/editor/dockLayout";
import {
  bumpIoGeneration,
  useDiskWatch,
  useUnsavedGuards,
  useWidth,
  type LeaveTarget,
} from "src/features/contracts/hooks/useWorkspaceGuards";
import DiffView, { type DiffMode } from "src/features/contracts/components/workspace/DiffView";
import BuildPane, {
  type AuditRecord,
  type BuildRecord,
  type OutputLine,
  type Problem,
} from "src/features/contracts/components/workspace/BuildPane";
import DeployPane, {
  NUMERIC_TYPES,
  type CtorParam,
} from "src/features/contracts/components/workspace/DeployPane";
import LeaveSheet from "src/features/contracts/components/workspace/LeaveSheet";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { useWallet } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import * as contractService from "src/services/contracts/contractService";
import { captureScope } from "src/services/network/networkService";
import type { UseContractRegistryReturn } from "src/features/contracts/hooks/useContractRegistry";
import type { CompileResult, ContractReceipt, DeployResult } from "src/types/contract";
import "src/features/contracts/components/workspace/workspace.css";

const AML_PLACEHOLDER = `// Example: everything lives inside one Program block
Program Counter {
  state {
    count: int
  }

  constructor() {
    self.count = 0
  }

  fn increment() {
    self.count = self.count + 1
  }

  fn get_count(): int {
    return self.count
  }
}`;

const ASM_PLACEHOLDER = `; Example: Return the sum of two arguments
PUSH arg0
PUSH arg1
ADD
RETURN`;

// AML constructor params are positional and typed: one labeled field per parameter.
// the deploy card can render one labeled field per parameter instead of raw JSON.
function parseConstructorParams(source: string): CtorParam[] | null {
  const m = source.match(/constructor\s*\(([^)]*)\)/);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((p) => {
      const [name, type] = p.split(":").map((x) => x.trim());
      return { name: name || "?", type: type || "" };
    })
    .filter((p) => p.name !== "?" || p.type);
}

// OASM has no typed constructor signature: infer the arg count from argN usage.
function parseAsmArgs(source: string): CtorParam[] {
  let max = -1;
  const re = /\barg(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) max = Math.max(max, parseInt(m[1], 10));
  return Array.from({ length: max + 1 }, (_, i) => ({ name: `arg${i}`, type: "" }));
}

function buildParamsJson(params: CtorParam[], values: Record<string, string>): string {
  const parts = params.map((p) => {
    const v = (values[p.name] ?? "").trim();
    if (NUMERIC_TYPES.has(p.type)) return /^-?\d+$/.test(v) ? v : "0";
    if (p.type === "bool") return v === "true" ? "true" : "false";
    return JSON.stringify(v);
  });
  return `[${parts.join(", ")}]`;
}

function ctorPlaceholder(params: CtorParam[] | null): string {
  if (!params || params.length === 0) return "[]";
  const sample = (p: CtorParam): string => {
    if (NUMERIC_TYPES.has(p.type)) return "0";
    if (p.type === "bool") return "false";
    if (p.type === "address") return '"oct..."';
    return JSON.stringify(p.name);
  };
  return `[\n${params.map((p) => `  ${sample(p)}`).join(",\n")}\n]`;
}

interface ParsedError {
  line: number | null;
  column: number | null;
  message: string;
}

function parseCompileError(msg: string): ParsedError {
  const lineMatch = msg.match(/line\s+(\d+)/i);
  const colMatch = msg.match(/col(?:umn)?\s+(\d+)/i);
  return {
    line: lineMatch ? parseInt(lineMatch[1]) : null,
    column: colMatch ? parseInt(colMatch[1]) : null,
    message: msg,
  };
}

function levelOf(r: CompileResult | null | undefined): string | null {
  const v = r?.verification;
  if (!v) return null;
  if (v.safety) return v.safety;
  if (v.verified === false || (v.errors ?? 0) > 0) return "error";
  if ((v.warnings ?? 0) > 0) return "warning";
  return "safe";
}

const NO_AI_PROVIDER = "no-ai-provider";
const DOCK_KEY = "contract_dock_w";
const DIFF_KEY = "contract_diff_mode";
const FILES_KEY = "contract_files_open";

type DockTab = "assistant" | "build" | "deploy";

const baseName = (f: string) => f.split("/").pop() ?? f;

const Icon = {
  assistant: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3.5 5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 2.5v-2.5h0a1.5 1.5 0 0 1-1.5-1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  build: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M5 4.5h8M5 9h8M5 13.5h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  deploy: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M9 12V3.5M5.5 7 9 3.5 12.5 7M4 12.5v1a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

interface Props {
  registry: UseContractRegistryReturn;
  onInteract?: (address: string) => void;
}

export default function CompileDeployTab({ registry, onInteract }: Props) {
  const { t } = useTranslation();
  const { activeWallet, networkId, showMessage } = useWallet();
  const navigate = useNavigate();
  const address = activeWallet?.address ?? "";
  const walletId = activeWallet?.id ?? "";

  const [diskDir, setDiskDir] = useState<string | null>(() =>
    localStorage.getItem("contract_workspace_dir"),
  );
  const [diskEntries, setDiskEntries] = useState<WorkspaceEntry[]>([]);
  const [localFiles, setLocalFiles] = useState<Record<string, string>>(() => loadWorkspace().files);
  const project = diskDir ? `disk:${diskDir}` : "local";
  const store = useSyncExternalStore(bufferStore.subscribe, bufferStore.get);
  const buffers = store.project === project ? store : emptyBuffers(project);
  const active = buffers.active;
  const file = active ? buffers.files[active] : undefined;
  const source = file?.buf ?? "";
  const savedText = file?.saved ?? "";
  const dirty = useMemo(() => dirtyNames(buffers), [buffers]);
  const dirtySet = useMemo(() => new Set(dirty), [dirty]);
  const isDirty = source !== savedText;
  const language =
    detectContractLanguage(source) ?? (active.endsWith(".oasm") ? "assembly" : "aml");

  const editorRef = useRef<CodeEditorHandle>(null);
  const chatRef = useRef<AIChatHandle>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deployedNetworkRef = useRef("");
  const liveCompileSeq = useRef(0);

  const [caret, setCaret] = useState({ line: 1, col: 1 });
  const [editorSelection, setEditorSelection] = useState("");
  const [vimMode, setVimMode] = useState(() => localStorage.getItem("contract_editor_vim") === "1");
  const [view, setView] = useState<"code" | "diff">("code");
  const [diffBase, setDiffBase] = useState<"saved" | "disk">("saved");
  const [diffMode, setDiffMode] = useState<DiffMode>(() =>
    localStorage.getItem(DIFF_KEY) === "inline" ? "inline" : "split",
  );
  const [menu, setMenu] = useState(false);
  const [filesPref, setFilesPref] = useState<"auto" | "on" | "off">(() =>
    localStorage.getItem(FILES_KEY) === "0" ? "off" : "auto",
  );
  const [dockTab, setDockTab] = useState<DockTab>("assistant");
  const [dockW, setDockW] = useState(() => Number(localStorage.getItem(DOCK_KEY)) || 440);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const [sheet, setSheet] = useState<{ target: LeaveTarget; proceed: () => void } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);

  const [inlineEdit, setInlineEdit] = useState<{
    instruction: string;
    running: boolean;
    preview: string;
    done: boolean;
    range: { from: number; to: number };
    error: string;
  } | null>(null);
  const inlineAbortRef = useRef<AbortController | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const [live, setLive] = useState<{ result: CompileResult | null; error: string }>({
    result: null,
    error: "",
  });
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [building, setBuilding] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRecord | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [output, setOutput] = useState<OutputLine[]>([]);

  const [contractName, setContractName] = useState("");
  const [constructorParams, setConstructorParams] = useState("");
  const [ctorValues, setCtorValues] = useState<Record<string, string>>({});
  const [rawParamsMode, setRawParamsMode] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployReceipt, setDeployReceipt] = useState<ContractReceipt | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [pendingDeploy, setPendingDeploy] = useState(false);

  const aiConfig = useAiConfig();
  const catalog = useModelCatalog();
  const modelLabel =
    catalog
      .find((e) => e.provider === aiConfig.provider)
      ?.models.find((m) => m.id === aiConfig.model)?.label ??
    aiConfig.model ??
    "";

  const log = useCallback((type: OutputLine["type"], msg: string) => {
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setOutput((prev) => [...prev.slice(-200), { time, type, msg }]);
  }, []);

  const width = useWidth(rowRef);
  const layout = dockLayout(width || 1, dockW);
  const [wasDocked, setWasDocked] = useState(layout.docked);
  if (width > 0 && wasDocked !== layout.docked) {
    setWasDocked(layout.docked);
    if (!layout.docked) setOverlayOpen(true);
  }
  const filesOn = filesPref === "on" || (filesPref === "auto" && layout.filesInline);
  const filesFloat = filesOn && !layout.filesInline;
  const overlayShown = !layout.docked && overlayOpen;

  const openDock = (tab: DockTab) => {
    setDockTab(tab);
    setOverlayOpen(true);
  };

  const persistActive = (name: string) => {
    if (diskDir) localStorage.setItem("contract_workspace_active", name);
    else saveWorkspace({ files: loadWorkspace().files, active: name });
  };

  const startLocal = () => {
    const ws = loadWorkspace();
    setLocalFiles(ws.files);
    const s = bufferStore.get();
    if (s.project === "local" && s.active) return;
    bufferStore.set(openBuffer(emptyBuffers("local"), ws.active, ws.files[ws.active] ?? ""));
  };

  const startDisk = async (dir: string, fresh: boolean) => {
    const key = `disk:${dir}`;
    const entries = await listWorkspace(dir);
    setDiskEntries(entries);
    const s = bufferStore.get();
    if (!fresh && s.project === key && s.active) return;
    const stored = fresh ? "" : (localStorage.getItem("contract_workspace_active") ?? "");
    const target =
      entries.find((e) => !e.is_dir && e.rel === stored) ??
      entries.find((e) => !e.is_dir && e.rel.endsWith("main.aml")) ??
      entries.find((e) => !e.is_dir);
    let next = emptyBuffers(key);
    if (target) {
      next = openBuffer(next, target.rel, await readWorkspaceFile(dir, target.rel));
      localStorage.setItem("contract_workspace_active", target.rel);
    }
    bufferStore.set(next);
  };

  useMountEffect(() => {
    const dir = localStorage.getItem("contract_workspace_dir");
    if (!dir) {
      startLocal();
      return;
    }
    startDisk(dir, false).catch((e) => {
      logger.warn("contract", `stored workspace unavailable (${e}) - back to local`);
      localStorage.removeItem("contract_workspace_dir");
      setDiskDir(null);
      startLocal();
    });
  });

  const refreshDisk = useCallback(async () => {
    if (!diskDir) return;
    try {
      setDiskEntries(await listWorkspace(diskDir));
    } catch (e) {
      logger.warn("contract", `workspace list failed: ${e}`);
    }
  }, [diskDir]);

  useDiskWatch(diskDir, () => void refreshDisk());

  const resetBuildState = () => {
    setDeployResult(null);
    setDeployReceipt(null);
    setVerified(null);
    setPendingDeploy(false);
  };

  const writeOne = async (name: string): Promise<boolean> => {
    const f = bufferStore.get().files[name];
    if (!f) return true;
    const text = f.buf;
    bumpIoGeneration();
    try {
      if (diskDir) await writeWorkspaceFile(diskDir, name, text);
      else {
        const ws = loadWorkspace();
        const files = { ...ws.files, [name]: text };
        saveWorkspace({ files, active: bufferStore.get().active || name });
        setLocalFiles(files);
      }
      bufferStore.set((s) => markSaved(s, name, text));
      return true;
    } catch (e) {
      showMessage(
        "error",
        t("contracts.ws.saveFailed", { name: baseName(name), error: String(e) }),
      );
      return false;
    }
  };

  const saveAll = async (): Promise<boolean> => {
    for (const n of dirtyNames(bufferStore.get())) if (!(await writeOne(n))) return false;
    return true;
  };

  const revert = (name = active) => {
    bufferStore.set((s) => revertBuffer(s, name));
    setView("code");
  };

  const askLeave = useCallback((target: LeaveTarget, proceed: () => void) => {
    setMenu(false);
    setSheet({ target, proceed });
  }, []);

  useUnsavedGuards(project, askLeave);

  const decide = async (choice: LeaveChoice) => {
    if (!sheet) return;
    const plan = leavePlan(bufferStore.get(), choice);
    if (!plan.proceed) {
      setSheet(null);
      return;
    }
    setSheetBusy(true);
    try {
      for (const n of plan.write) if (!(await writeOne(n))) return;
      if (plan.discard) bufferStore.set(discardAll);
    } finally {
      setSheetBusy(false);
    }
    const go = sheet.proceed;
    setSheet(null);
    go();
  };

  const whenSaved = (target: LeaveTarget, run: () => void) => {
    if (dirty.length) askLeave(target, run);
    else run();
  };

  const openFile = async (name: string) => {
    if (filesFloat) setFilesPref("auto");
    if (name === active) return;
    setView("code");
    if (buffers.files[name]) {
      bufferStore.set((s) => openBuffer(s, name, ""));
      persistActive(name);
      return;
    }
    try {
      const text = diskDir ? await readWorkspaceFile(diskDir, name) : (localFiles[name] ?? "");
      bufferStore.set((s) => (s.project === project ? openBuffer(s, name, text) : s));
      persistActive(name);
    } catch (e) {
      showMessage(
        "error",
        t("contracts.ws.openFailed", { name: baseName(name), error: String(e) }),
      );
    }
  };

  const createFile = async (rawRel: string, content = "") => {
    if (diskDir) {
      const parts = rawRel.split("/");
      const base = normalizeFileName(parts.pop() ?? "", language);
      if (!base) return;
      const rel = [...parts, base].join("/");
      try {
        bumpIoGeneration();
        await writeWorkspaceFile(diskDir, rel, content);
        await refreshDisk();
        bufferStore.set((s) => openBuffer(s, rel, content));
        persistActive(rel);
      } catch (e) {
        showMessage("error", t("contracts.ws.openFailed", { name: rel, error: String(e) }));
      }
      return;
    }
    const name = normalizeFileName(rawRel, language);
    const ws = loadWorkspace();
    if (!name || name in ws.files) return;
    const files = { ...ws.files, [name]: content };
    saveWorkspace({ files, active: name });
    setLocalFiles(files);
    bufferStore.set((s) => openBuffer(s, name, content));
  };

  const createDir = async (rel: string) => {
    if (!diskDir || !rel) return;
    try {
      await mkdirWorkspace(diskDir, rel);
      await refreshDisk();
    } catch (e) {
      showMessage("error", String(e));
    }
  };

  const renameFile = async (from: string, rawTo: string) => {
    if (diskDir) {
      const isDir = diskEntries.some((e) => e.rel === from && e.is_dir);
      const parts = rawTo.split("/");
      const base = isDir
        ? (parts.pop() ?? "").trim()
        : normalizeFileName(parts.pop() ?? "", language);
      if (!base) return;
      const to = [...parts, base].join("/");
      if (to === from) return;
      try {
        bumpIoGeneration();
        await renameWorkspaceEntry(diskDir, from, to);
        await refreshDisk();
        bufferStore.set((s) => renameBuffer(s, from, to));
        persistActive(bufferStore.get().active);
      } catch (e) {
        showMessage("error", String(e));
      }
      return;
    }
    const to = normalizeFileName(rawTo, language);
    const ws = loadWorkspace();
    if (!to || to === from || to in ws.files || !(from in ws.files)) return;
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(ws.files)) files[k === from ? to : k] = v;
    bufferStore.set((s) => renameBuffer(s, from, to));
    saveWorkspace({ files, active: bufferStore.get().active });
    setLocalFiles(files);
  };

  const openFallback = async (names: string[]) => {
    const next = names[0];
    if (next) await openFile(next);
  };

  const deleteFile = async (name: string) => {
    if (diskDir) {
      try {
        bumpIoGeneration();
        await deleteWorkspaceEntry(diskDir, name);
        const entries = await listWorkspace(diskDir);
        setDiskEntries(entries);
        bufferStore.set((s) => dropBuffer(s, name));
        if (!bufferStore.get().active)
          await openFallback(entries.filter((e) => !e.is_dir).map((e) => e.rel));
      } catch (e) {
        showMessage("error", String(e));
      }
      return;
    }
    const ws = loadWorkspace();
    if (!(name in ws.files) || Object.keys(ws.files).length <= 1) return;
    const files = { ...ws.files };
    delete files[name];
    setLocalFiles(files);
    bufferStore.set((s) => dropBuffer(s, name));
    const nextActive = bufferStore.get().active || Object.keys(files)[0];
    saveWorkspace({ files, active: nextActive });
    if (!bufferStore.get().active)
      bufferStore.set((s) => openBuffer(s, nextActive, files[nextActive] ?? ""));
  };

  const downloadFile = async (name: string) => {
    let content = buffers.files[name]?.buf;
    if (content == null) {
      if (diskDir) {
        try {
          content = await readWorkspaceFile(diskDir, name);
        } catch {
          return;
        }
      } else content = localFiles[name] ?? "";
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = baseName(name);
    a.click();
    URL.revokeObjectURL(url);
  };

  const switchToFolder = async (dir: string) => {
    try {
      localStorage.setItem("contract_workspace_dir", dir);
      localStorage.removeItem("contract_workspace_active");
      setDiskDir(dir);
      await startDisk(dir, true);
      setBuild(null);
      setAudit(null);
      resetBuildState();
    } catch (e) {
      showMessage("error", String(e));
    }
  };

  const openFolder = () =>
    whenSaved("project", () => {
      void pickWorkspaceFolder().then((dir) => {
        if (dir) void switchToFolder(dir);
      });
    });

  const closeFolder = () =>
    whenSaved("project", () => {
      localStorage.removeItem("contract_workspace_dir");
      localStorage.removeItem("contract_workspace_active");
      setDiskDir(null);
      setDiskEntries([]);
      bufferStore.set(emptyBuffers("local"));
      setBuild(null);
      setAudit(null);
      resetBuildState();
      startLocal();
    });

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => void createFile(f.name, ev.target?.result as string);
    reader.readAsText(f);
    e.target.value = "";
  };

  const handleSourceChange = useCallback((next: string) => {
    bufferStore.set((s) => (s.active ? editBuffer(s, s.active, next) : s));
  }, []);

  const replaceAll = (text: string) => {
    if (editorRef.current) editorRef.current.setValue(text);
    else handleSourceChange(text);
  };

  const applyCode = (code: string): (() => void) => {
    const name = active;
    const before = source;
    replaceAll(isWholeFile(code, source) ? code : mergeSnippet(source, code, caret.line));
    return () => {
      if (bufferStore.get().active === name) replaceAll(before);
      else bufferStore.set((s) => editBuffer(s, name, before));
    };
  };

  // effect:audited - live lint: compile silently on a 700ms typing pause. Only the problem count
  // and the gutter's error line follow it; Build owns the deploy.
  // problem count and the gutter's error line follow it; Build owns the deploy.
  useEffect(() => {
    const seq = ++liveCompileSeq.current;
    if (!source.trim()) {
      setLive({ result: null, error: "" });
      return;
    }
    const id = setTimeout(async () => {
      try {
        const result = await contractService.compile(source, language);
        if (liveCompileSeq.current === seq) setLive({ result, error: "" });
      } catch (err) {
        if (liveCompileSeq.current !== seq) return;
        setLive({ result: null, error: err instanceof Error ? err.message : String(err) });
      }
    }, 700);
    return () => clearTimeout(id);
  }, [source, language]);

  const liveError = live.error ? parseCompileError(live.error) : null;

  const runBuild = async () => {
    if (building || !source.trim()) return;
    openDock("build");
    const name = active;
    const text = source;
    const lang = language;
    setBuilding(true);
    setAiSuggestion(null);
    resetBuildState();
    log("info", `Compiling ${baseName(name)} (${text.split("\n").length} lines)`);
    try {
      const result = await contractService.compile(text, lang);
      setBuild({ file: name, text, language: lang, result, error: "" });
      log("success", `Compiled: ${result.size} bytes, ${result.instructions} instructions`);
      if (result.version) log("info", `Compiler v${result.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Compilation failed";
      logger.error("contract", `compile failed - ${msg}`);
      setBuild({ file: name, text, language: lang, result: null, error: msg });
      log("error", msg);
      const instant = getInstantSuggestion(msg, lang);
      setAiSuggestion(instant);
      void getAISuggestion(msg, text, lang).then(
        (r) => r.suggestion && setAiSuggestion(r.suggestion),
      );
    } finally {
      setBuilding(false);
    }
  };

  const runAudit = async (): Promise<AuditFinding[] | null> => {
    openDock("build");
    const config = getConfig();
    if (!isAiReady(config)) {
      setAuditError(NO_AI_PROVIDER);
      return null;
    }
    const name = active;
    const text = source;
    setAuditing(true);
    setAuditError("");
    try {
      const findings = await auditContract(text, language, config);
      setAudit({ file: name, text, findings });
      return findings;
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Audit failed");
      return null;
    } finally {
      setAuditing(false);
    }
  };

  const fileOf = (name: string) => buffers.files[name];
  const stale = !!build && (build.file !== active || fileOf(build.file)?.buf !== build.text);
  const builtOk = !!build?.result && !build.error;
  const deployReady = builtOk && !stale;
  const sourceKind = (rec: { file: string; text: string } | null) =>
    rec && fileOf(rec.file)?.saved === rec.text
      ? t("contracts.ws.savedFile")
      : t("contracts.ws.unsavedChanges");
  const buildLevel = levelOf(build?.result);

  const problems: Problem[] = [];
  if (build && build.file === active) {
    if (build.error) {
      const pe = parseCompileError(build.error);
      problems.push({ sev: "error", text: pe.message, line: pe.line, col: pe.column });
    }
    for (const f of build.result?.verification?.findings ?? []) {
      const sev = f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info";
      problems.push({
        sev,
        text: `${f.function_name ? `${f.function_name}: ` : ""}${f.message ?? f.code ?? ""}`,
        line: null,
        col: null,
      });
    }
  }
  const auditForFile = audit && audit.file === active ? audit : null;

  const compileResult = deployReady ? build!.result : null;
  const deploy = useDeployReview(
    address,
    walletId,
    compileResult ? compileResult.deploy_payload || compileResult.bytecode : null,
    !!compileResult?.deploy_payload,
  );
  const openDeployReview = deploy.open;

  const preview = useQuery({
    queryKey: [
      "contractDeployPreview",
      networkId,
      address,
      compileResult?.certificate?.source_hash ?? compileResult?.bytecode.slice(0, 64) ?? "",
      compileResult?.bytecode.length ?? 0,
    ],
    queryFn: () => contractService.previewDeploy(compileResult!.bytecode, captureScope(address)),
    enabled: !!compileResult && !!address && dockTab === "deploy",
    staleTime: 30_000,
    gcTime: 60_000,
  });

  const ctorParams =
    !build || !compileResult
      ? null
      : build.language === "aml"
        ? parseConstructorParams(build.text)
        : parseAsmArgs(build.text);

  const setCtorValue = (name: string, v: string) => {
    if (!ctorParams) return;
    setCtorValues((prev) => {
      const next = { ...prev, [name]: v };
      setConstructorParams(ctorParams.length ? buildParamsJson(ctorParams, next) : "");
      return next;
    });
  };

  const ctorJsonError: "invalid" | "count" | null = (() => {
    if (!compileResult || !(rawParamsMode || ctorParams == null)) return null;
    const raw = constructorParams.trim();
    if (!raw) return ctorParams && ctorParams.length > 0 ? "count" : null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return "invalid";
      return ctorParams && parsed.length !== ctorParams.length ? "count" : null;
    } catch {
      return "invalid";
    }
  })();

  const toggleRawParams = (on: boolean) => {
    if (!ctorParams) return;
    try {
      const parsed: unknown = JSON.parse(constructorParams || "[]");
      if (on && Array.isArray(parsed) && parsed.length > 0)
        setConstructorParams(JSON.stringify(parsed, null, 2));
      if (!on && Array.isArray(parsed)) {
        const next: Record<string, string> = {};
        ctorParams.forEach((cp, i) => {
          const v = parsed[i];
          if (v !== undefined) next[cp.name] = typeof v === "string" ? v : JSON.stringify(v);
        });
        setCtorValues(next);
      }
    } catch {}
    setRawParamsMode(on);
  };

  const handleDeploy = async () => {
    if (!compileResult) return;
    const params = constructorParams.trim() || undefined;
    if (params) {
      try {
        JSON.parse(params);
      } catch {
        showMessage("error", 'Constructor parameters must be valid JSON array (e.g. ["arg1", 42])');
        return;
      }
    }
    try {
      await openDeployReview({
        bytecodeB64: compileResult.bytecode,
        deployPayload: compileResult.deploy_payload || undefined,
        constructorParams: params,
      });
    } catch (err) {
      showMessage("error", err instanceof Error ? err.message : "Could not prepare the deploy");
    }
  };

  // Deploy gate: formal-verification errors from the node block first; with an AI
  // provider configured, unaudited (or changed) source runs the AI audit too.
  // High-severity findings require an explicit override.
  const guardedDeploy = async () => {
    if (!build) return;
    if (buildLevel === "error") {
      setPendingDeploy(true);
      return;
    }
    if (!isAiReady(getConfig())) {
      void handleDeploy();
      return;
    }
    const audited = audit && audit.file === build.file && audit.text === build.text;
    if (!audited) {
      setPendingDeploy(true);
      const findings = await runAudit();
      setDockTab("deploy");
      if (findings == null || !findings.some((f) => f.severity === "high")) {
        setPendingDeploy(false);
        void handleDeploy();
      }
      return;
    }
    if (audit.findings.some((f) => f.severity === "high")) {
      setPendingDeploy(true);
      return;
    }
    void handleDeploy();
  };

  const gate =
    !pendingDeploy || auditing
      ? ""
      : buildLevel === "error"
        ? t("contracts.compile.verifierErrors")
        : audit?.findings.some((f) => f.severity === "high")
          ? t("contracts.compile.highFindings", {
              count: audit.findings.filter((f) => f.severity === "high").length,
            })
          : "";

  const confirmDeploy = async () => {
    if (!compileResult || !build || deploying) return;
    setDeploying(true);
    const deployNetwork = deploy.review?.scope.networkId ?? "";
    try {
      const result = await deploy.confirm();
      if (!result) return;
      deployedNetworkRef.current = deployNetwork;
      saveContractSource(deployNetwork, result.contractAddress, {
        source: build.text,
        file: build.file,
        language: build.language,
        origin: "deployed",
        verified: false,
      });
      setDeployReceipt(null);
      setVerified(null);
      setDeployResult(result);
      registry.addContract({
        address: result.contractAddress,
        name: contractName || `Contract ${registry.contracts.length + 1}`,
        language: build.language,
        deployedAt: Date.now(),
        deployTxHash: result.txHash,
        bytecodeSize: compileResult.size,
        abi: compileResult.abi,
      });
      logger.info(
        "contract",
        `deploy success - addr=${result.contractAddress} hash=${result.txHash.slice(0, 16)}`,
      );
      log("success", `Deployed to ${result.contractAddress}`);
      log("info", `Tx hash: ${result.txHash}`);
      setTimeout(() => {
        contractService
          .getContractReceipt(result.txHash)
          .then(setDeployReceipt)
          .catch(() => {});
      }, 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deployment failed";
      log("error", `Deploy failed: ${msg}`);
      showMessage("error", msg);
    } finally {
      setDeploying(false);
    }
  };

  const handleVerify = async () => {
    if (!deployResult || !build) return;
    setVerifying(true);
    try {
      const result = await contractService.verifyContract(deployResult.contractAddress, build.text);
      setVerified(result.verified);
      markContractVerified(
        deployedNetworkRef.current,
        deployResult.contractAddress,
        result.verified,
      );
      log(
        result.verified ? "success" : "warn",
        result.message || (result.verified ? "Source verified" : "Source does not match"),
      );
    } catch {
      log("error", "Verification request failed");
      showMessage("error", "Verification request failed");
    } finally {
      setVerifying(false);
    }
  };

  const openInlineEdit = (prefill?: { line?: number | null; instruction?: string }) => {
    const ed = editorRef.current;
    if (!ed) return;
    let range = ed.getSelectionRange();
    if (prefill?.line) {
      const lines = source.split("\n");
      const line = Math.min(prefill.line, lines.length);
      const from = lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
      range = { from, to: from + (lines[line - 1]?.length ?? 0) };
      ed.selectRange(range.from, range.to);
    }
    const whole = range.from === range.to;
    setInlineEdit({
      instruction: prefill?.instruction ?? "",
      running: false,
      preview: "",
      done: false,
      range: whole ? { from: 0, to: source.length } : range,
      error: "",
    });
    setTimeout(() => inlineInputRef.current?.focus(), 30);
  };

  const closeInlineEdit = () => {
    inlineAbortRef.current?.abort();
    inlineAbortRef.current = null;
    setInlineEdit(null);
    editorRef.current?.focus();
  };

  const runInlineEdit = async () => {
    if (!inlineEdit || !inlineEdit.instruction.trim() || inlineEdit.running) return;
    const config = getConfig();
    if (!isAiReady(config)) {
      setInlineEdit((p) => p && { ...p, error: t("contracts.compile.noAiProvider") });
      return;
    }
    const region = source.slice(inlineEdit.range.from, inlineEdit.range.to);
    const controller = new AbortController();
    inlineAbortRef.current = controller;
    setInlineEdit((p) => p && { ...p, running: true, preview: "", done: false, error: "" });
    try {
      const code = await editSelection(
        inlineEdit.instruction,
        region,
        source,
        language,
        config,
        (d) => setInlineEdit((p) => p && { ...p, preview: p.preview + d }),
        controller.signal,
      );
      setInlineEdit((p) => p && { ...p, running: false, done: true, preview: code });
    } catch (e) {
      const aborted =
        controller.signal.aborted ||
        (e instanceof Error && (e.name === "AbortError" || /cancel/i.test(e.message)));
      if (aborted) setInlineEdit(null);
      else
        setInlineEdit(
          (p) =>
            p && { ...p, running: false, error: e instanceof Error ? e.message : "Edit failed" },
        );
    } finally {
      inlineAbortRef.current = null;
    }
  };

  const acceptInlineEdit = () => {
    if (!inlineEdit?.done) return;
    editorRef.current?.replaceRange(inlineEdit.range.from, inlineEdit.range.to, inlineEdit.preview);
    setInlineEdit(null);
    editorRef.current?.focus();
  };

  const outline = useMemo(
    () =>
      language === "aml"
        ? parseOutline(source)
        : { program: "", state: [], events: [], writes: [], views: [] },
    [language, source],
  );

  const conflict =
    (file?.disk != null ? active : buffers.tabs.find((n) => buffers.files[n]?.disk != null)) ?? "";

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (sheet || inlineEdit) return;
      if (dockTab === "assistant" && (layout.docked || overlayShown) && chatRef.current?.escape())
        return;
      if (menu) return setMenu(false);
      if (overlayShown) return setOverlayOpen(false);
      if (filesFloat) return setFilesPref("auto");
      if (view === "diff") return setView("code");
      return;
    }
    if (!mod || sheet) return;
    if (k === "s" || e.code === "KeyS") {
      e.preventDefault();
      if (e.altKey) void saveAll();
      else if (active) void writeOne(active);
    } else if (k === "b") {
      e.preventDefault();
      setFilesPref(filesOn ? "off" : "on");
    } else if (k === "i") {
      e.preventDefault();
      openDock("assistant");
      setTimeout(() => chatRef.current?.focus(), 30);
    } else if (k === "n") {
      e.preventDefault();
      chatRef.current?.newChat();
      openDock("assistant");
      setTimeout(() => chatRef.current?.focus(), 30);
    }
  };

  const onRzDown = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = { x: e.clientX, w: layout.docked ? layout.dockW : layout.overlayW };
    setDragging(true);
  };
  const onRzMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDockW(resizeDock(layout, d.w, e.clientX - d.x));
  };
  const onRzUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    localStorage.setItem(DOCK_KEY, String(dockW));
  };
  const onRzKey = (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const from = layout.docked ? layout.dockW : layout.overlayW;
    const next = resizeDock(layout, from, dir * (e.shiftKey ? 60 : 20));
    setDockW(next);
    localStorage.setItem(DOCK_KEY, String(next));
  };

  const resizer = (
    <div
      className={`rz${dragging ? " on" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("contracts.ws.resize")}
      aria-valuenow={layout.docked ? layout.dockW : layout.overlayW}
      aria-valuemin={DOCK_MIN}
      aria-valuemax={layout.docked ? layout.dockMax : layout.overlayMax}
      tabIndex={0}
      onPointerDown={onRzDown}
      onPointerMove={onRzMove}
      onPointerUp={onRzUp}
      onPointerCancel={onRzUp}
      onKeyDown={onRzKey}
    >
      <i />
    </div>
  );

  const tabName = (tab: DockTab) =>
    tab === "assistant"
      ? t("contracts.compile.assistant")
      : tab === "build"
        ? t("contracts.compile.build")
        : t("contracts.compile.stepDeploy");

  const deployName =
    outline.program ||
    contractName ||
    baseName(build?.file ?? active).replace(/\.(aml|oasm)$/i, "");
  const deployTitle = t("contracts.compile.deployTitle", { name: deployName });
  const blocked = !build
    ? t("contracts.ws.notBuilt")
    : stale
      ? t("contracts.ws.changedSinceBuild")
      : !builtOk
        ? t("contracts.ws.buildFailed")
        : "";
  const deploySource = build
    ? t("contracts.ws.sourceIn", { source: sourceKind(build), file: baseName(build.file) })
    : "";
  const sizeLabel = compileResult
    ? t("contracts.compile.bytes", {
        count: compileResult.size,
        size: compileResult.size.toLocaleString(),
      })
    : "";
  const networkName = NETWORKS[networkId]?.name ?? networkId;
  const regs = language === "aml" && source.trim() ? maxLocalsUsed(source) : 0;
  const lineCount = source.split("\n").length;
  const diffText = diffBase === "disk" && file?.disk != null ? file.disk : savedText;

  return (
    <div
      className={`cw flex h-full min-h-0 flex-col${dragging ? " dragging" : ""}`}
      onKeyDown={onKeyDown}
      data-look="ext"
    >
      <div className="row" ref={rowRef}>
        <div className="card ecard">
          <div className="ehead">
            <input
              ref={fileInputRef}
              type="file"
              accept=".aml,.oasm"
              onChange={handleFileImport}
              className="hidden"
            />
            <button
              type="button"
              className="fbtn press"
              onClick={() => setMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menu}
              data-t="filemenu"
            >
              {t("contracts.compile.fileMenu")}
              <ChevronDown size={10} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ibtn press"
              onClick={() => setFilesPref(filesOn ? "off" : "on")}
              aria-label={t("contracts.ws.files")}
              aria-pressed={filesOn}
              title={t("contracts.ws.files")}
              data-t="files-toggle"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="2"
                  y="3"
                  width="12"
                  height="10"
                  rx="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
            <div className="tabs" role="tablist" aria-label={t("contracts.ws.openFiles")}>
              {buffers.tabs.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={name === active}
                  className={`tab press${name === active ? " on" : ""}`}
                  style={{ flexShrink: name === active ? 0 : Math.pow(20, i) }}
                  onClick={() => void openFile(name)}
                  title={name}
                >
                  <span className="mono">{baseName(name)}</span>
                  {dirtySet.has(name) && (
                    <span className="ddot" role="img" aria-label={t("contracts.ws.unsaved")} />
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`ghost press${view === "diff" ? " pressed" : ""}`}
              onClick={() => {
                setDiffBase("saved");
                setView((v) => (v === "diff" ? "code" : "diff"));
              }}
              disabled={!isDirty && view !== "diff"}
              aria-pressed={view === "diff"}
              data-t="compare"
            >
              {t("contracts.ws.compare")}
            </button>
            <button
              type="button"
              className="ghost press"
              onClick={() => void writeOne(active)}
              disabled={!isDirty}
              data-t="save"
            >
              {t("contracts.ws.save")}
            </button>
            {menu && (
              <>
                <button
                  type="button"
                  className="catch"
                  tabIndex={-1}
                  aria-label={t("common.close")}
                  onClick={() => setMenu(false)}
                />
                <div className="menu" role="menu" aria-label={t("contracts.compile.fileMenu")}>
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    disabled={!isDirty}
                    onClick={() => {
                      setMenu(false);
                      void writeOne(active);
                    }}
                  >
                    {t("contracts.ws.save")}
                    <kbd>Cmd S</kbd>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    disabled={dirty.length === 0}
                    onClick={() => {
                      setMenu(false);
                      void saveAll();
                    }}
                  >
                    {t("contracts.ws.saveAll")}
                    <kbd>Opt Cmd S</kbd>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    disabled={!isDirty}
                    onClick={() => {
                      setMenu(false);
                      setDiffBase("saved");
                      setView("diff");
                    }}
                    data-t="m-compare"
                  >
                    {t("contracts.ws.compareSaved")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    disabled={!isDirty}
                    onClick={() => {
                      setMenu(false);
                      revert();
                    }}
                  >
                    {t("contracts.ws.revert")}
                  </button>
                  <div className="mcap caps">{t("contracts.compile.templates")}</div>
                  {CONTRACT_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      role="menuitem"
                      className="mi"
                      onClick={() => {
                        setMenu(false);
                        replaceAll(tpl.source);
                      }}
                    >
                      {tpl.label}
                    </button>
                  ))}
                  <div className="h-1.5 flex-none" />
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    onClick={() => {
                      setMenu(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    {t("contracts.compile.import")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="mi"
                    disabled={!source}
                    onClick={() => {
                      setMenu(false);
                      replaceAll("");
                    }}
                  >
                    {t("contracts.compile.clearFile")}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="ebody">
            {filesOn && view !== "diff" && (
              <FilesPanel
                entries={
                  diskDir
                    ? diskEntries
                    : [...new Set([...Object.keys(localFiles), ...Object.keys(buffers.files)])].map(
                        (rel) => ({ rel, is_dir: false }),
                      )
                }
                activeFile={active}
                dirty={dirtySet}
                diskDir={diskDir}
                floating={filesFloat}
                onOpen={(n) => void openFile(n)}
                onCreate={(n) => void createFile(n)}
                onCreateDir={(n) => void createDir(n)}
                onRename={(a, b) => void renameFile(a, b)}
                onDelete={(n) => void deleteFile(n)}
                onDownload={(n) => void downloadFile(n)}
                onOpenFolder={openFolder}
                onCloseFolder={closeFolder}
                outline={[...outline.events, ...outline.writes, ...outline.views].sort(
                  (a, b) => a.line - b.line,
                )}
                onJump={(line) => {
                  if (filesFloat) setFilesPref("auto");
                  editorRef.current?.goToLine(line);
                }}
              />
            )}
            <div className="ed">
              {view === "diff" && file ? (
                <DiffView
                  base={diffText}
                  current={source}
                  baseLabel={
                    diffBase === "disk" ? t("contracts.ws.baseDisk") : t("contracts.ws.baseSaved")
                  }
                  fileName={baseName(active)}
                  mode={diffMode}
                  onMode={(m) => {
                    setDiffMode(m);
                    localStorage.setItem(DIFF_KEY, m);
                  }}
                  onRevert={() => revert()}
                  revertDisabled={!isDirty}
                  onBack={() => setView("code")}
                />
              ) : null}
              <div className={view === "diff" && file ? "hidden" : "relative min-h-0 flex-1"}>
                {diskDir && !active ? (
                  <div className="edempty">
                    <button
                      type="button"
                      className="ghost press"
                      onClick={() => void createFile("main.aml")}
                    >
                      {t("contracts.compile.createMain")}
                    </button>
                  </div>
                ) : (
                  <CodeEditor
                    ref={editorRef}
                    value={source}
                    onChange={handleSourceChange}
                    language={language === "assembly" ? "assembly" : "aml"}
                    placeholder={language === "assembly" ? ASM_PLACEHOLDER : AML_PLACEHOLDER}
                    errorLine={liveError?.line ?? null}
                    vimMode={vimMode}
                    onInlineEdit={() => openInlineEdit()}
                    onSelectionChange={setEditorSelection}
                    savedText={savedText}
                    docKey={`${project}:${active}`}
                    onCursorChange={(line, col) => setCaret({ line, col })}
                  />
                )}
                {inlineEdit && (
                  <div className="ibar">
                    <div className="flex items-center gap-2">
                      <input
                        ref={inlineInputRef}
                        value={inlineEdit.instruction}
                        onChange={(e) =>
                          setInlineEdit((p) => p && { ...p, instruction: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void runInlineEdit();
                          if (e.key === "Escape") {
                            e.preventDefault();
                            closeInlineEdit();
                          }
                          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i")
                            e.preventDefault();
                        }}
                        placeholder={
                          inlineEdit.range.from === 0 && inlineEdit.range.to === source.length
                            ? t("contracts.ws.inlineWhole")
                            : t("contracts.ws.inlineSelection")
                        }
                        aria-label={t("contracts.ws.inlineLabel")}
                        disabled={inlineEdit.running}
                      />
                      {inlineEdit.running && (
                        <button type="button" className="ghost press" onClick={closeInlineEdit}>
                          {t("contracts.compile.stop")}
                        </button>
                      )}
                    </div>
                    {inlineEdit.error && (
                      <p className="text-meta text-(--neg)">{inlineEdit.error}</p>
                    )}
                    {(inlineEdit.running || inlineEdit.done) && (
                      <>
                        <pre className="mono">{inlineEdit.preview || " "}</pre>
                        <div className="flex items-center justify-end gap-2">
                          {inlineEdit.running ? (
                            <span
                              className="ld"
                              role="img"
                              aria-label={t("contracts.ws.generating")}
                            >
                              <b />
                              <b />
                              <b />
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="ghost press"
                                onClick={closeInlineEdit}
                              >
                                {t("common.reject")}
                              </button>
                              <button
                                type="button"
                                className="key press"
                                onClick={acceptInlineEdit}
                              >
                                {t("contracts.compile.apply")}
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
              {conflict && (
                <div className="disk" role="alert">
                  <div className="diskc">
                    <span className="msg">
                      {t("contracts.ws.changedOnDisk", { name: baseName(conflict) })}
                    </span>
                    <button
                      type="button"
                      className="ghost press"
                      onClick={() => {
                        if (conflict !== active) void openFile(conflict);
                        setDiffBase("disk");
                        setView("diff");
                      }}
                      data-t="diskcompare"
                    >
                      {t("contracts.ws.compare")}
                    </button>
                    <button
                      type="button"
                      className="ghost press"
                      onClick={() => bufferStore.set((s) => reloadFromDisk(s, conflict))}
                      data-t="reload"
                    >
                      {t("contracts.ws.reload")}
                    </button>
                    <button
                      type="button"
                      className="key press"
                      onClick={() => {
                        bufferStore.set((s) => keepMine(s, conflict));
                        if (diffBase === "disk") setDiffBase("saved");
                      }}
                      data-t="keepmine"
                    >
                      {t("contracts.ws.keepMine")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="status mono" aria-live="polite">
            <span>{t("contracts.ws.position", { line: caret.line, col: caret.col })}</span>
            <span>{language === "assembly" ? "ASM" : "AML"}</span>
            <span className={liveError ? "neg" : undefined}>
              {t("contracts.compile.problems", { count: liveError ? 1 : 0 })}
            </span>
            {regs > 0 && <span className={regs > 31 ? "neg" : undefined}>regs {regs}/31</span>}
            <span className="spacer" />
            <button
              type="button"
              onClick={() => openInlineEdit()}
              title={t("contracts.ws.inlineLabel")}
            >
              Cmd I
            </button>
            <button
              type="button"
              onClick={() =>
                setVimMode((v) => {
                  localStorage.setItem("contract_editor_vim", v ? "0" : "1");
                  return !v;
                })
              }
              aria-pressed={vimMode}
              className={vimMode ? "on" : undefined}
            >
              VIM
            </button>
            <span>{t("contracts.compile.lines", { count: lineCount })}</span>
            <button
              type="button"
              className={`stsave press${isDirty ? " un" : ""}`}
              onClick={() => {
                setDiffBase("saved");
                setView((v) => (v === "diff" ? "code" : "diff"));
              }}
              disabled={!isDirty && view !== "diff"}
              title={t("contracts.ws.compareSaved")}
              data-t="stsave"
            >
              {isDirty ? t("contracts.ws.unsaved") : t("contracts.ws.saved")}
            </button>
          </div>
        </div>

        {layout.docked && resizer}
        <div
          className={layout.docked ? "card dock" : overlayShown ? "card ovl" : "hidden"}
          style={{ width: layout.docked ? layout.dockW : layout.overlayW }}
          role={layout.docked ? undefined : "dialog"}
          aria-label={layout.docked ? undefined : tabName(dockTab)}
          data-t="dock"
        >
          {!layout.docked && resizer}
          {layout.docked && (
            <div className="dockh">
              <div className="seg dseg" role="tablist" aria-label={t("contracts.ws.sidePanel")}>
                {(["assistant", "build", "deploy"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={dockTab === tab}
                    className={`press${dockTab === tab ? " on" : ""}`}
                    onClick={() => setDockTab(tab)}
                    data-t={`tab-${tab}`}
                  >
                    {tabName(tab)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className={dockTab === "assistant" ? "pane" : "hidden"}>
            <AIChatPanel
              key={project}
              ref={chatRef}
              project={project}
              sourceCode={source}
              selection={editorSelection}
              language={language}
              fileName={active}
              firstFn={outline.writes[0]?.name ?? ""}
              onApply={applyCode}
              onManageKeys={() => navigate("/settings?page=ai")}
            />
          </div>
          <div className={dockTab === "build" ? "pane" : "hidden"}>
            <BuildPane
              build={build}
              building={building}
              activeName={baseName(active)}
              sourceLabel={sourceKind(build)}
              stale={stale}
              level={buildLevel}
              problems={problems}
              suggestion={build?.error ? aiSuggestion : null}
              audit={auditForFile}
              auditSourceLabel={sourceKind(auditForFile)}
              auditing={auditing}
              auditError={auditError === NO_AI_PROVIDER ? "" : auditError}
              noProvider={auditError === NO_AI_PROVIDER && !isAiReady(aiConfig)}
              modelLabel={modelLabel}
              output={output}
              canBuild={!!source.trim() && !building}
              deployReady={deployReady}
              onBuild={() => void runBuild()}
              onAudit={() => void runAudit()}
              onJump={(line) => {
                setView("code");
                editorRef.current?.goToLine(line);
              }}
              onFix={(f) => {
                openDock("assistant");
                chatRef.current?.send(
                  `Fix: ${f.title}${f.line != null ? ` (line ${f.line})` : ""}. ${f.fix || f.detail}`,
                );
              }}
              onSetUp={() => navigate("/settings?page=ai")}
              onContinue={() => setDockTab("deploy")}
            />
          </div>
          <div className={dockTab === "deploy" ? "pane" : "hidden"}>
            <DeployPane
              title={deployTitle}
              blocked={blocked}
              contractName={contractName}
              namePlaceholder={deployName}
              onName={setContractName}
              ctorParams={ctorParams}
              ctorValues={ctorValues}
              onCtorValue={setCtorValue}
              rawParams={rawParamsMode}
              onRawParams={toggleRawParams}
              constructorJson={constructorParams}
              onConstructorJson={setConstructorParams}
              ctorPlaceholder={ctorPlaceholder(ctorParams)}
              ctorJsonError={ctorJsonError}
              predicted={preview.data?.contractAddress ?? ""}
              sourceLabel={sourceKind(build)}
              sizeLabel={sizeLabel}
              quote={deploy.pickQuote}
              ou={deploy.ou}
              onOu={(ou) => deploy.setOU(ou)}
              feeDisabled={deploying || deploy.checking}
              gate={gate}
              onGateCancel={() => setPendingDeploy(false)}
              onGateDeploy={() => {
                setPendingDeploy(false);
                void handleDeploy();
              }}
              result={deployResult}
              receipt={deployReceipt}
              verified={verified}
              verifying={verifying}
              onVerify={() => void handleVerify()}
              onInteract={
                onInteract && deployResult
                  ? () => onInteract(deployResult.contractAddress)
                  : undefined
              }
              reviewDisabled={deploying || deploy.preparing || auditing || !!ctorJsonError}
              onReview={() => void guardedDeploy()}
              onBuild={() => void runBuild()}
            />
          </div>
        </div>
        {!layout.docked && (
          <div
            className="card drail"
            role="tablist"
            aria-label={t("contracts.ws.sidePanel")}
            aria-orientation="vertical"
          >
            {(["assistant", "build", "deploy"] as const).map((tab) => {
              const on = overlayShown && dockTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-expanded={on}
                  className={`rt press${on ? " on" : ""}`}
                  onClick={() => {
                    setDockTab(tab);
                    setOverlayOpen(!on);
                  }}
                  data-t={`rail-${tab}`}
                >
                  {Icon[tab]}
                  <span>{tabName(tab)}</span>
                  {tab === "build" && problems.length > 0 && (
                    <b
                      className="rbadge"
                      aria-label={t("contracts.ws.problemsCount", { count: problems.length })}
                    >
                      {problems.length}
                    </b>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <LeaveSheet
        open={!!sheet}
        target={sheet?.target ?? "page"}
        files={dirty.map(baseName)}
        busy={sheetBusy}
        onChoose={(c) => void decide(c)}
      />

      <TransactionAuthModal
        isOpen={deploy.auth.isOpen}
        onResult={deploy.auth.handleResult}
        title={deploy.auth.title}
      />
      <ReviewPopup
        open={!!deploy.review}
        label={deployTitle}
        caption={deployTitle}
        verb={t("circles.deploy")}
        onReject={deploy.close}
        onConfirm={() => void confirmDeploy()}
        confirmDisabled={deploy.quote.status !== "ok" || !deploy.ou}
        busy={deploy.checking || deploying}
        error={deploy.error}
      >
        {deploy.review && build && (
          <>
            <KV label={t("contracts.ws.from")}>
              <WalletAvatar address={address} size={18} />
              {activeWallet?.name ?? ""}
            </KV>
            <KV label={t("contracts.ws.network")}>{networkName}</KV>
            <KV label={t("contracts.interact.contract")}>
              {contractName || t("contracts.compile.unnamed")}
            </KV>
            <KV label={t("contracts.compile.kind")}>
              {deploy.review.deployPayload
                ? t("contracts.compile.kindProgram")
                : t("contracts.compile.kindLegacy")}
            </KV>
            <KV label={t("contracts.ws.source")}>
              <span className="max-w-70 truncate">{deploySource}</span>
            </KV>
            {build.result?.certificate?.source_hash && (
              <KV label={t("contracts.compile.sourceHash")}>
                <span className="font-mono text-meta">
                  {`${build.result.certificate.source_hash.slice(0, 6)}...${build.result.certificate.source_hash.slice(-4)}`}
                </span>
              </KV>
            )}
            <KV label={t("contracts.compile.codeSize")}>{sizeLabel}</KV>
            <KV label={t("contracts.ws.contractAddress")} tall>
              <span className="max-w-70 font-mono text-meta break-all whitespace-normal">
                {deploy.review.contractAddress}
              </span>
            </KV>
            <KV label={t("contracts.compile.ctor")}>
              <span className="max-w-70 truncate font-mono text-meta">
                {deploy.review.constructorParams || t("sendFlow.none")}
              </span>
            </KV>
            <KV label={t("sendFlow.networkFee")}>
              <ReviewFee quote={deploy.quote} ou={deploy.ou} />
            </KV>
          </>
        )}
      </ReviewPopup>
    </div>
  );
}
