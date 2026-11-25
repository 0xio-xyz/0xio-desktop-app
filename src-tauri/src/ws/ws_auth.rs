//! Who may use the local WebSocket.
//!
//! The 0xio extension (its exact origin) and local programs (no Origin) connect and must pair.
//! A web page connects from its own `https` origin only while the user allows websites without
//! the extension; it pairs with nothing and may only send site requests, each reviewed in the
//! menu bar (see docs/DIRECT_SITES.md). Every other origin is refused at the handshake.
//!
//! The extension pairs once through an X25519 exchange whose six-digit code both sides show, and
//! keeps the pairing secret. On every connection both sides prove that secret (HMAC over fresh
//! nonces from each) before the extension sends any key material, so neither a program posing as
//! the desktop nor one posing as the extension gets anything. A program pairs with a token.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CHROME_EXTENSION_IDS: &[&str] = &["anknhjilldkeelailocijnfibefmepcc"];

pub const PAIR_TIMEOUT: Duration = Duration::from_secs(120);
pub const PAIR_COOLDOWN: Duration = Duration::from_secs(60);
/// Pairing reviews open at once, across all clients: one, so a client posing as the extension
/// cannot stack reviews in front of the user.
pub const MAX_PENDING_PAIRS: usize = 1;
pub const PAIR_GAP: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Client {
    Extension(String),
    Native,
    Web(String),
}

impl Client {
    pub fn limit_key(&self) -> String {
        match self {
            Client::Extension(o) | Client::Web(o) => o.clone(),
            Client::Native => "native".into(),
        }
    }

    pub fn default_name(&self) -> &'static str {
        match self {
            Client::Extension(o) if o.starts_with("chrome-extension://") => "0xio extension",
            Client::Extension(_) => "Firefox extension",
            Client::Web(_) => "Website",
            Client::Native => "Local app",
        }
    }
}

/// Dev builds also take an unpacked extension, whose id comes from its folder; pairing still applies.
fn is_chrome_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(lens)
            .all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebPolicy {
    pub allowed: bool,
    pub dev: bool,
}

#[cfg(test)]
impl WebPolicy {
    pub const OFF: WebPolicy = WebPolicy { allowed: false, dev: false };
}

pub fn classify(origin: Option<&str>, web: WebPolicy) -> Result<Client, &'static str> {
    let Some(raw) = origin else {
        return Ok(Client::Native);
    };
    let o = raw.trim();
    if o.is_empty()
        || o.len() > 255
        || !o.is_ascii()
        || o.chars().any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return Err("malformed origin");
    }
    let lower = o.to_ascii_lowercase();
    if lower == "null" {
        return Err("opaque origin");
    }
    if let Some(id) = lower.strip_prefix("chrome-extension://") {
        return if CHROME_EXTENSION_IDS.contains(&id) || (cfg!(debug_assertions) && is_chrome_id(id)) {
            Ok(Client::Extension(format!("chrome-extension://{id}")))
        } else {
            Err("unknown extension")
        };
    }
    // Firefox gives every install its own random id, so the exact origin is bound on pairing.
    if let Some(id) = lower.strip_prefix("moz-extension://") {
        return if is_uuid(id) {
            Ok(Client::Extension(format!("moz-extension://{id}")))
        } else {
            Err("malformed extension origin")
        };
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if !web.allowed {
            return Err("web page");
        }
        return crate::ws::ws_sites::web_origin(o, web.dev).map(Client::Web).ok_or("web origin not allowed");
    }
    if lower.starts_with("file:") {
        return Err("web page");
    }
    Err("origin not allowed")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Access {
    Allow,
    /// An extension from before pairing (3.0.3 and older) runs its proofs on the context it
    /// initialized itself, as 0xio Desktop 0.5.5 allowed.
    Legacy,
    Pair,
}

/// Methods that set up trust and carry no key material.
const EXTENSION_AUTH_METHODS: &[&str] = &["auth_hello", "auth_prove", "auth_pair"];

pub const PAIR_CONFIRM: &str = "auth_pair_confirm";
pub const PAIR_CANCEL: &str = "auth_pair_cancel";

/// What extensions 3.0.3 and older call on 0xio Desktop, read from their PvacManager: `init` with
/// their own PVAC master, then proofs and ciphers on that context. Nothing touches desktop keys,
/// wallet requests or another connection's context.
pub const LEGACY_METHODS: &[&str] = &[
    "init",
    "serializePubkey",
    "encrypt",
    "decrypt",
    "ctSub",
    "pedersenCommit",
    "checkBoundProvable",
    "makeRangeProof",
    "makeParallelRangeProofs",
    "makeBoundProof",
    "makeBoundRangeProof",
    "makeBoundKeySwitchProof",
    "makeBoundKeySwitchProofWithPubkey",
    "verifyBoundProof",
    "verifyBoundKeySwitchProofWithPubkey",
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub trusted: bool,
    /// The extension began the pairing handshake: from then on it is never a legacy session.
    pub handshake: bool,
}

impl Session {
    pub fn record(&mut self, method: &str) {
        if EXTENSION_AUTH_METHODS.contains(&method) {
            self.handshake = true;
        }
    }
}

/// What a client may call. `ping` always; the extension's pairing and proof methods before it is
/// verified; a program's `pair`; everything else only once trust is set up. The Origin header alone
/// never unlocks anything, with one exception the user can turn off: an extension that never
/// began the handshake may make the legacy proof calls on its own context.
pub fn access(client: &Client, session: &Session, allow_legacy: bool, method: &str) -> Access {
    if method == "ping" || session.trusted {
        return Access::Allow;
    }
    match client {
        Client::Extension(_) if EXTENSION_AUTH_METHODS.contains(&method) => Access::Allow,
        Client::Extension(_)
            if allow_legacy && !session.handshake && LEGACY_METHODS.contains(&method) =>
        {
            Access::Legacy
        }
        Client::Native if method == "pair" => Access::Allow,
        _ => Access::Pair,
    }
}

pub struct Window {
    span: Duration,
    max: usize,
    hits: HashMap<String, VecDeque<Instant>>,
}

impl Window {
    pub fn new(span: Duration, max: usize) -> Self {
        Self { span, max, hits: HashMap::new() }
    }

    pub fn hit(&mut self, key: &str, now: Instant) -> bool {
        let span = self.span;
        self.hits.retain(|_, q| {
            while q.front().is_some_and(|t| now.duration_since(*t) >= span) {
                q.pop_front();
            }
            !q.is_empty()
        });
        let q = self.hits.entry(key.to_string()).or_default();
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now);
        true
    }
}

/// Handshakes per client and overall, per minute. Web pages count apart, so no website can use
/// up the handshakes of the extension or a paired program.
pub struct HandshakeLimits {
    per_client: Window,
    overall: Window,
    web_overall: Window,
}

impl Default for HandshakeLimits {
    fn default() -> Self {
        Self {
            per_client: Window::new(Duration::from_secs(60), 12),
            overall: Window::new(Duration::from_secs(60), 60),
            web_overall: Window::new(Duration::from_secs(60), 120),
        }
    }
}

impl HandshakeLimits {
    pub fn allow(&mut self, client: &Client, now: Instant) -> bool {
        let overall = match client {
            Client::Web(_) => &mut self.web_overall,
            _ => &mut self.overall,
        };
        overall.hit("*", now) && self.per_client.hit(&client.limit_key(), now)
    }
}

pub const MAX_OTHER_CONNECTIONS: usize = 8;
pub const MAX_WEB_CONNECTIONS: usize = 32;
pub const MAX_WEB_PER_ORIGIN: usize = 6;

#[derive(Default)]
pub struct ConnCaps {
    other: usize,
    web: HashMap<String, usize>,
}

impl ConnCaps {
    pub fn web_total(&self) -> usize {
        self.web.values().sum()
    }

    pub fn admit(&mut self, client: &Client) -> bool {
        match client {
            Client::Web(o) => {
                let mine = self.web.get(o).copied().unwrap_or(0);
                if self.web_total() >= MAX_WEB_CONNECTIONS || mine >= MAX_WEB_PER_ORIGIN {
                    return false;
                }
                self.web.insert(o.clone(), mine + 1);
                true
            }
            _ => {
                if self.other >= MAX_OTHER_CONNECTIONS {
                    return false;
                }
                self.other += 1;
                true
            }
        }
    }

    pub fn release(&mut self, client: &Client) {
        match client {
            Client::Web(o) => {
                if let Some(n) = self.web.get_mut(o) {
                    *n -= 1;
                    if *n == 0 {
                        self.web.remove(o);
                    }
                }
            }
            _ => self.other = self.other.saturating_sub(1),
        }
    }
}

// Protocol 0xio-pair-v1, mirrored in the extension's src/services/desktop/desktopPairing.ts.

type HmacSha256 = Hmac<Sha256>;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn unhex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn random32() -> [u8; 32] {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

pub fn new_id() -> String {
    hex(&random32()[..16])
}

pub fn x25519_keypair() -> ([u8; 32], [u8; 32]) {
    let sk = random32();
    let pk = curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped(sk).to_bytes();
    (sk, pk)
}

/// X25519(sk, peer). None for a low-order peer key, whose shared secret is all zero.
pub fn x25519_shared(sk: [u8; 32], peer: [u8; 32]) -> Option<[u8; 32]> {
    let shared = curve25519_dalek::montgomery::MontgomeryPoint(peer).mul_clamped(sk).to_bytes();
    if shared.iter().all(|b| *b == 0) {
        None
    } else {
        Some(shared)
    }
}

/// sha256 over the label, both ids and both public keys, in a fixed order.
pub fn transcript(desktop_id: &str, client_id: &str, epk_e: &[u8; 32], epk_d: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"0xio-pair-v1");
    h.update([0]);
    h.update(desktop_id.as_bytes());
    h.update([0]);
    h.update(client_id.as_bytes());
    h.update([0]);
    h.update(epk_e);
    h.update(epk_d);
    h.finalize().into()
}

fn mac(key: &[u8], parts: &[&[u8]]) -> HmacSha256 {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac takes any key length");
    for p in parts {
        m.update(p);
    }
    m
}

/// The six digits both sides show: a man in the middle holds two different shared secrets and
/// transcripts, so the codes on the two screens differ.
pub fn pair_code(shared: &[u8; 32], t: &[u8; 32]) -> String {
    let c = mac(shared, &[b"0xio-pair-code", t]).finalize().into_bytes();
    let n = u32::from_be_bytes([c[0], c[1], c[2], c[3]]) % 1_000_000;
    let s = format!("{:06}", n);
    format!("{} {}", &s[..3], &s[3..])
}

pub fn pair_secret(shared: &[u8; 32], t: &[u8; 32]) -> [u8; 32] {
    mac(shared, &[b"0xio-pair-secret", t]).finalize().into_bytes().into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Desktop,
    Extension,
}

fn proof_mac(
    secret: &[u8; 32],
    role: Role,
    client_id: &str,
    desktop_id: &str,
    nonce_e: &[u8; 32],
    nonce_d: &[u8; 32],
) -> HmacSha256 {
    let role: &[u8] = match role {
        Role::Desktop => b"desktop",
        Role::Extension => b"extension",
    };
    mac(
        secret,
        &[
            b"0xio-auth-v1",
            &[0],
            role,
            &[0],
            client_id.as_bytes(),
            &[0],
            desktop_id.as_bytes(),
            &[0],
            nonce_e,
            nonce_d,
        ],
    )
}

/// HMAC(secret, label, role, ids, both nonces): the role keeps one side's answer from being
/// reflected as the other's, the fresh nonces keep an old answer from being replayed.
pub fn auth_proof(
    secret: &[u8; 32],
    role: Role,
    client_id: &str,
    desktop_id: &str,
    nonce_e: &[u8; 32],
    nonce_d: &[u8; 32],
) -> [u8; 32] {
    proof_mac(secret, role, client_id, desktop_id, nonce_e, nonce_d)
        .finalize()
        .into_bytes()
        .into()
}

pub fn verify_proof(
    secret: &[u8; 32],
    role: Role,
    client_id: &str,
    desktop_id: &str,
    nonce_e: &[u8; 32],
    nonce_d: &[u8; 32],
    proof_hex: &str,
) -> bool {
    let Some(proof) = unhex::<32>(proof_hex) else {
        return false;
    };
    proof_mac(secret, role, client_id, desktop_id, nonce_e, nonce_d)
        .verify_slice(&proof)
        .is_ok()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PairedExtension {
    pub client_id: String,
    /// The exact extension origin it paired from; a hello from another origin is not this pairing.
    pub origin: String,
    pub name: String,
    /// The pairing secret, hex. The desktop needs it to answer and check proofs, so it is kept
    /// as is in a file only this user can read.
    pub secret: String,
    pub paired_at: u64,
    #[serde(default)]
    pub last_used: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PairedNative {
    pub id: String,
    pub name: String,
    /// sha256 of the token the program presents; the token itself is never stored.
    pub token_hash: String,
    pub paired_at: u64,
    #[serde(default)]
    pub last_used: Option<u64>,
}

impl PairedNative {
    pub fn site_origin(&self) -> String {
        let slug: String = self
            .name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let slug: String = slug.chars().take(24).collect();
        let slug = slug.trim_end_matches('-');
        let short: String = self.id.chars().take(6).collect();
        if slug.is_empty() {
            format!("native://app-{short}")
        } else {
            format!("native://{slug}-{short}")
        }
    }
}

pub const TOUCH_EVERY: u64 = 3600;
const DAY: u64 = 86_400;
pub const FORGET_CHOICES: &[u32] = &[7, 30, 90, 0];

fn yes() -> bool {
    true
}

fn ninety() -> u32 {
    90
}

/// The user's choices for the local WebSocket, kept with the pairings so the server reads them
/// before any window opens.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairSettings {
    #[serde(default = "yes")]
    pub allow_legacy: bool,
    #[serde(default = "ninety")]
    pub forget_after_days: u32,
    #[serde(default = "yes")]
    pub notify_sites: bool,
    #[serde(default = "yes")]
    pub direct_sites: bool,
}

impl Default for PairSettings {
    fn default() -> Self {
        Self { allow_legacy: true, forget_after_days: 90, notify_sites: true, direct_sites: true }
    }
}

impl PairSettings {
    pub fn window(&self) -> Option<u64> {
        (self.forget_after_days > 0).then(|| u64::from(self.forget_after_days) * DAY)
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct PairStore {
    #[serde(default)]
    pub desktop_id: String,
    #[serde(default)]
    pub extensions: Vec<PairedExtension>,
    #[serde(default)]
    pub natives: Vec<PairedNative>,
    #[serde(default)]
    pub settings: PairSettings,
}

impl PairedExtension {
    pub fn last_used(&self) -> u64 {
        self.last_used.unwrap_or(self.paired_at)
    }
}

impl PairedNative {
    pub fn last_used(&self) -> u64 {
        self.last_used.unwrap_or(self.paired_at)
    }
}

pub fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

impl PairStore {
    pub fn ensure_id(&mut self) -> bool {
        if is_id(&self.desktop_id) {
            return false;
        }
        self.desktop_id = new_id();
        true
    }

    pub fn extension(&self, client_id: &str, origin: &str) -> Option<&PairedExtension> {
        self.extensions
            .iter()
            .find(|e| e.client_id == client_id && e.origin == origin)
    }

    pub fn add_extension(&mut self, client_id: &str, origin: &str, name: &str, secret: &[u8; 32], now: u64) {
        self.extensions.retain(|e| e.client_id != client_id);
        self.extensions.push(PairedExtension {
            client_id: client_id.to_string(),
            origin: origin.to_string(),
            name: name.to_string(),
            secret: hex(secret),
            paired_at: now,
            last_used: Some(now),
        });
    }

    pub fn native_by_token(&self, token: &str) -> Option<&PairedNative> {
        if token.len() < 32 || token.len() > 128 {
            return None;
        }
        let hash = token_hash(token);
        self.natives.iter().find(|n| n.token_hash == hash)
    }

    pub fn add_native(&mut self, name: &str, token: &str, now: u64) -> PairedNative {
        let entry = PairedNative {
            id: crate::system::uuid::new_v4_simple(),
            name: name.to_string(),
            token_hash: token_hash(token),
            paired_at: now,
            last_used: Some(now),
        };
        self.natives.push(entry.clone());
        entry
    }

    pub fn forget(&mut self, key: &str) -> bool {
        let before = self.extensions.len() + self.natives.len();
        self.extensions.retain(|e| e.client_id != key);
        self.natives.retain(|n| n.id != key);
        before != self.extensions.len() + self.natives.len()
    }

    pub fn touch(&mut self, key: &str, now: u64) -> bool {
        let fresh = |last: u64| now.saturating_sub(last) < TOUCH_EVERY;
        if let Some(e) = self.extensions.iter_mut().find(|e| e.client_id == key) {
            if fresh(e.last_used()) {
                return false;
            }
            e.last_used = Some(now);
            return true;
        }
        if let Some(n) = self.natives.iter_mut().find(|n| n.id == key) {
            if fresh(n.last_used()) {
                return false;
            }
            n.last_used = Some(now);
            return true;
        }
        false
    }

    pub fn sweep(&mut self, now: u64) -> Vec<String> {
        let Some(window) = self.settings.window() else {
            return Vec::new();
        };
        let stale = |last: u64| now.saturating_sub(last) > window;
        let mut gone = Vec::new();
        self.extensions.retain(|e| {
            let keep = !stale(e.last_used());
            if !keep {
                gone.push(e.client_id.clone());
            }
            keep
        });
        self.natives.retain(|n| {
            let keep = !stale(n.last_used());
            if !keep {
                gone.push(n.id.clone());
            }
            keep
        });
        gone
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub client_id: String,
    pub nonce_e: [u8; 32],
    pub nonce_d: [u8; 32],
}

pub fn auth_hello(
    store: &PairStore,
    origin: &str,
    client_id: &str,
    nonce_e_hex: &str,
    nonce_d: [u8; 32],
) -> Result<(serde_json::Value, Option<Challenge>), &'static str> {
    if !is_id(client_id) {
        return Err("client_id must be 32 hex characters");
    }
    let nonce_e = unhex::<32>(nonce_e_hex).ok_or("nonce must be 64 hex characters")?;
    let Some(entry) = store.extension(client_id, origin) else {
        return Ok((serde_json::json!({ "v": 1, "desktop_id": store.desktop_id, "paired": false }), None));
    };
    let secret = unhex::<32>(&entry.secret).ok_or("stored pairing is damaged")?;
    let proof = auth_proof(&secret, Role::Desktop, client_id, &store.desktop_id, &nonce_e, &nonce_d);
    let reply = serde_json::json!({
        "v": 1,
        "desktop_id": store.desktop_id,
        "paired": true,
        "nonce": hex(&nonce_d),
        "proof": hex(&proof),
    });
    Ok((reply, Some(Challenge { client_id: client_id.to_string(), nonce_e, nonce_d })))
}

pub fn auth_prove(
    store: &PairStore,
    origin: &str,
    challenge: Option<Challenge>,
    proof_hex: &str,
) -> Result<String, &'static str> {
    let c = challenge.ok_or("send auth_hello first")?;
    let entry = store.extension(&c.client_id, origin).ok_or("not paired")?;
    let secret = unhex::<32>(&entry.secret).ok_or("stored pairing is damaged")?;
    if verify_proof(&secret, Role::Extension, &c.client_id, &store.desktop_id, &c.nonce_e, &c.nonce_d, proof_hex) {
        Ok(c.client_id)
    } else {
        Err("proof does not match")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionPairing {
    pub client_id: String,
    pub origin: String,
    pub secret: [u8; 32],
}

pub fn start_extension_pairing(
    desktop_id: &str,
    origin: &str,
    client_id: &str,
    epk_e_hex: &str,
) -> Result<([u8; 32], String, ExtensionPairing), &'static str> {
    if !is_id(client_id) {
        return Err("client_id must be 32 hex characters");
    }
    let epk_e = unhex::<32>(epk_e_hex).ok_or("epk must be 64 hex characters")?;
    let (sk, epk_d) = x25519_keypair();
    let shared = x25519_shared(sk, epk_e).ok_or("bad public key")?;
    let t = transcript(desktop_id, client_id, &epk_e, &epk_d);
    Ok((
        epk_d,
        pair_code(&shared, &t),
        ExtensionPairing {
            client_id: client_id.to_string(),
            origin: origin.to_string(),
            secret: pair_secret(&shared, &t),
        },
    ))
}

pub fn clean_name(raw: Option<&str>, client: &Client) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(40).collect();
    // The extension's name is the desktop's to give: a program cannot call itself 0xio.
    if matches!(client, Client::Extension(_)) || cleaned.is_empty() {
        return client.default_name().to_string();
    }
    if cleaned.to_ascii_lowercase().contains("0xio") {
        return format!("{} (not verified)", cleaned);
    }
    cleaned
}

pub fn pairing_code() -> String {
    use rand::Rng;
    let n: u32 = rand::rngs::OsRng.gen_range(0..1_000_000);
    let s = format!("{:06}", n);
    format!("{} {}", &s[..3], &s[3..])
}

pub fn new_token() -> String {
    hex(&random32())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairOutcome {
    Approved(Option<(PairedNative, String)>),
    Refused,
    Expired,
    Cancelled,
}

pub struct PendingPair {
    pub id: String,
    pub key: String,
    pub client: Client,
    pub name: String,
    pub code: String,
    pub created: Instant,
    pub extension: Option<ExtensionPairing>,
    pub waiters: Vec<tokio::sync::oneshot::Sender<PairOutcome>>,
    pub desktop_ok: bool,
    pub ext_ok: bool,
}

impl PendingPair {
    fn is_install(&self, client_id: &str) -> bool {
        self.extension.as_ref().is_some_and(|e| e.client_id == client_id)
    }
}

#[derive(Default)]
pub struct Pairing {
    pub pending: HashMap<String, PendingPair>,
    refused_until: HashMap<String, Instant>,
    quiet_until: Option<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairStart {
    Paired(Option<PairedNative>),
    Join(String),
    Review,
    Later(Duration),
    Refused(&'static str),
}

#[derive(Debug)]
pub enum Approve {
    Done(PendingPair),
    /// An extension's review keeps nothing until the extension confirms the code.
    Waiting,
}

#[derive(Debug)]
pub enum Confirm {
    Done(PendingPair),
    Held,
    Ignored,
}

impl std::fmt::Debug for PendingPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPair").field("id", &self.id).field("key", &self.key).finish_non_exhaustive()
    }
}

impl Pairing {
    pub fn start(
        &mut self,
        store: &PairStore,
        client: &Client,
        key: &str,
        token: Option<&str>,
        now: Instant,
    ) -> PairStart {
        if *client == Client::Native {
            if let Some(n) = token.and_then(|t| store.native_by_token(t)) {
                return PairStart::Paired(Some(n.clone()));
            }
        }
        self.expire(now);
        if self.refused_until.get(key).is_some_and(|t| *t > now) {
            return PairStart::Refused("Pairing was refused. Try again in a minute.");
        }
        // An extension's review carries its own key exchange, so a second request replaces
        // nothing: it waits for the cooldown or the open review to end.
        if let Some(p) = self.pending.values().find(|p| p.key == key) {
            return if matches!(client, Client::Extension(_)) {
                PairStart::Refused("A pairing request is already open in 0xio Desktop")
            } else {
                PairStart::Join(p.id.clone())
            };
        }
        if self.pending.len() >= MAX_PENDING_PAIRS {
            return PairStart::Refused("A pairing request is already open in 0xio Desktop");
        }
        if let Some(left) = self.quiet_until.and_then(|t| t.checked_duration_since(now)).filter(|d| !d.is_zero()) {
            return PairStart::Later(left);
        }
        PairStart::Review
    }

    pub fn take(&mut self, id: &str, now: Instant) -> Option<PendingPair> {
        let p = self.pending.remove(id)?;
        self.quiet_until = Some(now + PAIR_GAP);
        Some(p)
    }

    pub fn approve(&mut self, id: &str, now: Instant) -> Option<Approve> {
        let p = self.pending.get_mut(id)?;
        if p.extension.is_some() && !p.ext_ok {
            p.desktop_ok = true;
            return Some(Approve::Waiting);
        }
        self.take(id, now).map(Approve::Done)
    }

    pub fn confirm(&mut self, id: &str, client_id: &str, now: Instant) -> Confirm {
        let Some(p) = self.pending.get_mut(id).filter(|p| p.is_install(client_id)) else {
            return Confirm::Ignored;
        };
        if !p.desktop_ok {
            p.ext_ok = true;
            return Confirm::Held;
        }
        self.take(id, now).map_or(Confirm::Ignored, Confirm::Done)
    }

    pub fn cancel(&mut self, id: &str, client_id: &str, now: Instant) -> Option<PendingPair> {
        if !self.pending.get(id)?.is_install(client_id) {
            return None;
        }
        self.take(id, now)
    }

    pub fn expire(&mut self, now: Instant) -> Vec<String> {
        let gone: Vec<String> = self
            .pending
            .values()
            .filter(|p| now.duration_since(p.created) >= PAIR_TIMEOUT)
            .map(|p| p.id.clone())
            .collect();
        for id in &gone {
            if let Some(p) = self.take(id, now) {
                for w in p.waiters {
                    let _ = w.send(PairOutcome::Expired);
                }
            }
        }
        self.refused_until.retain(|_, t| *t > now);
        gone
    }

    pub fn refuse(&mut self, key: &str, now: Instant) {
        self.refused_until.insert(key.to_string(), now + PAIR_COOLDOWN);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME: &str = "chrome-extension://anknhjilldkeelailocijnfibefmepcc";
    const FIREFOX: &str = "moz-extension://3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";

    #[test]
    fn no_origin_is_a_local_program() {
        assert_eq!(classify(None, WebPolicy::OFF), Ok(Client::Native));
    }

    #[test]
    fn web_pages_are_refused_at_the_handshake() {
        for page in [
            "https://app.example.com",
            "http://localhost:5173",
            "HTTPS://App.Example.com",
            "http://127.0.0.1:19345",
            "https://app.example.com/path",
            "file://",
            "file:///Users/me/page.html",
        ] {
            assert_eq!(classify(Some(page), WebPolicy::OFF), Err("web page"), "{page}");
        }
    }

    const ON: WebPolicy = WebPolicy { allowed: true, dev: false };
    const DEV: WebPolicy = WebPolicy { allowed: true, dev: true };

    #[test]
    fn web_pages_connect_only_while_allowed_and_well_formed() {
        let web = |o: &str| Ok(Client::Web(o.to_string()));
        assert_eq!(classify(Some("https://app.example.com"), ON), web("https://app.example.com"));
        assert_eq!(classify(Some("HTTPS://App.Example.COM"), ON), web("https://app.example.com"));
        assert_eq!(classify(Some("https://app.example.com:443"), ON), web("https://app.example.com"));
        assert_eq!(classify(Some("https://app.example.com:8443"), ON), web("https://app.example.com:8443"));
        assert_eq!(classify(Some("https://app.example.com"), WebPolicy::OFF), Err("web page"));
        for bad in [
            "https://app.example.com/",
            "https://app.example.com/path",
            "https://user@app.example.com",
            "https://app.example.com?x=1",
            "https://app.example.com#x",
            "http://app.example.com",
            "http://localhost.example.com",
            "https://",
            "file:///Users/me/page.html",
            "null",
        ] {
            assert!(classify(Some(bad), DEV).is_err(), "{bad}");
        }
        for local in ["http://localhost:5173", "http://127.0.0.1:3000", "http://localhost"] {
            assert!(classify(Some(local), ON).is_err(), "{local} in a release build");
            assert_eq!(classify(Some(local), DEV), web(local), "{local} in a dev build");
        }
        assert_eq!(classify(Some("http://LOCALHOST:80"), DEV), web("http://localhost"));
        assert_eq!(classify(Some(CHROME), ON), Ok(Client::Extension(CHROME.into())));
        assert_eq!(classify(None, ON), Ok(Client::Native));
    }

    #[test]
    fn a_web_page_gets_nothing_from_the_paired_methods() {
        let page = Client::Web("https://app.example.com".into());
        for m in ["init", "auth_hello", "auth_pair", "auth_prove", "pair", "wallet_rpc", "makeRangeProof", "decrypt"] {
            assert_eq!(access(&page, &FRESH, true, m), Access::Pair, "{m}");
        }
    }

    #[test]
    fn web_connections_are_capped_apart_from_the_extension() {
        let mut caps = ConnCaps::default();
        let a = Client::Web("https://a.com".into());
        for _ in 0..MAX_WEB_PER_ORIGIN {
            assert!(caps.admit(&a));
        }
        assert!(!caps.admit(&a), "per origin");
        let mut admitted = MAX_WEB_PER_ORIGIN;
        for i in 0..40 {
            if caps.admit(&Client::Web(format!("https://s{i}.com"))) {
                admitted += 1;
            }
        }
        assert_eq!(admitted, MAX_WEB_CONNECTIONS, "in all");
        assert!(caps.admit(&Client::Extension(CHROME.into())), "the extension still gets in");
        caps.release(&a);
        assert!(caps.admit(&a), "a slot came free");
        assert!(!caps.admit(&Client::Web("https://new.com".into())), "and is taken again");
        for _ in 1..MAX_OTHER_CONNECTIONS {
            assert!(caps.admit(&Client::Native));
        }
        assert!(!caps.admit(&Client::Native));
    }

    #[test]
    fn web_handshakes_cannot_use_up_the_extension_handshakes() {
        let t0 = Instant::now();
        let mut l = HandshakeLimits::default();
        let a = Client::Web("https://a.com".into());
        assert_eq!((0..20).filter(|_| l.allow(&a, t0)).count(), 12, "per origin");
        for i in 0..200 {
            l.allow(&Client::Web(format!("https://s{i}.com")), t0);
        }
        assert!(!l.allow(&Client::Web("https://late.com".into()), t0), "web in all");
        assert!(l.allow(&Client::Extension(CHROME.into()), t0));
        assert!(l.allow(&Client::Native, t0));
    }

    #[test]
    fn malformed_origins_are_refused() {
        for bad in ["", " ", "chrome-extension://a b", "\u{7}"] {
            assert!(classify(Some(bad), WebPolicy::OFF).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn opaque_file_and_other_schemes_are_refused() {
        assert_eq!(classify(Some("null"), WebPolicy::OFF), Err("opaque origin"));
        assert_eq!(classify(Some("NULL"), WebPolicy::OFF), Err("opaque origin"));
        assert!(classify(Some("safari-web-extension://abc"), WebPolicy::OFF).is_err());
        assert!(classify(Some("data:text/html,hi"), WebPolicy::OFF).is_err());
        assert!(classify(Some("ws://127.0.0.1:19345"), WebPolicy::OFF).is_err());
    }

    #[test]
    fn release_builds_know_only_the_0xio_chrome_extension_id() {
        assert_eq!(classify(Some(CHROME), WebPolicy::OFF), Ok(Client::Extension(CHROME.into())));
        let unpacked = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if cfg!(debug_assertions) {
            assert_eq!(classify(Some(unpacked), WebPolicy::OFF), Ok(Client::Extension(unpacked.into())));
        } else {
            assert_eq!(classify(Some(unpacked), WebPolicy::OFF), Err("unknown extension"));
        }
        assert_eq!(
            classify(Some("chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), WebPolicy::OFF),
            Err("unknown extension")
        );
        assert_eq!(classify(Some(&format!("{CHROME}/popup.html")), WebPolicy::OFF), Err("unknown extension"));
    }

    #[test]
    fn a_firefox_extension_needs_a_well_formed_install_id() {
        assert_eq!(classify(Some(FIREFOX), WebPolicy::OFF), Ok(Client::Extension(FIREFOX.into())));
        assert!(classify(Some("moz-extension://not-a-uuid"), WebPolicy::OFF).is_err());
        assert!(classify(Some(&format!("{FIREFOX}/x")), WebPolicy::OFF).is_err());
    }

    const FRESH: Session = Session { trusted: false, handshake: false };
    const TRUSTED: Session = Session { trusted: true, handshake: true };

    #[test]
    fn nothing_but_trust_setup_runs_before_trust() {
        let ext = Client::Extension(CHROME.into());
        for m in ["auth_hello", "auth_prove", "auth_pair", "ping"] {
            assert_eq!(access(&ext, &FRESH, false, m), Access::Allow, "{m}");
        }
        for m in ["init", "makeRangeProof", "decrypt", "destroy", "wallet_rpc", "pair"] {
            assert_eq!(access(&ext, &FRESH, false, m), Access::Pair, "{m}");
            assert_eq!(access(&ext, &TRUSTED, false, m), Access::Allow, "{m}");
        }
        assert_eq!(access(&Client::Native, &FRESH, false, "pair"), Access::Allow);
        assert_eq!(access(&Client::Native, &FRESH, false, "auth_pair"), Access::Pair);
        assert_eq!(access(&Client::Native, &FRESH, false, "init"), Access::Pair);
        assert_eq!(access(&Client::Native, &TRUSTED, false, "init"), Access::Allow);
    }

    #[test]
    fn an_unpaired_extension_gets_only_the_legacy_proof_calls() {
        for origin in [CHROME, FIREFOX] {
            let ext = Client::Extension(origin.into());
            for m in LEGACY_METHODS {
                assert_eq!(access(&ext, &FRESH, true, m), Access::Legacy, "{m}");
            }
            for m in [
                "wallet_rpc",
                "destroy",
                "pair",
                "commit",
                "ctAdd",
                "diagnoseCipher",
                "aesKat",
                "matchesSecretProfile",
                "wallet_get_private_key",
                "unknown",
            ] {
                assert_eq!(access(&ext, &FRESH, true, m), Access::Pair, "{m}");
            }
            assert_eq!(access(&ext, &FRESH, true, "ping"), Access::Allow);
            assert_eq!(access(&ext, &FRESH, true, "auth_hello"), Access::Allow);
        }
    }

    #[test]
    fn legacy_is_refused_when_turned_off() {
        let ext = Client::Extension(CHROME.into());
        for m in LEGACY_METHODS {
            assert_eq!(access(&ext, &FRESH, false, m), Access::Pair, "{m}");
        }
    }

    #[test]
    fn a_program_never_gets_legacy() {
        for m in LEGACY_METHODS {
            assert_eq!(access(&Client::Native, &FRESH, true, m), Access::Pair, "{m}");
        }
    }

    #[test]
    fn a_connection_that_began_the_handshake_cannot_fall_back_to_legacy() {
        let ext = Client::Extension(CHROME.into());
        for start in ["auth_hello", "auth_pair", "auth_prove"] {
            let mut s = Session::default();
            s.record(start);
            assert!(s.handshake, "{start}");
            assert_eq!(access(&ext, &s, true, "init"), Access::Pair, "{start}");
        }
        let mut s = Session::default();
        s.record("init");
        assert!(!s.handshake);
        assert_eq!(access(&ext, &s, true, "makeBoundProof"), Access::Legacy);
    }

    #[test]
    fn the_window_limits_per_key_and_forgets_old_hits() {
        let t0 = Instant::now();
        let mut w = Window::new(Duration::from_secs(60), 3);
        assert!(w.hit("a", t0));
        assert!(w.hit("a", t0));
        assert!(w.hit("a", t0));
        assert!(!w.hit("a", t0));
        assert!(w.hit("b", t0));
        assert!(w.hit("a", t0 + Duration::from_secs(61)));
    }

    #[test]
    fn handshakes_are_limited_per_client_and_overall() {
        let t0 = Instant::now();
        let mut l = HandshakeLimits::default();
        let ext = Client::Extension(CHROME.into());
        let allowed = (0..20).filter(|_| l.allow(&ext, t0)).count();
        assert_eq!(allowed, 12);
        assert!(l.allow(&Client::Native, t0));
        let mut overall = HandshakeLimits::default();
        let mut ok = 0;
        for i in 0..100 {
            let id = format!("3f2a9c1e-7b4d-4e8a-9c0f-{:012x}", i);
            if overall.allow(&Client::Extension(format!("moz-extension://{id}")), t0) {
                ok += 1;
            }
        }
        assert_eq!(ok, 60);
    }

    #[test]
    fn a_program_with_a_valid_token_is_paired() {
        let now = Instant::now();
        let mut store = PairStore::default();
        let mut p = Pairing::default();
        let token = new_token();
        let entry = store.add_native("My bot", &token, 1);
        assert_eq!(
            p.start(&store, &Client::Native, "native:1", Some(&token), now),
            PairStart::Paired(Some(entry))
        );
        assert_eq!(p.start(&store, &Client::Native, "native:1", Some(&new_token()), now), PairStart::Review);
        assert_eq!(p.start(&store, &Client::Native, "native:1", Some("short"), now), PairStart::Review);
        assert!(!store.natives.iter().any(|n| n.token_hash == token));
    }

    fn pending(id: &str, key: &str, client: Client, created: Instant) -> PendingPair {
        PendingPair {
            id: id.into(),
            key: key.into(),
            client,
            name: "x".into(),
            code: "123 456".into(),
            created,
            extension: None,
            waiters: vec![],
            desktop_ok: false,
            ext_ok: false,
        }
    }

    const INSTALL: &str = "fedcba9876543210fedcba9876543210";

    fn ext_pending(id: &str, created: Instant) -> PendingPair {
        let mut p = pending(id, &format!("ext:{INSTALL}"), Client::Extension(CHROME.into()), created);
        p.extension = Some(ExtensionPairing { client_id: INSTALL.into(), origin: CHROME.into(), secret: [9; 32] });
        p
    }

    #[test]
    fn one_review_at_a_time_across_all_clients() {
        let now = Instant::now();
        let store = PairStore::default();
        let mut p = Pairing::default();
        let ext = Client::Extension(CHROME.into());
        p.pending.insert("r1".into(), pending("r1", CHROME, ext.clone(), now));
        assert!(matches!(p.start(&store, &ext, CHROME, None, now), PairStart::Refused(_)));
        assert!(matches!(p.start(&store, &Client::Native, "native:1", None, now), PairStart::Refused(_)));
        p.pending.clear();
        p.pending.insert("r0".into(), pending("r0", "native:1", Client::Native, now));
        assert_eq!(p.start(&store, &Client::Native, "native:1", None, now), PairStart::Join("r0".into()));
        assert!(matches!(p.start(&store, &Client::Native, "native:2", None, now), PairStart::Refused(_)));
        assert!(matches!(
            p.start(&store, &Client::Extension(FIREFOX.into()), FIREFOX, None, now),
            PairStart::Refused(_)
        ));
    }

    #[test]
    fn a_closed_review_holds_the_next_one_for_a_moment() {
        let now = Instant::now();
        let store = PairStore::default();
        let mut p = Pairing::default();
        let ext = Client::Extension(CHROME.into());
        p.pending.insert("r1".into(), pending("r1", "native:1", Client::Native, now));
        assert!(p.take("r1", now).is_some());
        assert!(p.take("r1", now).is_none());
        assert_eq!(p.start(&store, &ext, CHROME, None, now), PairStart::Later(PAIR_GAP));
        let half = now + PAIR_GAP / 2;
        assert_eq!(p.start(&store, &ext, CHROME, None, half), PairStart::Later(PAIR_GAP - PAIR_GAP / 2));
        assert_eq!(p.start(&store, &ext, CHROME, None, now + PAIR_GAP), PairStart::Review);

        let token = new_token();
        let mut store = PairStore::default();
        let entry = store.add_native("bot", &token, 1);
        p.pending.insert("r2".into(), pending("r2", "native:2", Client::Native, now));
        p.take("r2", now);
        assert_eq!(
            p.start(&store, &Client::Native, "native:3", Some(&token), now),
            PairStart::Paired(Some(entry)),
            "a program with its token does not wait"
        );

        p.pending.insert("r3".into(), pending("r3", "native:4", Client::Native, now));
        assert_eq!(p.expire(now + PAIR_TIMEOUT), vec!["r3".to_string()]);
        assert_eq!(
            p.start(&PairStore::default(), &ext, CHROME, None, now + PAIR_TIMEOUT),
            PairStart::Later(PAIR_GAP),
            "an expired review holds the next one too"
        );
    }

    #[test]
    fn an_extension_pairing_needs_both_the_desktop_pair_and_the_extension_confirm() {
        let now = Instant::now();
        let mut p = Pairing::default();

        p.pending.insert("a".into(), ext_pending("a", now));
        assert!(matches!(p.approve("a", now), Some(Approve::Waiting)), "Pair alone keeps nothing");
        assert!(p.pending["a"].desktop_ok);
        assert!(matches!(p.confirm("a", "00000000000000000000000000000000", now), Confirm::Ignored));
        assert!(p.cancel("a", "00000000000000000000000000000000", now).is_none(), "another install cannot cancel");
        assert!(matches!(p.confirm("a", INSTALL, now), Confirm::Done(d) if d.id == "a"));
        assert!(p.pending.is_empty());

        p.pending.insert("b".into(), ext_pending("b", now));
        assert!(matches!(p.confirm("b", INSTALL, now), Confirm::Held), "confirm alone keeps nothing");
        assert!(p.pending["b"].ext_ok);
        assert!(matches!(p.confirm("b", INSTALL, now), Confirm::Held));
        assert!(matches!(p.approve("b", now), Some(Approve::Done(d)) if d.id == "b"), "Pair after the confirm settles");
        assert!(p.approve("b", now).is_none());

        p.pending.insert("c".into(), ext_pending("c", now));
        p.approve("c", now);
        assert!(p.cancel("c", INSTALL, now).is_some());
        assert!(matches!(p.confirm("c", INSTALL, now), Confirm::Ignored), "a cancelled review takes no confirm");

        assert!(matches!(p.confirm("none", INSTALL, now), Confirm::Ignored));
        p.pending.insert("n".into(), pending("n", "native:1", Client::Native, now));
        assert!(matches!(p.confirm("n", INSTALL, now), Confirm::Ignored), "a program's review takes no confirm");
        assert!(matches!(p.approve("n", now), Some(Approve::Done(_))), "a program pairs on Pair alone");
    }

    #[test]
    fn a_refusal_cools_down_and_old_reviews_expire() {
        let now = Instant::now();
        let store = PairStore::default();
        let mut p = Pairing::default();
        p.refuse("native:1", now);
        assert!(matches!(p.start(&store, &Client::Native, "native:1", None, now), PairStart::Refused(_)));
        assert_eq!(
            p.start(&store, &Client::Native, "native:1", None, now + PAIR_COOLDOWN),
            PairStart::Review
        );

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let mut old = pending("r1", "native:2", Client::Native, now);
        old.waiters.push(tx);
        p.pending.insert("r1".into(), old);
        assert_eq!(p.expire(now + PAIR_TIMEOUT), vec!["r1".to_string()]);
        assert!(p.pending.is_empty());
        assert_eq!(rx.try_recv(), Ok(PairOutcome::Expired));
    }

    #[test]
    fn names_are_cleaned_and_the_extension_name_is_fixed() {
        assert_eq!(clean_name(Some("  My\n bot \u{7}"), &Client::Native), "My bot");
        assert_eq!(clean_name(None, &Client::Native), "Local app");
        assert_eq!(clean_name(Some("0xio Wallet"), &Client::Native), "0xio Wallet (not verified)");
        assert_eq!(clean_name(Some("Evil"), &Client::Extension(CHROME.into())), "0xio extension");
        assert_eq!(clean_name(None, &Client::Extension(FIREFOX.into())), "Firefox extension");
        assert_eq!(clean_name(Some(&"x".repeat(100)), &Client::Native).len(), 40);
    }

    #[test]
    fn codes_are_six_digits_and_tokens_are_long() {
        let c = pairing_code();
        assert_eq!(c.len(), 7);
        assert!(c.chars().filter(|c| *c != ' ').all(|c| c.is_ascii_digit()));
        assert_eq!(new_token().len(), 64);
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn a_paired_program_is_its_own_site() {
        let n = PairedNative {
            id: "abcdef123456".into(),
            name: "My Bot!".into(),
            token_hash: String::new(),
            paired_at: 0,
            last_used: None,
        };
        assert_eq!(n.site_origin(), "native://my-bot-abcdef");
        let blank = PairedNative { name: "***".into(), ..n.clone() };
        assert_eq!(blank.site_origin(), "native://app-abcdef");
    }

    const DESKTOP_ID: &str = "0123456789abcdef0123456789abcdef";
    const CLIENT_ID: &str = "fedcba9876543210fedcba9876543210";

    fn pk(sk: [u8; 32]) -> [u8; 32] {
        curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped(sk).to_bytes()
    }

    #[test]
    fn both_sides_derive_the_same_code_and_secret() {
        let (sk_e, sk_d) = ([7u8; 32], [9u8; 32]);
        let (pk_e, pk_d) = (pk(sk_e), pk(sk_d));
        let t = transcript(DESKTOP_ID, CLIENT_ID, &pk_e, &pk_d);
        let ext = x25519_shared(sk_e, pk_d).unwrap();
        let desk = x25519_shared(sk_d, pk_e).unwrap();
        assert_eq!(ext, desk);
        assert_eq!(pair_code(&ext, &t), pair_code(&desk, &t));
        assert_eq!(pair_secret(&ext, &t), pair_secret(&desk, &t));
        let code = pair_code(&ext, &t);
        assert_eq!(code.len(), 7);
        assert_eq!(&code[3..4], " ");
    }

    /// The same numbers the extension's tests check (desktopPairing.test.ts), so both sides agree
    /// byte for byte.
    #[test]
    fn known_vectors_match_the_extension() {
        let (sk_e, sk_d) = ([7u8; 32], [9u8; 32]);
        let (pk_e, pk_d) = (pk(sk_e), pk(sk_d));
        let t = transcript(DESKTOP_ID, CLIENT_ID, &pk_e, &pk_d);
        let shared = x25519_shared(sk_e, pk_d).unwrap();
        let secret = pair_secret(&shared, &t);
        let (ne, nd) = ([1u8; 32], [2u8; 32]);
        let vectors = format!(
            "pk_e={}\npk_d={}\nshared={}\nt={}\ncode={}\nsecret={}\nproof_d={}\nproof_e={}",
            hex(&pk_e),
            hex(&pk_d),
            hex(&shared),
            hex(&t),
            pair_code(&shared, &t),
            hex(&secret),
            hex(&auth_proof(&secret, Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &nd)),
            hex(&auth_proof(&secret, Role::Extension, CLIENT_ID, DESKTOP_ID, &ne, &nd)),
        );
        assert_eq!(vectors, VECTORS, "\n{vectors}");
    }

    const VECTORS: &str = concat!(
        "pk_e=13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d\n",
        "pk_d=57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421\n",
        "shared=2ffe325b2a26611bf1911325d4a62b33749b8f350d0e88ba91e316acaae66554\n",
        "t=b24af20d8c79d4e62222c00ba1806992f32289aef3ef51cea65f4700ade34725\n",
        "code=821 949\n",
        "secret=bfbe67bee02915a813cc18ab4c1f2b8cf6c837b30e3ff86f8165b447c4afd1c7\n",
        "proof_d=25a0554cb9d737431d119e312a8895713eb7d15b5fecb99bf4e425e798436937\n",
        "proof_e=33499666c02c8e0238fb778a54d6ef377b23af9020e1aeddcd33aa762385a70f"
    );

    #[test]
    fn a_man_in_the_middle_gets_different_codes_on_each_side() {
        let (sk_e, sk_d, sk_m1, sk_m2) = ([7u8; 32], [9u8; 32], [11u8; 32], [13u8; 32]);
        // Extension to attacker, attacker to desktop: two exchanges, two transcripts.
        let t1 = transcript(DESKTOP_ID, CLIENT_ID, &pk(sk_e), &pk(sk_m1));
        let code_ext = pair_code(&x25519_shared(sk_e, pk(sk_m1)).unwrap(), &t1);
        let t2 = transcript(DESKTOP_ID, CLIENT_ID, &pk(sk_m2), &pk(sk_d));
        let code_desk = pair_code(&x25519_shared(sk_d, pk(sk_m2)).unwrap(), &t2);
        assert_ne!(code_ext, code_desk);
        let t = transcript(DESKTOP_ID, CLIENT_ID, &pk(sk_e), &pk(sk_d));
        let honest = x25519_shared(sk_e, pk(sk_d)).unwrap();
        assert_ne!(pair_secret(&x25519_shared(sk_m1, pk(sk_d)).unwrap(), &t), pair_secret(&honest, &t));
    }

    #[test]
    fn a_low_order_public_key_is_refused() {
        assert!(x25519_shared([7u8; 32], [0u8; 32]).is_none());
        assert!(start_extension_pairing(DESKTOP_ID, CHROME, CLIENT_ID, &hex(&[0u8; 32])).is_err());
        assert!(start_extension_pairing(DESKTOP_ID, CHROME, "short", &hex(&pk([7u8; 32]))).is_err());
        assert!(start_extension_pairing(DESKTOP_ID, CHROME, CLIENT_ID, "zz").is_err());
    }

    #[test]
    fn proofs_verify_only_for_the_right_secret_role_and_nonces() {
        let secret = [5u8; 32];
        let (ne, nd) = ([1u8; 32], [2u8; 32]);
        let p = hex(&auth_proof(&secret, Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &nd));
        assert!(verify_proof(&secret, Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &nd, &p));
        assert!(!verify_proof(&secret, Role::Extension, CLIENT_ID, DESKTOP_ID, &ne, &nd, &p));
        assert!(!verify_proof(&[6u8; 32], Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &nd, &p));
        assert!(!verify_proof(&secret, Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &[3u8; 32], &p));
        assert!(!verify_proof(&secret, Role::Desktop, DESKTOP_ID, CLIENT_ID, &ne, &nd, &p));
        assert!(!verify_proof(&secret, Role::Desktop, CLIENT_ID, DESKTOP_ID, &ne, &nd, "nothex"));
    }

    fn paired_store() -> (PairStore, [u8; 32]) {
        let mut store = PairStore::default();
        store.ensure_id();
        let secret = [5u8; 32];
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &secret, 1);
        (store, secret)
    }

    #[test]
    fn hello_then_prove_verifies_both_sides() {
        let (store, secret) = paired_store();
        let ne = [1u8; 32];
        let (reply, challenge) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&ne), [2u8; 32]).unwrap();
        assert_eq!(reply["paired"], true);
        assert_eq!(reply["v"], 1);
        let nd = unhex::<32>(reply["nonce"].as_str().unwrap()).unwrap();
        assert!(verify_proof(&secret, Role::Desktop, CLIENT_ID, &store.desktop_id, &ne, &nd, reply["proof"].as_str().unwrap()));
        let proof_e = hex(&auth_proof(&secret, Role::Extension, CLIENT_ID, &store.desktop_id, &ne, &nd));
        assert_eq!(auth_prove(&store, CHROME, challenge, &proof_e), Ok(CLIENT_ID.to_string()));
    }

    #[test]
    fn a_replayed_proof_is_rejected() {
        let (store, secret) = paired_store();
        let ne = [1u8; 32];
        let (_, first) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&ne), [2u8; 32]).unwrap();
        let old = hex(&auth_proof(&secret, Role::Extension, CLIENT_ID, &store.desktop_id, &ne, &[2u8; 32]));
        assert!(auth_prove(&store, CHROME, first, &old).is_ok());
        // A new connection draws a new desktop nonce: the recorded proof no longer fits.
        let (_, second) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&ne), [3u8; 32]).unwrap();
        assert!(auth_prove(&store, CHROME, second, &old).is_err());
        assert!(auth_prove(&store, CHROME, None, &old).is_err());
    }

    #[test]
    fn the_desktop_proof_cannot_be_reflected_as_the_extension_proof() {
        let (store, _) = paired_store();
        let (reply, challenge) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&[1u8; 32]), [2u8; 32]).unwrap();
        let reflected = reply["proof"].as_str().unwrap().to_string();
        assert!(auth_prove(&store, CHROME, challenge, &reflected).is_err());
    }

    #[test]
    fn hello_from_another_origin_or_unknown_install_is_not_paired() {
        let (store, _) = paired_store();
        let (reply, c) = auth_hello(&store, FIREFOX, CLIENT_ID, &hex(&[1u8; 32]), [2u8; 32]).unwrap();
        assert_eq!(reply["paired"], false);
        assert!(c.is_none());
        assert!(reply.get("proof").is_none());
        let (reply, _) = auth_hello(&store, CHROME, "00000000000000000000000000000000", &hex(&[1u8; 32]), [2u8; 32]).unwrap();
        assert_eq!(reply["paired"], false);
        assert!(auth_hello(&store, CHROME, CLIENT_ID, "short", [2u8; 32]).is_err());
    }

    #[test]
    fn unpairing_ends_verification() {
        let (mut store, secret) = paired_store();
        let ne = [1u8; 32];
        let (_, challenge) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&ne), [2u8; 32]).unwrap();
        assert!(store.forget(CLIENT_ID));
        let proof = hex(&auth_proof(&secret, Role::Extension, CLIENT_ID, &store.desktop_id, &ne, &[2u8; 32]));
        assert!(auth_prove(&store, CHROME, challenge, &proof).is_err());
        let (reply, _) = auth_hello(&store, CHROME, CLIENT_ID, &hex(&ne), [2u8; 32]).unwrap();
        assert_eq!(reply["paired"], false);
    }

    #[test]
    fn pairing_again_replaces_the_old_secret() {
        let (mut store, _) = paired_store();
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &[8u8; 32], 2);
        assert_eq!(store.extensions.len(), 1);
        assert_eq!(store.extensions[0].secret, hex(&[8u8; 32]));
    }

    #[test]
    fn a_desktop_id_is_made_once() {
        let mut store = PairStore::default();
        assert!(store.ensure_id());
        assert!(is_id(&store.desktop_id));
        let id = store.desktop_id.clone();
        assert!(!store.ensure_id());
        assert_eq!(store.desktop_id, id);
    }

    #[test]
    fn forgetting_removes_by_install_or_program_id() {
        let mut store = PairStore::default();
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &[5u8; 32], 1);
        let n = store.add_native("bot", &new_token(), 1);
        assert!(store.forget(CLIENT_ID));
        assert!(store.extension(CLIENT_ID, CHROME).is_none());
        assert!(store.forget(&n.id));
        assert!(!store.forget("missing"));
    }

    const DAY_S: u64 = 86_400;

    fn store_with(days: u32) -> PairStore {
        let mut store = PairStore::default();
        store.settings.forget_after_days = days;
        store
    }

    #[test]
    fn settings_default_to_legacy_on_ninety_days_and_notifications_on() {
        let store: PairStore = serde_json::from_str(r#"{"desktop_id":"","extensions":[],"natives":[]}"#).unwrap();
        assert_eq!(
            store.settings,
            PairSettings { allow_legacy: true, forget_after_days: 90, notify_sites: true, direct_sites: true }
        );
        let partial: PairStore = serde_json::from_str(r#"{"settings":{"allow_legacy":false}}"#).unwrap();
        assert!(!partial.settings.allow_legacy);
        assert_eq!(partial.settings.forget_after_days, 90);
        assert!(partial.settings.notify_sites);
        assert!(partial.settings.direct_sites, "websites may connect unless turned off");
        let off: PairStore = serde_json::from_str(r#"{"settings":{"direct_sites":false}}"#).unwrap();
        assert!(!off.settings.direct_sites);
        assert_eq!(PairSettings { forget_after_days: 0, ..PairSettings::default() }.window(), None);
        assert_eq!(PairSettings::default().window(), Some(90 * DAY_S));
    }

    #[test]
    fn unused_pairings_expire_by_last_use() {
        let now = 1_000 * DAY_S;
        let mut store = store_with(30);
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &[5u8; 32], now - 40 * DAY_S);
        let old = store.add_native("old bot", &new_token(), now - 40 * DAY_S);
        let used = store.add_native("used bot", &new_token(), now - 40 * DAY_S);
        store.natives.iter_mut().find(|n| n.id == used.id).unwrap().last_used = Some(now - 2 * DAY_S);
        let mut gone = store.sweep(now);
        gone.sort();
        let mut want = vec![CLIENT_ID.to_string(), old.id.clone()];
        want.sort();
        assert_eq!(gone, want);
        assert!(store.extensions.is_empty());
        assert_eq!(store.natives.len(), 1);
        assert_eq!(store.natives[0].id, used.id);
        assert!(store.sweep(now).is_empty());
    }

    #[test]
    fn never_keeps_every_pairing() {
        let now = 10_000 * DAY_S;
        let mut store = store_with(0);
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &[5u8; 32], 1);
        store.add_native("bot", &new_token(), 1);
        assert!(store.sweep(now).is_empty());
        assert_eq!(store.extensions.len() + store.natives.len(), 2);
    }

    #[test]
    fn last_use_falls_back_to_the_pairing_time() {
        let raw = format!(
            r#"{{"desktop_id":"{DESKTOP_ID}","extensions":[{{"client_id":"{CLIENT_ID}","origin":"{CHROME}","name":"0xio extension","secret":"{}","paired_at":100}}],"natives":[{{"id":"abc","name":"bot","token_hash":"","paired_at":200}}]}}"#,
            hex(&[5u8; 32])
        );
        let mut store: PairStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(store.extensions[0].last_used, None);
        assert_eq!(store.extensions[0].last_used(), 100);
        assert_eq!(store.natives[0].last_used(), 200);
        store.settings.forget_after_days = 7;
        assert_eq!(store.sweep(100 + 7 * DAY_S), Vec::<String>::new());
        assert_eq!(store.sweep(150 + 7 * DAY_S), vec![CLIENT_ID.to_string()]);
        assert_eq!(store.sweep(201 + 7 * DAY_S), vec!["abc".to_string()]);
    }

    #[test]
    fn last_use_is_written_at_most_hourly() {
        let mut store = PairStore::default();
        store.add_extension(CLIENT_ID, CHROME, "0xio extension", &[5u8; 32], 1_000);
        let n = store.add_native("bot", &new_token(), 1_000);
        assert_eq!(store.extensions[0].last_used, Some(1_000));
        assert!(!store.touch(CLIENT_ID, 1_000 + TOUCH_EVERY - 1));
        assert!(store.touch(CLIENT_ID, 1_000 + TOUCH_EVERY));
        assert_eq!(store.extensions[0].last_used(), 1_000 + TOUCH_EVERY);
        assert!(!store.touch(&n.id, 1_500));
        assert!(store.touch(&n.id, 1_000 + 2 * TOUCH_EVERY));
        assert!(!store.touch("missing", 1_000_000));
    }
}
