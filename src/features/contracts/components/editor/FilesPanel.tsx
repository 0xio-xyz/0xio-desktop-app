import { useMemo, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronDown, Download, Pencil, Trash2 } from "src/shared/ui/icons";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn, Pair } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import type { WorkspaceEntry } from "src/features/contracts/components/editor/workspaceFs";

interface Props {
  entries: WorkspaceEntry[];
  activeFile: string;
  dirty: Set<string>;
  /** null = built-in local workspace. */
  diskDir: string | null;
  floating: boolean;
  onOpen: (rel: string) => void;
  onCreate: (rel: string) => void;
  onCreateDir: (rel: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (rel: string) => void;
  onDownload: (rel: string) => void;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  outline: { name: string; line: number }[];
  onJump: (line: number) => void;
}

type Dialog =
  | { mode: "create"; dir: string }
  | { mode: "create-dir"; dir: string }
  | { mode: "rename"; target: string }
  | null;

function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(i + 1) : rel;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

const Chev = () => <ChevronDown size={10} aria-hidden="true" className="chev" />;

export default function FilesPanel({
  entries,
  activeFile,
  dirty,
  diskDir,
  floating,
  onOpen,
  onCreate,
  onCreateDir,
  onRename,
  onDelete,
  onDownload,
  onOpenFolder,
  onCloseFolder,
  outline,
  onJump,
}: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [nameInput, setNameInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());

  useEscapeKey(menu, () => setMenu(false));

  const groups = useMemo(() => {
    const files = entries.filter((e) => !e.is_dir).sort((a, b) => a.rel.localeCompare(b.rel));
    const dirs = new Map<string, string[]>();
    for (const f of files) {
      const dir = parentOf(f.rel);
      dirs.set(dir, [...(dirs.get(dir) ?? []), f.rel]);
    }
    for (const e of entries) if (e.is_dir && !dirs.has(e.rel)) dirs.set(e.rel, []);
    return [...dirs.entries()].sort(([a], [b]) =>
      a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
    );
  }, [entries]);

  const submitDialog = () => {
    const name = nameInput.trim().replace(/^\/+|\/+$/g, "");
    if (!name || !dialog) return;
    if (dialog.mode === "create") onCreate(dialog.dir ? `${dialog.dir}/${name}` : name);
    else if (dialog.mode === "create-dir") onCreateDir(dialog.dir ? `${dialog.dir}/${name}` : name);
    else {
      const dir = parentOf(dialog.target);
      onRename(dialog.target, dir ? `${dir}/${name}` : name);
    }
    setDialog(null);
    setNameInput("");
  };

  const ask = (d: Dialog, name = "") => {
    setMenu(false);
    setNameInput(name);
    setDialog(d);
  };

  const project = diskDir ? baseName(diskDir.replace(/\\/g, "/")) : t("contracts.ws.workspace");

  const row = (rel: string) => {
    const on = rel === activeFile;
    return (
      <div key={rel} className={`fr mono${on ? " on" : ""}`}>
        <button
          type="button"
          className="nm press"
          onClick={() => onOpen(rel)}
          aria-current={on ? "page" : undefined}
          title={rel}
        >
          {baseName(rel)}
        </button>
        {dirty.has(rel) && (
          <span className="ddot" role="img" aria-label={t("contracts.ws.unsaved")} />
        )}
        <span className="fx">
          <button
            type="button"
            onClick={() => onDownload(rel)}
            aria-label={t("contracts.ws.download")}
            title={t("contracts.ws.download")}
          >
            <Download size={12} />
          </button>
          <button
            type="button"
            onClick={() => ask({ mode: "rename", target: rel }, baseName(rel))}
            aria-label={t("contracts.ws.rename")}
            title={t("contracts.ws.rename")}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(rel)}
            aria-label={t("contracts.ws.delete")}
            title={t("contracts.ws.delete")}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className={`explorer${floating ? " float" : ""}`} data-t="files">
      <div className="relative">
        <button
          type="button"
          className="proj press"
          onClick={() => setMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menu}
          title={diskDir ?? undefined}
        >
          <span>{project}</span>
          <Chev />
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
            <div
              className="menu"
              role="menu"
              aria-label={project}
              style={{ top: 38, left: 0, width: 220 }}
            >
              <button
                type="button"
                role="menuitem"
                className="mi"
                onClick={() => ask({ mode: "create", dir: "" })}
              >
                {t("contracts.ws.newFile")}
              </button>
              {diskDir && (
                <button
                  type="button"
                  role="menuitem"
                  className="mi"
                  onClick={() => ask({ mode: "create-dir", dir: "" })}
                >
                  {t("contracts.ws.newFolder")}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="mi"
                onClick={() => {
                  setMenu(false);
                  onOpenFolder();
                }}
              >
                {t("contracts.ws.openFolder")}
              </button>
              {diskDir && (
                <button
                  type="button"
                  role="menuitem"
                  className="mi"
                  onClick={() => {
                    setMenu(false);
                    onCloseFolder();
                  }}
                >
                  {t("contracts.ws.closeFolder")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="exlist">
        {groups.map(([dir, files]) =>
          dir === "" ? (
            files.map(row)
          ) : (
            <div key={dir} className="contents">
              <button
                type="button"
                className="dirh caps"
                aria-expanded={!closedDirs.has(dir)}
                onClick={() =>
                  setClosedDirs((prev) => {
                    const next = new Set(prev);
                    if (next.has(dir)) next.delete(dir);
                    else next.add(dir);
                    return next;
                  })
                }
              >
                <span className="min-w-0 flex-1 truncate text-left">{dir}</span>
              </button>
              {!closedDirs.has(dir) && files.map(row)}
            </div>
          ),
        )}
        {outline.length > 0 && (
          <>
            <div className="dirh caps">{t("contracts.compile.outline")}</div>
            {outline.map((o) => (
              <button
                key={`${o.name}-${o.line}`}
                type="button"
                className="fr mono press"
                onClick={() => onJump(o.line)}
              >
                <span className="nm">{o.name}</span>
                <span className="flex-none text-[11.5px] text-(--fg-3) tabular-nums">{o.line}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <PopupShell
        open={dialog != null}
        label={
          dialog?.mode === "rename"
            ? t("contracts.ws.rename")
            : dialog?.mode === "create-dir"
              ? t("contracts.ws.newFolder")
              : t("contracts.ws.newFile")
        }
        onScrim={() => setDialog(null)}
      >
        <h3 className="text-title font-semibold text-content">
          {dialog?.mode === "rename"
            ? t("contracts.ws.rename")
            : dialog?.mode === "create-dir"
              ? t("contracts.ws.newFolder")
              : t("contracts.ws.newFile")}
        </h3>
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitDialog();
            if (e.key === "Escape") setDialog(null);
          }}
          placeholder={dialog?.mode === "create-dir" ? "lib" : "name.aml"}
          aria-label={t("contracts.ws.fileName")}
          autoFocus
          spellCheck={false}
          className="mt-4 h-10.5 w-full rounded-xl bg-surface-highlight px-3.5 font-mono text-meta text-content placeholder:text-content-muted focus:outline-none"
        />
        <Pair
          className="mt-5"
          left={<Btn onClick={() => setDialog(null)}>{t("common.cancel")}</Btn>}
          right={
            <Btn weight="primary" onClick={submitDialog} disabled={!nameInput.trim()}>
              {dialog?.mode === "rename" ? t("contracts.ws.rename") : t("contracts.ws.create")}
            </Btn>
          }
        />
      </PopupShell>

      <PopupShell
        open={confirmDelete != null}
        label={t("contracts.ws.delete")}
        onScrim={() => setConfirmDelete(null)}
      >
        <h3 className="text-title font-semibold text-content">
          {t("contracts.ws.deleteTitle", { name: confirmDelete ?? "" })}
        </h3>
        <p className="mt-2 text-meta text-content-secondary">
          {diskDir ? t("contracts.ws.deleteDisk") : t("contracts.ws.deleteLocal")}
        </p>
        <Pair
          className="mt-5"
          left={<Btn onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Btn>}
          right={
            <Btn
              weight="primary"
              data-autofocus
              onClick={() => {
                if (confirmDelete) onDelete(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              {t("contracts.ws.delete")}
            </Btn>
          }
        />
      </PopupShell>
    </div>
  );
}
