use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 33_554_432;

static PICKED: Mutex<Option<HashMap<String, (PathBuf, u64)>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Debug, PartialEq)]
pub struct PickedFile {
    token: String,
    path: String,
    name: String,
    size: u64,
}

fn name_of(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(str::to_owned)
}

fn walk(at: &Path, prefix: &str, top: bool, out: &mut Vec<(PathBuf, String, u64)>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Some(name) = name_of(at) else { return };
    if !top && name.starts_with('.') {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(at) else { return };
    if meta.is_file() {
        out.push((at.to_path_buf(), format!("{prefix}/{name}"), meta.len()));
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let inner = format!("{prefix}/{name}");
    for child in children(at) {
        walk(&child, &inner, false, out);
    }
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    found.sort();
    found
}

fn collect(roots: &[PathBuf]) -> Vec<(PathBuf, String, u64)> {
    let mut out = Vec::new();
    if let [only] = roots {
        if std::fs::symlink_metadata(only).is_ok_and(|m| m.is_dir()) {
            for child in children(only) {
                walk(&child, "", false, &mut out);
            }
            return out;
        }
    }
    for root in roots {
        walk(root, "", true, &mut out);
    }
    out.truncate(MAX_FILES);
    out
}

fn remember(found: Vec<(PathBuf, String, u64)>) -> Vec<PickedFile> {
    let mut held = PICKED.lock().unwrap_or_else(|e| e.into_inner());
    let map = held.get_or_insert_with(HashMap::new);
    found
        .into_iter()
        .filter_map(|(file, path, size)| {
            let name = name_of(&file)?;
            let token = format!("p{}", NEXT.fetch_add(1, Ordering::Relaxed));
            map.insert(token.clone(), (file, size));
            Some(PickedFile { token, path, name, size })
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn choose(app: &tauri::AppHandle, _kind: &str) -> Result<Vec<PathBuf>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(open_panel());
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn open_panel() -> Vec<PathBuf> {
    let Some(mtm) = objc2::MainThreadMarker::new() else { return Vec::new() };
    let panel = objc2_app_kit::NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(true);
    if panel.runModal() != 1 {
        return Vec::new();
    }
    panel
        .URLs()
        .iter()
        .filter_map(|url| url.path().map(|p| PathBuf::from(p.to_string())))
        .collect()
}

#[cfg(not(target_os = "macos"))]
async fn choose(app: &tauri::AppHandle, kind: &str) -> Result<Vec<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file();
    let picked = if kind == "folder" {
        dialog.blocking_pick_folders()
    } else {
        dialog.blocking_pick_files()
    };
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect())
}

#[tauri::command]
pub async fn circle_pick(app: tauri::AppHandle, kind: String) -> Result<Vec<PickedFile>, String> {
    let roots = choose(&app, &kind).await?;
    Ok(remember(collect(&roots)))
}

#[tauri::command]
pub async fn circle_read_picked(token: String) -> Result<tauri::ipc::Response, String> {
    let (path, size) = PICKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&token).cloned())
        .ok_or("File is no longer available")?;
    if size > MAX_FILE_BYTES {
        return Err("File is too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "File could not be read")?;
    if bytes.len() as u64 != size {
        return Err("File changed since it was chosen".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "oxio-circle-pick-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn site() -> Temp {
        let dir = Temp::new();
        let root = dir.path().join("site");
        std::fs::create_dir_all(root.join("css")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("index.html"), b"<p>").unwrap();
        std::fs::write(root.join("css/style.css"), b"a{}").unwrap();
        std::fs::write(root.join(".git/config"), b"x").unwrap();
        std::fs::write(root.join(".DS_Store"), b"x").unwrap();
        dir
    }

    fn paths(found: &[(PathBuf, String, u64)]) -> Vec<&str> {
        found.iter().map(|f| f.1.as_str()).collect()
    }

    #[test]
    fn a_lone_folder_drops_its_own_name_and_keeps_the_paths_inside() {
        let dir = site();
        let found = collect(&[dir.path().join("site")]);
        assert_eq!(paths(&found), ["/css/style.css", "/index.html"]);
        assert_eq!(found[0].2, 3);
    }

    #[test]
    fn a_folder_beside_other_picks_keeps_its_name() {
        let dir = site();
        let loose = dir.path().join("logo.svg");
        std::fs::write(&loose, b"<svg/>").unwrap();
        let found = collect(&[dir.path().join("site"), loose]);
        assert_eq!(paths(&found), ["/site/css/style.css", "/site/index.html", "/logo.svg"]);
    }

    #[test]
    fn loose_files_land_at_the_top() {
        let dir = site();
        let found = collect(&[dir.path().join("site/index.html")]);
        assert_eq!(paths(&found), ["/index.html"]);
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_a_folder_are_not_followed() {
        let dir = site();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"s").unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("site/link.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("site/up")).unwrap();
        let found = collect(&[dir.path().join("site")]);
        assert_eq!(paths(&found), ["/css/style.css", "/index.html"]);
    }

    #[test]
    fn the_list_stops_at_the_file_limit() {
        let dir = Temp::new();
        let root = dir.path().join("many");
        std::fs::create_dir(&root).unwrap();
        for i in 0..(MAX_FILES + 5) {
            std::fs::write(root.join(format!("f{i:04}.txt")), b"x").unwrap();
        }
        assert_eq!(collect(&[root]).len(), MAX_FILES);
    }

    #[test]
    fn a_remembered_file_reads_back_and_a_changed_one_is_refused() {
        let dir = site();
        let picked = remember(collect(&[dir.path().join("site/index.html")]));
        let token = picked[0].token.clone();
        assert_eq!((picked[0].name.as_str(), picked[0].size), ("index.html", 3));
        let read = |t: String| tauri::async_runtime::block_on(circle_read_picked(t));
        assert!(read(token.clone()).is_ok());
        std::fs::write(dir.path().join("site/index.html"), b"<p>more").unwrap();
        assert_eq!(read(token).err().as_deref(), Some("File changed since it was chosen"));
        assert_eq!(read("p0".into()).err().as_deref(), Some("File is no longer available"));
    }
}
