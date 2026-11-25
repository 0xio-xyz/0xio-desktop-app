mod dapp;
mod guard;
mod net;
mod pvac;
mod sites;
mod state;
mod system;
mod wallet;
mod ws;

use guard::ipc_guard;
use net::{nft_fetch, node_rpc};
use pvac::{proof_pool, pvac_commands, stealth};
use sites::{circle_pick, frame_protocol, site_frames, site_notify, site_relay};
use system::{autostart, log_file, single_instance, tray, window_look, workspace_commands};
use wallet::{secret_clipboard, touch_id, wallet_commands};
use ws::ws_server;

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::Manager;

static LAUNCHED: OnceLock<Instant> = OnceLock::new();
static PAGE_STARTED: OnceLock<u128> = OnceLock::new();

static LOG_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn log_path() -> Option<std::path::PathBuf> {
    LOG_PATH.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_log_path(path: std::path::PathBuf) {
    *LOG_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

pub fn ts() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let total_secs = secs as i64;
    let (h, m, s) = {
        #[cfg(unix)]
        {
            let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
            unsafe { libc::localtime_r(&total_secs, &mut tm) };
            (tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32)
        }
        #[cfg(not(unix))]
        {
            let day_secs = (total_secs % 86400) as u32;
            (day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60)
        }
    };
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, millis)
}

fn log_date() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64;
    #[cfg(unix)]
    {
        let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
        unsafe { libc::localtime_r(&total_secs, &mut tm) };
        format!(
            "{:04}-{:02}-{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday
        )
    }
    #[cfg(not(unix))]
    {
        "log".to_string()
    }
}

#[cfg(unix)]
fn setup_stderr_tee(log_dir: &std::path::Path) {
    use std::io::{Read, Write};
    use std::os::unix::io::FromRawFd;
    use std::time::SystemTime;

    let mut log = match log_file::DailyLog::start(log_dir, &log_date(), SystemTime::now()) {
        Ok(log) => log,
        Err(e) => {
            eprintln!("[0xio-desktop] Failed to open log file: {e}");
            return;
        }
    };
    set_log_path(log.path());

    let orig_stderr_fd = unsafe { libc::dup(2) };
    if orig_stderr_fd < 0 {
        eprintln!("[0xio-desktop] Failed to dup stderr");
        return;
    }

    let mut pipe_fds = [0i32; 2];
    if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
        eprintln!("[0xio-desktop] Failed to create pipe");
        unsafe { libc::close(orig_stderr_fd) };
        return;
    }
    let read_fd = pipe_fds[0];
    let write_fd = pipe_fds[1];

    if unsafe { libc::dup2(write_fd, 2) } != 2 {
        eprintln!("[0xio-desktop] Failed to redirect stderr");
        unsafe {
            libc::close(read_fd);
            libc::close(write_fd);
            libc::close(orig_stderr_fd);
        }
        return;
    }
    unsafe { libc::close(write_fd) };

    std::thread::Builder::new()
        .name("log-tee".to_string())
        .spawn(move || {
            let mut reader = unsafe { std::fs::File::from_raw_fd(read_fd) };
            let mut orig = unsafe { std::fs::File::from_raw_fd(orig_stderr_fd) };
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = orig.write_all(&buf[..n]);
                        let _ = orig.flush();
                        if let Some(moved) = log.write(&buf[..n], &log_date(), SystemTime::now()) {
                            set_log_path(moved);
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .ok();
}

#[cfg(not(unix))]
fn setup_stderr_tee(_log_dir: &std::path::Path) {
    // Not supported off Unix: logs go to stderr only.
}

macro_rules! tlog {
    ($($arg:tt)*) => {
        eprintln!("{} {}", $crate::ts(), format_args!($($arg)*))
    };
}
pub(crate) use tlog;

/// Written off the main thread and the async workers, so a stalled stderr pipe under `tauri dev`
/// blocks neither.
#[tauri::command]
async fn frontend_log(level: String, message: String) {
    let line = format!("{} [fe:{}] {}", ts(), level, message);
    let _ = tauri::async_runtime::spawn_blocking(move || eprintln!("{line}")).await;
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    tlog!("[updater] Restarting into the installed update");
    app.restart();
}

#[tauri::command]
fn get_log_path() -> Result<String, String> {
    log_path()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Log file not initialized".into())
}

#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let file = log_path().ok_or("Log folder not available")?;
    let path = file.parent().ok_or("Log folder not available")?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }
    Ok(())
}

/// Read before Tauri is initialized.
fn config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(|h| {
            std::path::PathBuf::from(h).join("Library/Application Support/com.0xio.desktop")
        })
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default() + "/.config");
        Some(std::path::PathBuf::from(base).join("com.0xio.desktop"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|d| std::path::PathBuf::from(d).join("com.0xio.desktop"))
    }
}

fn proof_threads_path() -> Option<std::path::PathBuf> {
    config_dir().map(|d| d.join("proof_threads.txt"))
}

fn read_proof_threads_config(available: usize) -> usize {
    let saved = proof_threads_path().and_then(|p| std::fs::read_to_string(p).ok());
    resolve_proof_threads(saved.as_deref(), available)
}

fn resolve_proof_threads(saved: Option<&str>, available: usize) -> usize {
    match saved.and_then(|s| s.trim().parse::<usize>().ok()) {
        Some(val) if val > 0 && val <= available => val,
        _ => available.min(4),
    }
}

#[derive(serde::Serialize)]
struct SystemInfo {
    proof_threads: usize,
    cores: usize,
    log_bytes: Option<u64>,
}

#[tauri::command]
fn system_info() -> SystemInfo {
    let proof_threads = proof_pool::threads();
    let cores = available_cores();
    let log_bytes = log_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    SystemInfo {
        proof_threads,
        cores,
        log_bytes,
    }
}

fn available_cores() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

#[tauri::command]
fn set_proof_threads(threads: usize) -> Result<(), String> {
    let path = proof_threads_path().ok_or("Cannot determine config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    std::fs::write(&path, threads.to_string())
        .map_err(|e| format!("Failed to write config: {e}"))?;
    let resolved = resolve_proof_threads(Some(&threads.to_string()), available_cores());
    proof_pool::set(resolved);
    tlog!("[0xio-desktop] Proof threads set to {} ({} in use)", threads, resolved);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
const APP_QUIT_ID: &str = "app-quit";

/// Quit (Cmd+Q) closes to the menu bar instead.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.into_iter().next() {
        let quit_at = app_submenu.items()?.iter().position(|item| {
            matches!(item, MenuItemKind::Predefined(p) if p.text().map(|t| t.starts_with("Quit")).unwrap_or(false))
        });
        if let Some(at) = quit_at {
            app_submenu.remove_at(at)?;
            let quit = MenuItemBuilder::with_id(APP_QUIT_ID, "Quit 0xio Desktop").accelerator("CmdOrCtrl+Q").build(app)?;
            app_submenu.insert(&quit, at)?;
        }
    }
    Ok(menu)
}

pub fn run() {
    let launched = *LAUNCHED.get_or_init(Instant::now);
    let context = tauri::generate_context!();
    let instance = match single_instance::claim(&context.config().identifier) {
        single_instance::Claim::First(instance) => Some(instance),
        single_instance::Claim::Running => return,
        single_instance::Claim::Unavailable => None,
    };
    let available = available_cores();
    let num_threads = read_proof_threads_config(available);
    rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global()
        .ok();
    proof_pool::set(num_threads);
    tlog!(
        "[0xio-desktop] Rayon thread pool: {} threads (of {} available)",
        num_threads,
        available
    );

    let app_state = state::AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            frame_protocol::stage_frame_document,
            frame_protocol::stage_frame_asset,
            circle_pick::circle_pick,
            circle_pick::circle_read_picked,
            nft_fetch::nft_fetch,
            node_rpc::node_rpc_post,
            pvac_commands::pvac_init_wallet,
            pvac_commands::pvac_destroy,
            pvac_commands::pvac_encrypt,
            pvac_commands::pvac_decrypt,
            pvac_commands::pvac_make_range_proof,
            pvac_commands::pvac_make_parallel_range_proofs,
            pvac_commands::pvac_make_bound_proof,
            pvac_commands::pvac_pedersen_commit,
            pvac_commands::pvac_serialize_pubkey,
            pvac_commands::pvac_matches_secret_profile,
            pvac_commands::pvac_make_bound_range_proof,
            pvac_commands::pvac_check_bound_provable,
            pvac_commands::pvac_diagnose_cipher,
            pvac_commands::pvac_make_bound_key_switch_proof,
            pvac_commands::pvac_make_bound_key_switch_proof_with_pubkey,
            pvac_commands::pvac_verify_bound_key_switch_proof_with_pubkey,
            pvac_commands::pvac_verify_bound_proof,
            pvac_commands::pvac_circle_verify_zero,
            pvac_commands::pvac_circle_verify_bound,
            pvac_commands::pvac_make_key_owner_proof,
            pvac_commands::pvac_build_cipher_proof_migration,
            pvac_commands::pvac_ct_sub,
            pvac_commands::pvac_commit,
            pvac_commands::pvac_aes_kat,
            stealth::stealth_match_outputs,
            wallet_commands::wallet_is_initialized,
            wallet_commands::wallet_create,
            wallet_commands::wallet_import_mnemonic,
            wallet_commands::wallet_import_private_key,
            wallet_commands::wallet_unlock,
            wallet_commands::wallet_unlock_status,
            wallet_commands::wallet_preview_secret,
            wallet_commands::wallet_mnemonic_wordlist,
            wallet_commands::wallet_mark_backed_up,
            wallet_commands::wallet_lock,
            wallet_commands::wallet_idle_report,
            wallet_commands::wallet_get_public_key,
            wallet_commands::wallet_sign_transaction,
            wallet_commands::wallet_delete,
            wallet_commands::wallet_create_additional,
            wallet_commands::wallet_derive_account,
            wallet_commands::wallet_scan_hd_accounts,
            wallet_commands::wallet_export_mnemonic,
            wallet_commands::wallet_export_private_key,
            wallet_commands::wallet_rename,
            wallet_commands::wallet_set_active,
            wallet_commands::wallet_reset,
            wallet_commands::wallet_has_password,
            wallet_commands::wallet_needs_password,
            wallet_commands::wallet_change_password,
            wallet_commands::wallet_remove_password,
            wallet_commands::wallet_import_address,
            wallet_commands::wallet_is_hell_mode,
            wallet_commands::wallet_activate_hell_mode,
            wallet_commands::wallet_seal_wallet,
            wallet_commands::wallet_rpc_respond,
            wallet_commands::wallet_finish_seal,
            ws_server::ws_pair_pending,
            ws_server::ws_pair_respond,
            ws_server::ws_paired_list,
            ws_server::ws_pair_forget,
            ws_server::ws_pair_settings,
            ws_server::ws_pair_set_settings,
            site_relay::site_list,
            site_relay::site_queue,
            site_relay::site_review_open,
            site_relay::site_stage,
            site_relay::site_respond,
            site_relay::site_progress,
            site_frames::site_frame_open,
            site_frames::site_frame_update,
            site_frames::site_frame_status,
            site_frames::site_wallet_hello,
            site_relay::site_disconnect,
            site_relay::site_send_event,
            site_relay::site_lock_event,
            site_relay::site_answer,
            site_relay::site_reject,
            site_notify::site_notify_permission,
            site_notify::site_notify_open_settings,
            site_notify::notice_post,
            dapp::window::dapp_open_window,
            dapp::bridge::dapp_bridge_request,
            dapp::bridge::dapp_bridge_respond,
            dapp::window::dapp_set_windows_hidden,
            dapp::window::dapp_emit_event,
            wallet_commands::wallet_verify_password,
            wallet_commands::wallet_end_reveal,
            secret_clipboard::wallet_copy_secret,
            secret_clipboard::wallet_clear_pasted_secret,
            touch_id::touch_id_state,
            touch_id::touch_id_store,
            touch_id::touch_id_prompt,
            touch_id::touch_id_available,
            touch_id::touch_id_read,
            touch_id::touch_id_clear,
            frontend_log,
            restart_app,
            get_log_path,
            open_log_folder,
            set_proof_threads,
            system_info,
            workspace_commands::workspace_list,
            workspace_commands::workspace_read,
            workspace_commands::workspace_write,
            workspace_commands::workspace_mkdir,
            workspace_commands::workspace_delete,
            workspace_commands::workspace_rename,
            tray::tray_publish,
            tray::tray_progress,
            tray::tray_get_state,
            tray::tray_action,
            tray::tray_unlock,
            tray::tray_approve_send,
            tray::tray_auth_hold,
            tray::tray_hide,
            tray::main_close_hold,
            window_look::window_theme,
        ])
        // Closing to the tray is intercepted here: more reliable than in setup.
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" {
                return;
            }
            let at = launched.elapsed().as_millis();
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    let _ = PAGE_STARTED.set(at);
                }
                tauri::webview::PageLoadEvent::Finished => {
                    let started = PAGE_STARTED.get().copied().unwrap_or(at);
                    tlog!("[0xio-desktop] Main page loaded +{at} ms (started +{started} ms)");
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    if !tray::close_held() {
                        tray::hide_main(window.app_handle());
                    }
                } else if window.label() == ipc_guard::TRAY_WINDOW {
                    tray::close_panel(window.app_handle());
                } else {
                    window.hide().ok();
                }
            }
        })
        .on_menu_event(|app, event| {
            if event.id() == APP_QUIT_ID {
                tray::hide_main(app);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let state_for_tray = app_state.clone();
            let state_for_ws = app_state.clone();

            if let Ok(data_dir) = app.path().app_data_dir() as Result<std::path::PathBuf, _> {
                setup_stderr_tee(&data_dir.join("logs"));
                tlog!(
                    "[0xio-desktop] Rayon: {} threads (of {} available)",
                    num_threads,
                    available
                );
                if let Some(path) = log_path() {
                    tlog!("[0xio-desktop] Logging to {}", path.display());
                }
            }

            let _ = app_state.app_handle.set(handle.clone());
            let state_for_lock = app_state.clone();
            wallet_commands::on_session_end(move |idle| state_for_lock.session_ended(idle));

            let granted = frame_protocol::origin().and_then(|origin| {
                app.add_capability(
                    tauri::ipc::CapabilityBuilder::new("dapp-oct-window")
                        .window("dapp-oct-*")
                        .local(false)
                        .remote(format!("{origin}/*"))
                        .permission("allow-dapp-bridge-request"),
                )
                .map_err(|e| e.to_string())
            });
            if let Err(e) = granted {
                tlog!("[0xio-desktop] frame listener is not available: {e}");
            }

            window_look::apply_saved(&handle);
            if let Some(instance) = instance {
                instance.listen(handle.clone());
            }
            tray::setup_tray(&handle, state_for_tray)?;
            site_notify::listen_clicks(&handle);
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(&handle)?)?;

            // Started by Open at login: stay in the menu bar until the user opens the window.
            if autostart::launched_hidden() {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new()
                    .expect("Failed to create Tokio runtime for WebSocket server");
                rt.block_on(async move {
                    ws_server::start(state_for_ws).await;
                });
            });

            tlog!("[0xio-desktop] App setup complete");
            Ok(())
        })
        .build(context)
        .expect("error while building 0xio desktop")
        .run(|app, event| match event {
            // Only the tray's Quit and an updater restart end the process; the menu bar stays.
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if code != Some(tauri::RESTART_EXIT_CODE) && !tray::quit_requested() {
                    api.prevent_exit();
                }
            }
            // Dock click, Finder, Spotlight or a second launch while running.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(app, None),
            _ => {}
        });
}

#[cfg(test)]
mod proof_threads_tests {
    use super::resolve_proof_threads;

    #[test]
    fn auto_caps_at_four() {
        assert_eq!(resolve_proof_threads(None, 10), 4);
        assert_eq!(resolve_proof_threads(Some("0"), 10), 4);
        assert_eq!(resolve_proof_threads(None, 2), 2);
    }

    #[test]
    fn keeps_a_valid_choice() {
        assert_eq!(resolve_proof_threads(Some(" 6\n"), 10), 6);
        assert_eq!(resolve_proof_threads(Some("8"), 8), 8);
    }

    #[test]
    fn falls_back_on_bad_input() {
        assert_eq!(resolve_proof_threads(Some("12"), 10), 4);
        assert_eq!(resolve_proof_threads(Some("many"), 10), 4);
    }
}
