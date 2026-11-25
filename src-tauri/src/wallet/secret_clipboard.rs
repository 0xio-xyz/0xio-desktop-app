use std::time::Duration;

use tauri::{AppHandle, Runtime, Webview};
use zeroize::Zeroize;

use crate::guard::ipc_guard::require_main;
use crate::wallet::wallet_commands::{revealed_secret, SecretKind};

const CLEAR_AFTER: Duration = Duration::from_secs(60);

pub(crate) trait Board {
    fn write_concealed(&self, text: &str) -> Result<i64, String>;
    fn stamp(&self) -> i64;
    fn text(&self) -> Option<String>;
    fn clear(&self);
}

pub(crate) fn clear_if_unchanged(board: &impl Board, stamp: i64) -> bool {
    if board.stamp() != stamp {
        return false;
    }
    board.clear();
    true
}

pub(crate) fn clear_if_holds(board: &impl Board, text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let stamp = board.stamp();
    let Some(mut held) = board.text() else {
        return false;
    };
    let same = held == text;
    held.zeroize();
    same && clear_if_unchanged(board, stamp)
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSPasteboard, NSPasteboardContentsOptions, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    use super::Board;

    const CONCEALED: &str = "org.nspasteboard.ConcealedType";

    pub(crate) struct System(pub(crate) Retained<NSPasteboard>);

    pub(crate) fn general() -> System {
        System(NSPasteboard::generalPasteboard())
    }

    impl Board for System {
        fn write_concealed(&self, text: &str) -> Result<i64, String> {
            self.0
                .prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
            let marked = self
                .0
                .setString_forType(&NSString::from_str(""), &NSString::from_str(CONCEALED));
            let written = marked
                && self
                    .0
                    .setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
            if !written {
                self.0.clearContents();
                return Err("Could not copy".to_string());
            }
            Ok(self.stamp())
        }

        fn stamp(&self) -> i64 {
            self.0.changeCount() as i64
        }

        fn text(&self) -> Option<String> {
            self.0
                .stringForType(unsafe { NSPasteboardTypeString })
                .map(|s| s.to_string())
        }

        fn clear(&self) {
            self.0.clearContents();
        }
    }

    #[cfg(test)]
    pub(crate) fn concealed(board: &System) -> bool {
        board
            .0
            .stringForType(&NSString::from_str(CONCEALED))
            .is_some()
    }
}

#[cfg(windows)]
mod system {
    use std::ffi::c_void;

    use super::Board;

    type Handle = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, mem: Handle) -> Handle;
        fn GetClipboardData(format: u32) -> Handle;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn GetClipboardSequenceNumber() -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(mem: Handle) -> *mut c_void;
        fn GlobalUnlock(mem: Handle) -> i32;
        fn GlobalFree(mem: Handle) -> Handle;
    }

    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const OPEN_TRIES: u32 = 10;

    pub(crate) struct System;

    pub(crate) fn general() -> System {
        System
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open() -> bool {
        for _ in 0..OPEN_TRIES {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        false
    }

    unsafe fn put(format: u32, bytes: &[u8]) -> bool {
        if format == 0 {
            return false;
        }
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if mem.is_null() {
            return false;
        }
        let at = GlobalLock(mem);
        if at.is_null() {
            GlobalFree(mem);
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), at as *mut u8, bytes.len());
        GlobalUnlock(mem);
        if SetClipboardData(format, mem).is_null() {
            GlobalFree(mem);
            return false;
        }
        true
    }

    unsafe fn put_flag(name: &str) -> bool {
        put(RegisterClipboardFormatW(wide(name).as_ptr()), &0u32.to_le_bytes())
    }

    impl Board for System {
        fn write_concealed(&self, text: &str) -> Result<i64, String> {
            if !open() {
                return Err("Could not copy".to_string());
            }
            let units = wide(text);
            let mut bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
            let written = unsafe {
                EmptyClipboard() != 0
                    && put_flag("ExcludeClipboardContentFromMonitorProcessing")
                    && put_flag("CanIncludeInClipboardHistory")
                    && put_flag("CanUploadToCloudClipboard")
                    && put(CF_UNICODETEXT, &bytes)
            };
            bytes.iter_mut().for_each(|b| *b = 0);
            if !written {
                unsafe { EmptyClipboard() };
            }
            unsafe { CloseClipboard() };
            if !written {
                return Err("Could not copy".to_string());
            }
            Ok(self.stamp())
        }

        fn stamp(&self) -> i64 {
            i64::from(unsafe { GetClipboardSequenceNumber() })
        }

        fn text(&self) -> Option<String> {
            if !open() {
                return None;
            }
            let text = unsafe {
                let mem = GetClipboardData(CF_UNICODETEXT);
                if mem.is_null() {
                    None
                } else {
                    let at = GlobalLock(mem) as *const u16;
                    if at.is_null() {
                        None
                    } else {
                        let mut len = 0usize;
                        while *at.add(len) != 0 {
                            len += 1;
                        }
                        let text = String::from_utf16_lossy(std::slice::from_raw_parts(at, len));
                        GlobalUnlock(mem);
                        Some(text)
                    }
                }
            };
            unsafe { CloseClipboard() };
            text
        }

        fn clear(&self) {
            if open() {
                unsafe {
                    EmptyClipboard();
                    CloseClipboard();
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod system {
    use super::Board;

    pub(crate) struct System;

    pub(crate) fn general() -> System {
        System
    }

    impl Board for System {
        fn write_concealed(&self, _text: &str) -> Result<i64, String> {
            Err("Copy is not available on this system".to_string())
        }

        fn stamp(&self) -> i64 {
            0
        }

        fn text(&self) -> Option<String> {
            None
        }

        fn clear(&self) {}
    }
}

fn clear_later<R: Runtime>(app: &AppHandle<R>, stamp: i64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        let _ = app.run_on_main_thread(move || {
            clear_if_unchanged(&system::general(), stamp);
        });
    });
}

#[tauri::command]
pub fn wallet_copy_secret<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    wallet_id: String,
    kind: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let mut secret = revealed_secret(&app, &wallet_id, SecretKind::parse(&kind)?)?;
    let written = system::general().write_concealed(&secret);
    secret.zeroize();
    clear_later(&app, written?);
    Ok(())
}

#[tauri::command]
pub fn wallet_clear_pasted_secret<R: Runtime>(
    webview: Webview<R>,
    text: String,
) -> Result<bool, String> {
    require_main(&webview)?;
    let mut text = text;
    let cleared = clear_if_holds(&system::general(), &text);
    text.zeroize();
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    #[derive(Default)]
    struct Fake {
        held: RefCell<Option<String>>,
        count: Cell<i64>,
        concealed: Cell<bool>,
    }

    impl Fake {
        fn user_copies(&self, text: &str) {
            *self.held.borrow_mut() = Some(text.to_string());
            self.concealed.set(false);
            self.count.set(self.count.get() + 1);
        }
    }

    impl Board for Fake {
        fn write_concealed(&self, text: &str) -> Result<i64, String> {
            self.user_copies(text);
            self.concealed.set(true);
            Ok(self.stamp())
        }

        fn stamp(&self) -> i64 {
            self.count.get()
        }

        fn text(&self) -> Option<String> {
            self.held.borrow().clone()
        }

        fn clear(&self) {
            *self.held.borrow_mut() = None;
            self.count.set(self.count.get() + 1);
        }
    }

    #[test]
    fn the_timer_clears_what_we_wrote() {
        let board = Fake::default();
        let stamp = board.write_concealed("alpha bravo").unwrap();
        assert!(board.concealed.get());
        assert!(clear_if_unchanged(&board, stamp));
        assert_eq!(board.text(), None);
    }

    #[test]
    fn the_timer_leaves_what_the_user_copied_since() {
        let board = Fake::default();
        let stamp = board.write_concealed("alpha bravo").unwrap();
        board.user_copies("a shopping list");
        assert!(!clear_if_unchanged(&board, stamp));
        assert_eq!(board.text().as_deref(), Some("a shopping list"));
    }

    #[test]
    fn the_timer_leaves_the_same_text_copied_again_by_the_user() {
        let board = Fake::default();
        let stamp = board.write_concealed("alpha bravo").unwrap();
        board.user_copies("alpha bravo");
        assert!(!clear_if_unchanged(&board, stamp));
        assert_eq!(board.text().as_deref(), Some("alpha bravo"));
    }

    #[test]
    fn an_earlier_timer_leaves_a_later_copy_of_ours() {
        let board = Fake::default();
        let first = board.write_concealed("alpha bravo").unwrap();
        let second = board.write_concealed("charlie delta").unwrap();
        assert!(!clear_if_unchanged(&board, first));
        assert_eq!(board.text().as_deref(), Some("charlie delta"));
        assert!(clear_if_unchanged(&board, second));
    }

    #[test]
    fn a_pasted_secret_is_cleared_only_while_the_clipboard_still_holds_it() {
        let board = Fake::default();
        board.user_copies("alpha bravo");
        assert!(!clear_if_holds(&board, "something else"));
        assert_eq!(board.text().as_deref(), Some("alpha bravo"));
        assert!(clear_if_holds(&board, "alpha bravo"));
        assert_eq!(board.text(), None);
        assert!(!clear_if_holds(&board, "alpha bravo"));
        assert!(!clear_if_holds(&board, ""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_private_pasteboard_takes_the_concealed_text_and_clears_by_change_count() {
        use objc2_app_kit::NSPasteboard;

        let board = system::System(NSPasteboard::pasteboardWithUniqueName());
        let stamp = board.write_concealed("alpha bravo").unwrap();
        assert_eq!(board.text().as_deref(), Some("alpha bravo"));
        assert!(system::concealed(&board));
        assert_eq!(board.stamp(), stamp);

        let later = board.write_concealed("charlie delta").unwrap();
        assert_ne!(later, stamp);
        assert!(!clear_if_unchanged(&board, stamp));
        assert_eq!(board.text().as_deref(), Some("charlie delta"));
        assert!(clear_if_holds(&board, "charlie delta"));
        assert_eq!(board.text(), None);
        assert!(!system::concealed(&board));
        let _: () = unsafe { objc2::msg_send![&*board.0, releaseGlobally] };
    }

    fn listed(source: &str, name: &str) -> bool {
        source.contains(&format!("\"{name}\""))
    }

    #[test]
    fn the_new_commands_are_granted_to_the_main_window_only() {
        let manifest = include_str!("../../build.rs");
        let main = include_str!("../../permissions/main-window.toml");
        let tray = include_str!("../../permissions/tray-window.toml");
        let dapp = include_str!("../../capabilities/dapp.json");
        let tray_capability = include_str!("../../capabilities/tray.json");
        for command in [
            "wallet_copy_secret",
            "wallet_clear_pasted_secret",
            "wallet_end_reveal",
            "wallet_verify_password",
        ] {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(listed(manifest, command), "{command} is not in the manifest");
            assert!(listed(main, &permission), "{command} is not granted to main");
            for other in [tray, dapp, tray_capability] {
                assert!(!other.contains(&permission), "{command} leaked to another window");
            }
        }
        let dapp: serde_json::Value = serde_json::from_str(dapp).unwrap();
        assert_eq!(dapp["permissions"], serde_json::json!(["allow-dapp-bridge-request"]));
    }
}
