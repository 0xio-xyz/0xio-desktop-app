use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::sites::site_lifecycle::{self, Admit, Asker, RequestLog, Status};
use crate::ws::ws_auth::{Client, Session, Window};

pub const MAX_WAITING_PER_SITE: usize = 3;
pub const SITE_RATE_PER_MINUTE: usize = 60;

pub const DIRECT: &str = "direct";
/// No record is ever kept under it, so the page gets what an unconnected site gets.
pub const DIRECT_UNPROVEN: &str = "direct-unproven";
pub const DIRECT_BROWSER: &str = "web";

pub const RELAY_NETWORKS: &[&str] = &["mainnet", "devnet"];

pub const RELAY_METHODS: &[&str] = &[
    "connect",
    "disconnect",
    "getAddress",
    "getBalance",
    "get_balance",
    "getWalletInfo",
    "getPublicKey",
    "getNetworkInfo",
    "get_network_info",
    "getConnectionStatus",
    "register_dapp",
    "switch_network",
    "send_transaction",
    "sendTransaction",
    "call_contract",
    "callContract",
    "contract_call_view",
    "contractCallView",
    "get_contract_storage",
    "getContractStorage",
    "deploy_contract",
    "deployContract",
    "signMessage",
    "sign_transaction",
    "signTransaction",
    "broadcast_only",
    "send_contract_transaction_sequence",
    "getTransactionHistory",
    "get_transaction_history",
    "rpc_call",
    "get_private_balance_info",
    "get_private_capabilities",
    "get_private_balance",
    "encrypt_value",
    "decrypt_value",
    "make_zero_proof",
    "make_range_proof",
    "register_private_view_key",
    "send_private_transfer",
    "get_pending_private_transfers",
    "claim_private_transfer",
];

pub const OPEN_METHODS: &[&str] = &[
    "connect",
    "disconnect",
    "register_dapp",
    "getNetworkInfo",
    "get_network_info",
    "getConnectionStatus",
    "contract_call_view",
    "contractCallView",
    "get_contract_storage",
    "getContractStorage",
    "rpc_call",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: &'static str,
}

impl Refusal {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub fn json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

pub const AUTH_REQUIRED: Refusal = Refusal::new(
    "AUTH_REQUIRED",
    "Only a paired 0xio extension that proved its pairing can carry a site.",
);
pub const INVALID: Refusal = Refusal::new("INVALID_PARAMS", "Malformed site request.");
pub const BAD_ORIGIN: Refusal = Refusal::new("INVALID_PARAMS", "That site cannot use 0xio Desktop.");
pub const NOT_ALLOWED: Refusal =
    Refusal::new("METHOD_NOT_ALLOWED", "0xio Desktop does not answer this method for a site.");
pub const NOT_CONNECTED: Refusal =
    Refusal::new("NOT_CONNECTED", "This site is not connected to 0xio Desktop.");
pub const TOO_MANY_WAITING: Refusal = Refusal::new(
    "RATE_LIMIT_EXCEEDED",
    "3 requests from this site are already waiting in 0xio Desktop.",
);
pub const TOO_FAST: Refusal =
    Refusal::new("RATE_LIMIT_EXCEEDED", "Too many requests from this site. Slow down.");
pub const REJECTED: Refusal = Refusal::new("USER_REJECTED", "Rejected in 0xio Desktop.");
pub const CANCELLED: Refusal = Refusal::new("USER_REJECTED", "The request was cancelled.");
pub const CLOSED: Refusal = Refusal::new("USER_REJECTED", "The page closed before 0xio Desktop answered.");
pub const TOO_LARGE: Refusal = Refusal::new("INVALID_PARAMS", "Site request is too large.");
pub const RECENTLY_REJECTED: Refusal =
    Refusal::new("USER_REJECTED", "Rejected in 0xio Desktop a moment ago. Try again shortly.");
pub const PAGE_TOO_FAST: Refusal = Refusal::new("RATE_LIMITED", "Too many requests from this page. Slow down.");
pub const PAGE_RATE_PER_SECOND: usize = 20;
pub const BAD_RID: Refusal = Refusal::new("INVALID_PARAMS", "Malformed request id.");
pub const REQUEST_ID_REUSED: Refusal =
    Refusal::new("REQUEST_ID_REUSED", "This request id belongs to another request. Make a new id.");
pub const TOO_MANY_RUNNING: Refusal = Refusal::new(
    "RATE_LIMIT_EXCEEDED",
    "8 requests from this site are still running in 0xio Desktop.",
);

pub const REVIEW_WINDOW: Duration = Duration::from_secs(300);

/// Still `USER_REJECTED`, so old sites read it as before.
pub fn expired_reply() -> Value {
    json!({ "error": {
        "code": "USER_REJECTED",
        "message": "The review in 0xio Desktop was not answered in 5 minutes.",
        "details": { "status": "expired" },
    } })
}

/// So a site cannot put a review back up at once.
pub const REJECT_COOLDOWN: Duration = Duration::from_secs(5);

/// A legacy (unpaired) extension, a paired program and anything not yet proven are refused.
pub fn site_client<'a>(client: &Client, session: &Session, ext_client: Option<&'a str>) -> Result<&'a str, Refusal> {
    match (client, ext_client) {
        (Client::Extension(_), Some(id)) if session.trusted => Ok(id),
        _ => Err(AUTH_REQUIRED),
    }
}

pub fn browser_of(client: &Client) -> &'static str {
    match client {
        Client::Extension(o) if o.starts_with("moz-extension://") => "firefox",
        _ => "chrome",
    }
}

const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

/// Exactly an origin: `https`, or `http` on this machine in a development build. Null, opaque
/// and `file:` origins never pass.
pub fn relay_origin(raw: &str, dev: bool) -> Option<String> {
    if raw.is_empty() || raw.len() > 255 || !raw.is_ascii() || raw.eq_ignore_ascii_case("null") {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let origin = url.origin();
    if !origin.is_tuple() {
        return None;
    }
    let serialized = origin.ascii_serialization();
    if serialized != raw {
        return None;
    }
    match url.scheme() {
        "https" => Some(serialized),
        "http" if dev && url.host_str().is_some_and(|h| LOCAL_HOSTS.contains(&h)) => Some(serialized),
        _ => None,
    }
}

/// Anything beyond scheme, host and port is refused, never cut away.
pub fn web_origin(raw: &str, dev: bool) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 255 || !raw.is_ascii() {
        return None;
    }
    let (_, rest) = raw.split_once("://")?;
    if rest.is_empty() || rest.contains(['/', '\\', '@', '?', '#']) {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    relay_origin(&url.origin().ascii_serialization(), dev)
}

fn top_origin(raw: &str) -> Option<String> {
    if raw.len() > 255 {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let s = url.origin().ascii_serialization();
    (s == raw).then_some(s)
}

fn is_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn dev_build() -> bool {
    cfg!(debug_assertions)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelaySite {
    pub origin: String,
    pub top_origin: Option<String>,
    pub framed: bool,
    pub tab_ref: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SiteRequest {
    pub id: String,
    pub site: RelaySite,
    pub network: String,
    pub method: String,
    pub params: Value,
    pub rid: Option<String>,
    pub digest: Option<String>,
}

/// A contract deploy of 512 KiB bytecode as base64 (683 KiB) with 64 KiB of constructor params fits.
pub const MAX_SITE_PARAMS: usize = 896 * 1024;

fn fits(v: &Value, max: usize) -> bool {
    struct Count {
        n: usize,
        max: usize,
    }
    impl std::io::Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.n += b.len();
            if self.n > self.max {
                return Err(std::io::ErrorKind::OutOfMemory.into());
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Count { n: 0, max }, v).is_ok()
}

/// The site comes only from `site.origin`, never from the params.
pub fn parse_request(msg: &Value, dev: bool) -> Result<SiteRequest, Refusal> {
    let id = msg.get("id").and_then(Value::as_str).filter(|s| is_hex32(s)).ok_or(INVALID)?;
    let site = msg.get("site").filter(|s| s.is_object()).ok_or(INVALID)?;
    let raw_origin = site.get("origin").and_then(Value::as_str).ok_or(INVALID)?;
    let origin = relay_origin(raw_origin, dev).ok_or(BAD_ORIGIN)?;
    let tab_ref = site.get("tab_ref").and_then(Value::as_str).filter(|s| is_hex32(s)).ok_or(INVALID)?;
    let framed = site.get("framed").and_then(Value::as_bool).unwrap_or(false);
    let top = site.get("top_origin").and_then(Value::as_str).and_then(top_origin);
    let network = msg.get("network").and_then(Value::as_str).filter(|n| RELAY_NETWORKS.contains(n)).ok_or(INVALID)?;
    let request = msg.get("request").filter(|r| r.is_object()).ok_or(INVALID)?;
    let method = request.get("method").and_then(Value::as_str).ok_or(INVALID)?;
    if !RELAY_METHODS.contains(&method) {
        return Err(NOT_ALLOWED);
    }
    let params = match request.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(p) if !fits(p, MAX_SITE_PARAMS) => return Err(TOO_LARGE),
        Some(p) => p.clone(),
    };
    let rid = site_lifecycle::parse_rid(msg.get("rid"))
        .map_err(|_| BAD_RID)?
        .filter(|_| site_lifecycle::LIFECYCLE_METHODS.contains(&method));
    let digest = rid.as_ref().map(|_| site_lifecycle::digest(method, &params, network));
    Ok(SiteRequest {
        id: id.to_ascii_lowercase(),
        site: RelaySite { origin, top_origin: top, framed, tab_ref: tab_ref.to_ascii_lowercase() },
        network: network.to_string(),
        method: method.to_string(),
        params,
        rid,
        digest,
    })
}


#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SiteRecord {
    pub origin: String,
    pub network: String,
    pub address: String,
    pub client_id: String,
    pub browser: String,
    pub wallet_id: String,
    pub wallet_name: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Milliseconds.
    pub connected_at: u64,
    /// Milliseconds; kept in memory between saves.
    #[serde(default)]
    pub last_request: Option<u64>,
}

impl SiteRecord {
    fn is(&self, network: &str, origin: &str, client_id: &str) -> bool {
        self.network == network && self.origin == origin && self.client_id == client_id
    }
}

/// The token itself is handed to the page once and never kept.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SiteToken {
    pub origin: String,
    pub client_id: String,
    pub hash: String,
}

pub const SITE_TOKEN_LEN: usize = 43;

pub fn new_site_token() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(crate::ws::ws_auth::random32())
}

fn token_shape(token: &str) -> bool {
    token.len() == SITE_TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Takes the same time wherever the inputs differ.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct SiteStore {
    #[serde(default)]
    pub sites: Vec<SiteRecord>,
    #[serde(default)]
    pub tokens: Vec<SiteToken>,
}

impl SiteStore {
    pub fn issue_token(&mut self, origin: &str, client_id: &str) -> String {
        let token = new_site_token();
        self.tokens.retain(|t| !(t.origin == origin && t.client_id == client_id));
        self.tokens.push(SiteToken {
            origin: origin.to_string(),
            client_id: client_id.to_string(),
            hash: crate::ws::ws_auth::token_hash(&token),
        });
        token
    }

    pub fn token_matches(&self, origin: &str, client_id: &str, token: &str) -> bool {
        if !token_shape(token) || !self.sites.iter().any(|s| s.origin == origin && s.client_id == client_id) {
            return false;
        }
        let Some(kept) = self.tokens.iter().find(|t| t.origin == origin && t.client_id == client_id) else {
            return false;
        };
        ct_eq(kept.hash.as_bytes(), crate::ws::ws_auth::token_hash(token).as_bytes())
    }

    /// Nothing could use those records without the token, so they go on every network.
    pub fn revoke(&mut self, origin: &str, client_id: &str) -> Vec<SiteRecord> {
        self.tokens.retain(|t| !(t.origin == origin && t.client_id == client_id));
        let (gone, kept): (Vec<_>, Vec<_>) =
            self.sites.drain(..).partition(|s| s.origin == origin && s.client_id == client_id);
        self.sites = kept;
        gone
    }

    pub fn get(&self, network: &str, origin: &str, client_id: &str) -> Option<&SiteRecord> {
        self.sites.iter().find(|s| s.is(network, origin, client_id))
    }

    pub fn resolve(&self, origin: &str, client_id: &str, network: &str) -> Option<&SiteRecord> {
        self.get(network, origin, client_id).or_else(|| {
            self.sites
                .iter()
                .filter(|s| s.origin == origin && s.client_id == client_id)
                .max_by_key(|s| s.connected_at)
        })
    }

    pub fn connect(&mut self, rec: SiteRecord) {
        self.sites.retain(|s| !s.is(&rec.network, &rec.origin, &rec.client_id));
        self.sites.push(rec);
    }

    pub fn disconnect(&mut self, network: &str, origin: &str, client_id: &str) -> Option<SiteRecord> {
        let at = self.sites.iter().position(|s| s.is(network, origin, client_id))?;
        Some(self.sites.remove(at))
    }

    pub fn switch_network(&mut self, origin: &str, client_id: &str, from: &str, to: &str, now: u64) -> bool {
        let Some(mut rec) = self.disconnect(from, origin, client_id) else {
            return false;
        };
        if self.get(to, origin, client_id).is_none() {
            rec.network = to.to_string();
            rec.connected_at = now;
            self.sites.push(rec);
        }
        true
    }

    pub fn forget_client(&mut self, client_id: &str) -> Vec<SiteRecord> {
        let (gone, kept): (Vec<_>, Vec<_>) = self.sites.drain(..).partition(|s| s.client_id == client_id);
        self.sites = kept;
        gone
    }

    pub fn note_request(&mut self, network: &str, origin: &str, client_id: &str, now: u64) {
        if let Some(s) = self.sites.iter_mut().find(|s| s.is(network, origin, client_id)) {
            s.last_request = Some(now);
        }
    }

    pub fn snapshot_for(&self, client_id: &str, origin: Option<&str>) -> Value {
        let mut mine: Vec<&SiteRecord> = self
            .sites
            .iter()
            .filter(|s| s.client_id == client_id && origin.is_none_or(|o| s.origin == o))
            .collect();
        mine.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
        let sites: Vec<Value> = mine
            .into_iter()
            .map(|s| {
                json!({
                    "origin": s.origin,
                    "network": s.network,
                    "address": s.address,
                    "wallet": { "name": s.wallet_name, "seed": s.address },
                    "relayed_by": s.client_id,
                    "connected_at": s.connected_at,
                })
            })
            .collect();
        json!({ "event": "sites_snapshot", "v": 1, "sites": sites })
    }
}

pub fn site_event(origin: &str, kind: &str, data: Value) -> Value {
    json!({ "event": "site_event", "v": 1, "origin": origin, "kind": kind, "data": data })
}

pub const EVENT_KINDS: &[&str] = &["accountsChanged", "networkChanged", "tx", "lock"];
/// Never sent through `site_send_event`: it goes only to the connections that sent the request.
pub const REQUEST_KIND: &str = "request";


pub struct Waiter {
    pub wire_id: String,
    pub conn: u64,
    pub tab_ref: String,
    pub rid: Option<String>,
    pub reply: oneshot::Sender<Value>,
}

pub struct Sent<'a> {
    pub client_id: &'a str,
    pub browser: &'static str,
    pub conn: u64,
    pub out: Option<mpsc::UnboundedSender<String>>,
    pub address: Option<String>,
}

/// Only `Unlock`, `Review` and `Approved` show in the menu bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Running,
    Unlock,
    Review,
    Approved,
}

impl Stage {
    pub fn visible(self) -> bool {
        self != Stage::Running
    }
}

pub struct Pending {
    pub id: String,
    pub client_id: String,
    pub browser: &'static str,
    pub site: RelaySite,
    pub network: String,
    pub method: String,
    pub created_ms: u64,
    pub stage: Stage,
    pub review: Option<Value>,
    pub notice: Option<String>,
    pub waiters: Vec<Waiter>,
    /// Approved and authorised: it runs to its end whatever happens to the page that sent it.
    pub committed: bool,
    pub review_since: Option<Instant>,
    #[cfg(test)]
    pub params: Value,
}

impl Pending {
    pub fn record_client(&self) -> &str {
        if self.client_id == DIRECT_UNPROVEN {
            DIRECT
        } else {
            &self.client_id
        }
    }

    pub fn proven(&self) -> bool {
        self.client_id != DIRECT_UNPROVEN
    }

    fn tabs(&self) -> usize {
        let mut refs: Vec<&str> = self.waiters.iter().map(|w| w.tab_ref.as_str()).collect();
        refs.sort_unstable();
        refs.dedup();
        refs.len()
    }

    pub fn answer(self, reply: &Value, status: Status) {
        for w in self.waiters {
            let r = match &w.rid {
                Some(rid) => site_lifecycle::decorate(reply, rid, status),
                None => reply.clone(),
            };
            let _ = w.reply.send(r);
        }
    }

    /// Never the raw params, which only the main window reads.
    pub fn json(&self) -> Value {
        json!({
            "id": self.id,
            "origin": self.site.origin,
            "topOrigin": self.site.top_origin,
            "framed": self.site.framed,
            "browser": self.browser,
            "clientId": self.client_id,
            "network": self.network,
            "method": self.method,
            "createdAt": self.created_ms,
            "stage": self.stage,
            "review": self.review,
            "tabs": self.tabs(),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Push {
    New(String),
    Merged(String),
    Stored,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Dropped {
    pub id: String,
    pub was_visible: bool,
}

pub struct SiteQueue {
    pub items: Vec<Pending>,
    pub log: RequestLog,
    rate: Window,
    page_rate: Window,
    rejected_until: std::collections::HashMap<String, Instant>,
}

impl Default for SiteQueue {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            log: RequestLog::default(),
            page_rate: Window::new(Duration::from_secs(1), PAGE_RATE_PER_SECOND),
            rate: Window::new(Duration::from_secs(60), SITE_RATE_PER_MINUTE),
            rejected_until: Default::default(),
        }
    }
}

pub fn answer_error(r: Refusal) -> Value {
    json!({ "error": r.json() })
}

/// Its `sign_transaction` review counted: never reviewed again, it runs to its end once it arrives.
fn method_runs_unreviewed(method: &str) -> bool {
    method == "broadcast_only"
}

pub fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `Approved` stays in review until Touch ID or the password passed.
fn stage_status(stage: Stage) -> Option<Status> {
    match stage {
        Stage::Running => Some(Status::Pending),
        Stage::Unlock => Some(Status::Locked),
        Stage::Review => Some(Status::ReviewOpen),
        Stage::Approved => None,
    }
}

impl SiteQueue {
    fn waiting_for(&self, origin: &str) -> usize {
        self.items.iter().filter(|p| p.site.origin == origin).map(|p| p.waiters.len()).sum()
    }

    pub fn page_hit(&mut self, conn: u64, now: Instant) -> bool {
        self.page_rate.hit(&conn.to_string(), now)
    }

    pub fn visible(&self) -> usize {
        self.items.iter().filter(|p| p.stage.visible()).count()
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Pending> {
        self.items.iter_mut().find(|p| p.id == id)
    }

    /// A repeat connect joins the waiting one. A known request id joins its running request or gets
    /// its stored answer; a different request under it is refused.
    pub fn push(
        &mut self,
        req: SiteRequest,
        sent: Sent,
        reply: oneshot::Sender<Value>,
        now: Instant,
        now_ms: u64,
    ) -> Result<Push, (Refusal, oneshot::Sender<Value>)> {
        if self.items.iter().any(|p| p.waiters.iter().any(|w| w.wire_id == req.id)) {
            return Err((INVALID, reply));
        }
        let proven = sent.client_id != DIRECT_UNPROVEN;
        let record_client = if proven { sent.client_id } else { DIRECT };
        let origin = req.site.origin.clone();
        let tab_ref = req.site.tab_ref.clone();
        let asker = Asker {
            client_id: record_client,
            origin: &origin,
            conn: sent.conn,
            tab_ref: &tab_ref,
            proven,
            connected: proven && sent.address.is_some(),
            target: sent.out.clone().map(site_lifecycle::Target::Socket),
        };
        let mut join = None;
        if let (Some(rid), Some(digest)) = (&req.rid, &req.digest) {
            let items = &self.items;
            match self.log.admit(&asker, rid, digest, |w| items.iter().any(|p| p.id == w)) {
                Admit::New => {}
                Admit::Join(wire) => join = Some(wire),
                Admit::Reused => return Err((REQUEST_ID_REUSED, reply)),
                Admit::Stored(answer, status) => {
                    if !self.rate.hit(&origin, now) {
                        return Err((TOO_FAST, reply));
                    }
                    let _ = reply.send(site_lifecycle::decorate(&answer, rid, status));
                    return Ok(Push::Stored);
                }
            }
        }
        if self.waiting_for(&origin) >= MAX_WAITING_PER_SITE {
            return Err((TOO_MANY_WAITING, reply));
        }
        if !self.rate.hit(&origin, now) {
            return Err((TOO_FAST, reply));
        }
        let waiter = Waiter { wire_id: req.id.clone(), conn: sent.conn, tab_ref: tab_ref.clone(), rid: req.rid.clone(), reply };
        if let Some(wire) = join {
            if let (Some(p), Some(rid)) = (self.items.iter_mut().find(|p| p.id == wire), &req.rid) {
                p.waiters.push(waiter);
                self.log.join(&asker, rid);
                return Ok(Push::Merged(wire));
            }
            return Err((INVALID, waiter.reply));
        }
        let merge_into = (req.method == "connect")
            .then(|| {
                self.items.iter().position(|p| {
                    p.method == "connect"
                        && p.site.origin == origin
                        && p.client_id == sent.client_id
                        && p.network == req.network
                        && !p.committed
                })
            })
            .flatten();
        let (wire, network) = match merge_into {
            Some(i) => (self.items[i].id.clone(), self.items[i].network.clone()),
            None => (req.id.clone(), req.network.clone()),
        };
        if let (Some(rid), Some(digest)) = (&req.rid, &req.digest) {
            let opened = self.log.open(&asker, rid, digest, &wire, &req.method, &network, sent.address.clone(), now, now_ms);
            if !opened {
                return Err((TOO_MANY_RUNNING, waiter.reply));
            }
        }
        if let Some(i) = merge_into {
            self.items[i].waiters.push(waiter);
            return Ok(Push::Merged(wire));
        }
        let committed = method_runs_unreviewed(&req.method);
        self.items.push(Pending {
            id: wire.clone(),
            client_id: sent.client_id.to_string(),
            browser: sent.browser,
            site: req.site,
            network: req.network,
            method: req.method,
            created_ms: now_ms,
            stage: Stage::Running,
            review: None,
            notice: None,
            waiters: vec![waiter],
            committed,
            review_since: None,
            #[cfg(test)]
            params: req.params,
        });
        Ok(Push::New(wire))
    }

    pub fn stage(&mut self, id: &str, stage: Stage, now: Instant) -> bool {
        let Some(p) = self.items.iter_mut().find(|p| p.id == id && !p.committed) else {
            return false;
        };
        p.stage = stage;
        if stage.visible() && p.review_since.is_none() {
            p.review_since = Some(now);
        }
        stage_status(stage).is_some_and(|status| self.log.stage(id, status, now, wall_ms()))
    }

    pub fn commit(&mut self, id: &str, now: Instant) -> Option<bool> {
        let p = self.items.iter_mut().find(|p| p.id == id && p.stage == Stage::Approved)?;
        p.committed = true;
        Some(self.log.signing(id, now, wall_ms()))
    }

    pub fn take(&mut self, id: &str) -> Option<Pending> {
        let at = self.items.iter().position(|p| p.id == id)?;
        Some(self.items.remove(at))
    }

    /// A committed request is never dropped: with `detach` its matching waiters go unanswered (their
    /// page is gone) and it runs on.
    fn drop_where(&mut self, reply: Value, detach: bool, mut hit: impl FnMut(&Pending, &Waiter) -> bool) -> Vec<Dropped> {
        let status = site_lifecycle::outcome("", &reply);
        let mut dropped = Vec::new();
        let mut i = 0;
        while i < self.items.len() {
            let item = &mut self.items[i];
            if item.committed {
                if detach {
                    let waiters = std::mem::take(&mut item.waiters);
                    let kept: Vec<Waiter> = waiters.into_iter().filter(|w| !hit(&*item, w)).collect();
                    item.waiters = kept;
                }
                i += 1;
                continue;
            }
            let mut kept = Vec::new();
            for w in std::mem::take(&mut item.waiters) {
                if hit(item, &w) {
                    let r = match &w.rid {
                        Some(rid) => site_lifecycle::decorate(&reply, rid, status),
                        None => reply.clone(),
                    };
                    let _ = w.reply.send(r);
                } else {
                    kept.push(w);
                }
            }
            item.waiters = kept;
            if item.waiters.is_empty() {
                let gone = self.items.remove(i);
                self.log.finish(&gone.id, &reply, false, None, Instant::now(), wall_ms());
                dropped.push(Dropped { id: gone.id, was_visible: gone.stage.visible() });
            } else {
                i += 1;
            }
        }
        dropped
    }

    /// Only the connection that sent the request may, and only before it runs.
    pub fn cancel(&mut self, conn: u64, id: &str) -> Vec<Dropped> {
        self.drop_where(answer_error(CANCELLED), false, |_, w| {
            w.conn == conn && (w.wire_id == id || w.rid.as_deref() == Some(id))
        })
    }

    pub fn running(&self, conn: u64, id: &str) -> bool {
        self.items.iter().any(|p| {
            p.committed && p.waiters.iter().any(|w| w.conn == conn && (w.wire_id == id || w.rid.as_deref() == Some(id)))
        })
    }

    pub fn close_tab(&mut self, conn: u64, tab_ref: &str) -> Vec<Dropped> {
        self.drop_where(answer_error(CLOSED), true, |_, w| w.conn == conn && w.tab_ref == tab_ref)
    }

    pub fn drop_conn(&mut self, conn: u64) -> Vec<Dropped> {
        self.drop_where(answer_error(CLOSED), true, |_, w| w.conn == conn)
    }

    pub fn expire(&mut self, now: Instant) -> Vec<Dropped> {
        self.drop_where(expired_reply(), false, |p, _| {
            p.review_since.is_some_and(|t| now.saturating_duration_since(t) >= REVIEW_WINDOW)
        })
    }

    pub fn reject(&mut self, ids: &[String]) -> Vec<Dropped> {
        let now = Instant::now();
        let origins: Vec<String> = self
            .items
            .iter()
            .filter(|p| ids.contains(&p.id) && p.stage.visible())
            .map(|p| p.site.origin.clone())
            .collect();
        self.rejected_until.retain(|_, t| *t > now);
        for o in origins {
            self.rejected_until.insert(o, now + REJECT_COOLDOWN);
        }
        self.drop_where(answer_error(REJECTED), false, |p, _| ids.contains(&p.id))
    }

    pub fn cooling(&self, origin: &str, now: Instant) -> bool {
        self.rejected_until.get(origin).is_some_and(|t| *t > now)
    }

    pub fn refuse_if_cooling(&mut self, id: &str, now: Instant) -> Option<Dropped> {
        let origin = self.items.iter().find(|p| p.id == id && !p.stage.visible())?.site.origin.clone();
        if !self.cooling(&origin, now) {
            return None;
        }
        self.drop_where(answer_error(RECENTLY_REJECTED), false, |p, _| p.id == id).into_iter().next()
    }

    pub fn drop_client(&mut self, client_id: &str) -> Vec<Dropped> {
        for p in self.items.iter_mut().filter(|p| p.client_id == client_id) {
            p.committed = false;
        }
        let gone = self.drop_where(answer_error(CLOSED), false, |p, _| p.client_id == client_id);
        self.log.forget_client(client_id);
        gone
    }

    pub fn json(&self) -> Vec<Value> {
        self.items.iter().filter(|p| p.stage.visible()).map(Pending::json).collect()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Arrival {
    Open,
    Count { notify: bool },
}

pub fn arrival(visible_before: usize, panel_open: bool) -> Arrival {
    if visible_before == 0 && !panel_open {
        Arrival::Open
    } else {
        Arrival::Count { notify: !panel_open }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub origin: String,
    pub body: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Notice {
    Quiet,
    Post { replaces: Option<Shown> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClickTarget {
    Review(String),
    Site(String),
}

#[derive(Debug, Default)]
pub struct SiteNotices {
    out: Vec<Shown>,
}

impl SiteNotices {
    pub fn arrive(&mut self, arrival: &Arrival, enabled: bool, origin: &str, body: &str) -> Notice {
        if !enabled || *arrival != (Arrival::Count { notify: true }) {
            return Notice::Quiet;
        }
        let shown = Shown { origin: origin.to_string(), body: body.to_string() };
        match self.out.iter_mut().find(|s| s.origin == origin) {
            Some(old) => Notice::Post { replaces: Some(std::mem::replace(old, shown)) },
            None => {
                self.out.push(shown);
                Notice::Post { replaces: None }
            }
        }
    }

    pub fn clear(&mut self) -> Vec<Shown> {
        std::mem::take(&mut self.out)
    }

    pub fn retain_waiting<'a>(&mut self, waiting: impl Iterator<Item = &'a str> + Clone) -> Vec<Shown> {
        let (keep, gone) = std::mem::take(&mut self.out)
            .into_iter()
            .partition(|s| waiting.clone().any(|w| w == s.origin));
        self.out = keep;
        gone
    }

    pub fn click(&mut self, origin: &str, waiting: &[(String, String)]) -> Option<ClickTarget> {
        self.out.retain(|s| s.origin != origin);
        let mine: Vec<&String> = waiting.iter().filter(|(_, o)| o == origin).map(|(id, _)| id).collect();
        match mine.as_slice() {
            [] => None,
            [id] => Some(ClickTarget::Review((*id).clone())),
            _ => Some(ClickTarget::Site(origin.to_string())),
        }
    }
}

/// The same for every notification of the site, so platforms that remove by identifier take the
/// right one.
pub fn notice_id(origin: &str) -> i32 {
    let hash = origin.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
    (hash & 0x7fff_ffff) as i32
}

pub fn notice_text(line: Option<&str>, origin: &str) -> String {
    let clean: Option<String> = line
        .map(|l| l.chars().filter(|c| !c.is_control()).take(240).collect::<String>())
        .filter(|l| l.contains(origin));
    clean.unwrap_or_else(|| format!("{origin} has a request waiting"))
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    #[serde(rename_all = "camelCase")]
    Connect { address: String, wallet_id: String, wallet_name: String, permissions: Vec<String> },
    Disconnect,
    #[serde(rename_all = "camelCase")]
    Switch { to: String },
}

/// A page that has not proven it is the connected site can only connect, never disconnect or
/// move the site.
pub fn apply_effects(store: &mut SiteStore, p: &Pending, effects: &[Effect], now_ms: u64) -> bool {
    let mut changed = false;
    let client = p.record_client();
    for e in effects {
        if !p.proven() && !matches!(e, Effect::Connect { .. }) {
            continue;
        }
        match e {
            Effect::Connect { address, wallet_id, wallet_name, permissions } => {
                if !valid_address(address) || wallet_id.is_empty() || wallet_id.len() > 128 {
                    continue;
                }
                let name: String = wallet_name.chars().filter(|c| !c.is_control()).take(64).collect();
                store.connect(SiteRecord {
                    origin: p.site.origin.clone(),
                    network: p.network.clone(),
                    address: address.clone(),
                    client_id: client.to_string(),
                    browser: p.browser.to_string(),
                    wallet_id: wallet_id.clone(),
                    wallet_name: name,
                    permissions: permissions.iter().filter(|s| s.len() <= 64).take(16).cloned().collect(),
                    connected_at: now_ms,
                    last_request: Some(now_ms),
                });
                changed = true;
            }
            Effect::Disconnect => {
                changed |= store.disconnect(&p.network, &p.site.origin, client).is_some();
            }
            Effect::Switch { to } => {
                if RELAY_NETWORKS.contains(&to.as_str()) && to != &p.network {
                    changed |= store.switch_network(&p.site.origin, client, &p.network, to, now_ms);
                }
            }
        }
    }
    changed
}

fn valid_address(a: &str) -> bool {
    a.starts_with("oct") && (40..=60).contains(&a.len()) && a.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME: &str = "chrome-extension://anknhjilldkeelailocijnfibefmepcc";
    const FIREFOX: &str = "moz-extension://3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
    const CLIENT: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";
    const ADDR: &str = "octBs4zPq8xHk2mN7vR3tY6uJ9wE1aS5dF8gH4jK1bN4hTQ9";

    fn hex32(n: u8) -> String {
        format!("{:032x}", n)
    }

    fn msg(id: u8, origin: &str, tab: u8, method: &str) -> Value {
        json!({
            "_id": 1, "method": "site_request", "v": 1, "id": hex32(id),
            "site": { "origin": origin, "framed": false, "tab_ref": hex32(tab), "browser": "chrome" },
            "network": "mainnet",
            "request": { "method": method, "params": {} }
        })
    }

    fn req(id: u8, origin: &str, tab: u8, method: &str) -> SiteRequest {
        parse_request(&msg(id, origin, tab, method), false).unwrap()
    }

    fn sent(client_id: &str, conn: u64) -> Sent<'_> {
        Sent { client_id, browser: "chrome", conn, out: None, address: None }
    }

    fn push(q: &mut SiteQueue, r: SiteRequest, conn: u64) -> (Result<Push, Refusal>, oneshot::Receiver<Value>) {
        let (tx, rx) = oneshot::channel();
        let out = q.push(r, sent(CLIENT, conn), tx, Instant::now(), 1).map_err(|(r, _)| r);
        (out, rx)
    }

    #[test]
    fn site_methods_need_a_proven_paired_extension() {
        let trusted = Session { trusted: true, handshake: true };
        let fresh = Session::default();
        let ext = Client::Extension(CHROME.into());
        assert_eq!(site_client(&ext, &trusted, Some(CLIENT)), Ok(CLIENT));
        assert_eq!(site_client(&ext, &fresh, None), Err(AUTH_REQUIRED));
        assert_eq!(site_client(&ext, &fresh, Some(CLIENT)), Err(AUTH_REQUIRED));
        assert_eq!(site_client(&Client::Native, &trusted, None), Err(AUTH_REQUIRED));
        assert_eq!(site_client(&Client::Native, &trusted, Some(CLIENT)), Err(AUTH_REQUIRED));
        assert_eq!(browser_of(&Client::Extension(FIREFOX.into())), "firefox");
        assert_eq!(browser_of(&ext), "chrome");
    }

    #[test]
    fn origins_are_checked_again() {
        assert_eq!(relay_origin("https://vaulta.euints.com", false).as_deref(), Some("https://vaulta.euints.com"));
        assert_eq!(relay_origin("https://app.x.io:8443", false).as_deref(), Some("https://app.x.io:8443"));
        for bad in [
            "null",
            "NULL",
            "",
            "file:///etc/passwd",
            "file://",
            "https://a.com/",
            "https://a.com/path",
            "https://user@a.com",
            "http://a.com",
            "HTTPS://A.COM",
            "data:text/html,hi",
            "blob:https://a.com/1",
            "chrome-extension://anknhjilldkeelailocijnfibefmepcc",
            "javascript:alert(1)",
        ] {
            assert_eq!(relay_origin(bad, true), None, "{bad}");
        }
        for local in ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:8080"] {
            assert_eq!(relay_origin(local, false), None, "{local} in a release build");
            assert_eq!(relay_origin(local, true).as_deref(), Some(local), "{local} in a dev build");
        }
        assert_eq!(relay_origin("http://evil.localhost.com", true), None);
    }

    #[test]
    fn a_request_names_the_site_only_by_site_origin() {
        let mut m = msg(1, "https://vaulta.euints.com", 2, "send_transaction");
        m["request"]["params"] = json!({ "origin": "https://evil.example", "to": "oct1" });
        let r = parse_request(&m, false).unwrap();
        assert_eq!(r.site.origin, "https://vaulta.euints.com");
        assert_eq!(r.method, "send_transaction");

        let mut m = msg(1, "file:///x", 2, "connect");
        assert_eq!(parse_request(&m, true).unwrap_err().code, "INVALID_PARAMS");
        m = msg(1, "https://a.com", 2, "eth_sendTransaction");
        assert_eq!(parse_request(&m, false).unwrap_err(), NOT_ALLOWED);
        m = msg(1, "https://a.com", 2, "connect");
        m["network"] = json!("devnet2");
        assert_eq!(parse_request(&m, false).unwrap_err(), INVALID);
        m = msg(1, "https://a.com", 2, "connect");
        m["id"] = json!("short");
        assert_eq!(parse_request(&m, false).unwrap_err(), INVALID);
        m = msg(1, "https://a.com", 2, "connect");
        m["site"]["top_origin"] = json!("https://shop.example");
        m["site"]["framed"] = json!(true);
        let r = parse_request(&m, false).unwrap();
        assert_eq!(r.site.top_origin.as_deref(), Some("https://shop.example"));
        assert!(r.site.framed);
    }

    #[test]
    fn three_per_site_wait_and_the_fourth_is_refused() {
        let mut q = SiteQueue::default();
        let mut rx = Vec::new();
        for i in 0..3 {
            let (out, r) = push(&mut q, req(i, "https://a.com", 9, "signMessage"), 1);
            assert_eq!(out, Ok(Push::New(hex32(i))));
            rx.push(r);
        }
        let (out, _) = push(&mut q, req(3, "https://a.com", 9, "signMessage"), 1);
        assert_eq!(out, Err(TOO_MANY_WAITING));
        assert_eq!(TOO_MANY_WAITING.code, "RATE_LIMIT_EXCEEDED");
        let (out, _) = push(&mut q, req(4, "https://b.com", 9, "signMessage"), 1);
        assert_eq!(out, Ok(Push::New(hex32(4))));
    }

    #[test]
    fn a_site_is_rate_limited() {
        let mut q = SiteQueue::default();
        let now = Instant::now();
        let mut hits = 0;
        for i in 0..=SITE_RATE_PER_MINUTE as u32 {
            let r = req((i % 200) as u8, "https://a.com", 1, "getBalance");
            let (tx, _rx) = oneshot::channel();
            if let Ok(Push::New(id)) = q.push(r, sent(CLIENT, 1), tx, now, 1) {
                q.take(&id);
                hits += 1;
            }
        }
        assert_eq!(hits, SITE_RATE_PER_MINUTE);
    }

    #[test]
    fn repeat_connects_merge_and_count_tabs() {
        let mut q = SiteQueue::default();
        let (a, _ra) = push(&mut q, req(1, "https://a.com", 1, "connect"), 1);
        let (b, _rb) = push(&mut q, req(2, "https://a.com", 2, "connect"), 1);
        assert_eq!(a, Ok(Push::New(hex32(1))));
        assert_eq!(b, Ok(Push::Merged(hex32(1))));
        assert_eq!(q.items.len(), 1);
        assert_eq!(q.items[0].json()["tabs"], 2);
    }

    #[tokio::test]
    async fn site_closed_and_site_cancel_drop_waiting_requests() {
        let mut q = SiteQueue::default();
        let (_, r1) = push(&mut q, req(1, "https://a.com", 7, "signMessage"), 1);
        let (_, r2) = push(&mut q, req(2, "https://a.com", 8, "signMessage"), 1);
        let (_, r3) = push(&mut q, req(3, "https://b.com", 7, "signMessage"), 2);
        q.get_mut(&hex32(1)).unwrap().stage = Stage::Review;

        let gone = q.close_tab(1, &hex32(7));
        assert_eq!(gone, vec![Dropped { id: hex32(1), was_visible: true }]);
        assert_eq!(r1.await.unwrap()["error"]["code"], "USER_REJECTED");

        assert!(q.cancel(2, &hex32(2)).is_empty(), "another connection cannot cancel it");
        assert_eq!(q.cancel(1, &hex32(2)), vec![Dropped { id: hex32(2), was_visible: false }]);
        assert_eq!(r2.await.unwrap()["error"]["code"], "USER_REJECTED");

        assert_eq!(q.items.len(), 1);
        assert_eq!(q.drop_conn(2).len(), 1);
        assert_eq!(r3.await.unwrap()["error"]["code"], "USER_REJECTED");
    }

    #[tokio::test]
    async fn a_merged_connect_stays_while_another_tab_waits() {
        let mut q = SiteQueue::default();
        let (_, r1) = push(&mut q, req(1, "https://a.com", 1, "connect"), 1);
        let (_, r2) = push(&mut q, req(2, "https://a.com", 2, "connect"), 1);
        assert!(q.close_tab(1, &hex32(1)).is_empty());
        assert_eq!(r1.await.unwrap()["error"]["code"], "USER_REJECTED");
        let p = q.take(&hex32(1)).unwrap();
        p.answer(&json!({ "result": { "address": ADDR } }), Status::Completed);
        assert_eq!(r2.await.unwrap()["result"]["address"], ADDR);
    }

    #[tokio::test]
    async fn reject_all_for_a_site() {
        let mut q = SiteQueue::default();
        let (_, r1) = push(&mut q, req(1, "https://a.com", 1, "signMessage"), 1);
        let (_, _r2) = push(&mut q, req(2, "https://b.com", 1, "signMessage"), 1);
        let ids: Vec<String> = q.items.iter().filter(|p| p.site.origin == "https://a.com").map(|p| p.id.clone()).collect();
        assert_eq!(q.reject(&ids).len(), 1);
        assert_eq!(r1.await.unwrap()["error"]["message"], REJECTED.message);
        assert_eq!(q.items.len(), 1);
    }

    fn record(network: &str, origin: &str, client: &str, at: u64) -> SiteRecord {
        SiteRecord {
            origin: origin.into(),
            network: network.into(),
            address: ADDR.into(),
            client_id: client.into(),
            browser: "chrome".into(),
            wallet_id: "w1".into(),
            wallet_name: "Spending".into(),
            permissions: vec![],
            connected_at: at,
            last_request: None,
        }
    }

    #[test]
    fn the_store_is_keyed_by_network_origin_and_client() {
        let mut s = SiteStore::default();
        s.connect(record("mainnet", "https://a.com", CLIENT, 1));
        s.connect(record("devnet", "https://a.com", CLIENT, 2));
        s.connect(record("mainnet", "https://a.com", OTHER, 3));
        assert_eq!(s.sites.len(), 3);
        let mut again = record("mainnet", "https://a.com", CLIENT, 4);
        again.address = "octOtherWallet00000000000000000000000000000000000".into();
        s.connect(again);
        assert_eq!(s.sites.len(), 3, "one wallet per site per network per extension");
        assert_eq!(s.get("mainnet", "https://a.com", CLIENT).unwrap().connected_at, 4);

        let snap = s.snapshot_for(CLIENT, None);
        assert_eq!(snap["event"], "sites_snapshot");
        assert_eq!(snap["v"], 1);
        let sites = snap["sites"].as_array().unwrap();
        assert_eq!(sites.len(), 2);
        assert!(sites.iter().all(|x| x["relayed_by"] == CLIENT));
        assert_eq!(sites[0]["network"], "mainnet");
        assert_eq!(sites[0]["wallet"]["name"], "Spending");
        assert_eq!(sites[0]["wallet"]["seed"], sites[0]["address"]);

        assert!(s.disconnect("devnet", "https://a.com", CLIENT).is_some());
        assert!(s.disconnect("devnet", "https://a.com", CLIENT).is_none());
        assert_eq!(s.snapshot_for(CLIENT, None)["sites"].as_array().unwrap().len(), 1);
        assert_eq!(s.snapshot_for(OTHER, None)["sites"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_switch_moves_only_this_site_and_requests_follow_it() {
        let mut s = SiteStore::default();
        s.connect(record("mainnet", "https://a.com", CLIENT, 1));
        s.connect(record("mainnet", "https://b.com", CLIENT, 1));
        assert!(s.switch_network("https://a.com", CLIENT, "mainnet", "devnet", 5));
        assert!(s.get("mainnet", "https://a.com", CLIENT).is_none());
        assert_eq!(s.resolve("https://a.com", CLIENT, "mainnet").unwrap().network, "devnet");
        assert_eq!(s.resolve("https://b.com", CLIENT, "mainnet").unwrap().network, "mainnet");
        assert!(s.resolve("https://a.com", OTHER, "mainnet").is_none());
    }

    #[test]
    fn effects_change_the_record_of_the_request_site_only() {
        let mut s = SiteStore::default();
        let mut q = SiteQueue::default();
        let (_, _rx) = push(&mut q, req(1, "https://a.com", 1, "connect"), 1);
        let p = q.take(&hex32(1)).unwrap();
        let connect = Effect::Connect {
            address: ADDR.into(),
            wallet_id: "w1".into(),
            wallet_name: "Spending".into(),
            permissions: vec!["accounts".into()],
        };
        assert!(apply_effects(&mut s, &p, &[connect], 9));
        let rec = s.get("mainnet", "https://a.com", CLIENT).unwrap();
        assert_eq!(rec.browser, "chrome");
        assert_eq!(rec.connected_at, 9);
        let bad = Effect::Connect {
            address: "0xabc".into(),
            wallet_id: "w".into(),
            wallet_name: "x".into(),
            permissions: vec![],
        };
        assert!(!apply_effects(&mut s, &p, &[bad], 9));
        assert!(apply_effects(&mut s, &p, &[Effect::Switch { to: "devnet".into() }], 10));
        assert_eq!(s.sites[0].network, "devnet");
        assert!(!apply_effects(&mut s, &p, &[Effect::Switch { to: "devnet2".into() }], 10));
        let parsed: Vec<Effect> = serde_json::from_value(json!([
            { "type": "connect", "address": ADDR, "walletId": "w", "walletName": "n", "permissions": [] },
            { "type": "disconnect" },
            { "type": "switch", "to": "devnet" }
        ]))
        .unwrap();
        assert_eq!(parsed.len(), 3);
    }

    fn connect_effect() -> Effect {
        Effect::Connect { address: ADDR.into(), wallet_id: "w1".into(), wallet_name: "Spending".into(), permissions: vec![] }
    }

    #[test]
    fn an_unproven_page_can_only_connect_and_connects_as_direct() {
        let mut s = SiteStore::default();
        s.connect(record("mainnet", "https://a.com", DIRECT, 1));
        let mut q = SiteQueue::default();
        let (tx, _rx) = oneshot::channel();
        q.push(req(1, "https://a.com", 1, "disconnect"), Sent { browser: DIRECT_BROWSER, ..sent(DIRECT_UNPROVEN, 1) }, tx, Instant::now(), 1)
            .map_err(|(r, _)| r)
            .unwrap();
        let p = q.take(&hex32(1)).unwrap();
        assert!(!p.proven());
        assert_eq!(p.record_client(), DIRECT);
        assert!(!apply_effects(&mut s, &p, &[Effect::Disconnect, Effect::Switch { to: "devnet".into() }], 5));
        assert_eq!(s.sites.len(), 1, "a page that has not proven itself cannot drop the site");
        assert_eq!(s.sites[0].network, "mainnet");
        assert!(apply_effects(&mut s, &p, &[connect_effect()], 6));
        assert_eq!(s.get("mainnet", "https://a.com", DIRECT).unwrap().connected_at, 6);
        assert!(s.sites.iter().all(|r| r.client_id != DIRECT_UNPROVEN), "nothing is kept as unproven");
    }

    #[test]
    fn site_tokens_keep_only_a_hash_and_match_in_constant_time() {
        let mut s = SiteStore::default();
        s.connect(record("mainnet", "https://a.com", DIRECT, 1));
        let t1 = s.issue_token("https://a.com", DIRECT);
        assert_eq!(t1.len(), SITE_TOKEN_LEN);
        assert!(t1.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        let saved = serde_json::to_string(&s).unwrap();
        assert!(!saved.contains(&t1), "the token itself is never stored");
        assert!(saved.contains(&crate::ws::ws_auth::token_hash(&t1)));
        assert!(s.token_matches("https://a.com", DIRECT, &t1));
        assert!(!s.token_matches("https://b.com", DIRECT, &t1), "a token is its site's only");
        assert!(!s.token_matches("https://a.com", CLIENT, &t1));
        let mut forged = t1.clone().into_bytes();
        forged[0] = if forged[0] == b'A' { b'B' } else { b'A' };
        assert!(!s.token_matches("https://a.com", DIRECT, std::str::from_utf8(&forged).unwrap()));
        assert!(!s.token_matches("https://a.com", DIRECT, ""));
        assert!(!s.token_matches("https://a.com", DIRECT, &crate::ws::ws_auth::token_hash(&t1)));

        let t2 = s.issue_token("https://a.com", DIRECT);
        assert_ne!(t1, t2);
        assert!(!s.token_matches("https://a.com", DIRECT, &t1), "a new token replaces the old");
        assert!(s.token_matches("https://a.com", DIRECT, &t2));
        assert_eq!(s.tokens.len(), 1);

        s.connect(record("devnet", "https://a.com", DIRECT, 2));
        s.connect(record("mainnet", "https://b.com", DIRECT, 3));
        assert_eq!(s.revoke("https://a.com", DIRECT).len(), 2);
        assert!(!s.token_matches("https://a.com", DIRECT, &t2));
        assert!(s.tokens.is_empty());
        assert_eq!(s.sites.len(), 1, "other sites stay");

        let t3 = s.issue_token("https://a.com", DIRECT);
        assert!(!s.token_matches("https://a.com", DIRECT, &t3), "no token without a connected site");

        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    #[test]
    fn a_store_from_before_tokens_still_reads() {
        let s: SiteStore = serde_json::from_str(r#"{"sites":[]}"#).unwrap();
        assert!(s.tokens.is_empty());
    }

    #[test]
    fn params_are_capped_by_their_serialized_size() {
        let mut m = msg(1, "https://a.com", 2, "deploy_contract");
        m["request"]["params"] = json!({ "bytecode": "A".repeat(700 * 1024), "params": "[]" });
        assert!(parse_request(&m, false).is_ok(), "the largest deploy the wallet takes fits");
        m["request"]["params"] = json!([{ "bytecode": "A".repeat(MAX_SITE_PARAMS) }]);
        assert_eq!(parse_request(&m, false).unwrap_err(), TOO_LARGE);
        m["request"]["params"] = json!(vec!["\u{1}"; MAX_SITE_PARAMS / 4]);
        assert_eq!(parse_request(&m, false).unwrap_err(), TOO_LARGE, "escapes count as sent");
    }

    #[test]
    fn a_rejected_site_gets_no_new_review_for_a_moment() {
        let mut q = SiteQueue::default();
        let push = |q: &mut SiteQueue, id: u8, origin: &str| {
            let (tx, rx) = oneshot::channel();
            q.push(req(id, origin, 1, "signMessage"), sent(CLIENT, 1), tx, Instant::now(), 1)
                .map_err(|(r, _)| r)
                .unwrap();
            rx
        };
        let _first = push(&mut q, 1, "https://a.com");
        q.get_mut(&hex32(1)).unwrap().stage = Stage::Review;
        assert_eq!(q.reject(&[hex32(1)]).len(), 1);
        let now = Instant::now();
        assert!(q.cooling("https://a.com", now));
        assert!(!q.cooling("https://b.com", now), "only the rejected site cools down");

        let mut again = push(&mut q, 2, "https://a.com");
        let gone = q.refuse_if_cooling(&hex32(2), now).unwrap();
        assert_eq!(gone.id, hex32(2));
        assert!(q.items.is_empty());
        assert_eq!(again.try_recv().unwrap()["error"]["message"], RECENTLY_REJECTED.message);

        let _other = push(&mut q, 3, "https://b.com");
        assert!(q.refuse_if_cooling(&hex32(3), now).is_none());
        let _later = push(&mut q, 4, "https://a.com");
        assert!(q.refuse_if_cooling(&hex32(4), now + REJECT_COOLDOWN).is_none(), "the cooldown ends");
        assert_eq!(q.items.len(), 2);

        let _unseen = push(&mut q, 5, "https://c.com");
        q.reject(&[hex32(5)]);
        assert!(!q.cooling("https://c.com", now), "a request the user never saw starts no cooldown");
    }

    #[test]
    fn forgetting_an_extension_forgets_only_its_sites() {
        let mut s = SiteStore::default();
        s.connect(record("mainnet", "https://a.com", CLIENT, 1));
        s.connect(record("devnet", "https://b.com", CLIENT, 1));
        s.connect(record("mainnet", "https://a.com", OTHER, 1));
        let gone = s.forget_client(CLIENT);
        assert_eq!(gone.len(), 2);
        assert_eq!(s.sites.len(), 1);
        assert_eq!(s.sites[0].client_id, OTHER);
    }

    #[test]
    fn only_the_first_request_opens_the_panel() {
        assert_eq!(arrival(0, false), Arrival::Open);
        assert_eq!(arrival(1, false), Arrival::Count { notify: true });
        assert_eq!(arrival(0, true), Arrival::Count { notify: false });
        assert_eq!(arrival(2, true), Arrival::Count { notify: false });
    }

    const A: &str = "https://app.octradex.xyz";
    const B: &str = "https://b.com";

    fn shown(origin: &str, body: &str) -> Shown {
        Shown { origin: origin.into(), body: body.into() }
    }

    const FRESH: Notice = Notice::Post { replaces: None };

    #[test]
    fn the_first_request_gets_no_notification() {
        let mut n = SiteNotices::default();
        assert_eq!(n.arrive(&arrival(0, false), true, A, "a"), Notice::Quiet);
        assert!(n.clear().is_empty());
    }

    #[test]
    fn no_notification_while_the_panel_is_open() {
        let mut n = SiteNotices::default();
        assert_eq!(n.arrive(&arrival(0, true), true, A, "a"), Notice::Quiet);
        assert_eq!(n.arrive(&arrival(2, true), true, B, "b"), Notice::Quiet);
        assert!(n.clear().is_empty());
    }

    #[test]
    fn a_later_request_with_the_panel_closed_posts_one() {
        let mut n = SiteNotices::default();
        assert_eq!(n.arrive(&arrival(1, false), true, A, "a"), FRESH);
        assert_eq!(n.arrive(&arrival(2, false), true, B, "b"), FRESH);
    }

    #[test]
    fn notifications_off_post_nothing() {
        let mut n = SiteNotices::default();
        assert_eq!(n.arrive(&arrival(1, false), false, A, "a"), Notice::Quiet);
        assert!(n.clear().is_empty());
    }

    #[test]
    fn a_new_request_replaces_its_sites_notification() {
        let mut n = SiteNotices::default();
        assert_eq!(n.arrive(&arrival(1, false), true, A, "a sign"), FRESH);
        assert_eq!(n.arrive(&arrival(2, false), true, B, "b send"), FRESH);
        assert_eq!(
            n.arrive(&arrival(3, false), true, A, "a send"),
            Notice::Post { replaces: Some(shown(A, "a sign")) }
        );
        assert_eq!(n.clear(), vec![shown(A, "a send"), shown(B, "b send")], "one per site");
    }

    #[test]
    fn a_site_that_stops_waiting_loses_its_notification() {
        let mut n = SiteNotices::default();
        n.arrive(&arrival(1, false), true, A, "a");
        n.arrive(&arrival(2, false), true, B, "b");
        assert_eq!(n.retain_waiting([B].into_iter()), vec![shown(A, "a")]);
        assert!(n.retain_waiting([B].into_iter()).is_empty());
        assert_eq!(n.arrive(&arrival(1, false), true, A, "a"), FRESH, "it may post again");
    }

    #[test]
    fn opening_the_panel_removes_every_notification() {
        let mut n = SiteNotices::default();
        n.arrive(&arrival(1, false), true, A, "a");
        assert_eq!(n.clear(), vec![shown(A, "a")]);
        assert!(n.clear().is_empty());
        assert_eq!(n.arrive(&arrival(1, false), true, A, "a"), FRESH, "the panel opened in between");
    }

    #[test]
    fn a_site_keeps_its_notice_id() {
        assert_eq!(notice_id(A), notice_id(A));
        assert_ne!(notice_id(A), notice_id(B));
        assert!(notice_id(A) >= 0 && notice_id("") >= 0);
    }

    #[test]
    fn the_notice_names_the_site() {
        let line = "https://app.octradex.xyz wants you to sign a transaction";
        assert_eq!(notice_text(Some(line), A), line);
        assert_eq!(notice_text(Some("a\nb https://app.octradex.xyz"), A), "ab https://app.octradex.xyz");
        assert_eq!(notice_text(Some("https://evil.example wants you to sign"), A), format!("{A} has a request waiting"));
        assert_eq!(notice_text(None, A), format!("{A} has a request waiting"));
    }

    #[test]
    fn a_click_opens_its_sites_review_or_group() {
        let w = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs.iter().map(|(i, o)| (i.to_string(), o.to_string())).collect()
        };
        let mut n = SiteNotices::default();
        n.arrive(&arrival(1, false), true, A, "a");
        n.arrive(&arrival(2, false), true, B, "b");
        assert_eq!(n.click(A, &w(&[("1", B), ("2", A)])), Some(ClickTarget::Review("2".into())));
        assert_eq!(n.clear(), vec![shown(B, "b")], "only the clicked one is gone");

        assert_eq!(
            n.click(A, &w(&[("1", B), ("2", A), ("3", A)])),
            Some(ClickTarget::Site(A.into())),
            "several from the site"
        );
        assert_eq!(n.click(B, &w(&[("1", B), ("2", A), ("3", A)])), Some(ClickTarget::Review("1".into())));
        assert_eq!(n.click(A, &w(&[("1", B)])), None, "its site stopped waiting");
        assert_eq!(n.click(A, &[]), None);
    }

    fn rid_req(id: u8, rid: u8, origin: &str, tab: u8, method: &str, params: Value) -> SiteRequest {
        let mut m = msg(id, origin, tab, method);
        m["rid"] = json!(hex32(rid));
        m["request"]["params"] = params;
        parse_request(&m, false).unwrap()
    }

    fn approve(q: &mut SiteQueue, id: u8) {
        q.stage(&hex32(id), Stage::Review, Instant::now());
        q.get_mut(&hex32(id)).unwrap().stage = Stage::Approved;
        assert!(q.commit(&hex32(id), Instant::now()).is_some());
    }

    #[test]
    fn a_request_id_is_read_only_for_review_methods_and_must_be_well_formed() {
        let r = rid_req(1, 9, "https://a.com", 1, "signMessage", json!({ "message": "hi" }));
        assert_eq!(r.rid, Some(hex32(9)));
        assert_eq!(r.digest, Some(site_lifecycle::digest("signMessage", &json!({ "message": "hi" }), "mainnet")));
        let read = rid_req(1, 9, "https://a.com", 1, "getBalance", json!({}));
        assert_eq!(read.rid, None, "reads keep no record");
        let mut m = msg(1, "https://a.com", 1, "signMessage");
        m["rid"] = json!("NOT-HEX");
        assert_eq!(parse_request(&m, false).unwrap_err(), BAD_RID);
    }

    #[tokio::test]
    async fn a_repeated_id_joins_or_answers_and_never_opens_a_second_review() {
        let mut q = SiteQueue::default();
        let params = json!({ "to": ADDR, "amount": "1" });
        let (a, ra) = push(&mut q, rid_req(1, 9, "https://a.com", 1, "send_transaction", params.clone()), 1);
        assert_eq!(a, Ok(Push::New(hex32(1))));
        let (b, rb) = push(&mut q, rid_req(2, 9, "https://a.com", 2, "send_transaction", params.clone()), 1);
        assert_eq!(b, Ok(Push::Merged(hex32(1))), "the same request joins");
        assert_eq!(q.items.len(), 1);
        let (c, _) = push(&mut q, rid_req(3, 9, "https://a.com", 1, "send_transaction", json!({ "to": ADDR, "amount": "2" })), 1);
        assert_eq!(c, Err(REQUEST_ID_REUSED), "a different request under the id is refused");
        let mut devnet = rid_req(4, 9, "https://a.com", 1, "send_transaction", params.clone());
        devnet.network = "devnet".into();
        devnet.digest = Some(site_lifecycle::digest("send_transaction", &params, "devnet"));
        let (d, _) = push(&mut q, devnet, 1);
        assert_eq!(d, Err(REQUEST_ID_REUSED), "the id cannot move to another network");
        let (e, _) = push(&mut q, rid_req(5, 9, "https://b.com", 1, "send_transaction", params.clone()), 1);
        assert_eq!(e, Ok(Push::New(hex32(5))), "another origin has its own ids");

        approve(&mut q, 1);
        let p = q.take(&hex32(1)).unwrap();
        let reply = json!({ "result": { "txHash": "ab".repeat(32) } });
        let status = q.log.finish(&p.id, &reply, p.committed, None, Instant::now(), 2).unwrap();
        assert_eq!(status, Status::Submitted);
        p.answer(&reply, status);
        for r in [ra, rb] {
            let got = r.await.unwrap();
            assert_eq!(got["rid"], hex32(9));
            assert_eq!(got["status"], "submitted");
        }

        let (f, rf) = push(&mut q, rid_req(6, 9, "https://a.com", 3, "send_transaction", params.clone()), 1);
        assert_eq!(f, Ok(Push::Stored), "after it ran, the same request gets the stored answer");
        assert_eq!(rf.await.unwrap()["result"]["txHash"], "ab".repeat(32));
        assert_eq!(q.items.iter().filter(|p| p.site.origin == "https://a.com").count(), 0, "no second review");
    }

    #[tokio::test]
    async fn a_rejected_id_answers_rejected_again() {
        let mut q = SiteQueue::default();
        let (_, r1) = push(&mut q, rid_req(1, 9, "https://a.com", 1, "signMessage", json!({})), 1);
        q.stage(&hex32(1), Stage::Review, Instant::now());
        q.reject(&[hex32(1)]);
        let first = r1.await.unwrap();
        assert_eq!(first["status"], "rejected");
        assert_eq!(first["error"]["details"]["requestId"], hex32(9));
        let (again, r2) = push(&mut q, rid_req(2, 9, "https://a.com", 1, "signMessage", json!({})), 1);
        assert_eq!(again, Ok(Push::Stored));
        assert_eq!(r2.await.unwrap()["error"]["code"], "USER_REJECTED");
        assert!(q.items.is_empty());
    }

    #[test]
    fn an_approved_request_runs_on_and_keeps_its_outcome_when_its_page_closes() {
        let mut q = SiteQueue::default();
        let (_, mut r1) = push(&mut q, rid_req(1, 9, "https://a.com", 7, "signMessage", json!({})), 1);
        let (_, mut r2) = push(&mut q, rid_req(2, 8, "https://a.com", 7, "signMessage", json!({ "message": "x" })), 1);
        approve(&mut q, 1);
        q.stage(&hex32(2), Stage::Review, Instant::now());

        let gone = q.close_tab(1, &hex32(7));
        assert_eq!(gone, vec![Dropped { id: hex32(2), was_visible: true }], "the unanswered review closes");
        assert_eq!(r2.try_recv().unwrap()["status"], "rejected");
        assert_eq!(q.log.get(CLIENT, "https://a.com", &hex32(8)).unwrap().card.status, Status::Rejected);

        assert_eq!(q.items.len(), 1, "the approved one stays");
        assert!(q.items[0].waiters.is_empty());
        assert!(matches!(r1.try_recv(), Err(oneshot::error::TryRecvError::Closed)), "nobody is told it was rejected");
        assert!(q.drop_conn(1).is_empty());

        let p = q.take(&hex32(1)).unwrap();
        let reply = json!({ "result": { "signature": "sig" } });
        assert_eq!(q.log.finish(&p.id, &reply, p.committed, None, Instant::now(), 3), Some(Status::Completed));
        let rec = q.log.get(CLIENT, "https://a.com", &hex32(9)).unwrap();
        assert_eq!(rec.card.result.as_ref().unwrap()["signature"], "sig");
    }

    #[tokio::test]
    async fn a_running_request_cannot_be_cancelled_or_rejected() {
        let mut q = SiteQueue::default();
        let (_, r1) = push(&mut q, rid_req(1, 9, "https://a.com", 7, "signMessage", json!({})), 1);
        approve(&mut q, 1);
        assert!(q.cancel(1, &hex32(1)).is_empty());
        assert!(q.cancel(1, &hex32(9)).is_empty(), "nor by its request id");
        assert!(q.running(1, &hex32(9)));
        assert!(q.reject(&[hex32(1)]).is_empty());
        assert!(q.expire(Instant::now() + REVIEW_WINDOW * 2).is_empty(), "nor does it expire");
        assert_eq!(q.items[0].waiters.len(), 1, "the page still gets its answer");
        q.take(&hex32(1)).unwrap().answer(&json!({ "result": { "signature": "s" } }), Status::Completed);
        assert_eq!(r1.await.unwrap()["result"]["signature"], "s");
    }

    #[test]
    fn running_needs_the_verb_first() {
        let mut q = SiteQueue::default();
        let (_, _r) = push(&mut q, rid_req(1, 9, "https://a.com", 7, "send_transaction", json!({})), 1);
        assert!(q.commit(&hex32(1), Instant::now()).is_none(), "still pending");
        q.stage(&hex32(1), Stage::Review, Instant::now());
        assert!(q.commit(&hex32(1), Instant::now()).is_none(), "the review is open, the verb not clicked");
        assert!(q.commit(&hex32(2), Instant::now()).is_none(), "unknown");
        q.get_mut(&hex32(1)).unwrap().stage = Stage::Approved;
        assert_eq!(q.commit(&hex32(1), Instant::now()), Some(true));
        assert_eq!(q.log.get(CLIENT, "https://a.com", &hex32(9)).unwrap().card.status, Status::Signing);
    }

    #[test]
    fn a_review_expires_after_five_minutes() {
        let mut q = SiteQueue::default();
        let (_, mut r1) = push(&mut q, rid_req(1, 9, "https://a.com", 7, "signMessage", json!({})), 1);
        let (_, _r2) = push(&mut q, rid_req(2, 8, "https://a.com", 7, "signMessage", json!({ "m": 1 })), 1);
        let t = Instant::now();
        q.stage(&hex32(1), Stage::Unlock, t);
        q.stage(&hex32(1), Stage::Review, t + Duration::from_secs(60));
        assert!(q.expire(t + REVIEW_WINDOW - Duration::from_secs(1)).is_empty());
        let gone = q.expire(t + REVIEW_WINDOW);
        assert_eq!(gone, vec![Dropped { id: hex32(1), was_visible: true }], "the clock starts when it first shows");
        let reply = r1.try_recv().unwrap();
        assert_eq!(reply["error"]["code"], "USER_REJECTED");
        assert_eq!(reply["error"]["details"]["status"], "expired");
        assert_eq!(reply["status"], "expired");
        assert_eq!(q.log.get(CLIENT, "https://a.com", &hex32(9)).unwrap().card.status, Status::Expired);
        assert_eq!(q.items.len(), 1, "a request still preparing its review has no clock yet");
    }

    #[test]
    fn a_site_runs_at_most_eight_requests_with_ids() {
        let mut q = SiteQueue::default();
        for i in 0..8u8 {
            let (out, _r) = push(&mut q, rid_req(i, 100 + i, "https://a.com", 7, "signMessage", json!({ "i": i })), 1);
            assert!(matches!(out, Ok(Push::New(_))));
            approve(&mut q, i);
            q.items.last_mut().unwrap().waiters.clear();
        }
        let (out, _r) = push(&mut q, rid_req(20, 120, "https://a.com", 7, "signMessage", json!({})), 1);
        assert_eq!(out, Err(TOO_MANY_RUNNING));
        assert_eq!(TOO_MANY_RUNNING.code, "RATE_LIMIT_EXCEEDED");
    }

    #[test]
    fn a_pre_signed_broadcast_runs_on_when_its_page_closes() {
        let mut q = SiteQueue::default();
        let (_, _r) = push(&mut q, rid_req(1, 9, "https://a.com", 7, "broadcast_only", json!({ "signedTx": {} })), 1);
        assert!(q.items[0].committed);
        assert!(q.close_tab(1, &hex32(7)).is_empty());
        assert!(q.cancel(1, &hex32(9)).is_empty());
        assert_eq!(q.log.get(CLIENT, "https://a.com", &hex32(9)).unwrap().card.status, Status::Pending);
        let p = q.take(&hex32(1)).unwrap();
        let reply = json!({ "result": { "txHash": "ab".repeat(32) } });
        assert_eq!(q.log.finish(&p.id, &reply, p.committed, None, Instant::now(), 2), Some(Status::Submitted));
    }
}
