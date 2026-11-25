//! Window checks behind the capability ACL. The ACL already keeps these commands out of every
//! window but the main one; this holds even if a capability is ever widened by mistake.

use tauri::{Runtime, Webview};

use crate::tlog;

const MAIN_WINDOW: &str = "main";
const DAPP_WINDOW_PREFIX: &str = "dapp-";
pub(crate) const TRAY_WINDOW: &str = "tray";

pub(crate) fn require_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() == MAIN_WINDOW {
        return Ok(());
    }
    tlog!(
        "[0xio-desktop] refused a wallet command from window {}",
        webview.label()
    );
    Err("Not allowed from this window".into())
}

pub(crate) fn require_dapp<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label().starts_with(DAPP_WINDOW_PREFIX) {
        return Ok(());
    }
    tlog!(
        "[0xio-desktop] refused a dApp bridge call from window {}",
        webview.label()
    );
    Err("Not a dApp window".into())
}

pub(crate) fn require_tray<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() == TRAY_WINDOW {
        return Ok(());
    }
    tlog!(
        "[0xio-desktop] refused a tray command from window {}",
        webview.label()
    );
    Err("Not allowed from this window".into())
}
