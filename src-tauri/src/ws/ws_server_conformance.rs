//! Pages reach the real socket, queue and request log; a stand-in for the main window answers as
//! `useSiteRelay` does, and the suite plays the person and the chain over a control socket.

use super::*;
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::sites::site_lifecycle::Progress;
use crate::ws::ws_sites::{Effect, Stage};

const WATCH_FOR_MS: u64 = 600_000;
const ADDR: &str = "octRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR";
const SUBMITS: &[&str] = &[
    "register_private_view_key",
    "send_transaction",
    "call_contract",
    "deploy_contract",
    "send_contract_transaction_sequence",
    "send_private_transfer",
    "claim_private_transfer",
];

struct Watched {
    wire: String,
    method: String,
    since_ms: u64,
}

const KEY_SWITCH_FEE: u128 = 1_000_000;

struct Sim {
    registered: bool,
    foreign_key: bool,
    pending_registration: bool,
    balance_raw: u128,
    locked: bool,
    offset_ms: u64,
    seen: std::collections::HashSet<String>,
    shown: std::collections::HashSet<String>,
    reviews: u64,
    signatures: u64,
    hashes: u64,
    epoch: u64,
    watched: HashMap<String, Watched>,
}

impl Default for Sim {
    fn default() -> Self {
        Self {
            registered: false,
            foreign_key: false,
            pending_registration: false,
            balance_raw: 1_000_000_000_000,
            locked: false,
            offset_ms: 0,
            seen: Default::default(),
            shown: Default::default(),
            reviews: 0,
            signatures: 0,
            hashes: 0,
            epoch: 0,
            watched: Default::default(),
        }
    }
}

fn refuse(code: &str, message: &str) -> Value {
    json!({ "success": false, "error": { "code": code, "message": message } })
}

struct Wallet {
    state: Arc<AppState>,
    sim: Arc<Mutex<Sim>>,
    task: tokio::task::JoinHandle<()>,
}

fn fresh_state() -> Arc<AppState> {
    let state = AppState::new();
    let mut store = PairStore::default();
    store.ensure_id();
    *lock(&state.ws_pairs) = Some(store);
    *lock(&state.ws_sites) = Some(ws_sites::SiteStore::default());
    state
}

fn rid_of(state: &AppState, wire: &str) -> Option<String> {
    lock(&state.ws_site_queue).log.following(wire).next().map(|r| r.card.rid.clone())
}

fn on_screen(state: &AppState) -> Option<(String, Stage)> {
    lock(&state.ws_site_queue)
        .items
        .iter()
        .find(|p| matches!(p.stage, Stage::Unlock | Stage::Review) && !p.committed)
        .map(|p| (p.id.clone(), p.stage))
}

fn find_review(state: &AppState, rid: Option<&str>) -> Option<(String, Stage)> {
    let (wire, stage) = on_screen(state)?;
    match rid {
        None => Some((wire, stage)),
        Some(r) if rid_of(state, &wire).as_deref() == Some(r) || wire == r => Some((wire, stage)),
        Some(_) => None,
    }
}

fn connected_on(state: &AppState, origin: &str, client: &str, network: &str) -> bool {
    site_relay::with_sites(state, |s| s.get(network, origin, client).is_some())
}

fn ok(data: Value) -> Value {
    json!({ "success": true, "data": data })
}

fn network_info(id: &str) -> Value {
    json!({ "id": id, "name": id, "isTestnet": id != "mainnet" })
}

fn pump(state: &Arc<AppState>, sim: &Mutex<Sim>) {
    type Fresh = (String, String, String, String, String);
    let fresh: Vec<Fresh> = lock(&state.ws_site_queue)
        .items
        .iter()
        .filter(|p| !lock(sim).seen.contains(&p.id))
        .map(|p| (p.id.clone(), p.method.clone(), p.site.origin.clone(), p.record_client().to_string(), p.network.clone()))
        .collect();
    for (wire, method, origin, client, network) in fresh {
        lock(sim).seen.insert(wire.clone());
        match method.as_str() {
            "getConnectionStatus" => {
                let connected = connected_on(state, &origin, &client, &network);
                let answer = if connected && lock(sim).locked {
                    json!({ "connected": true, "address": ADDR, "networkId": network, "locked": true })
                } else if connected {
                    json!({ "connected": true, "address": ADDR, "networkId": network })
                } else {
                    json!({ "connected": false, "isConnected": false, "networkId": network, "permissions": [] })
                };
                site_relay::respond(state, &wire, &ok(answer), &[]);
            }
            "disconnect" => {
                site_relay::respond(state, &wire, &ok(json!({ "disconnected": true })), &[]);
            }
            "get_network_info" | "getNetworkInfo" => {
                site_relay::respond(state, &wire, &ok(network_info(&network)), &[]);
            }
            "connect" if connected_on(state, &origin, &client, &network) => {
                site_relay::respond(state, &wire, &ok(json!({ "address": ADDR, "canSign": true, "networkId": network })), &[]);
            }
            "switch_network" => {
                let to = params_of(state, &wire).and_then(|p| p["networkId"].as_str().map(str::to_string));
                if to.as_deref() == Some(network.as_str()) {
                    site_relay::respond(state, &wire, &ok(json!({ "network": network, "switched": false })), &[]);
                } else {
                    show(state, sim, &wire);
                }
            }
            "broadcast_only" if params_of(state, &wire).and_then(|p| p.pointer("/signedTx/from").cloned()) != Some(json!(ADDR)) => {
                site_relay::respond(state, &wire, &refuse("INVALID_PARAMS", "signedTx.from must be the connected address."), &[]);
            }
            "register_private_view_key" => {
                let asked = params_of(state, &wire).and_then(|p| p["address"].as_str().map(str::to_string));
                let (registered, foreign, pending, balance) = {
                    let s = lock(sim);
                    (s.registered, s.foreign_key, s.pending_registration, s.balance_raw)
                };
                let reply = if asked.as_deref().is_some_and(|a| a != ADDR) {
                    Some(refuse("INVALID_PARAMS", "Can only register the connected wallet's view key"))
                } else if registered {
                    Some(ok(json!({ "status": "registered", "view_pubkey": "dmlldw==", "pvac": true })))
                } else if foreign {
                    Some(refuse("PVAC_KEY_MISMATCH", "Another private key is registered for this account."))
                } else if pending {
                    Some(refuse("REGISTRATION_PENDING", "The registration is confirming."))
                } else if balance < KEY_SWITCH_FEE {
                    Some(refuse("INSUFFICIENT_BALANCE", "Not enough OCT for the network fee."))
                } else {
                    None
                };
                match reply {
                    Some(r) => drop(site_relay::respond(state, &wire, &r, &[])),
                    None => show(state, sim, &wire),
                }
            }
            "broadcast_only" => {
                let hash = next_hash(sim);
                if let Some(w) = site_relay::respond(state, &wire, &ok(json!({ "txHash": hash })), &[]) {
                    watch(sim, &w.hashes, &w.id, &method);
                }
            }
            m if crate::sites::site_lifecycle::LIFECYCLE_METHODS.contains(&m) => show(state, sim, &wire),
            _ => {
                site_relay::respond(state, &wire, &ok(json!({})), &[]);
            }
        }
    }
}

fn params_of(state: &AppState, wire: &str) -> Option<Value> {
    lock(&state.ws_site_queue).items.iter().find(|p| p.id == wire).map(|p| p.params.clone())
}

fn show(state: &AppState, sim: &Mutex<Sim>, wire: &str) {
    let stage = if lock(sim).locked { Stage::Unlock } else { Stage::Review };
    if lock(&state.ws_site_queue).stage(wire, stage, Instant::now()) {
        site_relay::notify(state, wire);
    }
    let mut s = lock(sim);
    if s.shown.insert(wire.to_string()) {
        s.reviews += 1;
    }
}

fn next_hash(sim: &Mutex<Sim>) -> String {
    let mut s = lock(sim);
    s.hashes += 1;
    format!("{:064x}", 0xab00_0000_u64 + s.hashes)
}

fn watch(sim: &Mutex<Sim>, hashes: &[String], wire: &str, method: &str) {
    let mut s = lock(sim);
    let since_ms = s.offset_ms;
    for h in hashes {
        s.watched.insert(h.clone(), Watched { wire: wire.to_string(), method: method.to_string(), since_ms });
    }
}

fn approve(state: &Arc<AppState>, sim: &Mutex<Sim>, rid: Option<&str>) -> Result<(), String> {
    let (wire, stage) = find_review(state, rid).ok_or("no such review on screen")?;
    if stage == Stage::Unlock {
        return Err("unlock first".into());
    }
    let (method, network) = {
        let mut q = lock(&state.ws_site_queue);
        let p = q.get_mut(&wire).ok_or("ended")?;
        p.stage = Stage::Approved;
        (p.method.clone(), p.network.clone())
    };
    site_relay::progress_of(state, &wire, &Progress::Signing)?;
    let (response, effects): (Value, Vec<Effect>) = match method.as_str() {
        "connect" => (
            ok(json!({ "address": ADDR, "publicKey": "pk", "canSign": true, "networkId": network, "permissions": ["accounts"] })),
            vec![Effect::Connect { address: ADDR.into(), wallet_id: "w1".into(), wallet_name: "Main".into(), permissions: vec!["accounts".into()] }],
        ),
        "switch_network" => {
            let to = if network == "mainnet" { "devnet" } else { "mainnet" };
            (ok(json!({ "network": to, "switched": true })), vec![Effect::Switch { to: to.into() }])
        }
        "signMessage" | "sign_transaction" => {
            lock(sim).signatures += 1;
            (ok(json!({ "signature": "c2lnbmF0dXJl", "address": ADDR })), vec![])
        }
        m if SUBMITS.contains(&m) => {
            lock(sim).signatures += 1;
            let hash = next_hash(sim);
            (ok(json!({ "txHash": hash, "hash": hash })), vec![])
        }
        _ => (ok(json!({})), vec![]),
    };
    if let Some(w) = site_relay::respond(state, &wire, &response, &effects) {
        watch(sim, &w.hashes, &w.id, &method);
    }
    if method == "register_private_view_key" {
        lock(sim).pending_registration = true;
    }
    Ok(())
}

fn chain(state: &AppState, sim: &Mutex<Sim>, hash: &str, verdict: &str, reason: &str) -> Result<(), String> {
    let (wire, method, epoch) = {
        let mut s = lock(sim);
        s.epoch += 1;
        let epoch = 1000 + s.epoch;
        let w = s.watched.get(hash).ok_or("unknown hash")?;
        (w.wire.clone(), w.method.clone(), epoch)
    };
    if method == "register_private_view_key" {
        let mut s = lock(sim);
        s.pending_registration = false;
        s.registered = verdict == "confirm";
    }
    let progress = match verdict {
        "confirm" => {
            let receipt = (method == "call_contract" || method == "deploy_contract").then(|| {
                json!({ "contract": "octCCCC", "method": "deposit", "success": true, "effort": 1200, "events": [], "error": null })
            });
            let result = (method == "register_private_view_key")
                .then(|| json!({ "status": "registered", "view_pubkey": "dmlldw==", "pvac": true }));
            Progress::Confirmed {
                epoch: Some(epoch),
                receipt_unavailable: receipt.is_none().then(|| "not_contract".to_string()),
                receipt,
                result,
            }
        }
        _ => Progress::Failed { code: "EXECUTION_FAILED".into(), message: reason.to_string() },
    };
    site_relay::progress_of(state, &wire, &progress)
}

fn advance(state: &AppState, sim: &Mutex<Sim>, ms: u64) -> Result<(), String> {
    let (offset, stale) = {
        let mut s = lock(sim);
        s.offset_ms += ms;
        let offset = s.offset_ms;
        let stale: Vec<String> = s
            .watched
            .iter()
            .filter(|(_, w)| offset.saturating_sub(w.since_ms) >= WATCH_FOR_MS)
            .map(|(h, _)| h.clone())
            .collect();
        let wires: Vec<String> = stale.iter().filter_map(|h| s.watched.remove(h).map(|w| w.wire)).collect();
        (offset, wires)
    };
    site_relay::sweep_at(state, Instant::now() + Duration::from_millis(offset));
    for wire in stale {
        site_relay::progress_of(state, &wire, &Progress::Unwatched)?;
    }
    Ok(())
}

fn unlock(state: &AppState, sim: &Mutex<Sim>) {
    lock(sim).locked = false;
    let waiting: Vec<String> =
        lock(&state.ws_site_queue).items.iter().filter(|p| p.stage == Stage::Unlock).map(|p| p.id.clone()).collect();
    for wire in waiting {
        if lock(&state.ws_site_queue).stage(&wire, Stage::Review, Instant::now()) {
            site_relay::notify(state, &wire);
        }
    }
}

async fn create() -> (u16, Wallet) {
    let state = fresh_state();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = state.clone();
    let sim = Arc::new(Mutex::new(Sim::default()));
    let (pump_state, pump_sim) = (state.clone(), sim.clone());
    let task = tokio::spawn(async move {
        let accept = tokio::spawn(async move {
            while let Ok((stream, peer)) = listener.accept().await {
                tokio::spawn(handle_client(serving.clone(), stream, peer));
            }
        });
        loop {
            pump(&pump_state, &pump_sim);
            tokio::time::sleep(Duration::from_millis(2)).await;
            if accept.is_finished() {
                break;
            }
        }
    });
    (port, Wallet { state, sim, task })
}

async fn command(wallets: &Mutex<HashMap<u64, Arc<Wallet>>>, next: &AtomicU64, cmd: Value) -> Value {
    let name = cmd["cmd"].as_str().unwrap_or_default();
    if name == "create" {
        let (port, wallet) = create().await;
        let id = next.fetch_add(1, Ordering::SeqCst);
        lock(wallets).insert(id, Arc::new(wallet));
        return json!({ "wallet": id, "port": port });
    }
    let Some(w) = cmd["wallet"].as_u64().and_then(|id| lock(wallets).get(&id).cloned()) else {
        return json!({ "error": "no such wallet" });
    };
    let rid = cmd["rid"].as_str();
    let hash = cmd["hash"].as_str().unwrap_or_default();
    let done = |r: Result<(), String>| match r {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e }),
    };
    match name {
        "approve" => done(approve(&w.state, &w.sim, rid)),
        "reject" => done(match find_review(&w.state, rid) {
            Some((wire, _)) => {
                site_relay::reject(&w.state, &[wire]);
                Ok(())
            }
            None => Err("no such review on screen".into()),
        }),
        "review" => {
            let shown = on_screen(&w.state).map(|(wire, _)| rid_of(&w.state, &wire).unwrap_or(wire));
            json!({ "rid": shown })
        }
        "account" => {
            let mut s = lock(&w.sim);
            s.registered = cmd["registered"].as_bool().unwrap_or(false);
            s.balance_raw = cmd["balanceRaw"].as_str().and_then(|b| b.parse().ok()).unwrap_or(0);
            s.foreign_key = cmd["foreignKey"].as_bool().unwrap_or(false);
            s.pending_registration = cmd["pendingRegistration"].as_bool().unwrap_or(false);
            json!({ "ok": true })
        }
        "lock" => {
            lock(&w.sim).locked = true;
            json!({ "ok": true })
        }
        "unlock" => {
            unlock(&w.state, &w.sim);
            json!({ "ok": true })
        }
        "confirm" => done(chain(&w.state, &w.sim, hash, "confirm", "")),
        "fail" | "drop" => done(chain(&w.state, &w.sim, hash, name, cmd["reason"].as_str().unwrap_or("dropped"))),
        "advance" => done(advance(&w.state, &w.sim, cmd["ms"].as_u64().unwrap_or(0))),
        "stats" => {
            let s = lock(&w.sim);
            json!({ "signatures": s.signatures, "reviewsOpened": s.reviews })
        }
        "dispose" => {
            w.task.abort();
            json!({ "ok": true })
        }
        _ => json!({ "error": "unknown command" }),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn conformance_server() {
    let Ok(file) = std::env::var("CONFORMANCE_FILE") else { return };
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(&file, json!({ "control": control.local_addr().unwrap().port() }).to_string()).unwrap();
    let wallets: Arc<Mutex<HashMap<u64, Arc<Wallet>>>> = Arc::default();
    let next = Arc::new(AtomicU64::new(1));
    let done = format!("{file}.done");
    let started = Instant::now();
    loop {
        if std::path::Path::new(&done).exists() || started.elapsed() > Duration::from_secs(1800) {
            break;
        }
        let Ok(Ok((stream, _))) = tokio::time::timeout(Duration::from_millis(200), control.accept()).await else {
            continue;
        };
        let (wallets, next) = (wallets.clone(), next.clone());
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let cmd: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                let mut reply = command(&wallets, &next, cmd.clone()).await;
                reply["seq"] = cmd["seq"].clone();
                if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
    }
}
