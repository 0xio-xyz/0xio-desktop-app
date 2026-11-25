use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::{mpsc, oneshot};

use crate::guard::ipc_guard::{require_main, require_tray, TRAY_WINDOW};
use crate::sites::site_lifecycle::{self, Card, Progress, Target, View, Watch};
use crate::state::AppState;
use crate::tlog;
use crate::ws::ws_sites::{
    self, apply_effects, arrival, Arrival, ClickTarget, Dropped, Effect, Notice, Push, Refusal, Sent, SiteRecord,
    SiteStore, Stage, EVENT_KINDS, NOT_CONNECTED,
};

pub struct Sub {
    pub client_id: String,
    pub origin: Option<String>,
    pub snapshots: bool,
    pub out: mpsc::UnboundedSender<String>,
}

impl Sub {
    fn hears(&self, client_id: &str, origin: &str) -> bool {
        self.client_id == client_id && self.origin.as_deref().is_none_or(|o| o == origin)
    }
}

pub type SiteSubs = HashMap<u64, Sub>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    ws_sites::wall_ms()
}

fn emit(state: &AppState, event: &str, payload: Value) {
    if let Some(handle) = state.app_handle.get() {
        let _ = handle.emit(event, payload);
    }
}

fn emit_main(state: &AppState, event: &str, payload: Value) {
    if let Some(handle) = state.app_handle.get() {
        let _ = handle.emit_to("main", event, payload);
    }
}

fn sites_path(state: &AppState) -> Option<PathBuf> {
    let dir = state.app_handle.get()?.path().app_data_dir().ok()?;
    Some(dir.join("ws_sites.json"))
}

pub fn with_sites<T>(state: &AppState, f: impl FnOnce(&mut SiteStore) -> T) -> T {
    let mut guard = lock(&state.ws_sites);
    if guard.is_none() {
        let store: SiteStore = sites_path(state)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        *guard = Some(store);
    }
    f(guard.as_mut().expect("store loaded above"))
}

fn save_sites(state: &AppState, store: &SiteStore) {
    let Some(path) = sites_path(state) else { return };
    let Ok(bytes) = serde_json::to_vec_pretty(store) else { return };
    let _ = crate::system::atomic_file::write(&path, &bytes);
}

fn sites_changed(state: &AppState, client_ids: &[String]) {
    let all = with_sites(state, |s| {
        save_sites(state, s);
        let subs = lock(&state.ws_site_subs);
        for sub in subs.values().filter(|x| x.snapshots && client_ids.contains(&x.client_id)) {
            let _ = sub.out.send(s.snapshot_for(&sub.client_id, sub.origin.as_deref()).to_string());
        }
        s.sites.clone()
    });
    emit(state, "relay-sites", json!(all));
}

/// Never to another origin.
pub(crate) fn send_event(state: &AppState, client_id: &str, origin: &str, kind: &str, data: Value) -> usize {
    let text = ws_sites::site_event(origin, kind, data).to_string();
    lock(&state.ws_site_subs)
        .values()
        .filter(|x| x.hears(client_id, origin))
        .filter(|x| x.out.send(text.clone()).is_ok())
        .count()
}

fn queue_json(state: &AppState) -> Value {
    json!({ "items": lock(&state.ws_site_queue).json() })
}

fn queue_changed(state: &AppState) {
    let (payload, visible, gone) = {
        let q = lock(&state.ws_site_queue);
        let waiting = q.items.iter().filter(|p| p.stage.visible()).map(|p| p.site.origin.as_str());
        let gone = lock(&state.ws_site_notices).retain_waiting(waiting);
        (json!({ "items": q.json() }), q.visible(), gone)
    };
    emit(state, "site-queue", payload);
    if let Some(app) = state.app_handle.get() {
        crate::system::tray::set_site_count(app, visible);
        crate::sites::site_notify::remove(app, gone);
    }
}

fn dropped(state: &AppState, gone: Vec<Dropped>) {
    if gone.is_empty() {
        return;
    }
    let ids: Vec<String> = gone.into_iter().map(|d| d.id).collect();
    for id in &ids {
        notify(state, id);
    }
    emit_main(state, "site-dropped", json!({ "ids": ids }));
    queue_changed(state);
}

fn reply_frame(wire_id: &str, reply: Value, rid: &Option<Value>) -> Value {
    let mut frame = json!({ "v": 1, "id": wire_id });
    if let (Some(obj), Some(r)) = (frame.as_object_mut(), reply.as_object()) {
        for (k, v) in r {
            obj.insert(k.clone(), v.clone());
        }
    }
    with_id(frame, rid)
}

fn with_id(mut v: Value, id: &Option<Value>) -> Value {
    if let (Some(id), Some(obj)) = (id, v.as_object_mut()) {
        obj.insert("_id".to_string(), id.clone());
    }
    v
}

pub fn refusal_frame(r: Refusal, msg: &Value) -> Value {
    let mut v = json!({ "v": 1, "error": r.json() });
    if let Some(id) = msg.get("id").and_then(Value::as_str) {
        v["id"] = json!(id);
    }
    with_id(v, &msg.get("_id").cloned())
}

/// `locked`, the network and the signer only while the site is connected here (for a web page,
/// on a connection that proved it with its token).
fn view_for(state: &AppState, client_id: &str, origin: &str, conn: u64, address: Option<&str>) -> View {
    let proven = client_id != ws_sites::DIRECT || web_client(state, conn) == ws_sites::DIRECT;
    let (connected, signer) = with_sites(state, |s| {
        let mut mine = s.sites.iter().filter(|r| r.origin == origin && r.client_id == client_id).peekable();
        let connected = mine.peek().is_some();
        (connected, address.is_some_and(|a| mine.any(|r| r.address == a)))
    });
    View { connected: proven && connected, address: proven && signer }
}

/// Only to the connections and frames that sent the request. Relayed events name the tab, so the
/// extension tells only that one; a frame's event goes through the main window, which masks it.
pub(crate) fn notify(state: &AppState, wire_id: &str) -> usize {
    type Out = (Target, u64, String, String, String, Card);
    let outs: Vec<Out> = {
        let q = lock(&state.ws_site_queue);
        q.log
            .following(wire_id)
            .flat_map(|r| {
                r.listeners.iter().map(move |l| {
                    (l.target.clone(), l.conn, r.client_id.clone(), r.origin.clone(), l.tab_ref.clone(), r.card.clone())
                })
            })
            .collect()
    };
    let mut sent = 0;
    for (target, conn, client, origin, tab, card) in outs {
        match target {
            Target::Frame(frame) => {
                let full = View { connected: true, address: true };
                emit_main(state, "frame-request-update", json!({ "frame": frame, "origin": origin, "data": card.json(full) }));
                sent += 1;
            }
            Target::Socket(out) => {
                let view = view_for(state, &client, &origin, conn, card.address.as_deref());
                let mut ev = ws_sites::site_event(&origin, ws_sites::REQUEST_KIND, card.json(view));
                if client != ws_sites::DIRECT {
                    ev["tab_ref"] = json!(tab);
                }
                if out.send(ev.to_string()).is_ok() {
                    sent += 1;
                }
            }
        }
    }
    sent
}

/// An unproven page may ask only about ids it sent on this connection; anything else reads
/// `unknown`, as an id never seen does.
pub fn status(state: &AppState, conn: u64, client_id: &str, origin: &str, msg: &Value) -> Value {
    let rid = match site_lifecycle::parse_rid(msg.get("rid")) {
        Ok(Some(r)) => r,
        _ => return json!({ "v": 1, "error": ws_sites::BAD_RID.json() }),
    };
    let proven = client_id != ws_sites::DIRECT_UNPROVEN;
    let carrier = if proven { client_id } else { ws_sites::DIRECT };
    let now = Instant::now();
    let (card, recheck) = {
        let mut q = lock(&state.ws_site_queue);
        if !q.log.status_allowed(carrier, origin, now) {
            return json!({ "v": 1, "error": ws_sites::TOO_FAST.json() });
        }
        let card = q.log.lookup(carrier, origin, &rid, conn, proven).map(|r| r.card.clone());
        let recheck = card.as_ref().and_then(|_| q.log.recheck(carrier, origin, &rid, now));
        (card, recheck)
    };
    if let Some(w) = recheck {
        emit_recheck(state, &w);
    }
    let result = match card {
        Some(c) => c.json(view_for(state, carrier, origin, conn, c.address.as_deref())),
        None => site_lifecycle::unknown(&rid),
    };
    json!({ "v": 1, "result": result })
}

pub(crate) fn emit_recheck(state: &AppState, w: &Watch) {
    emit_main(state, "site-recheck", json!(w));
}

pub fn page_allowed(state: &AppState, conn: u64) -> bool {
    lock(&state.ws_site_queue).page_hit(conn, Instant::now())
}

pub fn relayed_origin(msg: &Value) -> Option<String> {
    let raw = msg.pointer("/site/origin").or_else(|| msg.get("origin")).and_then(Value::as_str)?;
    ws_sites::relay_origin(raw, ws_sites::dev_build())
}

pub fn sweep(state: &AppState) {
    sweep_at(state, Instant::now());
}

pub fn sweep_at(state: &AppState, now: Instant) {
    let gone = {
        let mut q = lock(&state.ws_site_queue);
        let gone = q.expire(now);
        q.log.sweep(now);
        gone
    };
    dropped(state, gone);
}


pub fn subscribe(
    state: &AppState,
    conn: u64,
    client_id: &str,
    origin: Option<&str>,
    out: mpsc::UnboundedSender<String>,
) -> Value {
    let snap = with_sites(state, |s| s.snapshot_for(client_id, origin));
    let _ = out.send(snap.to_string());
    let sub = Sub { client_id: client_id.to_string(), origin: origin.map(str::to_string), snapshots: true, out };
    lock(&state.ws_site_subs).insert(conn, sub);
    json!({ "v": 1, "ok": true })
}

/// It hears its origin's events only once it showed its site token, or once a connect it sent
/// was approved.
pub fn listen_web(state: &AppState, conn: u64, origin: &str, out: mpsc::UnboundedSender<String>) {
    let sub = Sub {
        client_id: ws_sites::DIRECT_UNPROVEN.to_string(),
        origin: Some(origin.to_string()),
        snapshots: false,
        out,
    };
    lock(&state.ws_site_subs).insert(conn, sub);
}

pub fn web_client(state: &AppState, conn: u64) -> String {
    lock(&state.ws_site_subs)
        .get(&conn)
        .map(|s| s.client_id.clone())
        .unwrap_or_else(|| ws_sites::DIRECT_UNPROVEN.to_string())
}

fn is_web(sub: &Sub, origin: &str) -> bool {
    sub.origin.as_deref() == Some(origin)
        && (sub.client_id == ws_sites::DIRECT || sub.client_id == ws_sites::DIRECT_UNPROVEN)
}

pub fn set_web_proven(state: &AppState, conn: u64, origin: &str, proven: bool) {
    let mut subs = lock(&state.ws_site_subs);
    if let Some(sub) = subs.get_mut(&conn).filter(|s| is_web(s, origin)) {
        let to = if proven { ws_sites::DIRECT } else { ws_sites::DIRECT_UNPROVEN };
        sub.client_id = to.to_string();
    }
}

/// Its open pages are unconnected until a new connect is approved.
pub fn revoke_direct(state: &AppState, origin: &str) {
    let gone = with_sites(state, |s| s.revoke(origin, ws_sites::DIRECT));
    lock(&state.ws_site_queue).log.forget_site(ws_sites::DIRECT, origin);
    {
        let empty = SiteStore::default().snapshot_for(ws_sites::DIRECT_UNPROVEN, Some(origin)).to_string();
        let mut subs = lock(&state.ws_site_subs);
        for sub in subs.values_mut().filter(|s| s.client_id == ws_sites::DIRECT && is_web(s, origin)) {
            sub.client_id = ws_sites::DIRECT_UNPROVEN.to_string();
            if sub.snapshots {
                let _ = sub.out.send(empty.clone());
            }
        }
    }
    sites_changed(state, &[ws_sites::DIRECT.to_string()]);
    tlog!("[sites] Revoked a direct site ({} record(s) went)", gone.len());
}

pub fn connection_closed(state: &AppState, conn: u64) {
    lock(&state.ws_site_subs).remove(&conn);
    let gone = lock(&state.ws_site_queue).drop_conn(conn);
    dropped(state, gone);
}

/// A queued request is answered later through `out`, so the read loop never waits for a review.
pub fn request(
    state: &Arc<AppState>,
    conn: u64,
    client_id: &str,
    browser: &'static str,
    msg: &Value,
    out: mpsc::UnboundedSender<String>,
) -> Option<Value> {
    let req = match ws_sites::parse_request(msg, ws_sites::dev_build()) {
        Ok(r) => r,
        Err(r) => return Some(refusal_frame(r, msg)),
    };
    let rid = msg.get("_id").cloned();
    let now = now_ms();
    let (network, address) = with_sites(state, |s| {
        let rec = if req.method == "connect" {
            s.get(&req.network, &req.site.origin, client_id)
        } else {
            s.resolve(&req.site.origin, client_id, &req.network)
        };
        let found = rec.map(|r| (r.network.clone(), r.address.clone()));
        if let Some((n, _)) = &found {
            s.note_request(n, &req.site.origin, client_id, now);
        }
        found.unzip()
    });
    if network.is_none() && !ws_sites::OPEN_METHODS.contains(&req.method.as_str()) {
        return Some(refusal_frame(NOT_CONNECTED, msg));
    }
    let mut req = req;
    req.network = network.unwrap_or(req.network);
    let wire_id = req.id.clone();
    let (tx, rx) = oneshot::channel::<Value>();
    let payload = json!({
        "id": req.id,
        "origin": req.site.origin,
        "topOrigin": req.site.top_origin,
        "framed": req.site.framed,
        "browser": browser,
        "clientId": client_id,
        "network": req.network,
        "method": req.method,
        "params": req.params,
    });
    let sent = Sent { client_id, browser, conn, out: Some(out.clone()), address };
    let pushed = lock(&state.ws_site_queue).push(req, sent, tx, Instant::now(), now);
    match pushed {
        Err((r, _)) => return Some(refusal_frame(r, msg)),
        Ok(Push::New(id)) => {
            emit_main(state, "site-request", payload);
            notify(state, &id);
        }
        Ok(Push::Merged(id)) => {
            queue_changed(state);
            notify(state, &id);
        }
        Ok(Push::Stored) => {}
    }
    // No answer when the page went away while its approved request ran on.
    tokio::spawn(async move {
        if let Ok(reply) = rx.await {
            let _ = out.send(reply_frame(&wire_id, reply, &rid).to_string());
        }
    });
    None
}

/// Refused once the request runs (`ok: false`); its answer still comes.
pub fn cancel(state: &AppState, conn: u64, client_id: &str, origin: Option<&str>, msg: &Value) -> Value {
    let id = msg.get("id").or_else(|| msg.get("rid")).and_then(Value::as_str).map(str::to_ascii_lowercase);
    let mut reply = json!({ "v": 1, "ok": true });
    if let Some(id) = id {
        let (gone, running) = {
            let mut q = lock(&state.ws_site_queue);
            (q.cancel(conn, &id), q.running(conn, &id))
        };
        dropped(state, gone);
        if running {
            reply["ok"] = json!(false);
        }
    }
    if let (Ok(Some(_)), Some(origin)) = (site_lifecycle::parse_rid(msg.get("rid")), origin) {
        if let Some(result) = status(state, conn, client_id, origin, msg).get("result") {
            reply["result"] = result.clone();
        }
    }
    reply
}

pub fn closed(state: &AppState, conn: u64, msg: &Value) -> Value {
    if let Some(tab) = msg.get("tab_ref").and_then(Value::as_str) {
        let gone = lock(&state.ws_site_queue).close_tab(conn, &tab.to_ascii_lowercase());
        dropped(state, gone);
    }
    json!({ "v": 1, "ok": true })
}

pub fn disconnect(state: &AppState, client_id: &str, msg: &Value) -> Value {
    let origin = msg.get("origin").and_then(Value::as_str).and_then(|o| ws_sites::relay_origin(o, ws_sites::dev_build()));
    let network = msg.get("network").and_then(Value::as_str).filter(|n| ws_sites::RELAY_NETWORKS.contains(n));
    let (Some(origin), Some(network)) = (origin, network) else {
        return json!({ "v": 1, "error": ws_sites::INVALID.json() });
    };
    let gone = with_sites(state, |s| s.disconnect(network, &origin, client_id));
    if gone.is_some() {
        lock(&state.ws_site_queue).log.forget_site(client_id, &origin);
        sites_changed(state, &[client_id.to_string()]);
        send_event(state, client_id, &origin, "accountsChanged", json!({ "accounts": [] }));
    }
    json!({ "v": 1, "ok": true })
}

/// Its sites hear that they have no account before they are forgotten.
pub fn forget_client(state: &AppState, client_id: &str) -> usize {
    let mine: Vec<SiteRecord> = with_sites(state, |s| s.sites.iter().filter(|r| r.client_id == client_id).cloned().collect());
    for r in &mine {
        send_event(state, client_id, &r.origin, "accountsChanged", json!({ "accounts": [] }));
    }
    let gone = with_sites(state, |s| s.forget_client(client_id));
    if !gone.is_empty() {
        sites_changed(state, &[]);
        tlog!("[sites] Forgot {} site(s) relayed by {}", gone.len(), &client_id[..client_id.len().min(8)]);
    }
    let dropped_now = lock(&state.ws_site_queue).drop_client(client_id);
    dropped(state, dropped_now);
    gone.len()
}


fn panel_open(state: &AppState) -> bool {
    state
        .app_handle
        .get()
        .and_then(|a| a.get_webview_window(TRAY_WINDOW))
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

fn needs_user(state: &AppState, id: &str, visible_before: usize) {
    let Some(app) = state.app_handle.get() else { return };
    let arrival = arrival(visible_before, panel_open(state));
    if arrival == Arrival::Open {
        crate::system::tray::open_for_site(app, Some(id.to_string()), None);
        return;
    }
    let Some((origin, line)) = lock(&state.ws_site_queue).get_mut(id).map(|p| (p.site.origin.clone(), p.notice.clone()))
    else {
        return;
    };
    let enabled = crate::ws::ws_server::notify_sites_on(state);
    let body = ws_sites::notice_text(line.as_deref(), &origin);
    let notice = lock(&state.ws_site_notices).arrive(&arrival, enabled, &origin, &body);
    if let Notice::Post { replaces } = notice {
        crate::sites::site_notify::post(app, origin, body, replaces);
    }
}

pub fn clear_notices(state: &AppState) {
    let gone = lock(&state.ws_site_notices).clear();
    if let Some(app) = state.app_handle.get() {
        crate::sites::site_notify::remove(app, gone);
    }
}

pub fn notification_clicked(state: &AppState, origin: &str) {
    let waiting: Vec<(String, String)> = lock(&state.ws_site_queue)
        .items
        .iter()
        .filter(|p| p.stage.visible())
        .map(|p| (p.id.clone(), p.site.origin.clone()))
        .collect();
    let target = lock(&state.ws_site_notices).click(origin, &waiting);
    let Some(app) = state.app_handle.get() else { return };
    tlog!("[sites] notification clicked (still waiting: {})", target.is_some());
    match target {
        Some(ClickTarget::Review(id)) => crate::system::tray::open_for_site(app, Some(id), None),
        Some(ClickTarget::Site(origin)) => crate::system::tray::open_for_site(app, None, Some(origin)),
        None => {}
    }
}


#[tauri::command]
pub fn site_list(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<Vec<SiteRecord>, String> {
    require_main(&webview)?;
    Ok(with_sites(&state, |s| s.sites.clone()))
}

#[tauri::command]
pub fn site_review_open(webview: Webview, app: AppHandle, id: String) -> Result<(), String> {
    require_main(&webview)?;
    if id.is_empty() || id.len() > 64 {
        return Err("Malformed request id".into());
    }
    crate::system::tray::open_for_site(&app, Some(id), None);
    Ok(())
}

#[tauri::command]
pub fn site_queue(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    if webview.label() != "main" {
        require_tray(&webview)?;
    }
    Ok(queue_json(&state))
}

pub(crate) fn refuse_while_cooling(state: &AppState, id: &str) -> Result<(), String> {
    let gone = lock(&state.ws_site_queue).refuse_if_cooling(id, Instant::now());
    match gone {
        Some(d) => {
            dropped(state, vec![d]);
            Err("Rejected a moment ago".into())
        }
        None => Ok(()),
    }
}

#[tauri::command]
pub fn site_stage(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    id: String,
    stage: Stage,
    review: Option<Value>,
    notice: Option<String>,
) -> Result<(), String> {
    require_main(&webview)?;
    if stage.visible() {
        refuse_while_cooling(&state, &id)?;
    }
    let (before, became_visible, changed) = {
        let mut q = lock(&state.ws_site_queue);
        let before = q.visible();
        let Some(p) = q.get_mut(&id) else {
            return Err("This request has ended".into());
        };
        let was = p.stage.visible();
        if review.is_some() {
            p.review = review;
        }
        if notice.is_some() {
            p.notice = notice;
        }
        let changed = q.stage(&id, stage, Instant::now());
        (before, !was && stage.visible(), changed)
    };
    queue_changed(&state);
    if changed {
        notify(&state, &id);
    }
    if became_visible {
        needs_user(&state, &id, before);
    }
    Ok(())
}

fn reply_of(response: &Value) -> Value {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return json!({ "result": response.get("data").cloned().unwrap_or(Value::Null) });
    }
    let err = response.get("error");
    let code = err
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && c.len() <= 64 && c.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
        .unwrap_or("UNKNOWN_ERROR");
    let message = err
        .and_then(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()))
        .unwrap_or("Request failed in 0xio Desktop.");
    let message: String = message.chars().take(500).collect();
    json!({ "error": { "code": code, "message": message } })
}

#[tauri::command]
pub fn site_respond(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    id: String,
    response: Value,
    effects: Option<Vec<Effect>>,
) -> Result<Option<Watch>, String> {
    require_main(&webview)?;
    Ok(respond(&state, &id, &response, &effects.unwrap_or_default()))
}

/// `signing` is refused once the request ended (page closed, expired), so nothing runs for it.
#[tauri::command]
pub fn site_progress(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    id: String,
    progress: Progress,
) -> Result<(), String> {
    require_main(&webview)?;
    progress_of(&state, &id, &progress)
}

pub fn progress_of(state: &AppState, id: &str, progress: &Progress) -> Result<(), String> {
    let changed = {
        let mut q = lock(&state.ws_site_queue);
        match progress {
            Progress::Signing => q.commit(id, Instant::now()).ok_or("This request has ended")?,
            p => q.log.progress(id, p, Instant::now(), now_ms()),
        }
    };
    if changed {
        notify(state, id);
    }
    Ok(())
}

/// The record changes before the site hears the answer, also when the page closed after the
/// approval.
pub fn respond(state: &AppState, id: &str, response: &Value, effects: &[Effect]) -> Option<Watch> {
    let p = lock(&state.ws_site_queue).take(id)?;
    let mut reply = reply_of(response);
    if !effects.is_empty() {
        let direct = p.record_client() == ws_sites::DIRECT;
        let connects = reply.get("result").is_some_and(Value::is_object)
            && effects.iter().any(|e| matches!(e, Effect::Connect { .. }));
        let (changed, token) = with_sites(state, |s| {
            let changed = apply_effects(s, &p, effects, now_ms());
            let token = (direct && connects && s.get(&p.network, &p.site.origin, ws_sites::DIRECT).is_some())
                .then(|| s.issue_token(&p.site.origin, ws_sites::DIRECT));
            (changed, token)
        });
        if let Some(token) = token.as_ref() {
            for w in &p.waiters {
                set_web_proven(state, w.conn, &p.site.origin, true);
            }
            reply["result"]["siteToken"] = json!(token);
        }
        if changed || token.is_some() {
            sites_changed(state, &[p.record_client().to_string()]);
        }
        if p.proven() && effects.iter().any(|e| matches!(e, Effect::Disconnect)) {
            send_event(state, &p.client_id, &p.site.origin, "accountsChanged", json!({ "accounts": [] }));
            if direct {
                revoke_direct(state, &p.site.origin);
            }
        }
    }
    let failed = reply["error"]["code"].as_str().filter(|c| *c != "USER_REJECTED").map(str::to_string);
    if let (Some(code), true) = (failed, p.stage == Stage::Approved) {
        emit(
            state,
            "site-outcome",
            json!({ "id": p.id, "origin": p.site.origin, "code": code, "message": reply["error"]["message"] }),
        );
    }
    let signer = effects.iter().find_map(|e| match e {
        Effect::Connect { address, .. } => Some(address.as_str()),
        _ => None,
    });
    let ends_well = matches!(
        site_lifecycle::outcome(&p.method, &reply),
        site_lifecycle::Status::Completed | site_lifecycle::Status::Submitted
    );
    if ends_well && lock(&state.ws_site_queue).log.unlocked(&p.id, Instant::now(), now_ms()) {
        notify(state, &p.id);
    }
    let (status, watch) = {
        let mut q = lock(&state.ws_site_queue);
        let status = q.log.finish(&p.id, &reply, p.committed, signer, Instant::now(), now_ms());
        (status, q.log.watch(&p.id))
    };
    notify(state, &p.id);
    let status = status.unwrap_or_else(|| site_lifecycle::outcome(&p.method, &reply));
    p.answer(&reply, status);
    queue_changed(state);
    watch
}

#[tauri::command]
pub fn site_disconnect(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    network: String,
    origin: String,
    client_id: String,
) -> Result<Vec<SiteRecord>, String> {
    require_main(&webview)?;
    let gone = with_sites(&state, |s| s.disconnect(&network, &origin, &client_id));
    if gone.is_some() {
        lock(&state.ws_site_queue).log.forget_site(&client_id, &origin);
        sites_changed(&state, &[client_id.clone()]);
        send_event(&state, &client_id, &origin, "accountsChanged", json!({ "accounts": [] }));
    }
    if client_id == ws_sites::DIRECT {
        revoke_direct(&state, &origin);
    }
    Ok(with_sites(&state, |s| s.sites.clone()))
}

/// Only while the site is still connected.
#[tauri::command]
pub fn site_send_event(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    origin: String,
    client_id: String,
    kind: String,
    data: Value,
) -> Result<(), String> {
    require_main(&webview)?;
    if !EVENT_KINDS.contains(&kind.as_str()) {
        return Err("Unknown event".into());
    }
    let known = with_sites(&state, |s| s.sites.iter().any(|r| r.origin == origin && r.client_id == client_id));
    if known {
        send_event(&state, &client_id, &origin, &kind, data);
    }
    Ok(())
}

#[tauri::command]
pub fn site_lock_event(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    require_main(&webview)?;
    let mut pairs: Vec<(String, String)> =
        with_sites(&state, |s| s.sites.iter().map(|r| (r.client_id.clone(), r.origin.clone())).collect());
    pairs.sort();
    pairs.dedup();
    for (client, origin) in pairs {
        send_event(&state, &client, &origin, "lock", json!({}));
    }
    Ok(())
}


#[tauri::command]
pub fn site_answer(webview: Webview, state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    require_tray(&webview)?;
    {
        let mut q = lock(&state.ws_site_queue);
        let Some(p) = q.get_mut(&id) else {
            return Err("This request has ended".into());
        };
        if p.stage != Stage::Review {
            return Err("This request is not ready".into());
        }
        p.stage = Stage::Approved;
    }
    queue_changed(&state);
    emit_main(&state, "site-answer", json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn site_reject(webview: Webview, state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Result<(), String> {
    require_tray(&webview)?;
    reject(&state, &ids);
    Ok(())
}

pub fn reject(state: &AppState, ids: &[String]) {
    let gone = lock(&state.ws_site_queue).reject(ids);
    dropped(state, gone);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_carry_the_sdk_shape() {
        let ok = reply_of(&json!({ "success": true, "data": { "txHash": "ab" } }));
        assert_eq!(ok, json!({ "result": { "txHash": "ab" } }));
        let err = reply_of(&json!({ "success": false, "error": { "code": "USER_REJECTED", "message": "no" } }));
        assert_eq!(err["error"]["code"], "USER_REJECTED");
        assert!(err.get("result").is_none());
        let odd = reply_of(&json!({ "success": false, "error": { "code": "bad code", "message": "x" } }));
        assert_eq!(odd["error"]["code"], "UNKNOWN_ERROR");
        let framed = reply_frame("ab", ok, &Some(json!(7)));
        assert_eq!(framed, json!({ "v": 1, "id": "ab", "_id": 7, "result": { "txHash": "ab" } }));
    }
}
