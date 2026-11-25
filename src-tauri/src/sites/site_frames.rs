//! Request status for pages of the in-app browser and the dApp windows. Their requests are
//! answered by the main window; the records live in the same request log as socket sites.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{State, Webview};

use crate::guard::ipc_guard::require_main;
use crate::sites::site_lifecycle::{self, Admit, Asker, Status, Target, View, Watch};
use crate::sites::site_relay;
use crate::state::AppState;
use crate::ws::ws_sites;

pub const FRAME: &str = "frame";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn valid_frame(frame: &str) -> bool {
    !frame.is_empty() && frame.len() <= 160 && !frame.chars().any(char::is_control)
}

fn new_wire() -> String {
    crate::ws::ws_auth::hex(&crate::ws::ws_auth::random32())[..32].to_string()
}

#[allow(clippy::too_many_arguments)]
pub fn open(
    state: &AppState,
    origin: &str,
    frame: &str,
    network: &str,
    address: Option<String>,
    method: &str,
    params: &Value,
    rid: Option<&Value>,
) -> Value {
    let rid = match site_lifecycle::parse_rid(rid) {
        Err(()) => return json!({ "kind": "invalid" }),
        Ok(None) => return json!({ "kind": "none" }),
        Ok(Some(r)) => r,
    };
    if !site_lifecycle::LIFECYCLE_METHODS.contains(&method) || !valid_frame(frame) {
        return json!({ "kind": "none" });
    }
    let digest = site_lifecycle::digest(method, params, network);
    let asker = Asker {
        client_id: FRAME,
        origin,
        conn: 0,
        tab_ref: frame,
        proven: true,
        connected: address.is_some(),
        target: Some(Target::Frame(frame.to_string())),
    };
    let (reply, wire) = {
        let mut q = lock(&state.ws_site_queue);
        match q.log.admit(&asker, &rid, &digest, |_| true) {
            Admit::Reused => (json!({ "kind": "reused" }), None),
            Admit::Stored(answer, status) => {
                (json!({ "kind": "stored", "reply": site_lifecycle::decorate(&answer, &rid, status) }), None)
            }
            Admit::Join(wire) => {
                q.log.join(&asker, &rid);
                (json!({ "kind": "join", "wire": wire }), None)
            }
            Admit::New => {
                let wire = new_wire();
                let opened = q.log.open(&asker, &rid, &digest, &wire, method, network, address, Instant::now(), ws_sites::wall_ms());
                if opened {
                    (json!({ "kind": "new", "wire": wire }), Some(wire))
                } else {
                    (json!({ "kind": "busy" }), None)
                }
            }
        }
    };
    if let Some(w) = wire {
        site_relay::notify(state, &w);
    }
    reply
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FrameUpdate {
    Stage { status: Status },
    Signing,
    Finish { reply: Value, committed: bool, address: Option<String> },
}

pub fn update(state: &AppState, wire: &str, up: &FrameUpdate) -> Value {
    let now = Instant::now();
    let (changed, out) = {
        let mut q = lock(&state.ws_site_queue);
        if q.log.following(wire).next().is_none_or(|r| r.client_id != FRAME) {
            return json!({ "error": "This request has ended" });
        }
        match up {
            FrameUpdate::Stage { status } if matches!(status, Status::Pending | Status::Locked | Status::ReviewOpen) => {
                (q.log.stage(wire, *status, now, ws_sites::wall_ms()), json!({}))
            }
            FrameUpdate::Stage { .. } => (false, json!({ "error": "Not a stage" })),
            FrameUpdate::Signing => (q.log.signing(wire, now, ws_sites::wall_ms()), json!({})),
            FrameUpdate::Finish { reply, committed, address } => {
                if q.log.unlocked(wire, now, ws_sites::wall_ms()) {
                    drop(q);
                    site_relay::notify(state, wire);
                    q = lock(&state.ws_site_queue);
                }
                let status = q.log.finish(wire, reply, *committed, address.as_deref(), now, ws_sites::wall_ms());
                let watch: Option<Watch> = q.log.watch(wire);
                (status.is_some(), json!({ "status": status.map(Status::as_str), "watch": watch }))
            }
        }
    };
    if changed {
        site_relay::notify(state, wire);
    }
    out
}

/// The full record; the main window hides what a site that is not connected may not see.
pub fn status(state: &AppState, origin: &str, rid: &Value) -> Value {
    let rid = match site_lifecycle::parse_rid(Some(rid)) {
        Ok(Some(r)) => r,
        _ => return json!({ "error": ws_sites::BAD_RID.json() }),
    };
    let now = Instant::now();
    let (card, recheck) = {
        let mut q = lock(&state.ws_site_queue);
        let card = q.log.get(FRAME, origin, &rid).map(|r| r.card.clone());
        let recheck = card.as_ref().and_then(|_| q.log.recheck(FRAME, origin, &rid, now));
        (card, recheck)
    };
    if let Some(w) = recheck {
        site_relay::emit_recheck(state, &w);
    }
    let result = match card {
        Some(c) => c.json(View { connected: true, address: true }),
        None => site_lifecycle::unknown(&rid),
    };
    json!({ "result": result })
}

pub fn hello() -> Value {
    let mut v = json!({ "version": env!("CARGO_PKG_VERSION") });
    site_lifecycle::advertise(&mut v);
    v
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn site_frame_open(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    origin: String,
    frame: String,
    network: String,
    address: Option<String>,
    method: String,
    params: Value,
    rid: Option<Value>,
) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(open(&state, &origin, &frame, &network, address, &method, &params, rid.as_ref()))
}

#[tauri::command]
pub fn site_frame_update(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    wire: String,
    update: FrameUpdate,
) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(self::update(&state, &wire, &update))
}

#[tauri::command]
pub fn site_frame_status(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    origin: String,
    rid: Value,
) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(status(&state, &origin, &rid))
}

#[tauri::command]
pub fn site_wallet_hello(webview: Webview) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(hello())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "https://pool.example";
    const OTHER: &str = "https://other.example";

    fn rid(n: u8) -> Value {
        json!(format!("{:032x}", n))
    }

    fn state() -> Arc<AppState> {
        let s = AppState::new();
        *lock(&s.ws_sites) = Some(ws_sites::SiteStore::default());
        s
    }

    fn send(s: &AppState, frame: &str, origin: &str, n: u8, params: Value) -> Value {
        open(s, origin, frame, "mainnet", Some("oct1".into()), "send_transaction", &params, Some(&rid(n)))
    }

    #[test]
    fn a_frame_request_gets_one_record_joins_and_reuse_rules() {
        let s = state();
        let first = send(&s, "iframe:a:1", SITE, 1, json!({ "amount": "1" }));
        assert_eq!(first["kind"], "new");
        let wire = first["wire"].as_str().unwrap().to_string();
        assert_eq!(send(&s, "iframe:a:2", SITE, 1, json!({ "amount": "1" }))["kind"], "join");
        assert_eq!(send(&s, "iframe:a:1", SITE, 1, json!({ "amount": "2" }))["kind"], "reused");
        assert_eq!(send(&s, "iframe:b:1", OTHER, 1, json!({ "amount": "1" }))["kind"], "new", "ids are per origin");
        let devnet = open(&s, SITE, "iframe:a:1", "devnet", None, "send_transaction", &json!({ "amount": "1" }), Some(&rid(1)));
        assert_eq!(devnet["kind"], "reused", "the network is part of the request");

        update(&s, &wire, &FrameUpdate::Stage { status: Status::ReviewOpen });
        update(&s, &wire, &FrameUpdate::Signing);
        let hash = "ab".repeat(32);
        let done = update(&s, &wire, &FrameUpdate::Finish { reply: json!({ "result": { "txHash": hash } }), committed: true, address: None });
        assert_eq!(done["status"], "submitted");
        assert_eq!(done["watch"]["hashes"][0], hash);
        let again = send(&s, "iframe:a:3", SITE, 1, json!({ "amount": "1" }));
        assert_eq!(again["kind"], "stored");
        assert_eq!(again["reply"]["result"]["txHash"], hash);
        assert_eq!(again["reply"]["status"], "submitted");
        let st = status(&s, SITE, &rid(1));
        assert_eq!(st["result"]["status"], "submitted");
        assert_eq!(status(&s, OTHER, &rid(9))["result"]["status"], "unknown");
        assert_eq!(status(&s, SITE, &json!("nope"))["error"]["code"], "INVALID_PARAMS");
    }

    #[test]
    fn malformed_ids_and_reads_are_told_apart() {
        let s = state();
        assert_eq!(open(&s, SITE, "f", "mainnet", None, "connect", &json!({}), Some(&json!("XYZ")))["kind"], "invalid");
        assert_eq!(open(&s, SITE, "f", "mainnet", None, "connect", &json!({}), None)["kind"], "none");
        assert_eq!(open(&s, SITE, "f", "mainnet", None, "getBalance", &json!({}), Some(&rid(1)))["kind"], "none");
    }

    #[test]
    fn a_rejected_or_expired_frame_request_never_runs_again() {
        let s = state();
        let w = send(&s, "f", SITE, 2, json!({}))["wire"].as_str().unwrap().to_string();
        update(&s, &w, &FrameUpdate::Stage { status: Status::ReviewOpen });
        let expired = json!({ "error": { "code": "USER_REJECTED", "message": "late", "details": { "status": "expired" } } });
        assert_eq!(update(&s, &w, &FrameUpdate::Finish { reply: expired, committed: false, address: None })["status"], "expired");
        let again = send(&s, "f", SITE, 2, json!({}));
        assert_eq!(again["kind"], "stored");
        assert_eq!(again["reply"]["error"]["code"], "USER_REJECTED");
        assert_eq!(again["reply"]["status"], "expired");
    }

    #[test]
    fn a_strangers_frame_request_does_not_move_at_unlock() {
        let s = state();
        let w = open(&s, SITE, "f", "mainnet", None, "connect", &json!({}), Some(&rid(4)))["wire"].as_str().unwrap().to_string();
        update(&s, &w, &FrameUpdate::Stage { status: Status::Locked });
        let before = status(&s, SITE, &rid(4))["result"].clone();
        assert_eq!(before["status"], "review_open");
        update(&s, &w, &FrameUpdate::Stage { status: Status::ReviewOpen });
        let after = status(&s, SITE, &rid(4))["result"].clone();
        assert_eq!((after["seq"].clone(), after["updatedAt"].clone()), (before["seq"].clone(), before["updatedAt"].clone()));

        let c = send(&s, "f", SITE, 5, json!({}))["wire"].as_str().unwrap().to_string();
        update(&s, &c, &FrameUpdate::Stage { status: Status::Locked });
        assert_eq!(status(&s, SITE, &rid(5))["result"]["status"], "locked", "a connected site sees locked");
    }

    #[test]
    fn a_socket_record_is_not_a_frame_record() {
        let s = state();
        assert_eq!(update(&s, "00000000000000000000000000000000", &FrameUpdate::Signing)["error"], "This request has ended");
    }

    #[test]
    fn hello_names_the_protocol_and_nothing_about_the_user() {
        let h = hello();
        assert_eq!(h["protocol"], 2);
        assert_eq!(h["kind"], "desktop");
        assert_eq!(h["capabilities"], json!(site_lifecycle::CAPABILITIES));
        assert_eq!(h.as_object().unwrap().len(), 4);
    }
}
