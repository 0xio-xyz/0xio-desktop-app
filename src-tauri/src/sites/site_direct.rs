//! A local program can send any Origin header, so the origin alone grants nothing: a connection
//! is the connected site only once its `site_hello` shows the site token.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::sites::site_lifecycle;
use crate::sites::site_relay;
use crate::state::AppState;
use crate::ws::ws_sites::{Refusal, DIRECT, DIRECT_BROWSER};

pub const WEB_METHODS: &[&str] =
    &["ping", "site_hello", "site_request", "site_cancel", "site_status", "sites_subscribe"];

pub const WEB_ONLY: Refusal = Refusal::new(
    "AUTH_REQUIRED",
    "A website can only send site requests to 0xio Desktop.",
);

pub fn tab_ref(conn: u64) -> String {
    format!("{:032x}", u128::from(conn))
}

/// The handshake's origin, whatever the body says.
pub fn as_site_request(msg: &Value, origin: &str, conn: u64) -> Value {
    let mut msg = msg.clone();
    if let Some(obj) = msg.as_object_mut() {
        obj.remove("origin");
        obj.insert(
            "site".into(),
            json!({ "origin": origin, "framed": false, "tab_ref": tab_ref(conn) }),
        );
    }
    msg
}

/// A page learns nothing about the user until its `site_token` proves the connection; a wrong
/// one is answered `token_status: "invalid"` so the page forgets it.
pub fn hello(state: &AppState, conn: u64, origin: &str, msg: &Value) -> Value {
    let status = match msg.get("site_token") {
        None | Some(Value::Null) => None,
        Some(t) => {
            let token = t.as_str().unwrap_or_default();
            Some(site_relay::with_sites(state, |s| s.token_matches(origin, DIRECT, token)))
        }
    };
    let proven = status == Some(true);
    site_relay::set_web_proven(state, conn, origin, proven);
    let network = proven
        .then(|| {
            site_relay::with_sites(state, |s| {
                s.sites
                    .iter()
                    .filter(|r| r.origin == origin && r.client_id == DIRECT)
                    .max_by_key(|r| r.connected_at)
                    .map(|r| r.network.clone())
            })
        })
        .flatten();
    let mut reply = match network {
        Some(network) => json!({
            "v": 1,
            "wallet": "0xio-desktop",
            "version": env!("CARGO_PKG_VERSION"),
            "network": network,
        }),
        None => json!({ "v": 1, "wallet": "0xio-desktop" }),
    };
    site_lifecycle::advertise(&mut reply);
    if let Some(ok) = status {
        reply["token_status"] = json!(if ok { "valid" } else { "invalid" });
    }
    reply
}

fn with_id(mut v: Value, id: &Option<Value>) -> Value {
    if let (Some(id), Some(obj)) = (id, v.as_object_mut()) {
        obj.insert("_id".to_string(), id.clone());
    }
    v
}

pub fn handle(
    state: &Arc<AppState>,
    conn: u64,
    origin: &str,
    method: &str,
    msg: &Value,
    out: mpsc::UnboundedSender<String>,
) -> Option<Value> {
    if !WEB_METHODS.contains(&method) {
        return Some(site_relay::refusal_frame(WEB_ONLY, msg));
    }
    if !site_relay::page_allowed(state, conn) {
        return Some(site_relay::refusal_frame(crate::ws::ws_sites::PAGE_TOO_FAST, msg));
    }
    let id = msg.get("_id").cloned();
    match method {
        "ping" => Some(with_id(json!({ "pong": true }), &id)),
        "site_hello" => Some(with_id(hello(state, conn, origin, msg), &id)),
        "site_request" => {
            let req = as_site_request(msg, origin, conn);
            let client = site_relay::web_client(state, conn);
            site_relay::request(state, conn, &client, DIRECT_BROWSER, &req, out)
        }
        "site_cancel" => {
            let client = site_relay::web_client(state, conn);
            Some(with_id(site_relay::cancel(state, conn, &client, Some(origin), msg), &id))
        }
        "site_status" => {
            let client = site_relay::web_client(state, conn);
            Some(with_id(site_relay::status(state, conn, &client, origin, msg), &id))
        }
        "sites_subscribe" => {
            let client = site_relay::web_client(state, conn);
            Some(with_id(site_relay::subscribe(state, conn, &client, Some(origin), out), &id))
        }
        _ => Some(site_relay::refusal_frame(WEB_ONLY, msg)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::ws_sites;

    #[test]
    fn the_body_cannot_name_another_site() {
        let msg = json!({
            "_id": 1, "method": "site_request", "v": 1, "id": format!("{:032x}", 1),
            "origin": "https://evil.example",
            "site": { "origin": "https://evil.example", "framed": true, "tab_ref": format!("{:032x}", 9), "top_origin": "https://x.y" },
            "network": "mainnet",
            "request": { "method": "connect", "params": { "origin": "https://evil.example" } }
        });
        let req = as_site_request(&msg, "https://a.com", 7);
        assert!(req.get("origin").is_none());
        let parsed = ws_sites::parse_request(&req, false).unwrap();
        assert_eq!(parsed.site.origin, "https://a.com");
        assert!(!parsed.site.framed);
        assert_eq!(parsed.site.top_origin, None);
        assert_eq!(parsed.site.tab_ref, tab_ref(7));
        assert_ne!(tab_ref(7), tab_ref(8));
    }
}
