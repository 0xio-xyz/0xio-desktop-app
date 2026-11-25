use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::oneshot;

use crate::dapp::window::site_of;
use crate::guard::ipc_guard::{require_dapp, require_main};
use crate::tlog;

#[derive(Debug, Serialize)]
pub struct BridgeRefusal {
    pub code: &'static str,
    pub message: String,
}

fn unauthorized(message: impl Into<String>) -> BridgeRefusal {
    BridgeRefusal {
        code: "UNAUTHORIZED",
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> BridgeRefusal {
    BridgeRefusal {
        code: "INTERNAL_ERROR",
        message: message.into(),
    }
}

/// Keyed by window label and the page's id, so one dapp cannot claim another's answer by reusing
/// its id.
static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<BridgeReply>>>> = Mutex::new(None);

#[derive(Clone, Serialize)]
pub struct BridgeRequest {
    pub id: String,
    /// Taken from the webview's URL, not from the page.
    pub origin: String,
    pub method: String,
    pub params: serde_json::Value,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BridgeReply {
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[tauri::command]
pub async fn dapp_bridge_request(
    handle: AppHandle,
    webview: Webview,
    id: String,
    method: String,
    params: serde_json::Value,
    rid: Option<String>,
) -> Result<(), BridgeRefusal> {
    require_dapp(&webview).map_err(unauthorized)?;
    let rid = rid.filter(|r| r.len() <= 64);
    let label = webview.label().to_string();
    tlog!("[0xio-desktop] bridge <- {method} (id={id}, window={label})");
    let origin = webview
        .url()
        .ok()
        .and_then(|u| site_of(&label, &u))
        .ok_or_else(|| unauthorized("This page cannot reach the wallet"))?;

    let key = format!("{label}/{id}");
    let (tx, rx) = oneshot::channel::<BridgeReply>();
    {
        let mut guard = PENDING
            .lock()
            .map_err(|_| internal("bridge lock poisoned"))?;
        let pending = guard.get_or_insert_with(HashMap::new);
        if pending.contains_key(&key) {
            return Err(BridgeRefusal {
                code: "INVALID_PARAMS",
                message: "Duplicate request id".into(),
            });
        }
        pending.insert(key.clone(), tx);
    }

    tlog!("[0xio-desktop] bridge -> wallet UI (id={id}, origin={origin})");
    handle
        .emit(
            "dapp-bridge-request",
            BridgeRequest {
                id: key.clone(),
                origin: origin.clone(),
                method,
                params,
                label: label.clone(),
                rid,
            },
        )
        .map_err(|e| {
            if let Ok(mut guard) = PENDING.lock() {
                guard.as_mut().and_then(|m| m.remove(&key));
            }
            internal(format!("Failed to reach the wallet: {e}"))
        })?;

    let reply = rx.await.unwrap_or(BridgeReply {
        result: None,
        error: Some("Wallet did not answer".into()),
        code: Some("INTERNAL_ERROR".into()),
        details: None,
        rid: None,
        status: None,
    });

    tlog!(
        "[0xio-desktop] bridge <- wallet UI (id={id}, ok={})",
        reply.error.is_none()
    );
    // Not answered when the window has since navigated to another origin.
    if let Some(win) = handle.get_webview_window(&label) {
        let current = win.url().ok().and_then(|u| site_of(&label, &u));
        if current.as_deref() != Some(origin.as_str()) {
            tlog!("[0xio-desktop] bridge reply dropped: {label} left {origin}");
            return Ok(());
        }
        let payload = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
        let id_js = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".into());
        let js = format!("window.__octraResolve && window.__octraResolve({id_js}, {payload});");
        let _ = win.eval(&js);
    }
    Ok(())
}

#[tauri::command]
pub async fn dapp_bridge_respond(
    webview: Webview,
    id: String,
    reply: BridgeReply,
) -> Result<(), String> {
    require_main(&webview)?;
    let sender = {
        let mut guard = PENDING.lock().map_err(|_| "bridge lock poisoned")?;
        guard.as_mut().and_then(|m| m.remove(&id))
    };
    match sender {
        Some(tx) => {
            let _ = tx.send(reply);
            Ok(())
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{unauthorized, BridgeReply};

    #[test]
    fn a_refusal_reaches_the_page_with_a_code_and_a_message() {
        let js = serde_json::to_value(unauthorized("This page cannot reach the wallet")).unwrap();
        assert_eq!(js["code"], "UNAUTHORIZED");
        assert_eq!(js["message"], "This page cannot reach the wallet");
    }

    #[test]
    fn a_reply_carries_the_wallet_error_code() {
        let reply: BridgeReply = serde_json::from_value(serde_json::json!({
            "error": "This wallet is watch-only and cannot sign.",
            "code": "WATCH_ONLY"
        }))
        .unwrap();
        assert_eq!(reply.code.as_deref(), Some("WATCH_ONLY"));
        let js = serde_json::to_value(&reply).unwrap();
        assert_eq!(js["code"], "WATCH_ONLY");
    }

    #[test]
    fn a_reply_without_a_code_still_parses() {
        let reply: BridgeReply =
            serde_json::from_value(serde_json::json!({ "result": { "ok": true } })).unwrap();
        assert!(reply.code.is_none());
        assert!(serde_json::to_value(&reply).unwrap().get("code").is_none());
    }
}
