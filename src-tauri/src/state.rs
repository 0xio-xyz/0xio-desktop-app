use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicUsize, Ordering}};
use pvac_handler::Context;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub struct Slot<C> {
    pub fp: Option<String>,
    pub ctx: Option<C>,
}

pub type PvacSlot = Slot<Context>;
/// The desktop's own slot: a proof clones the handle and runs without holding the lock, so
/// independent proofs can run side by side.
pub type DeskSlot = Slot<Arc<Context>>;

impl<C> Default for Slot<C> {
    fn default() -> Self {
        Self { fp: None, ctx: None }
    }
}

impl<C> Slot<C> {
    pub fn set(&mut self, fp: String, ctx: C) {
        self.fp = Some(fp);
        self.ctx = Some(ctx);
    }

    pub fn clear(&mut self) {
        self.fp = None;
        self.ctx = None;
    }
}

/// sha256 over a domain tag and the PVAC master seed: names the key material without exposing it.
pub fn context_fingerprint(master: &[u8; 32]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"0xio-pvac-ctx-v1");
    h.update(master);
    h.finalize()[..16].iter().map(|b| format!("{:02x}", b)).collect()
}

pub struct AppState {
    pub ctx: Mutex<DeskSlot>,
    /// Separate from `ctx` so extension init doesn't overwrite the desktop's context.
    pub ws_ctx: Mutex<PvacSlot>,
    /// The connection whose `init` set `ws_ctx`, so a legacy connection cannot take it from a
    /// paired one that is still open.
    pub ws_ctx_conn: Mutex<Option<u64>>,
    pub ws_clients: AtomicUsize,
    pub computing: AtomicUsize,
    pub ext_computing: AtomicUsize,
    pub tray_handle: Mutex<Option<Box<dyn std::any::Any + Send>>>,
    pub app_handle: OnceLock<AppHandle>,
    pub pending_wallet_rpc: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    pub ws_limits: Mutex<crate::ws::ws_auth::HandshakeLimits>,
    pub ws_caps: Mutex<crate::ws::ws_auth::ConnCaps>,
    pub ws_pairing: Mutex<crate::ws::ws_auth::Pairing>,
    pub ws_pairs: Mutex<Option<crate::ws::ws_auth::PairStore>>,
    pub ws_conns: Mutex<HashMap<u64, (Option<String>, Arc<tokio::sync::Notify>)>>,
    pub ws_sites: Mutex<Option<crate::ws::ws_sites::SiteStore>>,
    pub ws_site_queue: Mutex<crate::ws::ws_sites::SiteQueue>,
    pub ws_site_subs: Mutex<crate::sites::site_relay::SiteSubs>,
    pub ws_site_notices: Mutex<crate::ws::ws_sites::SiteNotices>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ctx: Mutex::new(DeskSlot::default()),
            ws_ctx: Mutex::new(PvacSlot::default()),
            ws_ctx_conn: Mutex::new(None),
            ws_clients: AtomicUsize::new(0),
            computing: AtomicUsize::new(0),
            ext_computing: AtomicUsize::new(0),
            tray_handle: Mutex::new(None),
            app_handle: OnceLock::new(),
            pending_wallet_rpc: Mutex::new(HashMap::new()),
            ws_limits: Mutex::new(crate::ws::ws_auth::HandshakeLimits::default()),
            ws_caps: Mutex::new(crate::ws::ws_auth::ConnCaps::default()),
            ws_pairing: Mutex::new(crate::ws::ws_auth::Pairing::default()),
            ws_pairs: Mutex::new(None),
            ws_conns: Mutex::new(HashMap::new()),
            ws_sites: Mutex::new(None),
            ws_site_queue: Mutex::new(crate::ws::ws_sites::SiteQueue::default()),
            ws_site_subs: Mutex::new(HashMap::new()),
            ws_site_notices: Mutex::new(crate::ws::ws_sites::SiteNotices::default()),
        })
    }

    pub fn session_ended(&self, idle: bool) {
        self.ctx.lock().unwrap_or_else(|e| e.into_inner()).clear();
        if idle {
            if let Some(handle) = self.app_handle.get() {
                let _ = handle.emit_to("main", "wallet-idle-locked", ());
            }
        }
    }

    pub fn client_connected(&self) {
        self.ws_clients.fetch_add(1, Ordering::SeqCst);
        self.emit_ws_clients();
    }

    pub fn client_disconnected(&self) {
        self.ws_clients.fetch_sub(1, Ordering::SeqCst);
        self.emit_ws_clients();
    }

    pub fn connected_clients(&self) -> usize {
        self.ws_clients.load(Ordering::SeqCst)
    }

    pub fn begin_compute(&self) {
        self.computing.fetch_add(1, Ordering::SeqCst);
        self.emit_computing();
    }

    pub fn end_compute(&self) {
        self.computing.fetch_sub(1, Ordering::SeqCst);
        self.emit_computing();
    }

    pub fn is_computing(&self) -> bool {
        self.computing.load(Ordering::SeqCst) > 0
    }

    pub fn begin_ext_compute(&self) {
        self.ext_computing.fetch_add(1, Ordering::SeqCst);
        self.emit_ext_computing();
        self.begin_compute();
    }

    pub fn end_ext_compute(&self) {
        self.ext_computing.fetch_sub(1, Ordering::SeqCst);
        self.emit_ext_computing();
        self.end_compute();
    }

    pub fn is_ext_computing(&self) -> bool {
        self.ext_computing.load(Ordering::SeqCst) > 0
    }

    fn emit_ext_computing(&self) {
        if let Some(handle) = self.app_handle.get() {
            let _ = handle.emit("ext-computing-changed", self.is_ext_computing());
        }
    }

    fn emit_ws_clients(&self) {
        if let Some(handle) = self.app_handle.get() {
            let _ = handle.emit("ws-clients-changed", self.connected_clients());
        }
    }

    fn emit_computing(&self) {
        if let Some(handle) = self.app_handle.get() {
            let _ = handle.emit("ws-computing-changed", self.is_computing());
        }
    }
}
