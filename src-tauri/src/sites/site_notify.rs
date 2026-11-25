//! macOS notifications for site requests that wait while the menu bar panel is closed.
//!
//! The notification plugin posts them and reports a click on one with the site it was posted
//! for. It reports the permission as granted on every desktop, so the system permission is read
//! and asked for here, the first time a notification is due. It cannot remove a shown
//! notification on macOS, so that is done here, in the notification center that shows it.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, Webview};
use tauri_plugin_notification::NotificationExt;

use crate::guard::ipc_guard::require_main;
use crate::state::AppState;
use crate::tlog;
use crate::ws::ws_sites::{notice_id, Shown};

const ORIGIN: &str = "origin";

/// Whether macOS lets 0xio Desktop post notifications. `Unknown` when the app does not run from
/// its bundle (a development run), where the system cannot be asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

type Done = Box<dyn FnOnce(Permission) + Send>;

pub fn post<R: Runtime>(app: &AppHandle<R>, origin: String, body: String, replaces: Option<Shown>) {
    let app = app.clone();
    permission(
        true,
        Box::new(move |p| {
            if p == Permission::Denied {
                tlog!("[sites] notification not posted: off in macOS settings");
                return;
            }
            let main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(old) = replaces {
                    remove_now(&main, &[old]);
                }
                let shown = main
                    .notification()
                    .builder()
                    .id(notice_id(&origin))
                    .body(body)
                    .extra(ORIGIN, origin)
                    .show();
                if let Err(e) = shown {
                    tlog!("[sites] notification failed: {}", e);
                }
            });
        }),
    );
}

pub fn remove<R: Runtime>(app: &AppHandle<R>, gone: Vec<Shown>) {
    if gone.is_empty() {
        return;
    }
    let main = app.clone();
    let _ = app.run_on_main_thread(move || remove_now(&main, &gone));
}

fn remove_now<R: Runtime>(app: &AppHandle<R>, gone: &[Shown]) {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac::remove(gone);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let ids = gone.iter().map(|s| notice_id(&s.origin)).collect();
        let _ = app.notification().remove_active(ids);
    }
}

/// A click opens the panel on the site the notification was posted for. Set up before the first
/// notification: the plugin reports clicks only on notifications shown while a handler exists.
pub fn listen_clicks<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let origin = performed
            .notification()
            .and_then(|n| n.extra().get(ORIGIN))
            .and_then(|v| v.as_str());
        let Some(origin) = origin.map(str::to_string) else { return };
        let app = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(AFTER_REOPEN);
            let state: State<'_, Arc<AppState>> = app.state();
            crate::sites::site_relay::notification_clicked(&state, &origin);
        });
    });
}

fn permission(ask: bool, done: Done) {
    #[cfg(target_os = "macos")]
    mac::permission(ask, done);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = ask;
        done(Permission::Granted);
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSBundle, NSString};

    use super::{Done, Permission, Shown};

    #[link(name = "UserNotifications", kind = "framework")]
    extern "C" {}

    const NOT_DETERMINED: isize = 0;
    const DENIED: isize = 1;
    const ALERT_AND_SOUND: usize = (1 << 2) | (1 << 1);

    type Shared = Arc<Mutex<Option<Done>>>;

    fn finish(done: &Shared, p: Permission) {
        let f = done.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(f) = f {
            f(p);
        }
    }

    /// The notification center, only for the app running from its bundle: outside one it raises.
    fn center() -> Option<Retained<AnyObject>> {
        let bundle = NSBundle::mainBundle();
        if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") {
            return None;
        }
        let class = AnyClass::get(c"UNUserNotificationCenter")?;
        // Safety: a class method of UNUserNotificationCenter that returns the shared center.
        unsafe { msg_send![class, currentNotificationCenter] }
    }

    pub fn permission(ask: bool, done: Done) {
        let Some(center) = center() else {
            return done(Permission::Unknown);
        };
        let done: Shared = Arc::new(Mutex::new(Some(done)));
        let block = RcBlock::new(move |settings: *mut AnyObject| {
            let status: isize = if settings.is_null() {
                NOT_DETERMINED
            } else {
                // Safety: a UNNotificationSettings handed to this completion handler.
                unsafe { msg_send![settings, authorizationStatus] }
            };
            match status {
                DENIED => finish(&done, Permission::Denied),
                NOT_DETERMINED if ask => request(done.clone()),
                NOT_DETERMINED => finish(&done, Permission::NotDetermined),
                _ => finish(&done, Permission::Granted),
            }
        });
        // Safety: the block matches void (^)(UNNotificationSettings *) and is copied by the callee.
        unsafe {
            let _: () = msg_send![&*center, getNotificationSettingsWithCompletionHandler: &*block];
        }
    }

    fn request(done: Shared) {
        let Some(center) = center() else {
            return finish(&done, Permission::Unknown);
        };
        let block = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
            finish(&done, if granted.as_bool() { Permission::Granted } else { Permission::Denied });
        });
        // Safety: the block matches void (^)(BOOL, NSError *) and is copied by the callee.
        unsafe {
            let _: () = msg_send![
                &*center,
                requestAuthorizationWithOptions: ALERT_AND_SOUND,
                completionHandler: &*block
            ];
        }
    }

    /// Removes the delivered notifications that show these texts. The plugin posts through
    /// NSUserNotificationCenter and keeps no handle, so the text a site's notification shows is
    /// what finds it. Main thread only.
    pub fn remove(gone: &[Shown]) {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return;
        }
        let Some(class) = AnyClass::get(c"NSUserNotificationCenter") else { return };
        // Safety: class and instance methods of NSUserNotificationCenter and NSArray, called on
        // the main thread, with the objects they return.
        unsafe {
            let center: Option<Retained<AnyObject>> = msg_send![class, defaultUserNotificationCenter];
            let Some(center) = center else { return };
            let delivered: Option<Retained<AnyObject>> = msg_send![&*center, deliveredNotifications];
            let Some(delivered) = delivered else { return };
            let count: usize = msg_send![&*delivered, count];
            for i in 0..count {
                let n: Retained<AnyObject> = msg_send![&*delivered, objectAtIndex: i];
                let text: Option<Retained<NSString>> = msg_send![&*n, informativeText];
                if text.is_some_and(|t| gone.iter().any(|s| s.body == t.to_string())) {
                    let _: () = msg_send![&*center, removeDeliveredNotification: &*n];
                }
            }
        }
    }
}

#[tauri::command]
pub async fn site_notify_permission(webview: Webview) -> Result<Permission, String> {
    require_main(&webview)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    permission(
        false,
        Box::new(move |p| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(p);
            }
        }),
    );
    Ok(rx.await.unwrap_or(Permission::Unknown))
}

#[tauri::command]
pub fn notice_post<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, title: String) -> Result<(), String> {
    require_main(&webview)?;
    let title = title.trim().to_string();
    if title.is_empty() || title.chars().count() > 160 {
        return Err("Malformed notice".into());
    }
    if app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false) {
        return Ok(());
    }
    let app2 = app.clone();
    permission(
        true,
        Box::new(move |p| {
            if p == Permission::Denied {
                return;
            }
            let main = app2.clone();
            let _ = app2.run_on_main_thread(move || {
                if let Err(e) = main.notification().builder().title(title).show() {
                    tlog!("[notices] notification failed: {}", e);
                }
            });
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn site_notify_open_settings<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require_main(&webview)?;
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}",
            app.config().identifier
        );
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// A click may also reopen the app, which shows the main window and hides the panel; the panel
/// opens after that.
const AFTER_REOPEN: std::time::Duration = std::time::Duration::from_millis(250);
