// Contract workspace on the real filesystem: the frontend holds a user-chosen
// root directory and addresses everything by relative path. Every command
// re-validates that the resolved path stays inside that root.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Webview;

use crate::guard::ipc_guard::require_main;

#[derive(Serialize)]
pub struct WorkspaceEntry {
    pub rel: String,
    pub is_dir: bool,
}

const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 2000;
const MAX_FILE_BYTES: u64 = 2_000_000;

fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("workspace root not accessible: {e}"))?;
    if rel.split(['/', '\\']).any(|c| c == "..") {
        return Err("path escapes the workspace".into());
    }
    let joined = root.join(rel);
    // The leaf may not exist yet (writes/creates) - canonicalize the existing parent.
    let check = if joined.exists() {
        joined.canonicalize().map_err(|e| e.to_string())?
    } else {
        let parent = joined.parent().ok_or("invalid path")?;
        parent
            .canonicalize()
            .map_err(|e| format!("parent not accessible: {e}"))?
            .join(joined.file_name().ok_or("invalid path")?)
    };
    if !check.starts_with(&root) {
        return Err("path escapes the workspace".into());
    }
    Ok(check)
}

fn is_skipped_dir(name: &str) -> bool {
    matches!(name, "node_modules" | "target" | "dist" | "build" | "__pycache__")
}

fn walk(dir: &Path, root: &Path, depth: usize, out: &mut Vec<WorkspaceEntry>) {
    if depth > MAX_DEPTH || out.len() > MAX_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            if is_skipped_dir(&name) {
                continue;
            }
            out.push(WorkspaceEntry {
                rel: rel_str,
                is_dir: true,
            });
            walk(&path, root, depth + 1, out);
        } else {
            out.push(WorkspaceEntry {
                rel: rel_str,
                is_dir: false,
            });
        }
    }
}

#[tauri::command]
pub fn workspace_list(webview: Webview, dir: String) -> Result<Vec<WorkspaceEntry>, String> {
    require_main(&webview)?;
    let root = Path::new(&dir)
        .canonicalize()
        .map_err(|e| format!("cannot open workspace: {e}"))?;
    if !root.is_dir() {
        return Err("workspace root is not a directory".into());
    }
    let mut out = Vec::new();
    walk(&root, &root, 0, &mut out);
    Ok(out)
}

#[tauri::command]
pub fn workspace_read(webview: Webview, dir: String, rel: String) -> Result<String, String> {
    require_main(&webview)?;
    let path = resolve(&dir, &rel)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("file too large for the editor".into());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_write(
    webview: Webview,
    dir: String,
    rel: String,
    content: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let path = resolve(&dir, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_mkdir(webview: Webview, dir: String, rel: String) -> Result<(), String> {
    require_main(&webview)?;
    let path = resolve(&dir, &rel)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_delete(webview: Webview, dir: String, rel: String) -> Result<(), String> {
    require_main(&webview)?;
    let path = resolve(&dir, &rel)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        // Refuse to nuke non-empty directories - the wallet should never do that silently.
        let mut it = fs::read_dir(&path).map_err(|e| e.to_string())?;
        if it.next().is_some() {
            return Err("directory is not empty".into());
        }
        fs::remove_dir(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn workspace_rename(
    webview: Webview,
    dir: String,
    from: String,
    to: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let from_path = resolve(&dir, &from)?;
    let to_path = resolve(&dir, &to)?;
    if to_path.exists() {
        return Err("target already exists".into());
    }
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}
