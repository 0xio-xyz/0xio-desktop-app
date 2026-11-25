//! Request status records of wallet protocol 2, kept in memory only.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::ws::ws_auth::Window;

pub const PROTOCOL: u32 = 2;
pub const KIND: &str = "desktop";
pub const CAPABILITIES: &[&str] = &[
    "request_id",
    "request_status",
    "request_events",
    "idempotent",
    "wait_confirmed",
    "receipt",
    "can_sign",
    "kind",
];

/// Nothing about the user: answered to proven and unproven connections alike.
pub fn advertise(reply: &mut Value) {
    reply["protocol"] = json!(PROTOCOL);
    reply["kind"] = json!(KIND);
    reply["capabilities"] = json!(CAPABILITIES);
}

pub const LIFECYCLE_METHODS: &[&str] = &[
    "connect",
    "switch_network",
    "send_transaction",
    "sendTransaction",
    "call_contract",
    "callContract",
    "deploy_contract",
    "deployContract",
    "signMessage",
    "sign_transaction",
    "signTransaction",
    "broadcast_only",
    "send_contract_transaction_sequence",
    "register_private_view_key",
    "send_private_transfer",
    "claim_private_transfer",
    "encrypt_balance",
    "decrypt_balance",
];

/// These never submit, whatever their result names.
const NO_SIGNING: &[&str] = &["connect", "switch_network"];

const SUBMITS: &[&str] = &[
    "register_private_view_key",
    "send_transaction",
    "sendTransaction",
    "call_contract",
    "callContract",
    "deploy_contract",
    "deployContract",
    "broadcast_only",
    "send_contract_transaction_sequence",
    "send_private_transfer",
    "claim_private_transfer",
    "encrypt_balance",
    "decrypt_balance",
];

pub const MAX_PER_SITE: usize = 64;
pub const MAX_ACTIVE_PER_SITE: usize = 8;
pub const MAX_RECORDS: usize = 1024;
pub const MAX_WATCHED: usize = 32;
pub const MAX_WATCHED_PER_SITE: usize = 8;
pub const RECORD_TTL: Duration = Duration::from_secs(24 * 3600);
pub const MAX_STORED: usize = 4096;
pub const STATUS_RATE_PER_MINUTE: usize = 120;
pub const RECHECK_EVERY: Duration = Duration::from_secs(5);
const MAX_LISTENERS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Locked,
    ReviewOpen,
    Signing,
    Submitted,
    Confirmed,
    Completed,
    Failed,
    Rejected,
    Expired,
}

impl Status {
    pub fn is_final(self) -> bool {
        matches!(self, Status::Confirmed | Status::Completed | Status::Failed | Status::Rejected | Status::Expired)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Locked => "locked",
            Status::ReviewOpen => "review_open",
            Status::Signing => "signing",
            Status::Submitted => "submitted",
            Status::Confirmed => "confirmed",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Rejected => "rejected",
            Status::Expired => "expired",
        }
    }
}

pub fn parse_rid(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) => {
            Ok(Some(s.clone()))
        }
        Some(_) => Err(()),
    }
}

fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                canonical(&m[k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(x, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Canonical JSON (keys sorted by code point, no whitespace) of `{method, network, params}`,
/// byte for byte as the shared conformance vectors.
pub fn digest(method: &str, params: &Value, network: &str) -> String {
    digest_of(method, params, &json!(network))
}

fn canonical_request(method: &str, params: &Value, network: &Value) -> String {
    let mut text = String::new();
    canonical(&json!({ "method": method, "params": params, "network": network }), &mut text);
    text
}

fn digest_of(method: &str, params: &Value, network: &Value) -> String {
    crate::ws::ws_auth::hex(&Sha256::digest(canonical_request(method, params, network).as_bytes()))
}

fn fits(v: &Value) -> bool {
    serde_json::to_vec(v).map(|b| b.len() <= MAX_STORED).unwrap_or(false)
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn result_hashes(result: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |v: Option<&Value>| {
        if let Some(h) = v.and_then(Value::as_str).filter(|h| is_hash(h)) {
            if out.len() < 32 && !out.iter().any(|o| o == h) {
                out.push(h.to_string());
            }
        }
    };
    add(result.get("txHash"));
    add(result.get("hash"));
    for h in result.get("tx_hashes").and_then(Value::as_array).into_iter().flatten() {
        add(Some(h));
    }
    for r in result.get("results").and_then(Value::as_array).into_iter().flatten() {
        add(r.get("txHash"));
    }
    out
}

#[derive(Clone)]
pub enum Target {
    Socket(mpsc::UnboundedSender<String>),
    /// A page of the in-app browser or a dApp window, reached through the main window.
    Frame(String),
}

pub struct Listener {
    pub conn: u64,
    pub tab_ref: String,
    pub target: Target,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub rid: String,
    pub method: String,
    pub network: String,
    pub address: Option<String>,
    pub status: Status,
    pub hashes: Vec<String>,
    pub epoch: Option<u64>,
    pub receipt: Option<Value>,
    pub receipt_unavailable: Option<String>,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub watching: Option<bool>,
    pub seq: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct View {
    pub connected: bool,
    pub address: bool,
}

impl Card {
    /// A site that is not connected sees `locked` as `review_open`, and no network or address.
    pub fn json(&self, view: View) -> Value {
        let status = if self.status == Status::Locked && !view.connected { Status::ReviewOpen } else { self.status };
        let mut v = json!({
            "requestId": self.rid,
            "status": status.as_str(),
            "method": self.method,
            "seq": self.seq,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        });
        if view.connected {
            v["network"] = json!(self.network);
        }
        if view.address {
            if let Some(a) = &self.address {
                v["address"] = json!(a);
            }
        }
        if let Some(h) = self.hashes.first() {
            v["hash"] = json!(h);
            if self.hashes.len() > 1 {
                v["hashes"] = json!(self.hashes);
            }
        }
        if let Some(e) = self.epoch {
            v["epoch"] = json!(e);
        }
        if self.status == Status::Confirmed {
            if let Some(r) = &self.receipt_unavailable {
                v["receipt"] = Value::Null;
                v["receiptUnavailable"] = json!(r);
            } else if let Some(r) = &self.receipt {
                v["receipt"] = r.clone();
            }
        }
        if let Some(r) = self.result.as_ref().filter(|_| matches!(self.status, Status::Completed | Status::Confirmed)) {
            v["result"] = r.clone();
        }
        if let Some(e) = &self.error {
            v["error"] = e.clone();
        }
        if let Some(w) = self.watching {
            v["watching"] = json!(w);
        }
        v
    }
}

pub fn unknown(rid: &str) -> Value {
    json!({ "requestId": rid, "status": "unknown", "seq": 0 })
}

pub struct LifeRecord {
    pub client_id: String,
    pub origin: String,
    pub digest: String,
    pub wire_id: String,
    pub card: Card,
    pub answer: Option<Value>,
    /// An unproven page may read only ids it sent on its own connection.
    pub senders: Vec<u64>,
    pub listeners: Vec<Listener>,
    pub touched: Instant,
    pub rechecked: Option<Instant>,
    /// Sent by a site not connected at the time: never marked locked, so the unlock changes nothing
    /// it can see.
    pub stranger: bool,
}

impl LifeRecord {
    /// A submitted request nobody watches no longer counts as running, so it never blocks the site.
    pub fn active(&self) -> bool {
        !self.card.status.is_final() && !(self.card.status == Status::Submitted && self.card.watching != Some(true))
    }

    fn listen(&mut self, conn: u64, tab_ref: &str, target: Option<Target>) {
        if !self.senders.contains(&conn) && self.senders.len() < MAX_LISTENERS {
            self.senders.push(conn);
        }
        let Some(target) = target else { return };
        if self.listeners.iter().any(|l| l.conn == conn && l.tab_ref == tab_ref) {
            return;
        }
        self.listeners.retain(|l| !matches!(&l.target, Target::Socket(o) if o.is_closed()));
        if self.listeners.len() < MAX_LISTENERS {
            self.listeners.push(Listener { conn, tab_ref: tab_ref.to_string(), target });
        }
    }

    fn bump(&mut self, now: Instant, now_ms: u64) {
        self.card.seq += 1;
        self.card.updated_at = now_ms.max(self.card.updated_at);
        self.touched = now;
    }
}

#[derive(Debug, PartialEq)]
pub enum Admit {
    New,
    Join(String),
    Stored(Value, Status),
    Reused,
}

pub struct Asker<'a> {
    pub client_id: &'a str,
    pub origin: &'a str,
    pub conn: u64,
    pub tab_ref: &'a str,
    pub proven: bool,
    pub connected: bool,
    pub target: Option<Target>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub id: String,
    pub method: String,
    pub hashes: Vec<String>,
    pub network: String,
    pub address: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Progress {
    Signing,
    #[serde(rename_all = "camelCase")]
    Confirmed {
        epoch: Option<u64>,
        receipt: Option<Value>,
        receipt_unavailable: Option<String>,
        #[serde(default)]
        result: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { code: String, message: String },
    Unwatched,
}

const RECEIPT_UNAVAILABLE: &[&str] = &["not_contract", "refused", "error"];

fn clean_code(code: &str) -> String {
    let ok = !code.is_empty() && code.len() <= 64 && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_');
    if ok { code.to_string() } else { "UNKNOWN_ERROR".to_string() }
}

fn clean_message(m: &str) -> String {
    m.chars().filter(|c| !c.is_control()).take(500).collect()
}

/// The site token is handed out once and never kept.
fn without_token(reply: &Value) -> Value {
    let mut r = reply.clone();
    if let Some(res) = r.get_mut("result").and_then(Value::as_object_mut) {
        res.remove("siteToken");
    }
    r
}

pub fn decorate(reply: &Value, rid: &str, status: Status) -> Value {
    let mut r = reply.clone();
    if let Some(obj) = r.as_object_mut() {
        obj.insert("rid".into(), json!(rid));
        obj.insert("status".into(), json!(status.as_str()));
        if let Some(err) = obj.get_mut("error").and_then(Value::as_object_mut) {
            let details = err.entry("details").or_insert_with(|| Value::Object(Map::new()));
            if let Some(d) = details.as_object_mut() {
                d.insert("requestId".into(), json!(rid));
                d.insert("status".into(), json!(status.as_str()));
            }
        }
    }
    r
}

pub fn outcome(method: &str, reply: &Value) -> Status {
    if let Some(result) = reply.get("result") {
        if !NO_SIGNING.contains(&method) && !result_hashes(result).is_empty() {
            return Status::Submitted;
        }
        return Status::Completed;
    }
    match reply["error"]["code"].as_str() {
        Some("USER_REJECTED") if reply["error"]["details"]["status"] == "expired" => Status::Expired,
        Some("USER_REJECTED") => Status::Rejected,
        _ => Status::Failed,
    }
}

fn error_stage(code: &str, committed: bool) -> &'static str {
    if committed && !matches!(code, "NETWORK_CHANGED" | "WALLET_CHANGED") { "submit" } else { "review" }
}

pub struct RequestLog {
    pub records: Vec<LifeRecord>,
    status_rate: Window,
}

impl Default for RequestLog {
    fn default() -> Self {
        Self { records: Vec::new(), status_rate: Window::new(Duration::from_secs(60), STATUS_RATE_PER_MINUTE) }
    }
}

impl RequestLog {
    fn find(&self, client_id: &str, origin: &str, rid: &str) -> Option<usize> {
        self.records
            .iter()
            .position(|r| r.card.rid == rid && r.origin == origin && r.client_id == client_id)
    }

    pub fn get(&self, client_id: &str, origin: &str, rid: &str) -> Option<&LifeRecord> {
        self.find(client_id, origin, rid).map(|i| &self.records[i])
    }

    pub fn following(&self, wire_id: &str) -> impl Iterator<Item = &LifeRecord> + '_ {
        let id = wire_id.to_string();
        self.records.iter().filter(move |r| r.wire_id == id)
    }

    fn following_mut(&mut self, wire_id: &str) -> impl Iterator<Item = &mut LifeRecord> + '_ {
        let id = wire_id.to_string();
        self.records.iter_mut().filter(move |r| r.wire_id == id)
    }

    pub fn admit(&self, from: &Asker, rid: &str, digest: &str, running: impl Fn(&str) -> bool) -> Admit {
        let Some(rec) = self.get(from.client_id, from.origin, rid) else {
            return Admit::New;
        };
        if rec.digest != digest || (!from.proven && !rec.senders.contains(&from.conn)) {
            return Admit::Reused;
        }
        if !rec.card.status.is_final() && rec.card.status != Status::Submitted && running(&rec.wire_id) {
            return Admit::Join(rec.wire_id.clone());
        }
        let answer = rec.answer.clone().unwrap_or_else(|| {
            json!({ "error": { "code": "STATUS_UNKNOWN", "message": "0xio Desktop no longer holds this result." } })
        });
        Admit::Stored(answer, rec.card.status)
    }

    pub fn join(&mut self, from: &Asker, rid: &str) {
        if let Some(i) = self.find(from.client_id, from.origin, rid) {
            self.records[i].listen(from.conn, from.tab_ref, from.target.clone());
        }
    }

    fn evictable(&self, keep_site: Option<(&str, &str)>) -> Option<usize> {
        self.records
            .iter()
            .enumerate()
            .filter(|(_, r)| !r.active())
            .filter(|(_, r)| keep_site.is_none_or(|(c, o)| r.client_id == c && r.origin == o))
            .min_by_key(|(_, r)| r.touched)
            .map(|(i, _)| i)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        from: &Asker,
        rid: &str,
        digest: &str,
        wire_id: &str,
        method: &str,
        network: &str,
        address: Option<String>,
        now: Instant,
        now_ms: u64,
    ) -> bool {
        let site = |r: &LifeRecord| r.client_id == from.client_id && r.origin == from.origin;
        if self.records.iter().filter(|r| site(r) && r.active()).count() >= MAX_ACTIVE_PER_SITE {
            return false;
        }
        if self.records.iter().filter(|r| site(r)).count() >= MAX_PER_SITE {
            match self.evictable(Some((from.client_id, from.origin))) {
                Some(i) => drop(self.records.remove(i)),
                None => return false,
            }
        }
        if self.records.len() >= MAX_RECORDS {
            match self.evictable(Some((from.client_id, from.origin))).or_else(|| self.evictable(None)) {
                Some(i) => drop(self.records.remove(i)),
                None => return false,
            }
        }
        let mut rec = LifeRecord {
            client_id: from.client_id.to_string(),
            origin: from.origin.to_string(),
            digest: digest.to_string(),
            wire_id: wire_id.to_string(),
            card: Card {
                rid: rid.to_string(),
                method: method.to_string(),
                network: network.to_string(),
                address,
                status: Status::Pending,
                hashes: Vec::new(),
                epoch: None,
                receipt: None,
                receipt_unavailable: None,
                result: None,
                error: None,
                watching: None,
                seq: 1,
                created_at: now_ms,
                updated_at: now_ms,
            },
            answer: None,
            senders: Vec::new(),
            listeners: Vec::new(),
            touched: now,
            rechecked: None,
            stranger: !from.connected,
        };
        rec.listen(from.conn, from.tab_ref, from.target.clone());
        self.records.push(rec);
        true
    }

    pub fn stage(&mut self, wire_id: &str, status: Status, now: Instant, now_ms: u64) -> bool {
        let mut changed = false;
        for r in self.following_mut(wire_id) {
            let status = if status == Status::Locked && r.stranger { Status::ReviewOpen } else { status };
            if matches!(r.card.status, Status::Pending | Status::Locked | Status::ReviewOpen) && r.card.status != status {
                r.card.status = status;
                r.bump(now, now_ms);
                changed = true;
            }
        }
        changed
    }

    /// `locked` may only end rejected, expired or failed, so a request that needed no review after
    /// the unlock shows as open first.
    pub fn unlocked(&mut self, wire_id: &str, now: Instant, now_ms: u64) -> bool {
        let mut changed = false;
        for r in self.following_mut(wire_id).filter(|r| r.card.status == Status::Locked) {
            r.card.status = Status::ReviewOpen;
            r.bump(now, now_ms);
            changed = true;
        }
        changed
    }

    pub fn signing(&mut self, wire_id: &str, now: Instant, now_ms: u64) -> bool {
        let mut changed = false;
        for r in self.following_mut(wire_id) {
            if r.card.status == Status::ReviewOpen && SUBMITS.contains(&r.card.method.as_str()) {
                r.card.status = Status::Signing;
                r.bump(now, now_ms);
                changed = true;
            }
        }
        changed
    }

    pub fn finish(
        &mut self,
        wire_id: &str,
        reply: &Value,
        committed: bool,
        address: Option<&str>,
        now: Instant,
        now_ms: u64,
    ) -> Option<Status> {
        let mut ended = None;
        let stored = without_token(reply);
        for r in self.following_mut(wire_id) {
            if r.card.status.is_final() || r.card.status == Status::Submitted {
                continue;
            }
            let status = outcome(&r.card.method, reply);
            r.card.status = status;
            if let Some(a) = address {
                r.card.address = Some(a.to_string());
            }
            match status {
                Status::Submitted => {
                    r.card.hashes = reply.get("result").map(result_hashes).unwrap_or_default();
                    r.card.watching = Some(false);
                }
                Status::Completed => {
                    r.card.result = stored.get("result").filter(|v| fits(v)).cloned();
                }
                _ => {
                    let code = clean_code(reply["error"]["code"].as_str().unwrap_or_default());
                    let message = clean_message(reply["error"]["message"].as_str().unwrap_or_default());
                    let stage = error_stage(&code, committed);
                    r.card.error = Some(json!({ "code": code, "message": message, "stage": stage }));
                }
            }
            r.answer = if fits(&stored) {
                Some(stored.clone())
            } else if let Some(h) = r.card.hashes.first() {
                Some(json!({ "result": { "txHash": h, "hash": h } }))
            } else {
                None
            };
            r.bump(now, now_ms);
            ended = Some(status);
        }
        ended
    }

    pub fn watch(&mut self, wire_id: &str) -> Option<Watch> {
        let busy = |c: &str, o: &str, rs: &[LifeRecord]| {
            let all = rs.iter().filter(|r| r.card.watching == Some(true)).count();
            let site = rs.iter().filter(|r| r.card.watching == Some(true) && r.client_id == c && r.origin == o).count();
            all >= MAX_WATCHED || site >= MAX_WATCHED_PER_SITE
        };
        let i = self.records.iter().position(|r| {
            r.wire_id == wire_id && r.card.status == Status::Submitted && r.card.watching == Some(false)
        })?;
        if busy(&self.records[i].client_id, &self.records[i].origin, &self.records) {
            return None;
        }
        let watch = {
            let r = &self.records[i];
            Watch {
                id: wire_id.to_string(),
                method: r.card.method.clone(),
                hashes: r.card.hashes.clone(),
                network: r.card.network.clone(),
                address: r.card.address.clone(),
            }
        };
        for r in self.following_mut(wire_id) {
            if r.card.status == Status::Submitted {
                r.card.watching = Some(true);
            }
        }
        Some(watch)
    }

    pub fn progress(&mut self, wire_id: &str, p: &Progress, now: Instant, now_ms: u64) -> bool {
        let mut changed = false;
        for r in self.following_mut(wire_id) {
            if r.card.status != Status::Submitted {
                continue;
            }
            match p {
                Progress::Signing => continue,
                Progress::Confirmed { epoch, receipt, receipt_unavailable, result } => {
                    r.card.status = Status::Confirmed;
                    r.card.epoch = *epoch;
                    r.card.result = result.as_ref().filter(|v| fits(v)).cloned();
                    r.card.watching = None;
                    let unavailable = receipt_unavailable.as_deref().filter(|u| RECEIPT_UNAVAILABLE.contains(u));
                    match (receipt.as_ref().filter(|v| v.is_object()), unavailable) {
                        (_, Some(u)) => r.card.receipt_unavailable = Some(u.to_string()),
                        (Some(rc), None) if fits(rc) => r.card.receipt = Some(rc.clone()),
                        (Some(_), None) => r.card.receipt_unavailable = Some("error".into()),
                        (None, None) => {}
                    }
                }
                Progress::Failed { code, message } => {
                    let (code, message) = (clean_code(code), clean_message(message));
                    r.card.status = Status::Failed;
                    r.card.watching = None;
                    r.answer = Some(json!({ "error": { "code": code, "message": message } }));
                    r.card.error = Some(json!({ "code": code, "message": message, "stage": "execution" }));
                }
                Progress::Unwatched => {
                    if r.card.watching == Some(false) {
                        continue;
                    }
                    r.card.watching = Some(false);
                }
            }
            r.bump(now, now_ms);
            changed = true;
        }
        changed
    }

    /// An unproven page may read only ids it sent on this connection.
    pub fn lookup(&self, client_id: &str, origin: &str, rid: &str, conn: u64, proven: bool) -> Option<&LifeRecord> {
        self.get(client_id, origin, rid).filter(|r| proven || r.senders.contains(&conn))
    }

    pub fn status_allowed(&mut self, client_id: &str, origin: &str, now: Instant) -> bool {
        self.status_rate.hit(&format!("{client_id} {origin}"), now)
    }

    pub fn recheck(&mut self, client_id: &str, origin: &str, rid: &str, now: Instant) -> Option<Watch> {
        let i = self.find(client_id, origin, rid)?;
        let r = &mut self.records[i];
        if r.card.status != Status::Submitted || r.card.watching == Some(true) {
            return None;
        }
        if r.rechecked.is_some_and(|t| now.duration_since(t) < RECHECK_EVERY) {
            return None;
        }
        r.rechecked = Some(now);
        Some(Watch {
            id: r.wire_id.clone(),
            method: r.card.method.clone(),
            hashes: r.card.hashes.clone(),
            network: r.card.network.clone(),
            address: r.card.address.clone(),
        })
    }

    pub fn sweep(&mut self, now: Instant) {
        self.records.retain(|r| r.active() || now.duration_since(r.touched) < RECORD_TTL);
    }

    pub fn forget_site(&mut self, client_id: &str, origin: &str) {
        self.records.retain(|r| !(r.client_id == client_id && r.origin == origin && !r.active()));
    }

    pub fn forget_client(&mut self, client_id: &str) {
        self.records.retain(|r| r.client_id != client_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "https://a.com";
    const B: &str = "https://b.com";
    const CLIENT: &str = "0123456789abcdef0123456789abcdef";
    const HASH: &str = "aa00000000000000000000000000000000000000000000000000000000000001";

    fn rid(n: u8) -> String {
        format!("{:032x}", n)
    }

    fn from(origin: &str, conn: u64) -> Asker<'_> {
        Asker { client_id: CLIENT, origin, conn, tab_ref: "t", proven: true, connected: true, target: None }
    }

    fn open(log: &mut RequestLog, origin: &str, n: u8, method: &str) -> bool {
        let d = digest(method, &json!({}), "mainnet");
        log.open(&from(origin, 1), &rid(n), &d, &rid(n), method, "mainnet", None, Instant::now(), 1)
    }

    fn end(log: &mut RequestLog, n: u8) {
        log.finish(&rid(n), &json!({ "error": { "code": "USER_REJECTED", "message": "no" } }), false, None, Instant::now(), 2);
    }

    #[test]
    fn request_ids_are_32_lowercase_hex() {
        assert_eq!(parse_rid(None), Ok(None));
        assert_eq!(parse_rid(Some(&Value::Null)), Ok(None));
        assert_eq!(parse_rid(Some(&json!(rid(7)))), Ok(Some(rid(7))));
        for bad in [json!("ABCDEF0123456789ABCDEF0123456789"), json!("abc"), json!(7), json!(format!("{}0", rid(1)))] {
            assert_eq!(parse_rid(Some(&bad)), Err(()), "{bad}");
        }
    }

    #[test]
    fn the_digest_matches_the_shared_vectors_byte_for_byte() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../0xio-sdk/conformance/vectors.json");
        let Ok(text) = std::fs::read_to_string(path) else {
            eprintln!("skipped: no 0xio-sdk checkout beside 0xio-desktop");
            return;
        };
        let vectors: Value = serde_json::from_str(&text).unwrap();
        let cases = vectors["digest"].as_array().unwrap();
        assert!(!cases.is_empty());
        for v in cases {
            let method = v["method"].as_str().unwrap();
            let canonical = canonical_request(method, &v["params"], &v["network"]);
            assert_eq!(canonical, v["canonical"].as_str().unwrap(), "{}", v["name"]);
            assert_eq!(digest_of(method, &v["params"], &v["network"]), v["sha256"].as_str().unwrap(), "{}", v["name"]);
            if let Some(n) = v["network"].as_str() {
                assert_eq!(digest(method, &v["params"], n), v["sha256"].as_str().unwrap());
            }
        }
        for good in vectors["requestId"]["valid"].as_array().unwrap() {
            assert!(parse_rid(Some(good)).unwrap().is_some());
        }
        for bad in vectors["requestId"]["invalid"].as_array().unwrap() {
            assert!(parse_rid(Some(bad)).is_err(), "{bad}");
        }
        let finals: Vec<&str> = vectors["finalStatuses"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for s in [Status::Confirmed, Status::Completed, Status::Failed, Status::Rejected, Status::Expired] {
            assert!(finals.contains(&s.as_str()));
        }
        for c in CAPABILITIES {
            assert!(vectors["capabilities"].as_array().unwrap().iter().any(|x| x == c), "{c}");
        }
        let limits = &vectors["limits"];
        assert_eq!(limits["recordsPerOrigin"], MAX_PER_SITE);
        assert_eq!(limits["openPerOrigin"], MAX_ACTIVE_PER_SITE);
        assert_eq!(limits["recordsGlobal"], MAX_RECORDS);
        assert_eq!(limits["recordTtlMs"], RECORD_TTL.as_millis() as u64);
        assert_eq!(limits["resultMaxBytes"], MAX_STORED);
        assert_eq!(limits["watchedPerWallet"], MAX_WATCHED);
        assert_eq!(limits["watchedPerOrigin"], MAX_WATCHED_PER_SITE);
        assert_eq!(limits["reviewWindowMs"], crate::ws::ws_sites::REVIEW_WINDOW.as_millis() as u64);
        for m in vectors["lifecycleMethods"].as_array().unwrap() {
            assert!(LIFECYCLE_METHODS.contains(&m.as_str().unwrap()), "{m}");
        }
        for m in vectors["transactionMethods"].as_array().unwrap().iter().filter_map(Value::as_str) {
            assert!(SUBMITS.contains(&m), "{m}");
        }
    }

    #[test]
    fn moves_follow_the_shared_transitions() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../0xio-sdk/conformance/vectors.json");
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let vectors: Value = serde_json::from_str(&text).unwrap();
        let allowed = |from: Status, to: Status| {
            vectors["transitions"][from.as_str()].as_array().unwrap().iter().any(|s| s == to.as_str())
        };
        let now = Instant::now();
        let tx = json!({ "result": { "txHash": HASH } });
        let flows: [(u8, &str, &[Status]); 6] = [
            (1, "send_transaction", &[Status::ReviewOpen, Status::Signing, Status::Submitted, Status::Confirmed]),
            (2, "call_contract", &[Status::ReviewOpen, Status::Signing, Status::Submitted, Status::Failed]),
            (3, "signMessage", &[Status::ReviewOpen, Status::Completed]),
            (4, "register_private_view_key", &[Status::ReviewOpen, Status::Signing, Status::Submitted, Status::Confirmed]),
            (5, "connect", &[Status::Locked, Status::ReviewOpen, Status::Completed]),
            (6, "broadcast_only", &[Status::Submitted]),
        ];
        let mut log = RequestLog::default();
        for (n, method, steps) in flows {
            assert!(open(&mut log, A, n, method));
            let mut at = Status::Pending;
            for step in steps {
                match step {
                    Status::Locked | Status::ReviewOpen => drop(log.stage(&rid(n), *step, now, 2)),
                    Status::Signing => drop(log.signing(&rid(n), now, 3)),
                    Status::Submitted => drop(log.finish(&rid(n), &tx, true, None, now, 4)),
                    Status::Completed => drop(log.finish(&rid(n), &json!({ "result": { "ok": true } }), true, None, now, 4)),
                    Status::Confirmed => drop(log.progress(
                        &rid(n),
                        &Progress::Confirmed { epoch: Some(1), receipt: None, receipt_unavailable: None, result: None },
                        now,
                        5,
                    )),
                    Status::Failed => drop(log.progress(
                        &rid(n),
                        &Progress::Failed { code: "EXECUTION_FAILED".into(), message: "m".into() },
                        now,
                        5,
                    )),
                    _ => unreachable!(),
                }
                let next = log.get(CLIENT, A, &rid(n)).unwrap().card.status;
                assert_eq!(next, *step, "{method}");
                assert!(allowed(at, next), "{method}: {at:?} -> {next:?}");
                at = next;
            }
            assert!(!log.signing(&rid(n), now, 9) && !log.stage(&rid(n), Status::ReviewOpen, now, 9), "final");
        }
        let failed = log.get(CLIENT, A, &rid(2)).unwrap();
        assert_eq!(failed.answer.as_ref().unwrap()["error"]["code"], "EXECUTION_FAILED", "a repeat gets the chain's verdict");
    }

    #[test]
    fn the_digest_ignores_key_order_and_names_the_network() {
        let a = digest("send_transaction", &json!({ "to": "oct1", "amount": "5" }), "mainnet");
        let b = digest("send_transaction", &json!({ "amount": "5", "to": "oct1" }), "mainnet");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(a, digest("send_transaction", &json!({ "amount": "5", "to": "oct1" }), "devnet"));
        assert_ne!(a, digest("send_transaction", &json!({ "amount": "6", "to": "oct1" }), "mainnet"));
        assert_ne!(a, digest("call_contract", &json!({ "amount": "5", "to": "oct1" }), "mainnet"));
        let mut text = String::new();
        canonical(&json!({ "b": [1, { "d": 2, "c": "x" }], "a": null }), &mut text);
        assert_eq!(text, r#"{"a":null,"b":[1,{"c":"x","d":2}]}"#);
    }

    #[test]
    fn a_known_id_joins_returns_its_answer_or_is_refused() {
        let mut log = RequestLog::default();
        let d = digest("signMessage", &json!({}), "mainnet");
        assert_eq!(log.admit(&from(A, 1), &rid(1), &d, |_| true), Admit::New);
        assert!(open(&mut log, A, 1, "signMessage"));
        assert_eq!(log.admit(&from(A, 2), &rid(1), &d, |_| true), Admit::Join(rid(1)));
        let other = digest("signMessage", &json!({ "message": "x" }), "mainnet");
        assert_eq!(log.admit(&from(A, 2), &rid(1), &other, |_| true), Admit::Reused);
        assert_eq!(log.admit(&from(B, 2), &rid(1), &d, |_| true), Admit::New, "another origin never sees it");

        log.finish(&rid(1), &json!({ "result": { "signature": "s" } }), true, None, Instant::now(), 2);
        match log.admit(&from(A, 3), &rid(1), &d, |_| false) {
            Admit::Stored(answer, status) => {
                assert_eq!(answer["result"]["signature"], "s");
                assert_eq!(status, Status::Completed);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failed_or_rejected_id_never_runs_again() {
        for reply in [
            json!({ "error": { "code": "USER_REJECTED", "message": "no" } }),
            json!({ "error": { "code": "USER_REJECTED", "message": "late", "details": { "status": "expired" } } }),
            json!({ "error": { "code": "TRANSACTION_FAILED", "message": "boom" } }),
        ] {
            let mut log = RequestLog::default();
            let d = digest("send_transaction", &json!({}), "mainnet");
            assert!(open(&mut log, A, 1, "send_transaction"));
            let ended = log.finish(&rid(1), &reply, false, None, Instant::now(), 2).unwrap();
            assert!(ended.is_final());
            match log.admit(&from(A, 1), &rid(1), &d, |_| true) {
                Admit::Stored(answer, status) => {
                    assert_eq!(status, ended);
                    assert_eq!(answer["error"]["code"], reply["error"]["code"]);
                }
                other => panic!("a final {ended:?} must answer from the record, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_submitted_request_keeps_its_hash_and_moves_only_forward() {
        let mut log = RequestLog::default();
        assert!(open(&mut log, A, 1, "send_transaction"));
        let now = Instant::now();
        assert!(log.stage(&rid(1), Status::ReviewOpen, now, 2));
        assert!(log.signing(&rid(1), now, 3));
        let reply = json!({ "result": { "txHash": HASH } });
        assert_eq!(log.finish(&rid(1), &reply, true, None, now, 4), Some(Status::Submitted));
        let card = &log.get(CLIENT, A, &rid(1)).unwrap().card;
        assert_eq!(card.hashes, vec![HASH.to_string()]);
        assert_eq!(card.seq, 4);
        let w = log.watch(&rid(1)).unwrap();
        assert_eq!(w.hashes, vec![HASH.to_string()]);
        assert!(log.watch(&rid(1)).is_none(), "one watch per request");
        assert!(!log.stage(&rid(1), Status::ReviewOpen, now, 5), "a submitted request never goes back");
        let ok = Progress::Confirmed { epoch: Some(9), receipt: Some(json!({ "success": true, "events": [] })), receipt_unavailable: None, result: None };
        assert!(log.progress(&rid(1), &ok, now, 6));
        let card = &log.get(CLIENT, A, &rid(1)).unwrap().card;
        assert_eq!(card.status, Status::Confirmed);
        let j = card.json(View { connected: true, address: true });
        assert_eq!(j["status"], "confirmed");
        assert_eq!(j["hash"], HASH);
        assert_eq!(j["epoch"], 9);
        assert_eq!(j["receipt"]["success"], true);
        assert!(!log.progress(&rid(1), &Progress::Failed { code: "X".into(), message: "y".into() }, now, 7), "final");
    }

    #[test]
    fn a_confirmed_registration_carries_its_result() {
        let mut log = RequestLog::default();
        assert!(open(&mut log, A, 1, "register_private_view_key"));
        log.stage(&rid(1), Status::ReviewOpen, Instant::now(), 2);
        assert!(log.signing(&rid(1), Instant::now(), 3));
        log.finish(&rid(1), &json!({ "result": { "txHash": HASH, "status": "submitted" } }), true, None, Instant::now(), 4);
        let result = json!({ "status": "registered", "view_pubkey": "dmlldw==", "pvac": true });
        let done = Progress::Confirmed { epoch: Some(3), receipt: None, receipt_unavailable: Some("not_contract".into()), result: Some(result.clone()) };
        assert!(log.progress(&rid(1), &done, Instant::now(), 5));
        let j = log.get(CLIENT, A, &rid(1)).unwrap().card.json(View { connected: true, address: true });
        assert_eq!(j["status"], "confirmed");
        assert_eq!(j["result"], result);
    }

    #[test]
    fn a_chain_rejection_fails_at_execution() {
        let mut log = RequestLog::default();
        assert!(open(&mut log, A, 1, "call_contract"));
        log.signing(&rid(1), Instant::now(), 2);
        log.finish(&rid(1), &json!({ "result": { "txHash": HASH, "hash": HASH } }), true, None, Instant::now(), 3);
        let failed = Progress::Failed { code: "EXECUTION_FAILED".into(), message: "out of ou".into() };
        assert!(log.progress(&rid(1), &failed, Instant::now(), 4));
        let j = log.get(CLIENT, A, &rid(1)).unwrap().card.json(View { connected: true, address: true });
        assert_eq!(j["status"], "failed");
        assert_eq!(j["error"]["stage"], "execution");
    }

    #[test]
    fn errors_say_where_they_happened() {
        let mut log = RequestLog::default();
        for (n, code, committed, stage) in [
            (1, "TRANSACTION_FAILED", true, "submit"),
            (2, "NETWORK_CHANGED", true, "review"),
            (3, "WATCH_ONLY", false, "review"),
        ] {
            assert!(open(&mut log, A, n, "send_transaction"));
            log.finish(&rid(n), &json!({ "error": { "code": code, "message": "m" } }), committed, None, Instant::now(), 2);
            let card = &log.get(CLIENT, A, &rid(n)).unwrap().card;
            assert_eq!(card.status, Status::Failed);
            assert_eq!(card.error.as_ref().unwrap()["stage"], stage, "{code}");
        }
    }

    #[test]
    fn a_connect_completes_and_never_keeps_the_site_token() {
        let mut log = RequestLog::default();
        assert!(open(&mut log, A, 1, "connect"));
        assert!(!log.signing(&rid(1), Instant::now(), 2), "a connect signs nothing");
        let reply = json!({ "result": { "address": "oct1", "siteToken": "secret", "txHash": HASH } });
        assert_eq!(log.finish(&rid(1), &reply, true, Some("oct1"), Instant::now(), 3), Some(Status::Completed));
        let rec = log.get(CLIENT, A, &rid(1)).unwrap();
        assert!(rec.answer.as_ref().unwrap()["result"].get("siteToken").is_none());
        assert!(rec.card.result.as_ref().unwrap().get("siteToken").is_none());
        assert_eq!(rec.card.address.as_deref(), Some("oct1"));
    }

    #[test]
    fn a_strangers_request_is_never_marked_locked_so_the_unlock_shows_nothing() {
        let mut log = RequestLog::default();
        let d = digest("connect", &json!({}), "mainnet");
        let stranger = Asker { client_id: CLIENT, origin: A, conn: 1, tab_ref: "t", proven: true, connected: false, target: None };
        log.open(&stranger, &rid(1), &d, &rid(1), "connect", "mainnet", None, Instant::now(), 1);
        assert!(log.stage(&rid(1), Status::Locked, Instant::now(), 2));
        let before = log.get(CLIENT, A, &rid(1)).unwrap().card.clone();
        assert_eq!(before.status, Status::ReviewOpen);
        assert!(!log.stage(&rid(1), Status::ReviewOpen, Instant::now(), 9), "the unlock changes nothing");
        let after = &log.get(CLIENT, A, &rid(1)).unwrap().card;
        assert_eq!((after.seq, after.updated_at), (before.seq, before.updated_at));

        assert!(open(&mut log, A, 2, "signMessage"));
        assert!(log.stage(&rid(2), Status::Locked, Instant::now(), 2));
        assert_eq!(log.get(CLIENT, A, &rid(2)).unwrap().card.status, Status::Locked);
        assert!(log.stage(&rid(2), Status::ReviewOpen, Instant::now(), 3), "a connected site sees the unlock");
    }

    #[test]
    fn an_unconnected_site_sees_locked_as_review_open_and_no_address() {
        let mut log = RequestLog::default();
        let d = digest("connect", &json!({}), "mainnet");
        log.open(&from(A, 1), &rid(1), &d, &rid(1), "connect", "mainnet", Some("oct1".into()), Instant::now(), 1);
        log.stage(&rid(1), Status::Locked, Instant::now(), 2);
        let card = &log.get(CLIENT, A, &rid(1)).unwrap().card;
        let outside = card.json(View { connected: false, address: false });
        assert_eq!(outside["status"], "review_open");
        assert!(outside.get("address").is_none());
        assert!(outside.get("network").is_none());
        let inside = card.json(View { connected: true, address: true });
        assert_eq!(inside["status"], "locked");
        assert_eq!(inside["address"], "oct1");
        assert_eq!(inside["network"], "mainnet");
    }

    #[test]
    fn an_unproven_page_reads_and_joins_only_its_own_ids() {
        let mut log = RequestLog::default();
        let d = digest("connect", &json!({}), "mainnet");
        let mine = Asker { client_id: CLIENT, origin: A, conn: 5, tab_ref: "t", proven: false, connected: false, target: None };
        assert!(log.open(&mine, &rid(1), &d, &rid(1), "connect", "mainnet", None, Instant::now(), 1));
        assert!(log.lookup(CLIENT, A, &rid(1), 5, false).is_some());
        assert!(log.lookup(CLIENT, A, &rid(1), 6, false).is_none(), "another unproven connection");
        assert!(log.lookup(CLIENT, A, &rid(1), 6, true).is_some(), "the proven site reads any of its ids");
        assert!(log.lookup(CLIENT, B, &rid(1), 6, true).is_none(), "never another origin's");
        assert!(log.lookup("other", A, &rid(1), 5, true).is_none(), "never another carrier's");
        let stranger = Asker { conn: 6, ..mine };
        assert_eq!(log.admit(&stranger, &rid(1), &d, |_| true), Admit::Reused);
        let again = Asker { conn: 5, ..stranger };
        assert_eq!(log.admit(&again, &rid(1), &d, |_| true), Admit::Join(rid(1)));
    }

    #[test]
    fn a_site_runs_at_most_eight_and_keeps_at_most_sixty_four() {
        let mut log = RequestLog::default();
        for n in 0..8 {
            assert!(open(&mut log, A, n, "signMessage"));
        }
        assert!(!open(&mut log, A, 8, "signMessage"), "the ninth running request is refused");
        assert!(open(&mut log, B, 8, "signMessage"), "another site is not held back");
        for n in 0..8 {
            end(&mut log, n);
        }
        for n in 8..(MAX_PER_SITE as u8 + 8) {
            assert!(open(&mut log, A, n, "signMessage"));
            end(&mut log, n);
        }
        let mine = log.records.iter().filter(|r| r.origin == A).count();
        assert_eq!(mine, MAX_PER_SITE);
        assert!(log.get(CLIENT, A, &rid(0)).is_none(), "the oldest ended record went first");
        assert!(log.get(CLIENT, B, &rid(8)).is_some(), "never another site's");
    }

    #[test]
    fn the_whole_log_is_bounded_and_evicts_only_ended_records() {
        let mut log = RequestLog::default();
        let mut n: u32 = 0;
        let rid_of = |n: u32| format!("{:032x}", n);
        while log.records.len() < MAX_RECORDS {
            let origin = format!("https://s{}.com", n % 200);
            let f = Asker { client_id: CLIENT, origin: &origin, conn: 1, tab_ref: "t", proven: true, connected: true, target: None };
            assert!(log.open(&f, &rid_of(n), "d", &rid_of(n), "signMessage", "mainnet", None, Instant::now(), 1));
            log.finish(&rid_of(n), &json!({ "result": {} }), true, None, Instant::now(), 2);
            n += 1;
        }
        assert!(open(&mut log, A, 1, "signMessage"));
        assert_eq!(log.records.len(), MAX_RECORDS);
        assert!(log.get(CLIENT, "https://s0.com", &rid_of(0)).is_none());
    }

    #[test]
    fn records_last_a_day_after_their_last_change() {
        let mut log = RequestLog::default();
        assert!(open(&mut log, A, 1, "signMessage"));
        assert!(open(&mut log, A, 2, "signMessage"));
        end(&mut log, 1);
        let later = Instant::now() + RECORD_TTL;
        log.sweep(later);
        assert!(log.get(CLIENT, A, &rid(1)).is_none());
        assert!(log.get(CLIENT, A, &rid(2)).is_some(), "a running request stays");
    }

    #[test]
    fn watch_slots_are_bounded_per_site() {
        let mut log = RequestLog::default();
        for n in 0..9u8 {
            assert!(open(&mut log, A, n, "send_transaction"));
            let h = format!("{:064x}", n + 1);
            log.finish(&rid(n), &json!({ "result": { "txHash": h } }), true, None, Instant::now(), 2);
        }
        let watched = (0..9u8).filter(|n| log.watch(&rid(*n)).is_some()).count();
        assert_eq!(watched, MAX_WATCHED_PER_SITE);
        let unwatched = log.get(CLIENT, A, &rid(8)).unwrap();
        assert_eq!(unwatched.card.watching, Some(false));
        assert!(!unwatched.active(), "a submitted request nobody watches does not hold a running slot");
        assert!(log.recheck(CLIENT, A, &rid(8), Instant::now()).is_some());
        assert!(log.recheck(CLIENT, A, &rid(8), Instant::now()).is_none(), "at most every 5 s");
        assert!(log.recheck(CLIENT, A, &rid(0), Instant::now()).is_none(), "a watched one is not read again");
    }

    #[test]
    fn hashes_come_from_every_result_shape() {
        let h2 = format!("{:064x}", 2);
        assert_eq!(result_hashes(&json!({ "txHash": HASH, "hash": HASH })), vec![HASH.to_string()]);
        assert_eq!(result_hashes(&json!({ "tx_hashes": [HASH, h2] })), vec![HASH.to_string(), h2.clone()]);
        assert_eq!(result_hashes(&json!({ "results": [{ "index": 0, "txHash": h2 }] })), vec![h2]);
        assert!(result_hashes(&json!({ "txHash": "nothex" })).is_empty());
        assert!(result_hashes(&json!({ "signature": "s" })).is_empty());
    }

    #[test]
    fn replies_carry_the_id_and_status() {
        let r = decorate(&json!({ "error": { "code": "USER_REJECTED", "message": "no" } }), &rid(1), Status::Rejected);
        assert_eq!(r["rid"], rid(1));
        assert_eq!(r["status"], "rejected");
        assert_eq!(r["error"]["details"]["requestId"], rid(1));
        assert_eq!(r["error"]["details"]["status"], "rejected");
        let ok = decorate(&json!({ "result": { "txHash": HASH } }), &rid(1), Status::Submitted);
        assert_eq!(ok["status"], "submitted");
        assert!(ok["result"].get("details").is_none());
    }

    #[test]
    fn progress_reads_the_main_window_shape() {
        let p: Progress = serde_json::from_value(json!({ "status": "confirmed", "epoch": 4, "receiptUnavailable": "refused" })).unwrap();
        assert_eq!(p, Progress::Confirmed { epoch: Some(4), receipt: None, receipt_unavailable: Some("refused".into()), result: None });
        let p: Progress = serde_json::from_value(json!({ "status": "signing" })).unwrap();
        assert_eq!(p, Progress::Signing);
        let p: Progress = serde_json::from_value(json!({ "status": "failed", "code": "EXECUTION_FAILED", "message": "m" })).unwrap();
        assert!(matches!(p, Progress::Failed { .. }));
        assert!(serde_json::from_value::<Progress>(json!({ "status": "completed" })).is_err());
    }
}
