use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use tauri::{Emitter, Manager, State, Webview};

use crate::guard::ipc_guard::require_main;
use crate::sites::site_direct;
use crate::sites::site_relay;
use crate::state::{context_fingerprint, AppState, PvacSlot};
use crate::tlog;
use crate::ws::ws_auth::{
    self, Access, Approve, Client, Confirm, PairOutcome, PairSettings, PairStart, PairStore, PairedNative, PendingPair, Session,
    WebPolicy,
};
use crate::ws::ws_sites;

const MAX_CONNECTIONS: usize = ws_auth::MAX_OTHER_CONNECTIONS + ws_auth::MAX_WEB_CONNECTIONS;
const MAX_HANDSHAKING: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 1000 } else { 5000 });
/// A contract deploy of 512 KiB bytecode (683 KiB as base64) and 64 KiB of constructor params,
/// with room for the envelope.
pub const WEB_MAX_MESSAGE: usize = 1 << 20;
/// The biggest real ones carry a PVAC public key (about 4.1 MB as base64) with a cipher and a
/// proof; this leaves room for deep ciphers.
pub const PAIRED_MAX_MESSAGE: usize = 16 << 20;

static ACCEPTED: AtomicUsize = AtomicUsize::new(0);
static HANDSHAKING: AtomicUsize = AtomicUsize::new(0);

struct Counted(&'static AtomicUsize);

impl Counted {
    fn enter(n: &'static AtomicUsize) -> Self {
        n.fetch_add(1, Ordering::SeqCst);
        Self(n)
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const SWEEP_EVERY: Duration = Duration::from_secs(3600);
const SITE_SWEEP_EVERY: Duration = Duration::from_secs(5);

pub async fn start(state: Arc<AppState>) {
    let addr: SocketAddr = "127.0.0.1:19345".parse().unwrap();

    let mut attempt = 0u32;
    let listener = loop {
        match TcpListener::bind(&addr).await {
            Ok(l) => {
                if attempt > 0 {
                    tlog!("[ws_server] Listening on ws://{} (port freed after {} retries)", addr, attempt);
                } else {
                    tlog!("[ws_server] Listening on ws://{}", addr);
                }
                break l;
            }
            Err(e) => {
                if attempt == 0 {
                    tlog!(
                        "[ws_server] {} busy ({}), another copy of 0xio Desktop may be running; retrying until it is free",
                        addr,
                        e
                    );
                }
                attempt += 1;
                let wait = if attempt < 10 { 300 } else { 5_000 };
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            }
        }
    };

    let sweeper = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(SWEEP_EVERY);
        loop {
            every.tick().await;
            sweep_pairs(&sweeper);
        }
    });

    let reviews = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(SITE_SWEEP_EVERY);
        loop {
            every.tick().await;
            site_relay::sweep(&reviews);
        }
    });

    while let Ok((stream, peer)) = listener.accept().await {
        if !peer.ip().is_loopback() {
            tlog!("[ws_server] Rejected non-loopback connection from {}", peer);
            continue;
        }

        // Open connections are capped at the handshake; this caps the ones still on their way.
        if HANDSHAKING.load(Ordering::SeqCst) >= MAX_HANDSHAKING {
            tlog!("[ws_server] Too many handshakes at once ({}), rejecting {}", MAX_HANDSHAKING, peer);
            drop(stream);
            continue;
        }

        tokio::spawn(handle_client(state.clone(), stream, peer));
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn handle_client(state: Arc<AppState>, stream: tokio::net::TcpStream, peer: SocketAddr) {
    // A socket that never finishes its request head or handshake is dropped, and does not hold
    // one of the open connection slots meanwhile.
    let opened = {
        let _handshaking = Counted::enter(&HANDSHAKING);
        match timeout(HANDSHAKE_TIMEOUT, open_client(&state, stream, peer)).await {
            Ok(opened) => opened,
            Err(_) => {
                tlog!("[ws_server] Handshake from {} timed out", peer);
                None
            }
        }
    };
    let Some((ws_stream, client, _cap)) = opened else {
        return;
    };
    let _accepted = Counted::enter(&ACCEPTED);

    // Web pages are not the extension: they do not show as connected or hold the bridge context.
    let counted = !matches!(client, Client::Web(_));
    if counted {
        state.client_connected();
    }
    tlog!(
        "[ws_server] Client connected: {} as {} (total: {})",
        peer,
        client.limit_key(),
        state.connected_clients()
    );

    let (mut tx, mut rx) = ws_stream.split();
    let mut conn_ctx: Option<String> = None;
    // Trust is earned on each connection: the extension proves its pairing secret, a program
    // pairs or presents its token. The Origin header alone unlocks nothing, save the legacy proof
    // calls of an extension from before pairing while the user allows them.
    let mut session = Session::default();
    let mut legacy = false;
    let mut challenge: Option<ws_auth::Challenge> = None;
    let conn_id = NEXT_CONN.fetch_add(1, Ordering::SeqCst);
    let kill = Arc::new(tokio::sync::Notify::new());
    lock(&state.ws_conns).insert(conn_id, (None, kill.clone()));
    let mut native: Option<PairedNative> = None;
    let mut ext_client: Option<String> = None;
    let pair_key = format!("native:{}", crate::system::uuid::new_v4_simple());
    let mut rpc_limit = ws_auth::Window::new(Duration::from_secs(60), 30);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    // A web page is its origin and nothing more; turning websites off closes it.
    if let Client::Web(origin) = &client {
        set_conn_key(&state, conn_id, ws_sites::DIRECT);
        site_relay::listen_web(&state, conn_id, origin, out_tx.clone());
    }
    let mut idle_at = tokio::time::Instant::now() + IDLE_TIMEOUT;

    loop {
        let next = tokio::select! {
            _ = kill.notified() => {
                tlog!("[ws_server] {} was removed or turned off, disconnecting", peer);
                while let Ok(text) = out_rx.try_recv() {
                    let _ = tx.send(Message::Text(text)).await;
                }
                let _ = tx.send(Message::Close(None)).await;
                break;
            }
            Some(text) = out_rx.recv() => {
                if tx.send(Message::Text(text)).await.is_err() {
                    break;
                }
                continue;
            }
            _ = tokio::time::sleep_until(idle_at) => {
                tlog!("[ws_server] Idle timeout for {}, disconnecting", peer);
                let _ = tx.send(Message::Close(None)).await;
                break;
            }
            next = rx.next() => next,
        };
        idle_at = tokio::time::Instant::now() + IDLE_TIMEOUT;
        let msg_result = match next {
            Some(result) => result,
            None => break,
        };

        let msg = match msg_result {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(data)) => {
                let _ = tx.send(Message::Pong(data)).await;
                continue;
            }
            Ok(_) => continue,
            Err(e) => {
                tlog!("[ws_server] Read error from {}: {}", peer, e);
                break;
            }
        };

        let request: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => {
                let err = json!({ "error": "invalid JSON" });
                let _ = tx.send(Message::Text(err.to_string())).await;
                continue;
            }
        };

        let id = request.get("_id").cloned();
        let method = match request.get("method").and_then(|v| v.as_str()) {
            Some(m) => m.to_string(),
            None => {
                let err = with_id(json!({ "error": "missing 'method' field" }), &id);
                let _ = tx.send(Message::Text(err.to_string())).await;
                continue;
            }
        };

        // A web page sends site requests for its own origin and nothing else.
        if let Client::Web(origin) = &client {
            if let Some(reply) = site_direct::handle(&state, conn_id, origin, &method, &request, out_tx.clone()) {
                if tx.send(Message::Text(reply.to_string())).await.is_err() {
                    break;
                }
            }
            continue;
        }

        // Sites ride only on a proven pairing of the 0xio extension; a legacy extension and every
        // program are refused, whatever else they may call.
        if is_site_method(&method) {
            let reply = match ws_sites::site_client(&client, &session, ext_client.as_deref()) {
                Err(r) => Some(site_relay::refusal_frame(r, &request)),
                Ok(client_id) => {
                    let client_id = client_id.to_string();
                    match method.as_str() {
                        "site_request" => site_relay::request(
                            &state,
                            conn_id,
                            &client_id,
                            ws_sites::browser_of(&client),
                            &request,
                            out_tx.clone(),
                        ),
                        "site_cancel" => Some(with_id(
                            site_relay::cancel(
                                &state,
                                conn_id,
                                &client_id,
                                site_relay::relayed_origin(&request).as_deref(),
                                &request,
                            ),
                            &id,
                        )),
                        "site_closed" => Some(with_id(site_relay::closed(&state, conn_id, &request), &id)),
                        "site_disconnect" => Some(with_id(site_relay::disconnect(&state, &client_id, &request), &id)),
                        "site_status" => Some(with_id(
                            match site_relay::relayed_origin(&request) {
                                Some(origin) => site_relay::status(&state, conn_id, &client_id, &origin, &request),
                                None => json!({ "v": 1, "error": ws_sites::BAD_ORIGIN.json() }),
                            },
                            &id,
                        )),
                        _ => Some(with_id(site_relay::subscribe(&state, conn_id, &client_id, None, out_tx.clone()), &id)),
                    }
                }
            };
            if let Some(reply) = reply {
                if tx.send(Message::Text(reply.to_string())).await.is_err() {
                    break;
                }
            }
            continue;
        }

        let allow_legacy = with_store(&state, |s| s.settings.allow_legacy);
        match ws_auth::access(&client, &session, allow_legacy, &method) {
            Access::Allow => session.record(&method),
            Access::Legacy => {
                if !legacy {
                    legacy = true;
                    tlog!(
                        "[ws_server] {} legacy session: {} without pairing (extension 3.0.3 or older)",
                        peer,
                        client.limit_key()
                    );
                }
            }
            Access::Pair => {
                // With legacy calls turned off, an extension from before pairing is refused here
                // and runs its proofs locally, as it does when the desktop is closed.
                let err = match client {
                    Client::Native => json!({
                        "error": "Pair first: send {\"method\":\"pair\",\"name\":\"<your app>\"} and approve it in 0xio Desktop",
                        "code": "PAIRING_REQUIRED"
                    }),
                    Client::Extension(_) | Client::Web(_) => json!({
                        "error": "Pair the 0xio extension with 0xio Desktop first. Update the extension if it cannot pair.",
                        "code": "AUTH_REQUIRED"
                    }),
                };
                let _ = tx.send(Message::Text(with_id(err, &id).to_string())).await;
                continue;
            }
        }

        if let Client::Extension(origin) = &client {
            match method.as_str() {
                "auth_hello" => {
                    let client_id = request.get("client_id").and_then(|v| v.as_str()).unwrap_or("");
                    let nonce = request.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
                    sweep_pairs(&state);
                    let reply = with_store(&state, |s| {
                        ws_auth::auth_hello(s, origin, client_id, nonce, ws_auth::random32())
                    });
                    let reply = match reply {
                        Ok((reply, c)) => {
                            challenge = c;
                            reply
                        }
                        Err(why) => json!({ "v": 1, "error": why, "code": "BAD_REQUEST" }),
                    };
                    if tx.send(Message::Text(with_id(reply, &id).to_string())).await.is_err() {
                        break;
                    }
                    continue;
                }
                "auth_prove" => {
                    let proof = request.get("proof").and_then(|v| v.as_str()).unwrap_or("");
                    let taken = challenge.take();
                    sweep_pairs(&state);
                    match with_store(&state, |s| ws_auth::auth_prove(s, origin, taken, proof)) {
                        Ok(client_id) => {
                            session.trusted = true;
                            touch_pair(&state, &client_id);
                            set_conn_key(&state, conn_id, &client_id);
                            tlog!("[ws_server] {} verified as paired extension {}", peer, &client_id[..8]);
                            ext_client = Some(client_id);
                            let mut ok = json!({ "v": 1, "ok": true });
                            crate::sites::site_lifecycle::advertise(&mut ok);
                            let ok = with_id(ok, &id);
                            if tx.send(Message::Text(ok.to_string())).await.is_err() {
                                break;
                            }
                            continue;
                        }
                        Err(why) => {
                            // One try per connection: a wrong proof ends it.
                            tlog!("[ws_server] {} failed the pairing proof: {}", peer, why);
                            let err = with_id(json!({ "v": 1, "error": why, "code": "AUTH_FAILED" }), &id);
                            let _ = tx.send(Message::Text(err.to_string())).await;
                            let _ = tx.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }
                "auth_pair" => {
                    let client_id = request.get("client_id").and_then(|v| v.as_str()).unwrap_or("");
                    let epk = request.get("epk").and_then(|v| v.as_str()).unwrap_or("");
                    let desktop_id = with_store(&state, |s| s.desktop_id.clone());
                    let reply = match ws_auth::start_extension_pairing(&desktop_id, origin, client_id, epk) {
                        Err(why) => json!({ "v": 1, "error": why, "code": "BAD_REQUEST" }),
                        Ok((epk_d, code, ext)) => {
                            let notice = json!({ "event": "pairing", "v": 1, "desktop_id": desktop_id, "epk": ws_auth::hex(&epk_d) });
                            let key = format!("ext:{}", client_id);
                            let opening = Opening { name: None, token: None, code: Some(code), extension: Some(ext), notice };
                            match pair_client(&state, &client, &key, opening, &mut tx, &mut rx).await {
                                Paired::Yes(_) => json!({ "v": 1, "paired": true, "desktop_id": desktop_id }),
                                Paired::No(why, code) => json!({ "v": 1, "error": why, "code": code }),
                                Paired::Closed => break,
                            }
                        }
                    };
                    if tx.send(Message::Text(with_id(reply, &id).to_string())).await.is_err() {
                        break;
                    }
                    continue;
                }
                _ => {}
            }
        }

        if method == "pair" {
            let reply = if session.trusted {
                json!({ "paired": true })
            } else {
                let name = request.get("name").and_then(|v| v.as_str());
                let token = request.get("token").and_then(|v| v.as_str());
                let opening = Opening {
                    name: name.map(str::to_string),
                    token: token.map(str::to_string),
                    code: None,
                    extension: None,
                    notice: json!({}),
                };
                match pair_client(&state, &client, &pair_key, opening, &mut tx, &mut rx).await {
                    Paired::Yes(entry) => {
                        session.trusted = true;
                        let mut reply = json!({ "paired": true });
                        if let Some((entry, token)) = entry {
                            set_conn_key(&state, conn_id, &entry.id);
                            touch_pair(&state, &entry.id);
                            reply["site"] = json!(entry.site_origin());
                            if let Some(token) = token {
                                reply["token"] = json!(token);
                            }
                            native = Some(entry);
                        }
                        reply
                    }
                    Paired::No(why, code) => json!({ "error": why, "code": code }),
                    Paired::Closed => break,
                }
            };
            if tx.send(Message::Text(with_id(reply, &id).to_string())).await.is_err() {
                break;
            }
            continue;
        }
        if method == "pair" || method.starts_with("auth_") {
            let err = with_id(json!({ "error": "Not for this client", "code": "BAD_REQUEST" }), &id);
            let _ = tx.send(Message::Text(err.to_string())).await;
            continue;
        }

        let req_t0 = std::time::Instant::now();
        let tag = if legacy && !session.trusted { " legacy" } else { "" };
        tlog!("[ws_server] {}{} -> method={} (msg={}B)", peer, tag, method, msg.len());

        let response = if method == "wallet_rpc" {
            let site = match &client {
                Client::Extension(o) => ext_client.as_ref().map(|_| o.clone()),
                Client::Native => native.as_ref().map(PairedNative::site_origin),
                Client::Web(_) => None,
            };
            match site {
                _ if !rpc_limit.hit("rpc", Instant::now()) => {
                    json!({ "error": "Too many requests. Slow down.", "code": "RATE_LIMITED" })
                }
                Some(site) => handle_wallet_rpc(&state, &request, &site).await,
                None => json!({ "error": "Pair first", "code": "PAIRING_REQUIRED" }),
            }
        } else if method == "init" && !session.trusted && held_by_paired(&state, conn_id) {
            json!({ "error": "0xio Desktop is in use by a paired extension", "code": "BUSY" })
        } else {
            let state_clone = state.clone();
            let request_clone = request.clone();
            let method_clone = method.clone();
            let bound = conn_ctx.clone();

            let r = tokio::task::spawn_blocking(move || {
                handle_request(&state_clone, &method_clone, &request_clone, bound.as_deref())
            })
            .await
            .unwrap_or_else(|e| json!({ "error": format!("task panicked: {}", e) }));
            if method == "init" {
                if let Some(fp) = r.get("ctx").and_then(|v| v.as_str()) {
                    conn_ctx = Some(fp.to_string());
                    *lock(&state.ws_ctx_conn) = Some(conn_id);
                }
            }
            r
        };

        let response = with_id(response, &id);
        let response_str = response.to_string();
        let has_error = response.get("error").is_some();
        tlog!(
            "[ws_server] {}{} <- method={} {}({}B) in {}ms",
            peer,
            tag,
            method,
            if has_error { "ERROR " } else { "" },
            response_str.len(),
            req_t0.elapsed().as_millis()
        );

        if tx.send(Message::Text(response_str)).await.is_err() {
            break;
        }
    }

    lock(&state.ws_conns).remove(&conn_id);
    site_relay::connection_closed(&state, conn_id);
    if counted {
        state.client_disconnected();
    }
    // Bind the bridge key-context to an active connection: with no client left, wipe ws_ctx so a
    // later loopback connection can't reuse the decrypt/proof oracle without sending its own seed.
    // The extension re-sends `init` on every connect, so this is transparent to normal use.
    if state.connected_clients() == 0 {
        match state.ws_ctx.lock() {
            Ok(mut guard) => guard.clear(),
            Err(e) => e.into_inner().clear(),
        }
    }
    tlog!("[ws_server] Client disconnected: {} (remaining: {})", peer, state.connected_clients());
}

fn origin_header(head: &str) -> Option<&str> {
    head.split("\r\n").skip(1).take_while(|l| !l.is_empty()).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("origin").then(|| value.trim())
    })
}

/// Whether a connection gets the web page message limit: any Origin but the extension's
/// schemes. The handshake then refuses a web page that was not sized as one, so a header the
/// two reads disagree on cannot get a web page the larger limit.
fn sized_for_web(head: &str) -> bool {
    origin_header(head).is_some_and(|o| {
        let o = o.to_ascii_lowercase();
        !o.starts_with("chrome-extension://") && !o.starts_with("moz-extension://")
    })
}

fn ws_config(web: bool) -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    let max = if web { WEB_MAX_MESSAGE } else { PAIRED_MAX_MESSAGE };
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(max);
    config.max_frame_size = Some(max);
    config
}

async fn open_client(
    state: &Arc<AppState>,
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
) -> Option<(WsStream, Client, CapGuard)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // The extension probes with a plain `fetch('http://127.0.0.1:19345/')` before it opens a
    // WebSocket.
    let mut buf = [0u8; 8192];
    let mut stream = stream;
    // Firefox splits the handshake across packets, so peek until the head is complete.
    let mut n = 0usize;
    for _ in 0..400 {
        n = stream.peek(&mut buf).await.ok()?;
        if n == 0 || n >= buf.len() || buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let header = String::from_utf8_lossy(&buf[..n]).into_owned();

    // A preflight (Private Network Access, from browsers that still send one before a public page
    // reaches this machine): allowed, so the browser goes on to its own permission check. It
    // grants nothing; the handshake still decides who may connect.
    if header.starts_with("OPTIONS ") {
        let mut discard = vec![0u8; n];
        let _ = stream.read(&mut discard).await;
        let _ = stream.write_all(preflight_response().as_bytes()).await;
        tlog!("[ws_server] HTTP preflight from {} answered", peer);
        return None;
    }

    if header.starts_with("GET ") && !header.to_ascii_lowercase().contains("upgrade: websocket") {
        let mut discard = vec![0u8; n];
        let _ = stream.read(&mut discard).await;
        let body = r#"{"ok":true,"app":"0xio-desktop"}"#;
        // CORP lets the extension's probe through its popup's COEP require-corp.
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\nCross-Origin-Resource-Policy: cross-origin\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        let _ = stream.write_all(response.as_bytes()).await;
        tlog!("[ws_server] HTTP health probe from {} answered 200", peer);
        return None;
    }

    // Who the handshake comes from, by its Origin header (CSWSH protection).
    let web = WebPolicy {
        allowed: with_store(state, |s| s.settings.direct_sites),
        dev: ws_sites::dev_build(),
    };
    let web_sized = sized_for_web(&header);
    let mut admitted: Option<(Client, CapGuard)> = None;
    let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = match req.headers().get("origin") {
            None => None,
            Some(v) => match v.to_str() {
                Ok(s) => Some(s),
                Err(_) => return Err(refusal(StatusCode::FORBIDDEN, "malformed origin")),
            },
        };
        let client = match ws_auth::classify(origin, web) {
            Ok(c) => c,
            Err(why) => {
                tlog!("[ws_server] Refused handshake from {} ({}): {:?}", peer, why, origin);
                return Err(refusal(StatusCode::FORBIDDEN, why));
            }
        };
        if matches!(client, Client::Web(_)) && !web_sized {
            tlog!("[ws_server] Refused handshake from {}: origin read differently", peer);
            return Err(refusal(StatusCode::FORBIDDEN, "malformed origin"));
        }
        if !lock(&state.ws_limits).allow(&client, Instant::now()) {
            tlog!("[ws_server] Handshake limit reached for {}", client.limit_key());
            return Err(refusal(StatusCode::TOO_MANY_REQUESTS, "too many connections"));
        }
        if ACCEPTED.load(Ordering::SeqCst) >= MAX_CONNECTIONS || !lock(&state.ws_caps).admit(&client) {
            tlog!("[ws_server] Connection cap reached for {}", client.limit_key());
            return Err(refusal(StatusCode::SERVICE_UNAVAILABLE, "too many open connections"));
        }
        let cap = CapGuard { state: state.clone(), client: client.clone() };
        admitted = Some((client, cap));
        Ok(response)
    };

    let accepted = tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config(web_sized))).await;
    match accepted {
        Ok(ws) => admitted.map(|(client, cap)| (ws, client, cap)),
        Err(e) => {
            tlog!("[ws_server] WebSocket handshake failed from {}: {}", peer, e);
            None
        }
    }
}

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

struct CapGuard {
    state: Arc<AppState>,
    client: Client,
}

impl Drop for CapGuard {
    fn drop(&mut self) {
        lock(&self.state.ws_caps).release(&self.client);
    }
}

fn preflight_response() -> &'static str {
    concat!(
        "HTTP/1.1 204 No Content\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Allow-Methods: GET, OPTIONS\r\n",
        "Access-Control-Allow-Headers: *\r\n",
        "Access-Control-Allow-Private-Network: true\r\n",
        "Access-Control-Max-Age: 600\r\n",
        "Cross-Origin-Resource-Policy: cross-origin\r\n",
        "Content-Length: 0\r\n",
        "Connection: close\r\n\r\n"
    )
}

const SITE_METHODS: &[&str] =
    &["site_request", "site_cancel", "site_closed", "site_disconnect", "site_status", "sites_subscribe"];

fn is_site_method(method: &str) -> bool {
    SITE_METHODS.contains(&method)
}

fn set_conn_key(state: &AppState, conn_id: u64, key: &str) {
    if let Some(entry) = lock(&state.ws_conns).get_mut(&conn_id) {
        entry.0 = Some(key.to_string());
    }
}

fn held_by_paired(state: &AppState, conn_id: u64) -> bool {
    let Some(owner) = *lock(&state.ws_ctx_conn) else {
        return false;
    };
    owner != conn_id && lock(&state.ws_conns).get(&owner).is_some_and(|(key, _)| key.is_some())
}

fn close_client(state: &AppState, key: &str) -> usize {
    let conns = lock(&state.ws_conns);
    let mut closed = 0;
    for (client, kill) in conns.values() {
        if client.as_deref() == Some(key) {
            kill.notify_one();
            closed += 1;
        }
    }
    closed
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn refusal(status: StatusCode, why: &str) -> ErrorResponse {
    tokio_tungstenite::tungstenite::http::Response::builder()
        .status(status)
        .body(Some(why.to_string()))
        .unwrap_or_else(|_| ErrorResponse::new(Some(why.to_string())))
}

fn with_id(mut v: Value, id: &Option<Value>) -> Value {
    if let (Some(id), Some(obj)) = (id, v.as_object_mut()) {
        obj.insert("_id".to_string(), id.clone());
    }
    v
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn pairs_path(state: &AppState) -> Option<PathBuf> {
    let dir = state.app_handle.get()?.path().app_data_dir().ok()?;
    Some(dir.join("ws_pairings.json"))
}

fn unreadable_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".unreadable-{}", now_secs()));
    path.with_file_name(name)
}

fn read_pairs(path: &Path) -> PairStore {
    let Ok(bytes) = std::fs::read(path) else {
        return PairStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        let aside = unreadable_path(path);
        let kept = std::fs::rename(path, &aside).is_ok();
        tlog!("[ws_server] pairings file did not parse ({}), set aside: {}", e, kept);
        PairStore::default()
    })
}

fn with_store<T>(state: &AppState, f: impl FnOnce(&mut PairStore) -> T) -> T {
    let mut guard = lock(&state.ws_pairs);
    if guard.is_none() {
        let mut store = pairs_path(state).map(|p| read_pairs(&p)).unwrap_or_default();
        if store.ensure_id() {
            save_store(state, &store);
        }
        *guard = Some(store);
    }
    f(guard.as_mut().expect("store loaded above"))
}

fn sweep_pairs(state: &AppState) {
    let gone = with_store(state, |s| {
        let gone = s.sweep(now_secs());
        if !gone.is_empty() {
            save_store(state, s);
        }
        gone
    });
    for key in gone {
        site_relay::forget_client(state, &key);
        let closed = close_client(state, &key);
        tlog!("[ws_server] Forgot unused pairing {} ({} connection(s) closed)", key, closed);
    }
}

fn touch_pair(state: &AppState, key: &str) {
    with_store(state, |s| {
        if s.touch(key, now_secs()) {
            save_store(state, s);
        }
    });
}

fn save_store(state: &AppState, store: &PairStore) {
    let Some(path) = pairs_path(state) else { return };
    let Ok(bytes) = serde_json::to_vec_pretty(store) else { return };
    let _ = crate::system::atomic_file::write(&path, &bytes);
}

fn pending_json(p: &PendingPair) -> Value {
    let (kind, origin) = match &p.client {
        Client::Extension(o) if o.starts_with("moz-extension://") => ("firefox", Some(o.clone())),
        Client::Extension(o) => ("extension", Some(o.clone())),
        _ => ("app", None),
    };
    json!({ "id": p.id, "name": p.name, "code": p.code, "kind": kind, "origin": origin })
}

fn emit(state: &AppState, event: &str, payload: Value) {
    if let Some(handle) = state.app_handle.get() {
        let _ = handle.emit(event, payload);
    }
}

enum Paired {
    Yes(Option<(PairedNative, Option<String>)>),
    No(&'static str, &'static str),
    Closed,
}

type WsTx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Message,
>;
type WsRx = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>;

struct Opening {
    name: Option<String>,
    token: Option<String>,
    code: Option<String>,
    extension: Option<ws_auth::ExtensionPairing>,
    notice: Value,
}

async fn pair_client(
    state: &Arc<AppState>,
    client: &Client,
    key: &str,
    opening: Opening,
    tx: &mut WsTx,
    rx: &mut WsRx,
) -> Paired {
    sweep_pairs(state);
    let store = with_store(state, |s| s.clone());
    // A review that closed a moment ago holds the next one back (a retry from the extension waits
    // it out); only one waits at a time per connection, and never longer than the gap.
    let mut start = lock(&state.ws_pairing).start(&store, client, key, opening.token.as_deref(), Instant::now());
    if let PairStart::Later(wait) = start {
        tokio::time::sleep(wait.min(ws_auth::PAIR_GAP)).await;
        start = lock(&state.ws_pairing).start(&store, client, key, opening.token.as_deref(), Instant::now());
    }
    let now = Instant::now();
    let keyed = opening.extension.is_some();
    let install = opening.extension.as_ref().map(|e| e.client_id.clone());
    let (wtx, mut waiter) = oneshot::channel::<PairOutcome>();
    let (review_id, code) = match start {
        PairStart::Paired(entry) => return Paired::Yes(entry.map(|e| (e, None))),
        PairStart::Refused(why) => return Paired::No(why, "PAIRING_REFUSED"),
        PairStart::Later(_) => return Paired::No("Too many pairing requests. Try again.", "PAIRING_REFUSED"),
        PairStart::Join(id) => {
            let mut pairing = lock(&state.ws_pairing);
            let Some(p) = pairing.pending.get_mut(&id) else {
                return Paired::No("Pairing ended. Try again.", "PAIRING_REFUSED");
            };
            p.waiters.push(wtx);
            (id, p.code.clone())
        }
        PairStart::Review => {
            let pending = PendingPair {
                id: crate::system::uuid::new_v4(),
                key: key.to_string(),
                client: client.clone(),
                name: ws_auth::clean_name(opening.name.as_deref(), client),
                code: opening.code.clone().unwrap_or_else(ws_auth::pairing_code),
                created: now,
                extension: opening.extension,
                waiters: vec![wtx],
                desktop_ok: false,
                ext_ok: false,
            };
            let (id, code, payload) = (pending.id.clone(), pending.code.clone(), pending_json(&pending));
            lock(&state.ws_pairing).pending.insert(id.clone(), pending);
            tlog!("[ws_server] Pairing review opened for {}", key);
            emit(state, "ws-pair-request", payload);
            let st = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ws_auth::PAIR_TIMEOUT).await;
                let gone = lock(&st.ws_pairing).expire(Instant::now());
                for id in gone {
                    emit(&st, "ws-pair-resolved", json!({ "id": id, "outcome": "expired" }));
                }
            });
            (id, code)
        }
    };
    // A program is told the code to show; the extension works out the same code from the key
    // exchange itself, so it only gets the desktop's public key.
    let notice = if keyed {
        opening.notice
    } else {
        json!({ "event": "pairing", "code": code })
    };
    let _ = tx.send(Message::Text(notice.to_string())).await;

    loop {
        tokio::select! {
            outcome = &mut waiter => {
                return match outcome {
                    Ok(PairOutcome::Approved(entry)) => Paired::Yes(entry.map(|(e, t)| (e, Some(t)))),
                    Ok(PairOutcome::Refused) => Paired::No("Pairing refused in 0xio Desktop", "PAIRING_REFUSED"),
                    Ok(PairOutcome::Cancelled) => Paired::No("Pairing cancelled", "PAIRING_CANCELLED"),
                    Ok(PairOutcome::Expired) | Err(_) => Paired::No("Pairing timed out", "PAIRING_TIMEOUT"),
                };
            }
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let v = serde_json::from_str::<Value>(&text).ok();
                    if let (Some(v), Some(install)) = (v.as_ref(), install.as_deref()) {
                        if extension_answer(state, &review_id, install, v) {
                            continue;
                        }
                    }
                    let id = v.and_then(|v| v.get("_id").cloned());
                    let err = with_id(json!({ "error": "Waiting for pairing", "code": "PAIRING_PENDING" }), &id);
                    let _ = tx.send(Message::Text(err.to_string())).await;
                }
                Some(Ok(Message::Ping(data))) => {
                    let _ = tx.send(Message::Pong(data)).await;
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                    // A review ends with its connection: only that connection could take the result.
                    if lock(&state.ws_pairing).take(&review_id, Instant::now()).is_some() {
                        emit(state, "ws-pair-resolved", json!({ "id": review_id, "outcome": "closed" }));
                    }
                    return Paired::Closed;
                }
                Some(Ok(_)) => {}
            },
        }
    }
}

/// Only the install this review exchanged keys with counts.
fn extension_answer(state: &AppState, review_id: &str, install: &str, v: &Value) -> bool {
    let kind = v.get("type").or_else(|| v.get("method")).and_then(Value::as_str);
    let Some(kind) = kind.filter(|k| *k == ws_auth::PAIR_CONFIRM || *k == ws_auth::PAIR_CANCEL) else {
        return false;
    };
    let client_id = v.get("client_id").and_then(Value::as_str).unwrap_or("");
    if v.get("v").and_then(Value::as_u64) != Some(1) || client_id != install {
        tlog!("[ws_server] Ignored a pairing {} that is not this review's", kind);
        return true;
    }
    let now = Instant::now();
    if kind == ws_auth::PAIR_CANCEL {
        let ended = lock(&state.ws_pairing).cancel(review_id, client_id, now);
        if let Some(p) = ended {
            settle(state, p, PairOutcome::Cancelled);
        }
        return true;
    }
    match lock(&state.ws_pairing).confirm(review_id, client_id, now) {
        Confirm::Done(p) => {
            let outcome = keep(state, &p);
            settle(state, p, outcome);
        }
        Confirm::Held => tlog!("[ws_server] Pairing confirmed by the extension, waiting for Pair"),
        Confirm::Ignored => {}
    }
    true
}

fn keep(state: &AppState, pending: &PendingPair) -> PairOutcome {
    match &pending.client {
        Client::Extension(_) => match &pending.extension {
            Some(ext) => {
                with_store(state, |s| {
                    s.add_extension(&ext.client_id, &ext.origin, &pending.name, &ext.secret, now_secs());
                    save_store(state, s);
                });
                PairOutcome::Approved(None)
            }
            None => PairOutcome::Refused,
        },
        Client::Web(_) => PairOutcome::Refused,
        Client::Native => {
            let token = ws_auth::new_token();
            let entry = with_store(state, |s| {
                let e = s.add_native(&pending.name, &token, now_secs());
                save_store(state, s);
                e
            });
            PairOutcome::Approved(Some((entry, token)))
        }
    }
}

fn settle(state: &AppState, pending: PendingPair, outcome: PairOutcome) {
    let word = match outcome {
        PairOutcome::Approved(_) => "paired",
        PairOutcome::Refused => "refused",
        PairOutcome::Expired => "expired",
        PairOutcome::Cancelled => "cancelled",
    };
    tlog!("[ws_server] Pairing {} for {}", word, pending.key);
    for w in pending.waiters {
        let _ = w.send(outcome.clone());
    }
    emit(state, "ws-pair-resolved", json!({ "id": pending.id, "outcome": word }));
}

#[tauri::command]
pub fn ws_pair_pending(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<Vec<Value>, String> {
    require_main(&webview)?;
    let mut pairing = lock(&state.ws_pairing);
    pairing.expire(Instant::now());
    let mut list: Vec<&PendingPair> = pairing.pending.values().collect();
    list.sort_by_key(|p| p.created);
    Ok(list.into_iter().map(pending_json).collect())
}

/// "waiting" while an extension has not confirmed the code yet: nothing is kept until it does.
#[tauri::command]
pub fn ws_pair_respond(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    id: String,
    approve: bool,
) -> Result<&'static str, String> {
    require_main(&webview)?;
    respond_pair(&state, &id, approve)
}

fn respond_pair(state: &AppState, id: &str, approve: bool) -> Result<&'static str, String> {
    const ENDED: &str = "This pairing request has ended";
    let now = Instant::now();
    if !approve {
        let pending = {
            let mut pairing = lock(&state.ws_pairing);
            let pending = pairing.take(id, now).ok_or(ENDED)?;
            pairing.refuse(&pending.key, now);
            pending
        };
        settle(state, pending, PairOutcome::Refused);
        return Ok("refused");
    }
    let approved = lock(&state.ws_pairing).approve(id, now).ok_or(ENDED)?;
    match approved {
        Approve::Waiting => {
            tlog!("[ws_server] Pair pressed, waiting for the extension to confirm");
            Ok("waiting")
        }
        Approve::Done(pending) => {
            let outcome = keep(state, &pending);
            settle(state, pending, outcome);
            Ok("paired")
        }
    }
}

fn paired_json(store: &PairStore) -> Vec<Value> {
    let origins = store.extensions.iter().map(|e| {
        json!({
            "key": e.client_id,
            "name": e.name,
            "origin": e.origin,
            "paired_at": e.paired_at,
            "last_used": e.last_used(),
        })
    });
    let natives = store.natives.iter().map(|n| {
        json!({
            "key": n.id,
            "name": n.name,
            "origin": n.site_origin(),
            "paired_at": n.paired_at,
            "last_used": n.last_used(),
        })
    });
    origins.chain(natives).collect()
}

pub fn notify_sites_on(state: &AppState) -> bool {
    with_store(state, |s| s.settings.notify_sites)
}

#[tauri::command]
pub fn ws_paired_list(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<Vec<Value>, String> {
    require_main(&webview)?;
    sweep_pairs(&state);
    Ok(with_store(&state, |s| paired_json(s)))
}

#[tauri::command]
pub fn ws_pair_settings(webview: Webview, state: State<'_, Arc<AppState>>) -> Result<PairSettings, String> {
    require_main(&webview)?;
    Ok(with_store(&state, |s| s.settings))
}

#[tauri::command]
pub fn ws_pair_set_settings(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    allow_legacy: Option<bool>,
    forget_after_days: Option<u32>,
    notify_sites: Option<bool>,
    direct_sites: Option<bool>,
) -> Result<PairSettings, String> {
    require_main(&webview)?;
    if forget_after_days.is_some_and(|d| !ws_auth::FORGET_CHOICES.contains(&d)) {
        return Err("Pick 7, 30 or 90 days, or never".into());
    }
    let settings = with_store(&state, |s| {
        if let Some(on) = allow_legacy {
            s.settings.allow_legacy = on;
        }
        if let Some(days) = forget_after_days {
            s.settings.forget_after_days = days;
        }
        if let Some(on) = notify_sites {
            s.settings.notify_sites = on;
        }
        if let Some(on) = direct_sites {
            s.settings.direct_sites = on;
        }
        save_store(&state, s);
        s.settings
    });
    tlog!(
        "[ws_server] Settings: legacy extensions {}, forget unused pairings after {}, site notifications {}, websites {}",
        if settings.allow_legacy { "allowed" } else { "refused" },
        match settings.forget_after_days {
            0 => "never".to_string(),
            d => format!("{} days", d),
        },
        if settings.notify_sites { "on" } else { "off" },
        if settings.direct_sites { "allowed" } else { "refused" }
    );
    if !settings.notify_sites {
        crate::sites::site_relay::clear_notices(&state);
    }
    if !settings.direct_sites {
        let closed = close_client(&state, ws_sites::DIRECT);
        if closed > 0 {
            tlog!("[ws_server] Websites turned off ({} page(s) closed)", closed);
        }
    }
    sweep_pairs(&state);
    Ok(settings)
}

#[tauri::command]
pub fn ws_pair_forget(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Vec<Value>, String> {
    require_main(&webview)?;
    Ok(forget_pair(&state, &key))
}

fn forget_pair(state: &AppState, key: &str) -> Vec<Value> {
    if key == ws_sites::DIRECT {
        return with_store(state, |s| paired_json(s));
    }
    site_relay::forget_client(state, key);
    let list = with_store(state, |s| {
        if s.forget(key) {
            save_store(state, s);
        }
        paired_json(s)
    });
    let closed = close_client(state, key);
    tlog!("[ws_server] Removed paired client {} ({} connection(s) closed)", key, closed);
    list
}

fn ctx_free(method: &str) -> bool {
    matches!(method, "pedersenCommit" | "diagnoseCipher" | "aesKat" | "ping")
}

/// A connection may only use the bridge context it initialized itself.
fn check_bound(slot: &PvacSlot, bound: Option<&str>, msg: &Value) -> Result<(), String> {
    if slot.ctx.is_none() {
        return Ok(());
    }
    let fp = slot.fp.as_deref();
    if bound.is_none() || fp != bound {
        return Err("PVAC context belongs to another connection. Call init again.".into());
    }
    if let Some(requested) = msg.get("ctx").and_then(|v| v.as_str()) {
        if Some(requested) != fp {
            return Err("PVAC context mismatch. Call init again.".into());
        }
    }
    Ok(())
}

fn handle_request(state: &AppState, method: &str, msg: &Value, bound: Option<&str>) -> Value {
    match method {
        "init" => {
            // `master` (sha256-labeled wallet key) keeps the signing key out of this process;
            // `seed` is the raw key sent by extensions before 2.5.6.
            let (field, is_master) = if msg.get("master").is_some() {
                ("master", true)
            } else {
                ("seed", false)
            };
            let arr = match msg.get(field).and_then(|v| v.as_array()) {
                Some(arr) => arr,
                None => return json!({ "error": format!("{} must be an array of bytes", field) }),
            };
            if arr.len() < 32 {
                return json!({ "error": format!("{} must be at least 32 bytes", field) });
            }
            let mut key = [0u8; 32];
            for (i, v) in arr.iter().take(32).enumerate() {
                match v.as_u64() {
                    Some(n) if n <= 255 => key[i] = n as u8,
                    _ => {
                        return json!({ "error": format!("{}[{}] must be a number 0-255", field, i) })
                    }
                }
            }
            use zeroize::Zeroize;
            let mut master = if is_master {
                key
            } else {
                pvac_rs::crypto::keygen::master_seed(&key)
            };
            key.zeroize();
            let fp = context_fingerprint(&master);
            let (ctx, ms) = pvac_handler::Context::from_master(&master);
            master.zeroize();
            // The extension's pubkeyHashPrefix recipe.
            let pubkey_fp = {
                use sha2::{Digest, Sha256};
                let pk_bytes = pvac_rs::serialize::format::serialize_pubkey(&ctx.pk);
                let digest = Sha256::digest(&pk_bytes);
                digest[..8].iter().map(|b| format!("{:02x}", b)).collect::<String>()
            };
            let num_threads = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            // The bridge context, never the standalone one.
            match state.ws_ctx.lock() {
                Ok(mut guard) => guard.set(fp.clone(), ctx),
                Err(e) => e.into_inner().set(fp.clone(), ctx),
            }
            tlog!(
                "[ws_server] init done in {}ms (threads={}, from={})",
                ms,
                num_threads,
                field
            );
            json!({ "ready": true, "init_ms": ms, "threads": num_threads, "pubkey_fp": pubkey_fp, "ctx": fp })
        }

        "destroy" => {
            let mut guard = match state.ws_ctx.lock() {
                Ok(guard) => guard,
                Err(e) => e.into_inner(),
            };
            if check_bound(&guard, bound, msg).is_ok() {
                guard.clear();
                tlog!("[ws_server] bridge context destroyed");
            }
            json!({ "ok": true })
        }

        "ping" => {
            json!({ "pong": true, "version": env!("CARGO_PKG_VERSION") })
        }

        "makeRangeProof"
        | "makeParallelRangeProofs"
        | "makeBoundProof"
        | "makeBoundKeySwitchProof"
        | "makeBoundKeySwitchProofWithPubkey"
        | "makeBoundRangeProof"
        | "proveAmount"
        | "makeKeyOwnerProof"
        | "buildCipherProofMigration" => {
            state.begin_ext_compute();
            let result = {
                let ctx_guard = match state.ws_ctx.lock() {
                    Ok(guard) => guard,
                    Err(e) => e.into_inner(),
                };
                match check_bound(&ctx_guard, bound, msg) {
                    Ok(()) => {
                        let ctx = &ctx_guard.ctx;
                        crate::pvac::proof_pool::install(|| pvac_handler::dispatch(ctx, method, msg))
                    }
                    Err(e) => json!({ "error": e }),
                }
            };
            state.end_ext_compute();
            result
        }

        _ => {
            let ctx_guard = match state.ws_ctx.lock() {
                Ok(guard) => guard,
                Err(e) => e.into_inner(),
            };
            if !ctx_free(method) {
                if let Err(e) = check_bound(&ctx_guard, bound, msg) {
                    return json!({ "error": e });
                }
            }
            let ctx = &ctx_guard.ctx;
            crate::pvac::proof_pool::install(|| pvac_handler::dispatch(ctx, method, msg))
        }
    }
}

const WALLET_RPC_TIMEOUT: Duration = Duration::from_secs(120);

async fn handle_wallet_rpc(state: &AppState, msg: &Value, origin: &str) -> Value {
    let sdk_request = msg.get("request").cloned().unwrap_or(json!({}));

    let rpc_id = format!("wrpc-{}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis(),
        rand_id()
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();

    {
        let mut pending = match state.pending_wallet_rpc.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        pending.insert(rpc_id.clone(), tx);
    }

    // The site is who the handshake proved, never what the request says.
    let payload = json!({
        "rpc_id": rpc_id,
        "request": sdk_request,
        "origin": origin
    });

    if let Some(handle) = state.app_handle.get() {
        if let Err(e) = handle.emit("wallet-rpc-request", payload.to_string()) {
            tlog!("[ws_server] Failed to emit wallet-rpc-request: {}", e);
            if let Ok(mut pending) = state.pending_wallet_rpc.lock() {
                pending.remove(&rpc_id);
            }
            return json!({ "error": "Failed to forward request to wallet" });
        }
    } else {
        if let Ok(mut pending) = state.pending_wallet_rpc.lock() {
            pending.remove(&rpc_id);
        }
        return json!({ "error": "Desktop wallet not ready" });
    }

    match timeout(WALLET_RPC_TIMEOUT, rx).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => json!({ "error": "Wallet RPC channel closed" }),
        Err(_) => {
            if let Ok(mut pending) = state.pending_wallet_rpc.lock() {
                pending.remove(&rpc_id);
            }
            json!({ "error": "Wallet RPC timeout" })
        }
    }
}

fn rand_id() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::thread::current().id().hash(&mut h);
    std::time::Instant::now().hash(&mut h);
    h.finish() as u32
}

#[cfg(test)]
#[path = "ws_server_pairing_tests.rs"]
mod pairing_tests;

#[cfg(test)]
#[path = "ws_server_conformance.rs"]
mod conformance;

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENT: &str = "fedcba9876543210fedcba9876543210";

    #[test]
    fn an_unparsable_pairings_file_is_set_aside_not_overwritten() {
        let dir = crate::system::atomic_file::scratch_dir("pairs");
        let path = dir.join("ws_pairings.json");
        assert!(read_pairs(&path).extensions.is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        std::fs::write(&path, b"{\"desktop_id\":").unwrap();
        let store = read_pairs(&path);
        assert!(store.desktop_id.is_empty() && store.extensions.is_empty());
        assert!(!path.exists());
        let kept: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(kept.len(), 1);
        assert!(kept[0].file_name().unwrap().to_str().unwrap().starts_with("ws_pairings.json.unreadable-"));
        assert_eq!(std::fs::read(&kept[0]).unwrap(), b"{\"desktop_id\":");

        let good = PairStore { desktop_id: "d1".into(), ..Default::default() };
        std::fs::write(&path, serde_json::to_vec(&good).unwrap()).unwrap();
        assert_eq!(read_pairs(&path).desktop_id, "d1");
        assert!(path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn open(state: &AppState, id: u64) -> Arc<tokio::sync::Notify> {
        let kill = Arc::new(tokio::sync::Notify::new());
        lock(&state.ws_conns).insert(id, (None, kill.clone()));
        kill
    }

    async fn closed(kill: &tokio::sync::Notify) -> bool {
        tokio::time::timeout(Duration::from_millis(20), kill.notified()).await.is_ok()
    }

    #[tokio::test]
    async fn removing_a_paired_client_closes_only_its_connections() {
        let state = AppState::new();
        let ext_a = open(&state, 1);
        let ext_b = open(&state, 2);
        let program = open(&state, 3);
        let unpaired = open(&state, 4);
        set_conn_key(&state, 1, CLIENT);
        set_conn_key(&state, 2, CLIENT);
        let entry = PairStore::default().add_native("bot", &ws_auth::new_token(), 0);
        set_conn_key(&state, 3, &entry.id);

        assert_eq!(close_client(&state, CLIENT), 2);
        assert!(closed(&ext_a).await);
        assert!(closed(&ext_b).await);
        assert!(!closed(&program).await);
        assert!(!closed(&unpaired).await);

        assert_eq!(close_client(&state, &entry.id), 1);
        assert!(closed(&program).await);
        assert!(!closed(&unpaired).await);
        assert_eq!(close_client(&state, "missing"), 0);
    }

    #[test]
    fn a_legacy_init_cannot_take_the_context_of_an_open_paired_connection() {
        let state = AppState::new();
        open(&state, 1);
        open(&state, 2);
        assert!(!held_by_paired(&state, 2));
        *lock(&state.ws_ctx_conn) = Some(1);
        assert!(!held_by_paired(&state, 2));
        set_conn_key(&state, 1, CLIENT);
        assert!(held_by_paired(&state, 2));
        assert!(!held_by_paired(&state, 1));
        lock(&state.ws_conns).remove(&1);
        assert!(!held_by_paired(&state, 2));
    }

    mod relay {
        use super::*;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        const CHROME: &str = "chrome-extension://anknhjilldkeelailocijnfibefmepcc";
        const SECRET: [u8; 32] = [7u8; 32];
        const ADDR: &str = "octBs4zPq8xHk2mN7vR3tY6uJ9wE1aS5dF8gH4jK1bN4hTQ9";

        type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

        fn hex32(n: u8) -> String {
            format!("{:032x}", n)
        }

        fn paired_state() -> Arc<AppState> {
            let state = AppState::new();
            let mut store = PairStore::default();
            store.ensure_id();
            store.add_extension(CLIENT, CHROME, "0xio extension", &SECRET, now_secs());
            *lock(&state.ws_pairs) = Some(store);
            *lock(&state.ws_sites) = Some(ws_sites::SiteStore::default());
            state
        }

        async fn serve(state: Arc<AppState>) -> SocketAddr {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                while let Ok((stream, peer)) = listener.accept().await {
                    tokio::spawn(handle_client(state.clone(), stream, peer));
                }
            });
            addr
        }

        async fn open_ws(addr: SocketAddr, origin: Option<&str>) -> Ws {
            let mut req = format!("ws://{addr}/").into_client_request().unwrap();
            if let Some(o) = origin {
                req.headers_mut().insert("Origin", o.parse().unwrap());
            }
            tokio_tungstenite::connect_async(req).await.unwrap().0
        }

        async fn send(ws: &mut Ws, v: Value) {
            ws.send(Message::Text(v.to_string())).await.unwrap();
        }

        async fn next(ws: &mut Ws) -> Option<Value> {
            loop {
                match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
                    Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(&t).ok(),
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
                    Ok(Some(Ok(_))) => continue,
                }
            }
        }

        async fn prove(ws: &mut Ws, state: &AppState) -> Value {
            let ne = [3u8; 32];
            send(ws, json!({ "_id": 1, "method": "auth_hello", "v": 1, "client_id": CLIENT, "nonce": ws_auth::hex(&ne) })).await;
            let hello = next(ws).await.unwrap();
            let nd = ws_auth::unhex::<32>(hello["nonce"].as_str().unwrap()).unwrap();
            let desktop_id = with_store(state, |s| s.desktop_id.clone());
            let proof = ws_auth::auth_proof(&SECRET, ws_auth::Role::Extension, CLIENT, &desktop_id, &ne, &nd);
            send(ws, json!({ "_id": 2, "method": "auth_prove", "v": 1, "proof": ws_auth::hex(&proof) })).await;
            let reply = next(ws).await.unwrap();
            assert_eq!(reply["ok"], true);
            reply
        }

        #[tokio::test]
        async fn a_proven_extension_learns_the_wallet_protocol() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ext = open_ws(addr, Some(CHROME)).await;
            let reply = prove(&mut ext, &state).await;
            assert_eq!(reply["_id"], 2);
            assert_eq!(reply["v"], 1);
            assert_eq!(reply["protocol"], 2);
            assert_eq!(reply["kind"], "desktop");
            assert_eq!(reply["capabilities"], json!(crate::sites::site_lifecycle::CAPABILITIES));
            assert!(reply["capabilities"].as_array().unwrap().iter().any(|c| c == "request_status"));
        }

        fn site_request(rid: u64, id: u8, origin: &str, tab: u8, method: &str) -> Value {
            json!({
                "_id": rid, "method": "site_request", "v": 1, "id": hex32(id),
                "site": { "origin": origin, "framed": false, "tab_ref": hex32(tab), "browser": "chrome" },
                "network": "mainnet",
                "request": { "method": method, "params": {} }
            })
        }

        #[tokio::test]
        async fn legacy_extensions_and_programs_cannot_carry_a_site() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            for origin in [Some(CHROME), None] {
                let mut ws = open_ws(addr, origin).await;
                for (i, m) in ["site_request", "site_cancel", "site_closed", "site_disconnect", "site_status", "sites_subscribe"].iter().enumerate() {
                    let mut frame = site_request(i as u64, 1, "https://a.com", 1, "connect");
                    frame["method"] = json!(m);
                    send(&mut ws, frame).await;
                    let reply = next(&mut ws).await.unwrap();
                    assert_eq!(reply["error"]["code"], "AUTH_REQUIRED", "{m} from {origin:?}");
                    assert_eq!(reply["_id"], i as u64);
                }
            }
            assert!(lock(&state.ws_site_queue).items.is_empty());
        }

        #[tokio::test]
        async fn a_waiting_review_does_not_stop_the_socket() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(CHROME)).await;
            prove(&mut ws, &state).await;

            send(&mut ws, json!({ "_id": 3, "method": "sites_subscribe", "v": 1 })).await;
            assert_eq!(next(&mut ws).await.unwrap()["ok"], true);
            let snap = next(&mut ws).await.unwrap();
            assert_eq!(snap["event"], "sites_snapshot");
            assert_eq!(snap["sites"], json!([]));

            send(&mut ws, site_request(10, 1, "https://a.com", 1, "connect")).await;
            send(&mut ws, json!({ "_id": 11, "method": "ping" })).await;
            let pong = next(&mut ws).await.unwrap();
            assert_eq!(pong["_id"], 11, "ping is answered while the connect waits");
            assert_eq!(pong["pong"], true);

            send(&mut ws, site_request(12, 2, "https://a.com", 1, "signMessage")).await;
            let refused = next(&mut ws).await.unwrap();
            assert_eq!(refused["_id"], 12);
            assert_eq!(refused["error"]["code"], "NOT_CONNECTED");

            send(&mut ws, site_request(13, 3, "https://b.com", 5, "getNetworkInfo")).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(lock(&state.ws_site_queue).items.len(), 2);
            site_relay::respond(&state, &hex32(3), &json!({ "success": true, "data": { "network": "mainnet" } }), &[]);
            let answered = next(&mut ws).await.unwrap();
            assert_eq!(answered["_id"], 13);
            assert_eq!(answered["id"], hex32(3));
            assert_eq!(answered["v"], 1);
            assert_eq!(answered["result"]["network"], "mainnet");

            send(&mut ws, site_request(14, 4, "https://a.com", 2, "connect")).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(lock(&state.ws_site_queue).items.len(), 1, "the second tab joins the waiting connect");

            send(&mut ws, json!({ "_id": 15, "method": "site_cancel", "v": 1, "id": hex32(1) })).await;
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64());
            assert_eq!(got[0]["_id"], 10);
            assert_eq!(got[0]["error"]["code"], "USER_REJECTED");
            assert_eq!(got[1]["_id"], 15);
            assert_eq!(got[1]["ok"], true);

            let connect = ws_sites::Effect::Connect {
                address: ADDR.into(),
                wallet_id: "w1".into(),
                wallet_name: "Spending".into(),
                permissions: vec![],
            };
            site_relay::respond(&state, &hex32(1), &json!({ "success": true, "data": { "address": ADDR } }), &[connect]);
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64());
            assert_eq!(got[0]["event"], "sites_snapshot", "the record changes before the answer");
            assert_eq!(got[0]["sites"][0]["origin"], "https://a.com");
            assert_eq!(got[0]["sites"][0]["relayed_by"], CLIENT);
            assert_eq!(got[1]["_id"], 14);
            assert_eq!(got[1]["result"]["address"], ADDR);

            send(&mut ws, site_request(16, 5, "https://a.com", 2, "signMessage")).await;
            send(&mut ws, json!({ "_id": 17, "method": "site_closed", "v": 1, "tab_ref": hex32(2) })).await;
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64());
            assert_eq!(got[0]["_id"], 16);
            assert_eq!(got[0]["error"]["code"], "USER_REJECTED");
            assert_eq!(got[1]["ok"], true);

            forget_pair(&state, CLIENT);
            let gone = next(&mut ws).await.unwrap();
            assert_eq!(gone["event"], "site_event");
            assert_eq!(gone["origin"], "https://a.com");
            assert_eq!(gone["kind"], "accountsChanged");
            assert_eq!(gone["data"]["accounts"], json!([]));
            assert!(next(&mut ws).await.is_none(), "then the connection closes");
            assert!(with_sites_empty(&state));
        }

        #[tokio::test]
        async fn site_disconnect_forgets_and_tells_the_site() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(CHROME)).await;
            prove(&mut ws, &state).await;
            send(&mut ws, json!({ "_id": 3, "method": "sites_subscribe", "v": 1 })).await;
            next(&mut ws).await.unwrap();
            next(&mut ws).await.unwrap();
            site_relay::with_sites(&state, |s| {
                s.connect(ws_sites::SiteRecord {
                    origin: "https://a.com".into(),
                    network: "mainnet".into(),
                    address: ADDR.into(),
                    client_id: CLIENT.into(),
                    browser: "chrome".into(),
                    wallet_id: "w1".into(),
                    wallet_name: "Spending".into(),
                    permissions: vec![],
                    connected_at: 1,
                    last_request: None,
                })
            });
            send(&mut ws, json!({ "_id": 4, "method": "site_disconnect", "v": 1, "origin": "https://a.com", "network": "mainnet" })).await;
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64().unwrap_or(0) * 10 + u64::from(v["event"] == "site_event"));
            assert_eq!(got[0]["event"], "sites_snapshot");
            assert_eq!(got[0]["sites"], json!([]));
            assert_eq!(got[1]["kind"], "accountsChanged");
            assert_eq!(got[2]["_id"], 4);
            assert!(with_sites_empty(&state));
        }

        /// Relay e2e server for the extension, see its docs/DESKTOP_RELAY.md.
        #[tokio::test]
        #[ignore]
        async fn relay_e2e_server() {
            let Ok(file) = std::env::var("RELAY_E2E_FILE") else { return };
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let desktop_id = with_store(&state, |s| s.desktop_id.clone());
            std::fs::write(&file, json!({ "port": addr.port(), "desktop_id": desktop_id, "client_id": CLIENT, "secret": ws_auth::hex(&SECRET) }).to_string()).unwrap();
            let done = format!("{file}.done");
            let mut seen = std::collections::HashSet::new();
            let start = Instant::now();
            while !std::path::Path::new(&done).exists() && start.elapsed() < Duration::from_secs(90) {
                let fresh: Vec<(String, String)> = lock(&state.ws_site_queue)
                    .items
                    .iter()
                    .filter(|p| !seen.contains(&p.id))
                    .map(|p| (p.id.clone(), p.method.clone()))
                    .collect();
                for (id, method) in fresh {
                    seen.insert(id.clone());
                    let st = state.clone();
                    tokio::spawn(async move {
                        match method.as_str() {
                            "connect" => {
                                tokio::time::sleep(Duration::from_millis(400)).await;
                                let effect = ws_sites::Effect::Connect {
                                    address: ADDR.into(),
                                    wallet_id: "w1".into(),
                                    wallet_name: "Spending".into(),
                                    permissions: vec!["accounts".into()],
                                };
                                site_relay::respond(&st, &id, &json!({ "success": true, "data": { "address": ADDR, "publicKey": "pk", "canSign": true } }), &[effect]);
                            }
                            "signMessage" => drop(site_relay::respond(&st, &id, &json!({ "success": true, "data": { "signature": "sig", "address": ADDR } }), &[])),
                            "getNetworkInfo" => drop(site_relay::respond(&st, &id, &json!({ "success": true, "data": { "id": "mainnet" } }), &[])),
                            "send_transaction" => {}
                            _ => drop(site_relay::respond(&st, &id, &json!({ "success": false, "error": { "code": "USER_REJECTED", "message": "no" } }), &[])),
                        }
                    });
                }
                if std::path::Path::new(&format!("{file}.forget")).exists() {
                    let _ = std::fs::remove_file(format!("{file}.forget"));
                    forget_pair(&state, CLIENT);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        fn with_sites_empty(state: &AppState) -> bool {
            site_relay::with_sites(state, |s| s.sites.is_empty())
        }

        const PAGE: &str = "https://app.octradex.xyz";
        const OTHER_PAGE: &str = "https://b.example";

        async fn try_ws(addr: SocketAddr, origin: &str) -> Option<Ws> {
            let mut req = format!("ws://{addr}/").into_client_request().unwrap();
            req.headers_mut().insert("Origin", origin.parse().unwrap());
            tokio_tungstenite::connect_async(req).await.ok().map(|c| c.0)
        }

        fn web_request(rid: u64, id: u8, method: &str) -> Value {
            json!({
                "_id": rid, "method": "site_request", "v": 1, "id": hex32(id),
                "network": "mainnet",
                "request": { "method": method, "params": {} }
            })
        }

        async fn queued(state: &AppState, n: usize) -> Vec<(String, String, String, String)> {
            for _ in 0..50 {
                let q: Vec<_> = lock(&state.ws_site_queue)
                    .items
                    .iter()
                    .map(|p| (p.id.clone(), p.site.origin.clone(), p.client_id.clone(), p.browser.to_string()))
                    .collect();
                if q.len() == n {
                    return q;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("the queue never held {n}");
        }

        fn connect_effect() -> ws_sites::Effect {
            ws_sites::Effect::Connect {
                address: ADDR.into(),
                wallet_id: "w1".into(),
                wallet_name: "Spending".into(),
                permissions: vec![],
            }
        }

        #[tokio::test]
        async fn websites_are_refused_while_turned_off() {
            let state = paired_state();
            with_store(&state, |s| s.settings.direct_sites = false);
            let addr = serve(state.clone()).await;
            assert!(try_ws(addr, PAGE).await.is_none());
            with_store(&state, |s| s.settings.direct_sites = true);
            assert!(try_ws(addr, PAGE).await.is_some());
            for bad in ["http://evil.example", "null", "file://", "https://a.com/x"] {
                assert!(try_ws(addr, bad).await.is_none(), "{bad}");
            }
        }

        #[tokio::test]
        async fn a_website_gets_only_the_site_methods() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(PAGE)).await;
            send(&mut ws, json!({ "_id": 1, "method": "ping" })).await;
            let pong = next(&mut ws).await.unwrap();
            assert_eq!(pong["pong"], true);
            assert!(pong.get("version").is_none(), "a page learns no version from ping");
            let methods = [
                "init", "auth_hello", "auth_prove", "auth_pair", "pair", "wallet_rpc", "makeRangeProof",
                "decrypt", "destroy", "site_closed", "site_disconnect", "unknown",
            ];
            let seed = vec![0u8; 32];
            for (i, m) in methods.iter().enumerate() {
                send(&mut ws, json!({ "_id": 10 + i, "method": m, "client_id": CLIENT, "nonce": "00", "seed": seed.clone() })).await;
                let reply = next(&mut ws).await.unwrap();
                assert_eq!(reply["error"]["code"], "AUTH_REQUIRED", "{m}");
                assert_eq!(reply["_id"], 10 + i as u64);
            }
            assert!(lock(&state.ws_pairing).pending.is_empty(), "a page cannot raise a pairing review");
            assert_eq!(state.connected_clients(), 0, "a page is not the extension");
        }

        fn bare_hello(id: u64) -> Value {
            json!({
                "_id": id, "v": 1, "wallet": "0xio-desktop",
                "protocol": 2, "kind": "desktop",
                "capabilities": ["request_id", "request_status", "request_events", "idempotent", "wait_confirmed", "receipt", "can_sign", "kind"],
            })
        }

        #[tokio::test]
        async fn site_hello_says_nothing_until_the_page_shows_its_token() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(PAGE)).await;
            send(&mut ws, json!({ "_id": 1, "method": "site_hello", "v": 1 })).await;
            assert_eq!(next(&mut ws).await.unwrap(), bare_hello(1));
            let token = site_relay::with_sites(&state, |s| {
                let mut rec = record(PAGE);
                rec.network = "devnet".into();
                s.connect(rec);
                s.issue_token(PAGE, ws_sites::DIRECT)
            });
            send(&mut ws, json!({ "_id": 2, "method": "site_hello", "v": 1 })).await;
            assert_eq!(
                next(&mut ws).await.unwrap(),
                bare_hello(2),
                "the Origin header alone is not the connected site"
            );
            let hello = hello_with(&mut ws, 3, &json!(forge(&token))).await;
            let mut invalid = bare_hello(3);
            invalid["token_status"] = json!("invalid");
            assert_eq!(hello, invalid);
            let hello = hello_with(&mut ws, 4, &json!(token)).await;
            assert_eq!(hello["wallet"], "0xio-desktop");
            assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
            assert_eq!(hello["network"], "devnet");
            assert_eq!(hello["token_status"], "valid");
            let mut other = open_ws(addr, Some(OTHER_PAGE)).await;
            let hello = hello_with(&mut other, 5, &json!(token)).await;
            assert!(hello.get("network").is_none(), "a token proves only its own site");
            assert_eq!(hello["token_status"], "invalid");
        }

        fn forge(token: &str) -> String {
            let mut b = token.as_bytes().to_vec();
            b[0] = if b[0] == b'A' { b'B' } else { b'A' };
            String::from_utf8(b).unwrap()
        }

        async fn hello_with(ws: &mut Ws, rid: u64, token: &Value) -> Value {
            send(ws, json!({ "_id": rid, "method": "site_hello", "v": 1, "site_token": token })).await;
            next(ws).await.unwrap()
        }

        async fn proven_page(addr: SocketAddr, token: &str) -> Ws {
            let mut ws = open_ws(addr, Some(PAGE)).await;
            assert_eq!(hello_with(&mut ws, 900, &json!(token)).await["token_status"], "valid");
            ws
        }

        fn connected_with_token(state: &AppState) -> String {
            site_relay::with_sites(state, |s| {
                s.connect(record(PAGE));
                s.issue_token(PAGE, ws_sites::DIRECT)
            })
        }

        #[tokio::test]
        async fn a_valid_token_restores_the_grant_and_a_missing_or_forged_one_gets_nothing() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut good = proven_page(addr, &token).await;
            let mut bare = open_ws(addr, Some(PAGE)).await;
            send(&mut bare, json!({ "_id": 1, "method": "site_hello", "v": 1 })).await;
            next(&mut bare).await.unwrap();
            let mut forged = open_ws(addr, Some(PAGE)).await;
            assert_eq!(hello_with(&mut forged, 1, &json!(forge(&token))).await["token_status"], "invalid");
            let mut odd = open_ws(addr, Some(PAGE)).await;
            assert_eq!(hello_with(&mut odd, 1, &json!(42)).await["token_status"], "invalid");

            for ws in [&mut bare, &mut forged, &mut odd] {
                send(ws, json!({ "_id": 2, "method": "sites_subscribe", "v": 1 })).await;
                let mut got = vec![next(ws).await.unwrap(), next(ws).await.unwrap()];
                got.sort_by_key(|v| v["_id"].as_u64());
                assert_eq!(got[0]["sites"], json!([]), "no snapshot of the site");
                for m in ["signMessage", "getAddress", "getBalance", "switch_network"] {
                    send(ws, web_request(3, 3, m)).await;
                    assert_eq!(next(ws).await.unwrap()["error"]["code"], "NOT_CONNECTED", "{m}");
                }
            }
            assert_eq!(site_relay::send_event(&state, ws_sites::DIRECT, PAGE, "lock", json!({})), 1, "only the proven page hears");
            assert_eq!(next(&mut good).await.unwrap()["kind"], "lock");
            for ws in [&mut bare, &mut forged, &mut odd] {
                assert!(next(ws).await.is_none());
            }

            send(&mut good, web_request(4, 4, "signMessage")).await;
            let q = queued(&state, 1).await;
            assert_eq!(q[0].2, ws_sites::DIRECT, "the proven page runs on the stored grant");
            site_relay::respond(&state, &hex32(4), &json!({ "success": true, "data": { "signature": "s" } }), &[]);
            assert_eq!(next(&mut good).await.unwrap()["result"]["signature"], "s");

            send(&mut bare, web_request(5, 5, "connect")).await;
            send(&mut good, web_request(6, 6, "connect")).await;
            let q = queued(&state, 2).await;
            assert_eq!(q[0].2, ws_sites::DIRECT_UNPROVEN, "a connect from an unproven page is a fresh review");
            assert_eq!(q[1].2, ws_sites::DIRECT, "and never joins the proven one");
        }

        #[tokio::test]
        async fn an_approved_connect_issues_a_new_token_that_replaces_the_old() {
            let state = paired_state();
            let old = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(PAGE)).await;
            send(&mut ws, web_request(1, 1, "connect")).await;
            queued(&state, 1).await;
            site_relay::respond(&state, &hex32(1), &json!({ "success": true, "data": { "address": ADDR } }), &[connect_effect()]);
            let reply = next(&mut ws).await.unwrap();
            let token = reply["result"]["siteToken"].as_str().unwrap().to_string();
            assert_ne!(token, old);
            site_relay::with_sites(&state, |s| {
                assert!(!s.token_matches(PAGE, ws_sites::DIRECT, &old));
                assert!(s.token_matches(PAGE, ws_sites::DIRECT, &token));
            });
            proven_page(addr, &token).await;
            let mut stale = open_ws(addr, Some(PAGE)).await;
            assert_eq!(hello_with(&mut stale, 1, &json!(old)).await["token_status"], "invalid");

            send(&mut ws, web_request(2, 2, "connect")).await;
            queued(&state, 1).await;
            site_relay::respond(&state, &hex32(2), &json!({ "success": false, "error": { "code": "USER_REJECTED", "message": "no" } }), &[]);
            assert!(next(&mut ws).await.unwrap()["result"].get("siteToken").is_none());
            assert!(site_relay::with_sites(&state, |s| s.token_matches(PAGE, ws_sites::DIRECT, &token)), "a rejected connect keeps the token");
        }

        #[tokio::test]
        async fn an_unproven_page_cannot_disconnect_the_site() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut good = proven_page(addr, &token).await;
            let mut bare = open_ws(addr, Some(PAGE)).await;
            send(&mut bare, web_request(1, 1, "disconnect")).await;
            queued(&state, 1).await;
            site_relay::respond(&state, &hex32(1), &json!({ "success": true, "data": { "disconnected": true } }), &[ws_sites::Effect::Disconnect]);
            assert_eq!(next(&mut bare).await.unwrap()["result"]["disconnected"], true);
            assert!(next(&mut good).await.is_none(), "the site hears nothing");
            site_relay::with_sites(&state, |s| {
                assert_eq!(s.sites.len(), 1);
                assert!(s.token_matches(PAGE, ws_sites::DIRECT, &token));
            });
        }

        #[tokio::test]
        async fn disconnect_revokes_the_token_and_unproves_open_pages() {
            let state = paired_state();
            let token = connected_with_token(&state);
            site_relay::with_sites(&state, |s| {
                let mut rec = record(PAGE);
                rec.network = "devnet".into();
                s.connect(rec);
                s.connect(record(OTHER_PAGE));
            });
            let addr = serve(state.clone()).await;
            let mut a = proven_page(addr, &token).await;
            let mut a2 = proven_page(addr, &token).await;
            send(&mut a2, json!({ "_id": 1, "method": "sites_subscribe", "v": 1 })).await;
            next(&mut a2).await.unwrap();
            assert_eq!(next(&mut a2).await.unwrap()["sites"].as_array().unwrap().len(), 2);

            send(&mut a, web_request(2, 2, "disconnect")).await;
            queued(&state, 1).await;
            site_relay::respond(&state, &hex32(2), &json!({ "success": true, "data": { "disconnected": true } }), &[ws_sites::Effect::Disconnect]);
            let mut seen = Vec::new();
            while let Some(v) = next(&mut a2).await {
                seen.push(v);
            }
            assert!(seen.iter().any(|v| v["kind"] == "accountsChanged" && v["data"]["accounts"] == json!([])));
            assert_eq!(seen.last().unwrap()["sites"], json!([]), "the page ends on an empty snapshot");
            site_relay::with_sites(&state, |s| {
                assert!(!s.token_matches(PAGE, ws_sites::DIRECT, &token));
                assert!(s.sites.iter().all(|r| r.origin != PAGE), "gone on every network");
                assert_eq!(s.sites.len(), 1, "another site stays");
                assert!(s.tokens.is_empty());
            });
            send(&mut a2, web_request(3, 3, "signMessage")).await;
            assert_eq!(next(&mut a2).await.unwrap()["error"]["code"], "NOT_CONNECTED", "an open page is unproven at once");
            let mut again = open_ws(addr, Some(PAGE)).await;
            assert_eq!(hello_with(&mut again, 1, &json!(token)).await["token_status"], "invalid");
        }

        #[tokio::test]
        async fn removing_the_site_in_settings_revokes_its_token() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut page = proven_page(addr, &token).await;
            site_relay::with_sites(&state, |s| s.disconnect("mainnet", PAGE, ws_sites::DIRECT));
            site_relay::revoke_direct(&state, PAGE);
            send(&mut page, web_request(1, 1, "getAddress")).await;
            assert_eq!(next(&mut page).await.unwrap()["error"]["code"], "NOT_CONNECTED");
            assert!(!site_relay::with_sites(&state, |s| s.token_matches(PAGE, ws_sites::DIRECT, &token)));
        }

        #[tokio::test]
        async fn an_older_sdk_without_a_token_works_after_a_review_on_each_connection() {
            let state = paired_state();
            connected_with_token(&state);
            let addr = serve(state.clone()).await;
            for round in 1..=2u8 {
                let mut ws = open_ws(addr, Some(PAGE)).await;
                send(&mut ws, json!({ "_id": 1, "method": "site_hello", "v": 1 })).await;
                assert!(next(&mut ws).await.unwrap().get("network").is_none());
                send(&mut ws, web_request(2, round * 10, "getAddress")).await;
                assert_eq!(next(&mut ws).await.unwrap()["error"]["code"], "NOT_CONNECTED");
                send(&mut ws, web_request(3, round * 10 + 1, "connect")).await;
                let q = queued(&state, 1).await;
                assert_eq!(q[0].2, ws_sites::DIRECT_UNPROVEN, "connection {round} needs the review");
                site_relay::respond(&state, &hex32(round * 10 + 1), &json!({ "success": true, "data": { "address": ADDR } }), &[connect_effect()]);
                assert!(next(&mut ws).await.unwrap()["result"]["siteToken"].is_string());
                send(&mut ws, web_request(4, round * 10 + 2, "getAddress")).await;
                let q = queued(&state, 1).await;
                assert_eq!(q[0].2, ws_sites::DIRECT, "then this connection is the site");
                site_relay::respond(&state, &q[0].0, &json!({ "success": true, "data": { "address": ADDR } }), &[]);
                assert_eq!(next(&mut ws).await.unwrap()["result"]["address"], ADDR);
            }
        }

        fn record(origin: &str) -> ws_sites::SiteRecord {
            ws_sites::SiteRecord {
                origin: origin.into(),
                network: "mainnet".into(),
                address: ADDR.into(),
                client_id: ws_sites::DIRECT.into(),
                browser: ws_sites::DIRECT_BROWSER.into(),
                wallet_id: "w1".into(),
                wallet_name: "Spending".into(),
                permissions: vec![],
                connected_at: 1,
                last_request: None,
            }
        }

        #[tokio::test]
        async fn connect_then_sign_from_a_page_with_the_menu_bar_answering() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(PAGE)).await;
            send(&mut ws, json!({ "_id": 1, "method": "sites_subscribe", "v": 1 })).await;
            assert_eq!(next(&mut ws).await.unwrap()["ok"], true);
            assert_eq!(next(&mut ws).await.unwrap()["sites"], json!([]));

            send(&mut ws, web_request(2, 1, "signMessage")).await;
            assert_eq!(next(&mut ws).await.unwrap()["error"]["code"], "NOT_CONNECTED");

            let mut connect = web_request(3, 2, "connect");
            connect["site"] = json!({ "origin": "https://evil.example", "framed": true, "tab_ref": hex32(9) });
            connect["origin"] = json!("https://evil.example");
            send(&mut ws, connect).await;
            let q = queued(&state, 1).await;
            assert_eq!(
                q[0],
                (hex32(2), PAGE.to_string(), "direct-unproven".to_string(), "web".to_string()),
                "the site is the Origin, not yet proven"
            );
            site_relay::respond(&state, &hex32(2), &json!({ "success": true, "data": { "address": ADDR } }), &[connect_effect()]);
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64());
            assert_eq!(got[0]["event"], "sites_snapshot");
            assert_eq!(got[0]["sites"][0]["origin"], PAGE);
            assert_eq!(got[0]["sites"][0]["relayed_by"], "direct");
            assert_eq!(got[1]["_id"], 3);
            assert_eq!(got[1]["id"], hex32(2));
            assert_eq!(got[1]["result"]["address"], ADDR);
            let token = got[1]["result"]["siteToken"].as_str().expect("an approved connect carries the token");
            site_relay::with_sites(&state, |s| {
                assert!(s.token_matches(PAGE, ws_sites::DIRECT, token));
                assert!(!serde_json::to_string(s).unwrap().contains(token), "only the hash is kept");
            });

            send(&mut ws, web_request(4, 3, "signMessage")).await;
            let q = queued(&state, 1).await;
            assert_eq!(q[0].1, PAGE);
            site_relay::respond(&state, &hex32(3), &json!({ "success": true, "data": { "signature": "sig" } }), &[]);
            let signed = next(&mut ws).await.unwrap();
            assert_eq!(signed["_id"], 4);
            assert_eq!(signed["result"]["signature"], "sig");

            send(&mut ws, web_request(5, 4, "signMessage")).await;
            queued(&state, 1).await;
            site_relay::respond(&state, &hex32(4), &json!({ "success": false, "error": { "code": "USER_REJECTED", "message": "Rejected in 0xio Desktop." } }), &[]);
            assert_eq!(next(&mut ws).await.unwrap()["error"]["code"], "USER_REJECTED");
        }

        #[tokio::test]
        async fn snapshots_and_events_reach_only_pages_of_that_origin() {
            let state = paired_state();
            let token = site_relay::with_sites(&state, |s| {
                s.connect(record(PAGE));
                s.connect(record(OTHER_PAGE));
                s.issue_token(OTHER_PAGE, ws_sites::DIRECT);
                s.issue_token(PAGE, ws_sites::DIRECT)
            });
            let addr = serve(state.clone()).await;
            let mut a = proven_page(addr, &token).await;
            let mut a2 = proven_page(addr, &token).await;
            let mut b = open_ws(addr, Some(OTHER_PAGE)).await;
            send(&mut a, json!({ "_id": 1, "method": "sites_subscribe", "v": 1 })).await;
            next(&mut a).await.unwrap();
            let snap = next(&mut a).await.unwrap();
            assert_eq!(snap["sites"].as_array().unwrap().len(), 1);
            assert_eq!(snap["sites"][0]["origin"], PAGE);
            tokio::time::sleep(Duration::from_millis(30)).await;

            assert_eq!(site_relay::send_event(&state, ws_sites::DIRECT, PAGE, "lock", json!({})), 2);
            for ws in [&mut a, &mut a2] {
                let ev = next(ws).await.unwrap();
                assert_eq!(ev["event"], "site_event");
                assert_eq!(ev["origin"], PAGE);
                assert_eq!(ev["kind"], "lock");
            }
            assert!(next(&mut b).await.is_none(), "another origin hears nothing");
            assert_eq!(site_relay::send_event(&state, CLIENT, PAGE, "lock", json!({})), 0, "nor does an extension");
        }

        #[tokio::test]
        async fn closing_the_page_drops_its_requests() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut ws = open_ws(addr, Some(PAGE)).await;
            send(&mut ws, web_request(1, 1, "connect")).await;
            send(&mut ws, web_request(2, 2, "getNetworkInfo")).await;
            queued(&state, 2).await;
            send(&mut ws, json!({ "_id": 3, "method": "site_cancel", "v": 1, "id": hex32(2) })).await;
            let mut got = vec![next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
            got.sort_by_key(|v| v["_id"].as_u64());
            assert_eq!(got[0]["_id"], 2);
            assert_eq!(got[0]["error"]["code"], "USER_REJECTED");
            assert_eq!(got[1]["ok"], true);
            ws.close(None).await.unwrap();
            drop(ws);
            queued(&state, 0).await;
        }

        #[tokio::test]
        async fn pages_are_capped_per_origin_and_limited_per_site() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut open = Vec::new();
            for _ in 0..ws_auth::MAX_WEB_PER_ORIGIN {
                open.push(try_ws(addr, PAGE).await.expect("within the cap"));
            }
            assert!(try_ws(addr, PAGE).await.is_none(), "one origin holds at most six");
            let mut other = try_ws(addr, OTHER_PAGE).await.expect("another origin still connects");
            let mut ext = open_ws(addr, Some(CHROME)).await;
            prove(&mut ext, &state).await;

            let ws = &mut open[0];
            for i in 0..3u8 {
                send(ws, web_request(u64::from(i), i, "connect")).await;
            }
            for i in 3..6u8 {
                send(ws, web_request(u64::from(i), i, "getNetworkInfo")).await;
            }
            queued(&state, 1).await;
            assert_eq!(lock(&state.ws_site_queue).items[0].waiters.len(), 3, "repeat connects merge");
            for _ in 0..3 {
                let r = next(ws).await.unwrap();
                assert_eq!(r["error"]["code"], "RATE_LIMIT_EXCEEDED", "three wait per site at most");
            }
            send(&mut other, web_request(9, 9, "connect")).await;
            queued(&state, 2).await;
            drop(open);
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(try_ws(addr, PAGE).await.is_some(), "slots come back when pages close");
        }

        #[tokio::test]
        async fn turning_websites_off_closes_open_pages() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut page = open_ws(addr, Some(PAGE)).await;
            let mut ext = open_ws(addr, Some(CHROME)).await;
            prove(&mut ext, &state).await;
            send(&mut page, web_request(1, 1, "connect")).await;
            queued(&state, 1).await;
            assert_eq!(close_client(&state, ws_sites::DIRECT), 1);
            let r = next(&mut page).await;
            assert!(r.is_none() || r.unwrap()["error"]["code"] == "USER_REJECTED");
            queued(&state, 0).await;
            send(&mut ext, json!({ "_id": 5, "method": "ping" })).await;
            assert_eq!(next(&mut ext).await.unwrap()["pong"], true, "the extension stays");
            assert!(forget_pair(&state, ws_sites::DIRECT).len() == 1, "direct is not a pairing to remove");
        }

        const HASH: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

        fn rid_request(id: u64, wire: u8, rid: u8, method: &str, params: Value) -> Value {
            json!({
                "_id": id, "method": "site_request", "v": 1, "id": hex32(wire), "rid": hex32(rid),
                "network": "mainnet",
                "request": { "method": method, "params": params }
            })
        }

        async fn drain(ws: &mut Ws) -> Vec<Value> {
            let mut got = Vec::new();
            while let Some(v) = next(ws).await {
                got.push(v);
            }
            got
        }

        fn updates(frames: &[Value]) -> Vec<String> {
            frames
                .iter()
                .filter(|v| v["event"] == "site_event" && v["kind"] == "request")
                .map(|v| v["data"]["status"].as_str().unwrap_or_default().to_string())
                .collect()
        }

        async fn ask(ws: &mut Ws, id: u64, rid: u8) -> Value {
            send(ws, json!({ "_id": id, "method": "site_status", "v": 1, "rid": hex32(rid) })).await;
            let got = drain(ws).await;
            got.into_iter().find(|v| v["_id"] == id).expect("a status answer")["result"].clone()
        }

        fn to_stage(state: &AppState, wire: u8, stage: ws_sites::Stage) {
            if lock(&state.ws_site_queue).stage(&hex32(wire), stage, std::time::Instant::now()) {
                site_relay::notify(state, &hex32(wire));
            }
        }

        fn approve(state: &AppState, wire: u8) {
            to_stage(state, wire, ws_sites::Stage::Review);
            lock(&state.ws_site_queue).get_mut(&hex32(wire)).unwrap().stage = ws_sites::Stage::Approved;
            site_relay::progress_of(state, &hex32(wire), &crate::sites::site_lifecycle::Progress::Signing).unwrap();
        }

        #[tokio::test]
        async fn a_page_follows_its_request_from_pending_to_confirmed() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut page = proven_page(addr, &token).await;
            let params = json!({ "to": ADDR, "amount": "1" });
            send(&mut page, rid_request(1, 1, 7, "send_transaction", params.clone())).await;
            let got = drain(&mut page).await;
            assert_eq!(updates(&got), vec!["pending"]);
            let ev = got.iter().find(|v| v["kind"] == "request").unwrap();
            assert_eq!(ev["origin"], PAGE);
            assert_eq!(ev["data"]["requestId"], hex32(7));
            assert_eq!(ev["data"]["method"], "send_transaction");
            assert_eq!(ev["data"]["network"], "mainnet");
            assert_eq!(ev["data"]["address"], ADDR, "the connected site sees its signer");
            assert!(ev.get("tab_ref").is_none());

            to_stage(&state, 1, ws_sites::Stage::Unlock);
            to_stage(&state, 1, ws_sites::Stage::Review);
            approve(&state, 1);
            assert_eq!(updates(&drain(&mut page).await), vec!["locked", "review_open", "signing"]);
            assert_eq!(ask(&mut page, 2, 7).await["status"], "signing");

            let watch = site_relay::respond(&state, &hex32(1), &json!({ "success": true, "data": { "txHash": HASH } }), &[]).unwrap();
            assert_eq!(watch.hashes, vec![HASH.to_string()]);
            let got = drain(&mut page).await;
            assert_eq!(updates(&got), vec!["submitted"]);
            let reply = got.iter().find(|v| v["_id"] == 1).unwrap();
            assert_eq!(reply["rid"], hex32(7));
            assert_eq!(reply["status"], "submitted");
            assert_eq!(reply["result"]["txHash"], HASH);
            let s = ask(&mut page, 3, 7).await;
            assert_eq!(s["hash"], HASH);
            assert_eq!(s["watching"], true);

            let confirmed = crate::sites::site_lifecycle::Progress::Confirmed { epoch: Some(42), receipt: None, receipt_unavailable: Some("not_contract".into()), result: None };
            site_relay::progress_of(&state, &hex32(1), &confirmed).unwrap();
            let got = drain(&mut page).await;
            assert_eq!(updates(&got), vec!["confirmed"]);
            assert_eq!(got.iter().find(|v| v["kind"] == "request").unwrap()["data"]["epoch"], 42);
            let s = ask(&mut page, 4, 7).await;
            assert_eq!(s["status"], "confirmed");
            assert!(s["seq"].as_u64().unwrap() >= 6);

            send(&mut page, rid_request(5, 2, 7, "send_transaction", params.clone())).await;
            let got = drain(&mut page).await;
            let again = got.iter().find(|v| v["_id"] == 5).unwrap();
            assert_eq!(again["result"]["txHash"], HASH, "the same id gets the stored answer");
            assert_eq!(again["status"], "confirmed");
            assert!(lock(&state.ws_site_queue).items.is_empty(), "and never a second review");
            send(&mut page, rid_request(6, 3, 7, "send_transaction", json!({ "to": ADDR, "amount": "9" }))).await;
            let got = drain(&mut page).await;
            assert_eq!(got.iter().find(|v| v["_id"] == 6).unwrap()["error"]["code"], "REQUEST_ID_REUSED");
        }

        #[tokio::test]
        async fn status_and_events_stay_with_the_connection_that_sent_the_request() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut site = proven_page(addr, &token).await;
            let mut bare = open_ws(addr, Some(PAGE)).await;
            let mut other_bare = open_ws(addr, Some(PAGE)).await;
            let mut other_site = open_ws(addr, Some(OTHER_PAGE)).await;

            send(&mut site, rid_request(1, 1, 7, "signMessage", json!({ "message": "hi" }))).await;
            assert_eq!(updates(&drain(&mut site).await), vec!["pending"]);
            assert_eq!(ask(&mut other_site, 2, 7).await["status"], "unknown", "another origin never sees it");
            assert_eq!(ask(&mut bare, 2, 7).await["status"], "unknown", "a page without the token asks only about its own");
            send(&mut bare, rid_request(3, 2, 7, "signMessage", json!({ "message": "hi" }))).await;
            let got = drain(&mut bare).await;
            let refused = got.iter().find(|v| v["_id"] == 3).unwrap();
            assert_ne!(refused["status"], "pending");
            assert!(refused["error"].is_object(), "it cannot join or read another connection's request");

            send(&mut bare, rid_request(4, 3, 9, "connect", json!({}))).await;
            let got = drain(&mut bare).await;
            assert_eq!(updates(&got), vec!["pending"]);
            assert!(got.iter().find(|v| v["kind"] == "request").unwrap()["data"].get("address").is_none());
            to_stage(&state, 3, ws_sites::Stage::Unlock);
            let got = drain(&mut bare).await;
            assert_eq!(updates(&got), vec!["review_open"], "an unconnected page never learns the wallet is locked");
            assert_eq!(ask(&mut bare, 5, 9).await["status"], "review_open");
            assert_eq!(ask(&mut site, 5, 9).await["status"], "review_open", "a stranger's request is never marked locked");
            assert_eq!(ask(&mut other_bare, 5, 9).await["status"], "unknown");

            to_stage(&state, 3, ws_sites::Stage::Review);
            assert!(updates(&drain(&mut bare).await).is_empty(), "the unlock tells a stranger nothing");
            to_stage(&state, 1, ws_sites::Stage::Review);
            assert_eq!(updates(&drain(&mut site).await), vec!["review_open"]);
            for ws in [&mut bare, &mut other_bare, &mut other_site] {
                assert!(updates(&drain(ws).await).is_empty(), "nobody else hears it");
            }
            send(&mut site, json!({ "_id": 6, "method": "site_status", "v": 1, "rid": "XYZ" })).await;
            let got = drain(&mut site).await;
            assert_eq!(got.iter().find(|v| v["_id"] == 6).unwrap()["error"]["code"], "INVALID_PARAMS");
        }

        #[tokio::test]
        async fn an_approved_request_finishes_after_its_page_closes_and_the_reload_reads_it() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut page = proven_page(addr, &token).await;
            send(&mut page, rid_request(1, 1, 5, "signMessage", json!({ "message": "a" }))).await;
            send(&mut page, rid_request(2, 2, 6, "signMessage", json!({ "message": "b" }))).await;
            queued(&state, 2).await;
            approve(&state, 1);
            to_stage(&state, 2, ws_sites::Stage::Review);
            drop(page);
            let left = queued(&state, 1).await;
            assert_eq!(left[0].0, hex32(1), "the approved one runs on, the unanswered review closed");

            site_relay::respond(&state, &hex32(1), &json!({ "success": true, "data": { "signature": "sig" } }), &[]);
            let mut reloaded = proven_page(addr, &token).await;
            let s = ask(&mut reloaded, 1, 5).await;
            assert_eq!(s["status"], "completed");
            assert_eq!(s["result"]["signature"], "sig");
            assert_eq!(ask(&mut reloaded, 2, 6).await["status"], "rejected");
            send(&mut reloaded, rid_request(3, 3, 5, "signMessage", json!({ "message": "a" }))).await;
            let got = drain(&mut reloaded).await;
            assert_eq!(got.iter().find(|v| v["_id"] == 3).unwrap()["result"]["signature"], "sig");
            assert!(lock(&state.ws_site_queue).items.is_empty(), "nothing is signed twice");
        }

        #[tokio::test]
        async fn a_page_over_twenty_messages_a_second_is_answered_rate_limited() {
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut page = open_ws(addr, Some(PAGE)).await;
            for i in 0..30u64 {
                send(&mut page, json!({ "_id": i, "method": "ping" })).await;
            }
            let got = drain(&mut page).await;
            assert_eq!(got.len(), 30, "every message is answered");
            let limited = got.iter().filter(|v| v["error"]["code"] == "RATE_LIMITED").count();
            assert_eq!(limited, 30 - ws_sites::PAGE_RATE_PER_SECOND);
            assert!(got.iter().all(|v| v["_id"].is_u64()));
            let mut other = open_ws(addr, Some(PAGE)).await;
            send(&mut other, json!({ "_id": 1, "method": "ping" })).await;
            assert_eq!(next(&mut other).await.unwrap()["pong"], true, "each page has its own budget");
        }

        #[tokio::test]
        async fn a_page_cancels_by_request_id_only_before_approval() {
            let state = paired_state();
            let token = connected_with_token(&state);
            let addr = serve(state.clone()).await;
            let mut page = proven_page(addr, &token).await;
            send(&mut page, rid_request(1, 1, 5, "signMessage", json!({ "message": "a" }))).await;
            send(&mut page, rid_request(2, 2, 6, "send_transaction", json!({ "to": ADDR, "amount": "1" }))).await;
            queued(&state, 2).await;
            approve(&state, 2);
            drain(&mut page).await;

            send(&mut page, json!({ "_id": 3, "method": "site_cancel", "v": 1, "rid": hex32(5) })).await;
            let got = drain(&mut page).await;
            let reply = got.iter().find(|v| v["_id"] == 3).unwrap();
            assert_eq!(reply["ok"], true);
            assert_eq!(reply["result"]["status"], "rejected");
            assert_eq!(got.iter().find(|v| v["_id"] == 1).unwrap()["error"]["code"], "USER_REJECTED");

            send(&mut page, json!({ "_id": 4, "method": "site_cancel", "v": 1, "rid": hex32(6) })).await;
            let got = drain(&mut page).await;
            let reply = got.iter().find(|v| v["_id"] == 4).unwrap();
            assert_eq!(reply["ok"], false, "an approved request is not cancelled");
            assert_eq!(reply["result"]["status"], "signing");
            assert_eq!(queued(&state, 1).await[0].0, hex32(2));
        }

        #[tokio::test]
        async fn a_relayed_site_follows_its_request_through_the_extension() {
            let state = paired_state();
            site_relay::with_sites(&state, |s| {
                let mut rec = record(PAGE);
                rec.client_id = CLIENT.into();
                rec.browser = "chrome".into();
                s.connect(rec);
            });
            let addr = serve(state.clone()).await;
            let mut ext = open_ws(addr, Some(CHROME)).await;
            prove(&mut ext, &state).await;
            let mut frame = site_request(1, 1, PAGE, 4, "signMessage");
            frame["rid"] = json!(hex32(7));
            send(&mut ext, frame).await;
            let got = drain(&mut ext).await;
            assert_eq!(updates(&got), vec!["pending"]);
            let ev = got.iter().find(|v| v["kind"] == "request").unwrap();
            assert_eq!(ev["tab_ref"], hex32(4), "the extension tells only that tab");
            assert_eq!(ev["origin"], PAGE);

            let status = |id: u64, origin: &str| json!({ "_id": id, "method": "site_status", "v": 1, "rid": hex32(7), "site": { "origin": origin } });
            send(&mut ext, status(2, PAGE)).await;
            let got = drain(&mut ext).await;
            assert_eq!(got.iter().find(|v| v["_id"] == 2).unwrap()["result"]["status"], "pending");
            send(&mut ext, status(3, OTHER_PAGE)).await;
            let got = drain(&mut ext).await;
            assert_eq!(got.iter().find(|v| v["_id"] == 3).unwrap()["result"]["status"], "unknown");

            to_stage(&state, 1, ws_sites::Stage::Review);
            send(&mut ext, json!({ "_id": 4, "method": "site_closed", "v": 1, "tab_ref": hex32(4) })).await;
            let got = drain(&mut ext).await;
            assert_eq!(updates(&got), vec!["review_open", "rejected"]);
            let reply = got.iter().find(|v| v["_id"] == 1).unwrap();
            assert_eq!(reply["status"], "rejected");
            assert_eq!(reply["error"]["details"]["requestId"], hex32(7));
        }

        #[tokio::test]
        async fn a_preflight_is_answered_for_the_private_network() {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let state = paired_state();
            let addr = serve(state.clone()).await;
            let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
            s.write_all(b"OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://app.octradex.xyz\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Private-Network: true\r\n\r\n").await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            assert!(out.starts_with("HTTP/1.1 204"), "{out}");
            assert!(out.contains("Access-Control-Allow-Private-Network: true"));
        }
    }
}
