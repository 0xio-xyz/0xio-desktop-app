//! The local WebSocket's handshake limits and the extension pairing that waits for both sides.

use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const CHROME: &str = "chrome-extension://anknhjilldkeelailocijnfibefmepcc";
const INSTALL: &str = "0123456789abcdef0123456789abcdef";
const OTHER_INSTALL: &str = "abcdef0123456789abcdef0123456789";
const PAGE: &str = "https://app.octradex.xyz";

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn fresh_state() -> Arc<AppState> {
    let state = AppState::new();
    let mut store = PairStore::default();
    store.ensure_id();
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

async fn open_ws(addr: SocketAddr, origin: &str) -> Ws {
    let mut req = format!("ws://{addr}/").into_client_request().unwrap();
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.unwrap().0
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string())).await.unwrap();
}

async fn next_within(ws: &mut Ws, wait: Duration) -> Option<Value> {
    loop {
        match tokio::time::timeout(wait, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(&t).ok(),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

async fn next(ws: &mut Ws) -> Option<Value> {
    next_within(ws, Duration::from_millis(500)).await
}

fn paired(state: &AppState) -> Vec<String> {
    with_store(state, |s| s.extensions.iter().map(|e| e.client_id.clone()).collect())
}

fn review_id(state: &AppState) -> Option<String> {
    lock(&state.ws_pairing).pending.keys().next().cloned()
}

async fn start_pairing(addr: SocketAddr, state: &AppState, install: &str) -> (Ws, String) {
    let mut ws = open_ws(addr, CHROME).await;
    let (_, epk) = ws_auth::x25519_keypair();
    send(&mut ws, json!({ "_id": 1, "method": "auth_pair", "v": 1, "client_id": install, "epk": ws_auth::hex(&epk) })).await;
    let notice = next(&mut ws).await.unwrap();
    assert_eq!(notice["event"], "pairing");
    assert!(notice["epk"].is_string());
    (ws, review_id(state).unwrap())
}

fn confirm(install: &str) -> Value {
    json!({ "type": ws_auth::PAIR_CONFIRM, "v": 1, "client_id": install })
}

fn cancel(install: &str) -> Value {
    json!({ "type": ws_auth::PAIR_CANCEL, "v": 1, "client_id": install })
}

#[tokio::test]
async fn pair_alone_keeps_nothing_until_the_extension_confirms() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (mut ws, id) = start_pairing(addr, &state, INSTALL).await;

    assert_eq!(respond_pair(&state, &id, true), Ok("waiting"));
    assert!(paired(&state).is_empty(), "no save on the desktop's Pair alone");
    assert!(next_within(&mut ws, Duration::from_millis(150)).await.is_none(), "the extension hears nothing yet");

    send(&mut ws, confirm(OTHER_INSTALL)).await;
    send(&mut ws, json!({ "type": ws_auth::PAIR_CONFIRM, "v": 2, "client_id": INSTALL })).await;
    let mut other = open_ws(addr, CHROME).await;
    send(&mut other, confirm(INSTALL)).await;
    assert!(next(&mut other).await.unwrap().get("error").is_some(), "another socket cannot confirm");
    assert!(next_within(&mut ws, Duration::from_millis(150)).await.is_none());
    assert!(paired(&state).is_empty(), "a foreign confirm is ignored");
    assert_eq!(review_id(&state).as_deref(), Some(id.as_str()));

    send(&mut ws, confirm(INSTALL)).await;
    let reply = next(&mut ws).await.unwrap();
    assert_eq!(reply["_id"], 1);
    assert_eq!(reply["paired"], true);
    assert_eq!(paired(&state), vec![INSTALL.to_string()]);
    assert!(review_id(&state).is_none());
}

#[tokio::test]
async fn a_confirm_before_pair_is_held_until_pair() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (mut ws, id) = start_pairing(addr, &state, INSTALL).await;

    send(&mut ws, confirm(INSTALL)).await;
    assert!(next_within(&mut ws, Duration::from_millis(150)).await.is_none());
    assert!(paired(&state).is_empty(), "no save on the extension's confirm alone");
    assert!(lock(&state.ws_pairing).pending[&id].ext_ok);

    assert_eq!(respond_pair(&state, &id, true), Ok("paired"));
    assert_eq!(next(&mut ws).await.unwrap()["paired"], true);
    assert_eq!(paired(&state), vec![INSTALL.to_string()]);
}

#[tokio::test]
async fn a_cancel_or_wrong_pick_keeps_nothing() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (mut ws, id) = start_pairing(addr, &state, INSTALL).await;

    assert_eq!(respond_pair(&state, &id, true), Ok("waiting"));
    send(&mut ws, cancel(OTHER_INSTALL)).await;
    assert!(review_id(&state).is_some(), "another install cannot cancel");
    send(&mut ws, cancel(INSTALL)).await;
    let reply = next(&mut ws).await.unwrap();
    assert_eq!(reply["code"], "PAIRING_CANCELLED");
    assert!(paired(&state).is_empty());
    assert!(review_id(&state).is_none());
    assert!(respond_pair(&state, &id, true).is_err(), "the review has ended");
}

#[tokio::test]
async fn reject_refuses_and_keeps_nothing() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (mut ws, id) = start_pairing(addr, &state, INSTALL).await;
    send(&mut ws, confirm(INSTALL)).await;
    assert_eq!(respond_pair(&state, &id, false), Ok("refused"));
    assert_eq!(next(&mut ws).await.unwrap()["code"], "PAIRING_REFUSED");
    assert!(paired(&state).is_empty());
}

#[tokio::test]
async fn closing_the_socket_ends_the_review_and_what_it_held() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (mut ws, id) = start_pairing(addr, &state, INSTALL).await;
    send(&mut ws, confirm(INSTALL)).await;
    ws.close(None).await.unwrap();
    for _ in 0..50 {
        if review_id(&state).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(review_id(&state).is_none());
    assert!(respond_pair(&state, &id, true).is_err());
    assert!(paired(&state).is_empty());
}

#[tokio::test]
async fn one_pairing_review_at_a_time() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let (_ws, _id) = start_pairing(addr, &state, INSTALL).await;
    let mut second = open_ws(addr, CHROME).await;
    let (_, epk) = ws_auth::x25519_keypair();
    send(&mut second, json!({ "_id": 7, "method": "auth_pair", "v": 1, "client_id": OTHER_INSTALL, "epk": ws_auth::hex(&epk) })).await;
    let reply = next(&mut second).await.unwrap();
    assert_eq!(reply["_id"], 7);
    assert_eq!(reply["code"], "PAIRING_REFUSED");
    assert_eq!(lock(&state.ws_pairing).pending.len(), 1);
}

#[test]
fn the_origin_header_sizes_the_connection() {
    let head = |origin: Option<&str>| {
        let mut h = String::from("GET / HTTP/1.1\r\nHost: 127.0.0.1:19345\r\nUpgrade: websocket\r\n");
        if let Some(o) = origin {
            h.push_str(&format!("oRiGiN:  {o} \r\n"));
        }
        h.push_str("Sec-WebSocket-Version: 13\r\n\r\nbody-origin: https://x.com\r\n");
        h
    };
    assert_eq!(origin_header(&head(Some(PAGE))), Some(PAGE));
    assert_eq!(origin_header(&head(None)), None, "nothing after the head counts");
    assert!(sized_for_web(&head(Some(PAGE))));
    assert!(sized_for_web(&head(Some("null"))));
    assert!(!sized_for_web(&head(Some(CHROME))));
    assert!(!sized_for_web(&head(Some("MOZ-EXTENSION://3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f"))));
    assert!(!sized_for_web(&head(None)), "a program sends no Origin");
    assert_eq!(ws_config(true).max_message_size, Some(WEB_MAX_MESSAGE));
    assert_eq!(ws_config(true).max_frame_size, Some(WEB_MAX_MESSAGE));
    assert_eq!(ws_config(false).max_message_size, Some(PAIRED_MAX_MESSAGE));
}

#[tokio::test]
async fn a_web_page_cannot_send_what_the_extension_can() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let big = "x".repeat(WEB_MAX_MESSAGE + 1);

    let mut ext = open_ws(addr, CHROME).await;
    send(&mut ext, json!({ "_id": 1, "method": "ping", "pad": big })).await;
    assert_eq!(next(&mut ext).await.unwrap()["pong"], true, "the extension's large messages pass");

    let mut page = open_ws(addr, PAGE).await;
    send(&mut page, json!({ "_id": 1, "method": "site_hello", "v": 1 })).await;
    assert!(next(&mut page).await.is_some());
    let _ = page.send(Message::Text(json!({ "_id": 2, "method": "site_hello", "v": 1, "pad": big }).to_string())).await;
    assert!(next(&mut page).await.is_none(), "an oversized message from a page closes it");
}

#[tokio::test]
async fn a_silent_socket_is_dropped_before_the_handshake() {
    let state = fresh_state();
    let addr = serve(state.clone()).await;
    let mut raw = tokio::net::TcpStream::connect(addr).await.unwrap();
    raw.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n").await.unwrap();
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(HANDSHAKE_TIMEOUT + Duration::from_secs(2), raw.read(&mut buf)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "the server closed it: {read:?}");
}
