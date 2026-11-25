//! The colour the main window shows before its page paints: the lock screen's when a vault
//! exists, the onboarding screen's otherwise, in the theme the wallet last used.

use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, Webview};

use crate::guard::ipc_guard::require_main;

const FILE: &str = "window_theme";

/// (lock screen, onboarding) per theme, the same colours the two screens paint.
fn colors(theme: &str) -> Option<(Color, Color)> {
    match theme {
        "dim" => Some((Color(0x09, 0x09, 0x09, 0xff), Color(0x14, 0x15, 0x19, 0xff))),
        "light" => Some((Color(0xf6, 0xf6, 0xf6, 0xff), Color(0xf0, 0xf2, 0xff, 0xff))),
        "octra" => Some((Color(0x00, 0x00, 0xdb, 0xff), Color(0x00, 0x00, 0xdb, 0xff))),
        _ => None,
    }
}

pub fn apply_saved<R: Runtime>(app: &AppHandle<R>) {
    let saved = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(FILE)).ok());
    let Some((lock, start)) = colors(saved.as_deref().map(str::trim).unwrap_or("dim")) else {
        return;
    };
    let color = if crate::wallet::wallet_commands::vault_exists(app) {
        lock
    } else {
        start
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_background_color(Some(color));
    }
}

#[tauri::command]
pub fn window_theme<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    theme: String,
) -> Result<(), String> {
    require_main(&webview)?;
    colors(&theme).ok_or("Unknown theme")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::system::atomic_file::write(&dir.join(FILE), theme.as_bytes()).map_err(|e| e.to_string())
}
