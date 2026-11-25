use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac as _};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha512};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager, Runtime, Webview};
use zeroize::Zeroize;
use crate::guard::ipc_guard::require_main;
use crate::tlog;

const PBKDF2_ITERATIONS: u32 = 600_000;

type HmacSha512 = Hmac<Sha512>;

/// Master key: HMAC-SHA512("Octra seed", seed)[0..32].
fn derive_hd_key(seed: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha512 as KeyInit>::new_from_slice(b"Octra seed").expect("HMAC key size");
    mac.update(seed);
    let result = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn derive_address(pub_bytes: &[u8; 32]) -> String {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    hasher.update(pub_bytes);
    let hash = hasher.finalize();
    format!("oct{}", bs58_encode(&hash))
}

/// A base58 part shorter than 44 chars is left-padded with '1', as the app and extension do.
fn ensure_valid_address(address: &str) -> (String, bool) {
    if address.len() == 47 {
        return (address.to_string(), false);
    }
    let base58_part = &address[3..];
    if base58_part.len() < 44 {
        let padding = "1".repeat(44 - base58_part.len());
        let padded = format!("oct{}{}", padding, base58_part);
        tlog!("[wallet] Padded address detected: {} chars -> 47 (padded {} chars)", address.len(), 44 - base58_part.len());
        return (padded, true);
    }
    (address.to_string(), false)
}

fn address_of_key(private_key: &[u8; 32]) -> (String, bool) {
    use ed25519_dalek::SigningKey;
    let pub_bytes = SigningKey::from_bytes(private_key).verifying_key().to_bytes();
    ensure_valid_address(&derive_address(&pub_bytes))
}

/// The key of a recovery phrase: BIP39 when the words parse, raw PBKDF2 for a non-standard phrase.
/// Import and the import preview share it, so the address a preview names is the one saved.
fn key_from_mnemonic(words: &[String]) -> [u8; 32] {
    let mut mnemonic_str = words.join(" ");
    let mut seed = match bip39::Mnemonic::parse_normalized(&mnemonic_str) {
        Ok(m) => m.to_seed("").to_vec(),
        Err(_) => {
            tlog!("[wallet] Non-standard mnemonic, using raw PBKDF2-SHA512 derivation");
            let mut raw_seed = [0u8; 64];
            pbkdf2_hmac::<Sha512>(mnemonic_str.as_bytes(), b"mnemonic", 2048, &mut raw_seed);
            raw_seed.to_vec()
        }
    };
    mnemonic_str.zeroize();
    let key = derive_hd_key(&seed);
    seed.zeroize();
    key
}

fn key_from_b64(private_key: &str) -> Result<[u8; 32], String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let mut key_bytes = B64.decode(private_key).map_err(|_| "Invalid base64 private key")?;
    if key_bytes.len() != 32 {
        key_bytes.zeroize();
        return Err("Private key must be 32 bytes".to_string());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&key_bytes);
    key_bytes.zeroize();
    Ok(seed)
}

fn default_false() -> bool { false }

#[derive(Serialize, Deserialize, Clone)]
pub struct WalletEntry {
    pub id: String,
    pub name: String,
    pub address: String,
    pub wallet_type: String,
    pub is_active: bool,
    pub created_at: u64,
    pub source: String,
    pub private_key: Option<String>,
    pub mnemonic: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub exportable: bool,
    /// Create never shows the phrase, so Home asks for the backup until the user confirms it.
    #[serde(default = "default_false")]
    pub needs_backup: bool,
    /// A sealed wallet whose phrase has not been shown yet: the seal goes on once the user wrote
    /// it down. Kept in the vault so a quit before that step asks again on the next launch.
    #[serde(default = "default_false")]
    pub seal_pending: bool,
}

impl Drop for WalletEntry {
    fn drop(&mut self) {
        if let Some(ref mut pk) = self.private_key {
            pk.zeroize();
        }
        if let Some(ref mut words) = self.mnemonic {
            for word in words.iter_mut() {
                word.zeroize();
            }
        }
    }
}

fn default_true() -> bool { true }

#[derive(Serialize, Deserialize)]
struct Vault {
    salt: String,
    iv: String,
    data: String,
    version: u32,
    #[serde(default = "default_true")]
    has_password: bool,
    #[serde(default = "default_false")]
    hell_mode: bool,
}

fn vault_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("vault.json")
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let start = Instant::now();
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    tlog!("[wallet] PBKDF2 derive_key: {}ms ({} iterations)", start.elapsed().as_millis(), PBKDF2_ITERATIONS);
    key
}

fn encrypt_vault_with_flags(data: &[u8], password: &str, has_password: bool, hell_mode: bool) -> Result<Vault, String> {
    let (salt, mut key) = {
        let guard = SESSION_VAULT_KEY.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_salt, cached_key)) = *guard {
            (cached_salt, cached_key)
        } else {
            drop(guard);
            let mut salt = [0u8; 32];
            OsRng.fill_bytes(&mut salt);
            let key = derive_key(password, &salt);
            let mut guard = SESSION_VAULT_KEY.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((salt, key));
            (salt, key)
        }
    };

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    key.zeroize();

    let mut iv_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let encrypted = cipher.encrypt(nonce, data).map_err(|_| "Encryption failed".to_string())?;

    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    Ok(Vault {
        salt: B64.encode(salt),
        iv: B64.encode(iv_bytes),
        data: B64.encode(encrypted),
        version: 1,
        has_password,
        hell_mode,
    })
}

fn decrypt_vault(vault: &Vault, password: &str) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    let salt = B64.decode(&vault.salt).map_err(|_| "Invalid salt")?;
    let iv = B64.decode(&vault.iv).map_err(|_| "Invalid IV")?;
    let data = B64.decode(&vault.data).map_err(|_| "Invalid data")?;

    let mut key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| {
        key.zeroize();
        e.to_string()
    })?;

    let nonce = Nonce::from_slice(&iv);

    match cipher.decrypt(nonce, data.as_ref()) {
        Ok(plaintext) => {
            if salt.len() == 32 {
                let mut salt_arr = [0u8; 32];
                salt_arr.copy_from_slice(&salt);
                let mut guard = SESSION_VAULT_KEY.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some((salt_arr, key));
                tlog!("[wallet] Vault key cached from decrypt (saves will skip PBKDF2)");
            }
            key.zeroize();
            Ok(plaintext)
        }
        Err(_) => {
            key.zeroize();
            Err("Incorrect password".to_string())
        }
    }
}

const VAULT_UNREADABLE: &str = "The wallet file on this computer cannot be read. It was left untouched.";
const PASSWORD_REQUIRED: &str = "Set a password to keep wallet keys on this computer";

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn parse_vault_at(path: &Path) -> Option<Vault> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The vault, or its backup when the vault does not parse. None only when neither file exists.
fn read_vault_at(path: &Path) -> Result<Option<Vault>, String> {
    if let Some(vault) = parse_vault_at(path) {
        return Ok(Some(vault));
    }
    let backup = backup_path(path);
    if let Some(vault) = parse_vault_at(&backup) {
        tlog!("[wallet] vault did not parse, opened the backup");
        return Ok(Some(vault));
    }
    if path.exists() || backup.exists() {
        return Err(VAULT_UNREADABLE.to_string());
    }
    Ok(None)
}

/// With `keep_previous` the replaced vault becomes the backup, otherwise the backup gets the new one.
fn write_vault_at(path: &Path, vault: &Vault, keep_previous: bool) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(vault).map_err(|e| e.to_string())?;
    let backup = backup_path(path);
    if keep_previous {
        if let Ok(previous) = std::fs::read(path) {
            if serde_json::from_slice::<Vault>(&previous).is_ok() {
                crate::system::atomic_file::write(&backup, &previous).map_err(|e| e.to_string())?;
            }
        }
    }
    crate::system::atomic_file::write(path, &json).map_err(|e| e.to_string())?;
    if !keep_previous {
        crate::system::atomic_file::write(&backup, &json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn remove_vault_files(path: &Path) -> Result<(), String> {
    for file in [path.to_path_buf(), backup_path(path)] {
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| format!("Failed to delete vault: {}", e))?;
        }
    }
    Ok(())
}

fn read_vault<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Vault>, String> {
    read_vault_at(&vault_path(app))
}

fn save_vault_file<R: Runtime>(app: &AppHandle<R>, vault: &Vault) -> Result<(), String> {
    write_vault_at(&vault_path(app), vault, true)
}

fn holds_keys(wallets: &[WalletEntry]) -> bool {
    wallets.iter().any(|w| w.private_key.is_some() || w.mnemonic.is_some())
}

fn require_password_for_keys(wallets: &[WalletEntry], password: &str) -> Result<(), String> {
    if password.is_empty() && holds_keys(wallets) {
        return Err(PASSWORD_REQUIRED.to_string());
    }
    Ok(())
}

fn seal_wallets(wallets: &[WalletEntry], password: &str, hell_mode: bool) -> Result<Vault, String> {
    require_password_for_keys(wallets, password)?;
    let mut data = serde_json::to_vec(wallets).map_err(|e| e.to_string())?;
    let vault = encrypt_vault_with_flags(&data, password, !password.is_empty(), hell_mode);
    data.zeroize();
    vault
}

fn open_vault(vault: &Vault, password: &str) -> Result<Vec<WalletEntry>, String> {
    let mut decrypted = decrypt_vault(vault, password)?;
    let wallets = serde_json::from_slice(&decrypted).map_err(|e| format!("Invalid vault data: {}", e));
    decrypted.zeroize();
    wallets
}

fn load_wallets<R: Runtime>(app: &AppHandle<R>, password: &str) -> Result<Vec<WalletEntry>, String> {
    let vault = read_vault(app)?.ok_or("Vault not found")?;
    open_vault(&vault, password)
}

fn save_wallets<R: Runtime>(
    app: &AppHandle<R>,
    wallets: &[WalletEntry],
    password: &str,
) -> Result<(), String> {
    let vault = seal_wallets(wallets, password, is_hell_mode_active())?;
    save_vault_file(app, &vault)
}

/// For a removed wallet or a seal: the previous vault must not survive as the backup.
fn save_wallets_dropping_previous<R: Runtime>(
    app: &AppHandle<R>,
    wallets: &[WalletEntry],
    password: &str,
) -> Result<(), String> {
    let vault = seal_wallets(wallets, password, is_hell_mode_active())?;
    write_vault_at(&vault_path(app), &vault, false)
}

use std::sync::{Mutex, OnceLock};
static SESSION_PASSWORD: Mutex<Option<String>> = Mutex::new(None);
static WALLET_CACHE: Mutex<Option<Vec<WalletEntry>>> = Mutex::new(None);
static SESSION_VAULT_KEY: Mutex<Option<([u8; 32], [u8; 32])>> = Mutex::new(None);
static SESSION_HELL_MODE: Mutex<bool> = Mutex::new(false);

fn is_hell_mode_active() -> bool {
    *SESSION_HELL_MODE.lock().unwrap_or_else(|e| e.into_inner())
}

fn set_hell_mode_active(v: bool) {
    *SESSION_HELL_MODE.lock().unwrap_or_else(|e| e.into_inner()) = v;
}

fn forget_vault_key() {
    let mut guard = SESSION_VAULT_KEY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, ref mut key)) = *guard {
        key.zeroize();
    }
    *guard = None;
}

fn forget_session() {
    clear_wallet_cache();
    forget_vault_key();
    end_reveal();
    *PASSWORD_VERIFIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let mut guard = SESSION_PASSWORD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut pw) = *guard {
        pw.zeroize();
    }
    *guard = None;
    drop(guard);
    let mut idle = IDLE.lock().unwrap_or_else(|e| e.into_inner());
    idle.active_at = None;
    idle.working_until = None;
}

fn start_session(password: String) {
    *SESSION_PASSWORD.lock().unwrap_or_else(|e| e.into_inner()) = Some(password);
    IDLE.lock().unwrap_or_else(|e| e.into_inner()).active_at = Some(SystemTime::now());
}

const DEFAULT_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);
const WORK_HOLD_MAX: Duration = Duration::from_secs(30 * 60);
const LOCKED: &str = "Wallet is locked";

struct Idle {
    limit: Option<Duration>,
    active_at: Option<SystemTime>,
    working_until: Option<SystemTime>,
}

static IDLE: Mutex<Idle> = Mutex::new(Idle {
    limit: Some(DEFAULT_IDLE_LIMIT),
    active_at: None,
    working_until: None,
});

static SESSION_END: OnceLock<Box<dyn Fn(bool) + Send + Sync>> = OnceLock::new();

pub(crate) fn on_session_end(run: impl Fn(bool) + Send + Sync + 'static) {
    let _ = SESSION_END.set(Box::new(run));
}

fn end_session(idle: bool) {
    forget_session();
    crate::sites::frame_protocol::forget_all();
    if let Some(run) = SESSION_END.get() {
        run(idle);
    }
}

fn idle_expired(idle: &Idle, now: SystemTime) -> bool {
    let (Some(limit), Some(active_at)) = (idle.limit, idle.active_at) else {
        return false;
    };
    if idle.working_until.is_some_and(|until| now < until) {
        return false;
    }
    now.duration_since(active_at).is_ok_and(|quiet| quiet >= limit)
}

fn lock_if_idle_at(now: SystemTime) -> Result<(), String> {
    if !idle_expired(&IDLE.lock().unwrap_or_else(|e| e.into_inner()), now) {
        return Ok(());
    }
    tlog!("[wallet] idle deadline passed: session locked");
    end_session(true);
    Err(LOCKED.to_string())
}

pub(crate) fn lock_if_idle() -> Result<(), String> {
    lock_if_idle_at(SystemTime::now())
}

fn report_idle(auto_lock_minutes: u32, active: bool, working: bool, now: SystemTime) -> Result<(), String> {
    lock_if_idle_at(now)?;
    let mut idle = IDLE.lock().unwrap_or_else(|e| e.into_inner());
    idle.limit = (auto_lock_minutes > 0).then(|| Duration::from_secs(u64::from(auto_lock_minutes) * 60));
    if active && idle.active_at.is_some() {
        idle.active_at = Some(now);
    }
    idle.working_until = working.then(|| now + WORK_HOLD_MAX);
    Ok(())
}

#[tauri::command]
pub async fn wallet_idle_report(
    webview: Webview,
    auto_lock_minutes: u32,
    active: bool,
    working: bool,
) -> Result<(), String> {
    require_main(&webview)?;
    report_idle(auto_lock_minutes, active, working, SystemTime::now())
}

struct UnlockRateLimit {
    failed_attempts: u32,
    locked_until: Option<Instant>,
}

static UNLOCK_RATE_LIMIT: Mutex<UnlockRateLimit> = Mutex::new(UnlockRateLimit {
    failed_attempts: 0,
    locked_until: None,
});

const MAX_UNLOCK_ATTEMPTS: u32 = 5;
const BASE_LOCKOUT_SECS: u64 = 30;
const MAX_LOCKOUT_SECS: u64 = 3600;

fn lockout_for(failed: u32) -> u64 {
    if failed < MAX_UNLOCK_ATTEMPTS {
        return 0;
    }
    BASE_LOCKOUT_SECS
        .saturating_mul(2u64.saturating_pow(failed - MAX_UNLOCK_ATTEMPTS))
        .min(MAX_LOCKOUT_SECS)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct UnlockStatus {
    attempts_left: u32,
    next_lockout_seconds: u64,
    locked_seconds: u64,
}

fn unlock_status_of(rl: &UnlockRateLimit, now: Instant) -> UnlockStatus {
    let locked_seconds = match rl.locked_until {
        Some(until) if now < until => {
            let left = until - now;
            left.as_secs() + u64::from(left.subsec_nanos() > 0)
        }
        _ => 0,
    };
    UnlockStatus {
        attempts_left: MAX_UNLOCK_ATTEMPTS.saturating_sub(rl.failed_attempts).max(1),
        next_lockout_seconds: lockout_for((rl.failed_attempts + 1).max(MAX_UNLOCK_ATTEMPTS)),
        locked_seconds,
    }
}

fn too_many(seconds: u64) -> String {
    format!("Too many failed attempts. Try again in {} seconds.", seconds)
}

fn limited<T>(
    limit: &Mutex<UnlockRateLimit>,
    attempt: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    {
        let guard = limit.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(locked_until) = guard.locked_until {
            let now = Instant::now();
            if now < locked_until {
                return Err(too_many((locked_until - now).as_secs() + 1));
            }
        }
    }
    let result = attempt();
    let mut guard = limit.lock().unwrap_or_else(|e| e.into_inner());
    match result {
        Ok(value) => {
            guard.failed_attempts = 0;
            guard.locked_until = None;
            Ok(value)
        }
        Err(e) => {
            guard.failed_attempts = guard.failed_attempts.saturating_add(1);
            if guard.failed_attempts < MAX_UNLOCK_ATTEMPTS {
                return Err(e);
            }
            let lockout = lockout_for(guard.failed_attempts);
            guard.locked_until = Some(Instant::now() + Duration::from_secs(lockout));
            tlog!("[wallet] Rate limited: {} failed attempts, locked for {}s", guard.failed_attempts, lockout);
            Err(too_many(lockout))
        }
    }
}

fn open_limited_at(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    password: &str,
) -> Result<Vec<WalletEntry>, String> {
    let vault = read_vault_at(path)?.ok_or("Vault not found")?;
    limited(limit, || open_vault(&vault, password))
}

fn open_wallets_limited<R: Runtime>(app: &AppHandle<R>, password: &str) -> Result<Vec<WalletEntry>, String> {
    open_limited_at(&vault_path(app), &UNLOCK_RATE_LIMIT, password)
}

static PASSWORD_VERIFIED: Mutex<Option<Instant>> = Mutex::new(None);
const VERIFIED_FOR: Duration = Duration::from_secs(60);

fn take_verified(slot: &mut Option<Instant>, now: Instant) -> bool {
    slot.take().is_some_and(|at| now.saturating_duration_since(at) <= VERIFIED_FOR)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum SecretKind {
    Phrase,
    Key,
}

impl SecretKind {
    pub(crate) fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "phrase" => Ok(Self::Phrase),
            "key" => Ok(Self::Key),
            _ => Err("Unknown secret kind".to_string()),
        }
    }
}

struct Reveal {
    wallet_id: String,
    kind: SecretKind,
    at: Instant,
}

static REVEAL: Mutex<Option<Reveal>> = Mutex::new(None);
const REVEAL_FOR: Duration = Duration::from_secs(600);
const REVEAL_OVER: &str = "Authenticate again to copy";

fn begin_reveal(wallet_id: &str, kind: SecretKind) {
    *REVEAL.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Reveal { wallet_id: wallet_id.to_string(), kind, at: Instant::now() });
}

fn end_reveal() {
    *REVEAL.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn reveal_allows(reveal: Option<&Reveal>, wallet_id: &str, kind: SecretKind, now: Instant) -> bool {
    reveal.is_some_and(|r| {
        r.wallet_id == wallet_id && r.kind == kind && now.saturating_duration_since(r.at) <= REVEAL_FOR
    })
}

fn exportable_secret(wallet: &WalletEntry, kind: SecretKind) -> Result<String, String> {
    const SEALED: &str = "This wallet's credentials are sealed and cannot be exported";
    match kind {
        SecretKind::Phrase => {
            if !wallet.exportable {
                return Err(SEALED.to_string());
            }
            wallet
                .mnemonic
                .as_ref()
                .map(|words| words.join(" "))
                .ok_or("This wallet has no recovery phrase (imported via private key)".to_string())
        }
        SecretKind::Key => {
            if !wallet.exportable || wallet.seal_pending {
                return Err(SEALED.to_string());
            }
            wallet.private_key.clone().ok_or("No private key for this wallet".to_string())
        }
    }
}

pub(crate) fn revealed_secret<R: Runtime>(
    app: &AppHandle<R>,
    wallet_id: &str,
    kind: SecretKind,
) -> Result<String, String> {
    {
        let guard = REVEAL.lock().unwrap_or_else(|e| e.into_inner());
        if !reveal_allows(guard.as_ref(), wallet_id, kind, Instant::now()) {
            return Err(REVEAL_OVER.to_string());
        }
    }
    let wallets = get_cached_wallets(app)?;
    let wallet = wallets.iter().find(|w| w.id == wallet_id).ok_or("Wallet not found")?;
    exportable_secret(wallet, kind)
}

fn shares_phrase(a: &WalletEntry, b: &WalletEntry) -> bool {
    matches!((&a.mnemonic, &b.mnemonic), (Some(x), Some(y)) if x == y)
}

fn needs_backup_of(wallet: &WalletEntry, wallets: &[WalletEntry]) -> bool {
    wallet.needs_backup || wallets.iter().any(|w| w.needs_backup && shares_phrase(w, wallet))
}

fn mark_phrase_backed_up(wallets: &mut [WalletEntry], wallet_id: &str) -> Result<bool, String> {
    let at = wallets.iter().position(|w| w.id == wallet_id).ok_or("Wallet not found")?;
    let group: Vec<usize> = (0..wallets.len())
        .filter(|&i| i == at || shares_phrase(&wallets[i], &wallets[at]))
        .collect();
    let mut changed = false;
    for i in group {
        changed |= wallets[i].needs_backup;
        wallets[i].needs_backup = false;
    }
    Ok(changed)
}

fn get_session_password() -> Result<String, String> {
    lock_if_idle()?;
    let guard = SESSION_PASSWORD.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone().ok_or(LOCKED.to_string())
}

fn get_cached_wallets<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<WalletEntry>, String> {
    cached_wallets_or(|password| load_wallets(app, password))
}

fn cached_wallets_or(
    load: impl FnOnce(&str) -> Result<Vec<WalletEntry>, String>,
) -> Result<Vec<WalletEntry>, String> {
    lock_if_idle()?;
    {
        let guard = WALLET_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref wallets) = *guard {
            return Ok(wallets.clone());
        }
    }
    let password = get_session_password()?;
    let wallets = load(&password)?;
    let mut guard = WALLET_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(wallets.clone());
    Ok(wallets)
}

fn canonical_address(address: &str) -> String {
    match address.strip_prefix("oct") {
        Some(rest) if address.len() < 47 => format!("oct{:1>44}", rest),
        _ => address.to_string(),
    }
}

pub(crate) fn wallet_seed(
    wallets: &[WalletEntry],
    wallet_id: &str,
    expect_address: &str,
) -> Result<[u8; 32], String> {
    let wallet = wallets.iter().find(|w| w.id == wallet_id).ok_or("Wallet not found")?;
    let stored = wallet.private_key.as_ref().ok_or("No private key for this wallet")?;
    let mut seed = key_from_b64(stored)?;
    let (derived, _) = address_of_key(&seed);
    if canonical_address(expect_address) != derived || canonical_address(&wallet.address) != derived {
        seed.zeroize();
        return Err("Wallet does not match the expected address".to_string());
    }
    Ok(seed)
}

pub(crate) fn session_wallet_seed<R: Runtime>(
    app: &AppHandle<R>,
    wallet_id: &str,
    expect_address: &str,
) -> Result<[u8; 32], String> {
    wallet_seed(&get_cached_wallets(app)?, wallet_id, expect_address)
}

fn update_wallet_cache(wallets: &[WalletEntry]) {
    let mut guard = WALLET_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(wallets.to_vec());
}

fn clear_wallet_cache() {
    let mut guard = WALLET_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tauri::command]
pub async fn wallet_is_initialized<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<bool, String> {
    require_main(&webview)?;
    Ok(vault_exists(&app))
}

pub(crate) fn vault_exists<R: Runtime>(app: &AppHandle<R>) -> bool {
    let path = vault_path(app);
    path.exists() || backup_path(&path).exists()
}

fn numbered_name(name: &str) -> Option<(&str, u64)> {
    let (stem, number) = name.rsplit_once(char::is_whitespace)?;
    let stem = stem.trim_end();
    if stem.is_empty() || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((stem, number.parse().ok()?))
}

fn unique_wallet_name<'a>(base: &str, existing: impl IntoIterator<Item = &'a str>) -> String {
    let name = base.trim();
    let taken: Vec<String> = existing.into_iter().map(|n| n.trim().to_lowercase()).collect();
    if name.is_empty() || !taken.contains(&name.to_lowercase()) {
        return name.to_string();
    }
    let stem = numbered_name(name).map_or(name, |(stem, _)| stem);
    let key = stem.to_lowercase();
    let top = taken
        .iter()
        .filter_map(|n| numbered_name(n))
        .filter(|(s, _)| *s == key)
        .map(|(_, n)| n)
        .fold(1, u64::max);
    format!("{} {}", stem, top.saturating_add(1))
}

fn generate_wallet_entry(name: String, seal_pending: bool) -> Result<WalletEntry, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use ed25519_dalek::SigningKey;

    // Regenerate until the address is 47 chars, as the app and extension do.
    let mut mnemonic_words: Vec<String> = vec![];
    let mut private_key_b64 = String::new();
    let mut address = String::new();
    let max_attempts = 100;

    for attempt in 0..max_attempts {
        let mut entropy = [0u8; 16];
        OsRng.fill_bytes(&mut entropy);
        let mnemonic = bip39::Mnemonic::from_entropy(&entropy)
            .map_err(|e| format!("Mnemonic generation failed: {}", e))?;
        entropy.zeroize();

        let seed = mnemonic.to_seed("");
        let mut pk = derive_hd_key(&seed);
        let signing_key = SigningKey::from_bytes(&pk);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let addr = derive_address(&pub_bytes);

        if addr.len() == 47 || attempt == max_attempts - 1 {
            mnemonic_words = mnemonic.words().map(|w: &str| w.to_string()).collect();
            private_key_b64 = B64.encode(pk);
            address = addr;
            pk.zeroize();
            if attempt > 0 {
                tlog!("[wallet] Address grinding: found valid address on attempt {}", attempt + 1);
            }
            break;
        }
        pk.zeroize();
    }

    Ok(WalletEntry {
        id: crate::system::uuid::new_v4(),
        name,
        address,
        wallet_type: "hd".to_string(),
        is_active: true,
        created_at: now_secs(),
        source: "mnemonic".to_string(),
        private_key: Some(private_key_b64),
        mnemonic: Some(mnemonic_words),
        exportable: true, // sealed once the phrase was shown, when asked
        needs_backup: true,
        seal_pending,
    })
}

/// What Create hands the UI: the wallet's public fields only, never its phrase or key.
fn created_wallet_json(w: &WalletEntry) -> serde_json::Value {
    serde_json::json!({
        "id": w.id, "name": w.name, "address": w.address,
        "wallet_type": w.wallet_type, "is_active": w.is_active,
        "created_at": w.created_at, "source": w.source,
        "exportable": w.exportable, "needs_backup": w.needs_backup,
        "seal_pending": w.seal_pending
    })
}

#[tauri::command]
pub async fn wallet_create<R: Runtime>(
    webview: Webview<R>,
    password: String,
    sealed: Option<bool>,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();
    if read_vault(&app)?.is_some() {
        return Err("A vault already exists on this computer".to_string());
    }
    let wallet = generate_wallet_entry("Main Vault".to_string(), sealed.unwrap_or(false))?;
    let address = wallet.address.clone();

    save_wallets(&app, &[wallet.clone()], &password)?;

    start_session(password);
    update_wallet_cache(&[wallet.clone()]);

    tlog!("[wallet] wallet_create completed in {}ms (address: {})", cmd_start.elapsed().as_millis(), &address[..10]);
    // The phrase stays in the vault: Create never shows it, the Backup screen asks for it later.
    Ok(created_wallet_json(&wallet))
}

fn phrase_wallet_entry(mnemonic: Vec<String>, sealed: bool) -> Result<(WalletEntry, bool), String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    if mnemonic.len() < 12 {
        return Err("Mnemonic must have at least 12 words".to_string());
    }
    let mut private_key = key_from_mnemonic(&mnemonic);
    let (address, is_padded) = address_of_key(&private_key);
    let private_key_b64 = B64.encode(private_key);
    private_key.zeroize();

    let wallet = WalletEntry {
        id: crate::system::uuid::new_v4(),
        name: "Imported Wallet".to_string(),
        address,
        wallet_type: "hd".to_string(),
        is_active: true,
        created_at: now_secs(),
        source: "mnemonic".to_string(),
        private_key: Some(private_key_b64),
        mnemonic: Some(mnemonic),
        exportable: !sealed,
        needs_backup: false,
        seal_pending: false,
    };
    Ok((wallet, is_padded))
}

pub(crate) fn key_wallet_entry(private_key: String, sealed: bool) -> Result<(WalletEntry, bool), String> {
    let mut seed = key_from_b64(&private_key)?;
    let (address, is_padded) = address_of_key(&seed);
    seed.zeroize();

    let wallet = WalletEntry {
        id: crate::system::uuid::new_v4(),
        name: "Imported Wallet".to_string(),
        address,
        wallet_type: "imported".to_string(),
        is_active: true,
        created_at: now_secs(),
        source: "private_key".to_string(),
        private_key: Some(private_key),
        mnemonic: None,
        exportable: !sealed,
        needs_backup: false,
        seal_pending: false,
    };
    Ok((wallet, is_padded))
}

fn add_imported_wallet(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    mut wallet: WalletEntry,
    password: &str,
    sealed: bool,
) -> Result<Vec<WalletEntry>, String> {
    let mut wallets = match read_vault_at(path)? {
        Some(vault) => limited(limit, || open_vault(&vault, password))?,
        None => vec![],
    };
    wallet.name = unique_wallet_name(&wallet.name, wallets.iter().map(|w| w.name.as_str()));
    wallets.iter_mut().for_each(|w| w.is_active = false);
    wallets.push(wallet);
    write_vault_at(path, &seal_wallets(&wallets, password, sealed)?, true)?;
    Ok(wallets)
}

fn imported_phrase_json(wallets: &[WalletEntry], address: &str, is_padded: bool) -> Vec<serde_json::Value> {
    wallets
        .iter()
        .map(|w| {
            serde_json::json!({
                "id": w.id, "name": w.name, "address": w.address,
                "wallet_type": w.wallet_type, "is_active": w.is_active,
                "created_at": w.created_at, "source": w.source,
                "is_padded": is_padded && w.address == address,
                "address_warning": if is_padded && w.address == address {
                    Some("CRITICAL: This wallet was generated with a padding bug. Transactions will likely fail.")
                } else {
                    None
                }
            })
        })
        .collect()
}

fn imported_key_json(wallet: &WalletEntry, is_padded: bool) -> serde_json::Value {
    serde_json::json!({
        "id": wallet.id, "name": wallet.name, "address": wallet.address,
        "wallet_type": wallet.wallet_type, "is_active": wallet.is_active,
        "created_at": wallet.created_at, "source": wallet.source,
        "exportable": wallet.exportable, "needs_backup": wallet.needs_backup,
        "seal_pending": wallet.seal_pending,
        "is_padded": is_padded,
        "address_warning": if is_padded {
            Some("CRITICAL: This wallet was generated with a padding bug. Transactions will likely fail.")
        } else {
            None
        }
    })
}

#[tauri::command]
pub async fn wallet_import_mnemonic<R: Runtime>(
    webview: Webview<R>,
    mnemonic: Vec<String>,
    password: String,
    app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();
    let sealed = is_hell_mode_active();
    let (wallet, is_padded) = phrase_wallet_entry(mnemonic, sealed)?;
    let address = wallet.address.clone();
    let wallets = add_imported_wallet(&vault_path(&app), &UNLOCK_RATE_LIMIT, wallet, &password, sealed)?;

    start_session(password);
    update_wallet_cache(&wallets);

    let result = imported_phrase_json(&wallets, &address, is_padded);

    tlog!("[wallet] wallet_import_mnemonic completed in {}ms (padded={})", cmd_start.elapsed().as_millis(), is_padded);
    drop(wallets);
    Ok(result)
}

#[tauri::command]
pub async fn wallet_import_private_key<R: Runtime>(
    webview: Webview<R>,
    private_key: String,
    password: String,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();
    let sealed = is_hell_mode_active();
    let (wallet, is_padded) = key_wallet_entry(private_key, sealed)?;
    let wallets = add_imported_wallet(&vault_path(&app), &UNLOCK_RATE_LIMIT, wallet, &password, sealed)?;
    let wallet = wallets.last().cloned().ok_or("Wallet not found")?;

    start_session(password);
    update_wallet_cache(&wallets);

    let result = imported_key_json(&wallet, is_padded);

    tlog!("[wallet] wallet_import_private_key completed in {}ms (padded={})", cmd_start.elapsed().as_millis(), is_padded);
    drop(wallets);
    Ok(result)
}

#[tauri::command]
pub async fn wallet_unlock<R: Runtime>(
    webview: Webview<R>,
    password: String,
    app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    require_main(&webview)?;
    unlock_with_password(&app, password)
}

/// The one unlock path: rate limited, opens the vault, starts the session. Shared by the lock
/// screen and the menu bar panel so both count failed attempts against the same limit.
pub(crate) fn unlock_with_password<R: Runtime>(
    app: &AppHandle<R>,
    password: String,
) -> Result<Vec<serde_json::Value>, String> {
    let cmd_start = Instant::now();
    let vault = read_vault(app)?.ok_or("Vault not found")?;
    let wallets = limited(&UNLOCK_RATE_LIMIT, || open_vault(&vault, &password))?;
    tlog!("[wallet] wallet_unlock: vault decrypted in {}ms ({} wallets)", cmd_start.elapsed().as_millis(), wallets.len());

    if let Err(e) = require_password_for_keys(&wallets, &password) {
        forget_vault_key();
        return Err(e);
    }
    set_hell_mode_active(vault.hell_mode);

    start_session(password);
    update_wallet_cache(&wallets);

    let result = wallets_to_json(&wallets);

    drop(wallets);
    Ok(result)
}

#[tauri::command]
pub async fn wallet_unlock_status<R: Runtime>(webview: Webview<R>) -> Result<UnlockStatus, String> {
    require_main(&webview)?;
    let guard = UNLOCK_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
    Ok(unlock_status_of(&guard, Instant::now()))
}

/// What an import would add, without saving it: the kind and the address. The secret is read
/// here and dropped; only the address goes back, so the import field can name the wallet.
fn preview_secret(secret: &str) -> Result<serde_json::Value, String> {
    let mut parts: Vec<String> = secret.split_whitespace().map(str::to_string).collect();
    let derived = if parts.len() >= 12 {
        Ok(("phrase", key_from_mnemonic(&parts)))
    } else if parts.len() == 1 {
        key_from_b64(&parts[0]).map(|k| ("key", k))
    } else {
        Err("Not a recovery phrase or a private key".to_string())
    };
    parts.iter_mut().for_each(|w| w.zeroize());
    let (kind, mut key) = derived?;
    let (address, is_padded) = address_of_key(&key);
    key.zeroize();
    Ok(serde_json::json!({ "kind": kind, "address": address, "is_padded": is_padded }))
}

#[tauri::command]
pub async fn wallet_preview_secret<R: Runtime>(
    webview: Webview<R>,
    secret: String,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let mut secret = secret;
    let result = preview_secret(&secret);
    secret.zeroize();
    result
}

#[tauri::command]
pub async fn wallet_mnemonic_wordlist<R: Runtime>(
    webview: Webview<R>,
) -> Result<Vec<&'static str>, String> {
    require_main(&webview)?;
    Ok(bip39::Language::English.word_list().to_vec())
}

#[tauri::command]
pub async fn wallet_mark_backed_up<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;
    if mark_phrase_backed_up(&mut wallets, &wallet_id)? {
        save_wallets(&app, &wallets, &password)?;
        update_wallet_cache(&wallets);
    }
    let result = wallets_to_json(&wallets);
    drop(wallets);
    Ok(result)
}

pub(crate) fn lock_session() {
    end_session(false);
}

#[tauri::command]
pub async fn wallet_lock(webview: Webview) -> Result<(), String> {
    require_main(&webview)?;
    lock_session();
    tlog!("[wallet] wallet_lock: cache + password + vault key cleared");
    Ok(())
}

#[tauri::command]
pub async fn wallet_get_public_key<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<String, String> {
    require_main(&webview)?;
    public_key_of(&get_cached_wallets(&app)?, &wallet_id)
}

fn public_key_of(wallets: &[WalletEntry], wallet_id: &str) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use ed25519_dalek::SigningKey;

    let wallet = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;

    let pk_b64 = wallet.private_key.as_ref().ok_or("No private key")?;
    let mut pk_bytes = B64.decode(pk_b64).map_err(|_| "Invalid key data")?;
    let mut seed: [u8; 32] = pk_bytes[..32].try_into().map_err(|_| "Invalid key length")?;
    pk_bytes.zeroize();

    let signing_key = SigningKey::from_bytes(&seed);
    let public_key = signing_key.verifying_key();
    seed.zeroize();

    Ok(B64.encode(public_key.as_bytes()))
}

#[tauri::command]
pub async fn wallet_sign_transaction<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    _password: String,
    message: String,
    app: AppHandle<R>,
) -> Result<String, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();
    let signature = sign_with_wallet(&get_cached_wallets(&app)?, &wallet_id, &message)?;
    tlog!("[wallet] wallet_sign_transaction completed in {}ms", cmd_start.elapsed().as_millis());
    Ok(signature)
}

fn sign_with_wallet(wallets: &[WalletEntry], wallet_id: &str, message: &str) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    let wallet = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;

    let pk_b64 = wallet
        .private_key
        .as_ref()
        .ok_or("No private key")?;

    let mut pk_bytes = B64.decode(pk_b64).map_err(|_| "Invalid key data")?;
    let mut seed: [u8; 32] = pk_bytes[..32]
        .try_into()
        .map_err(|_| "Invalid key length")?;
    pk_bytes.zeroize();

    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(message.as_bytes());
    seed.zeroize();

    Ok(B64.encode(signature.to_bytes()))
}

fn wallets_to_json(wallets: &[WalletEntry]) -> Vec<serde_json::Value> {
    wallets
        .iter()
        .map(|w| {
            serde_json::json!({
                "id": w.id, "name": w.name, "address": w.address,
                "wallet_type": w.wallet_type, "is_active": w.is_active,
                "created_at": w.created_at, "source": w.source,
                "exportable": w.exportable, "needs_backup": needs_backup_of(w, wallets),
                "seal_pending": w.seal_pending
            })
        })
        .collect()
}

#[tauri::command]
pub async fn wallet_delete<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    if !password.is_empty() {
        let mut verified = PASSWORD_VERIFIED.lock().unwrap_or_else(|e| e.into_inner());
        if !take_verified(&mut verified, Instant::now()) {
            return Err("Enter your password to delete this wallet".to_string());
        }
    }
    let mut wallets = get_cached_wallets(&app)?;

    let was_active = wallets.iter().find(|w| w.id == wallet_id).map(|w| w.is_active).unwrap_or(false);
    wallets.retain(|w| w.id != wallet_id);

    if wallets.is_empty() {
        forget_session();
        set_hell_mode_active(false);
        remove_vault_files(&vault_path(&app))?;
        tlog!("[wallet] wallet_delete: last wallet removed - vault reset");
        return Ok(vec![]);
    }

    if was_active {
        if let Some(first) = wallets.first_mut() {
            first.is_active = true;
        }
    }

    save_wallets_dropping_previous(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);

    let result = wallets_to_json(&wallets);
    tlog!("[wallet] wallet_delete: removed {}, {} remaining", &wallet_id[..8], wallets.len());
    drop(wallets);
    Ok(result)
}

fn add_created_wallet(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    password: &str,
    sealed: bool,
) -> Result<(Vec<WalletEntry>, WalletEntry), String> {
    let mut wallets = open_limited_at(path, limit, password)?;
    let name = unique_wallet_name(&format!("Wallet {}", wallets.len() + 1), wallets.iter().map(|w| w.name.as_str()));
    let wallet = generate_wallet_entry(name, sealed)?;
    wallets.iter_mut().for_each(|w| w.is_active = false);
    wallets.push(wallet.clone());
    write_vault_at(path, &seal_wallets(&wallets, password, sealed)?, true)?;
    Ok((wallets, wallet))
}

#[tauri::command]
pub async fn wallet_create_additional<R: Runtime>(
    webview: Webview<R>,
    password: String,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();

    let (wallets, wallet) =
        add_created_wallet(&vault_path(&app), &UNLOCK_RATE_LIMIT, &password, is_hell_mode_active())?;
    update_wallet_cache(&wallets);

    tlog!("[wallet] wallet_create_additional completed in {}ms (address: {})", cmd_start.elapsed().as_millis(), &wallet.address[..10]);
    drop(wallets);
    Ok(created_wallet_json(&wallet))
}

/// HD child: HMAC-SHA512("Octra seed", seed || index_le_u32)[0..32], as webcli derives it.
fn derive_account_at(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    wallet_id: &str,
    password: &str,
    hd_index: u32,
    sealed: bool,
) -> Result<(Vec<WalletEntry>, WalletEntry), String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use ed25519_dalek::SigningKey;

    let mut wallets = open_limited_at(path, limit, password)?;

    let parent = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Parent wallet not found")?;

    let mnemonic_words = parent
        .mnemonic
        .as_ref()
        .ok_or("Parent wallet has no mnemonic to derive accounts from")?
        .clone();
    let parent_name = parent.name.clone();
    let parent_needs_backup = needs_backup_of(parent, &wallets);

    let mnemonic_str = mnemonic_words.join(" ");

    let seed = match bip39::Mnemonic::parse_normalized(&mnemonic_str) {
        Ok(m) => m.to_seed("").to_vec(),
        Err(_) => {
            let mut raw_seed = [0u8; 64];
            pbkdf2_hmac::<Sha512>(mnemonic_str.as_bytes(), b"mnemonic", 2048, &mut raw_seed);
            raw_seed.to_vec()
        }
    };

    let mut private_key = if hd_index == 0 {
        derive_hd_key(&seed)
    } else {
        let mut data = Vec::with_capacity(seed.len() + 4);
        data.extend_from_slice(&seed);
        data.push((hd_index & 0xFF) as u8);
        data.push(((hd_index >> 8) & 0xFF) as u8);
        data.push(((hd_index >> 16) & 0xFF) as u8);
        data.push(((hd_index >> 24) & 0xFF) as u8);
        let mut mac = <HmacSha512 as KeyInit>::new_from_slice(b"Octra seed").expect("HMAC key size");
        mac.update(&data);
        let result = mac.finalize().into_bytes();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result[..32]);
        key
    };

    let signing_key = SigningKey::from_bytes(&private_key);
    let pub_bytes = signing_key.verifying_key().to_bytes();
    let raw_address = derive_address(&pub_bytes);
    let (address, _) = ensure_valid_address(&raw_address);

    if wallets.iter().any(|w| w.address == address) {
        private_key.zeroize();
        return Err(format!("Account #{} already exists ({})", hd_index, &address[..12]));
    }

    let private_key_b64 = B64.encode(private_key);
    private_key.zeroize();

    if address.len() != 47 {
        return Err("Derived address has an invalid length: try a different index".to_string());
    }

    wallets.iter_mut().for_each(|w| w.is_active = false);

    let wallet = WalletEntry {
        id: crate::system::uuid::new_v4(),
        name: unique_wallet_name(&format!("{} {}", parent_name, u64::from(hd_index) + 1), wallets.iter().map(|w| w.name.as_str())),
        address: address.clone(),
        wallet_type: "hd".to_string(),
        is_active: true,
        created_at: now_secs(),
        source: "derived".to_string(),
        private_key: Some(private_key_b64),
        mnemonic: Some(mnemonic_words),
        exportable: !sealed,
        needs_backup: parent_needs_backup,
        seal_pending: false,
    };

    wallets.push(wallet.clone());
    write_vault_at(path, &seal_wallets(&wallets, password, sealed)?, true)?;
    Ok((wallets, wallet))
}

#[tauri::command]
pub async fn wallet_derive_account<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    password: String,
    hd_index: u32,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let cmd_start = Instant::now();
    let (wallets, wallet) = derive_account_at(
        &vault_path(&app),
        &UNLOCK_RATE_LIMIT,
        &wallet_id,
        &password,
        hd_index,
        is_hell_mode_active(),
    )?;
    update_wallet_cache(&wallets);

    tlog!("[wallet] wallet_derive_account #{} completed in {}ms (address: {})", hd_index, cmd_start.elapsed().as_millis(), &wallet.address[..10]);
    drop(wallets);
    Ok(created_wallet_json(&wallet))
}

fn scan_accounts_at(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    wallet_id: &str,
    password: &str,
    max_index: u32,
) -> Result<Vec<serde_json::Value>, String> {
    use ed25519_dalek::SigningKey;

    let wallets = open_limited_at(path, limit, password)?;
    let parent = wallets.iter().find(|w| w.id == wallet_id).ok_or("Parent wallet not found")?;
    let mnemonic_words = parent.mnemonic.as_ref().ok_or("No mnemonic")?.clone();
    let mnemonic_str = mnemonic_words.join(" ");
    let existing_addrs: std::collections::HashSet<String> = wallets.iter().map(|w| w.address.clone()).collect();

    let seed = match bip39::Mnemonic::parse_normalized(&mnemonic_str) {
        Ok(m) => m.to_seed("").to_vec(),
        Err(_) => {
            let mut raw_seed = [0u8; 64];
            pbkdf2_hmac::<Sha512>(mnemonic_str.as_bytes(), b"mnemonic", 2048, &mut raw_seed);
            raw_seed.to_vec()
        }
    };

    let cap = std::cmp::min(max_index, 50) as usize;
    let mut accounts = Vec::with_capacity(cap);

    for idx in 0..cap as u32 {
        let mut pk = if idx == 0 {
            derive_hd_key(&seed)
        } else {
            let mut data = Vec::with_capacity(seed.len() + 4);
            data.extend_from_slice(&seed);
            data.push((idx & 0xFF) as u8);
            data.push(((idx >> 8) & 0xFF) as u8);
            data.push(((idx >> 16) & 0xFF) as u8);
            data.push(((idx >> 24) & 0xFF) as u8);
            let mut mac = <HmacSha512 as KeyInit>::new_from_slice(b"Octra seed").expect("HMAC key size");
            mac.update(&data);
            let result = mac.finalize().into_bytes();
            let mut key = [0u8; 32];
            key.copy_from_slice(&result[..32]);
            key
        };
        let signing_key = SigningKey::from_bytes(&pk);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let raw_addr = derive_address(&pub_bytes);
        let (addr, _) = ensure_valid_address(&raw_addr);
        pk.zeroize();

        let already_imported = existing_addrs.contains(&addr);
        accounts.push(serde_json::json!({
            "index": idx,
            "address": addr,
            "imported": already_imported,
        }));
    }

    Ok(accounts)
}

#[tauri::command]
pub async fn wallet_scan_hd_accounts<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    password: String,
    max_index: u32,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let accounts =
        scan_accounts_at(&vault_path(&app), &UNLOCK_RATE_LIMIT, &wallet_id, &password, max_index)?;
    tlog!("[wallet] scanned {} HD accounts for wallet {}", accounts.len(), &wallet_id[..8.min(wallet_id.len())]);
    Ok(serde_json::json!({ "accounts": accounts }))
}

#[tauri::command]
pub async fn wallet_export_mnemonic<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    password: String,
    app: AppHandle<R>,
) -> Result<Vec<String>, String> {
    require_main(&webview)?;
    let wallets = open_wallets_limited(&app, &password)?;
    let wallet = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;
    exportable_secret(wallet, SecretKind::Phrase)?.zeroize();
    begin_reveal(&wallet_id, SecretKind::Phrase);
    Ok(wallet.mnemonic.clone().unwrap_or_default())
}

#[tauri::command]
pub async fn wallet_export_private_key<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    password: String,
    app: AppHandle<R>,
) -> Result<String, String> {
    require_main(&webview)?;
    let wallets = open_wallets_limited(&app, &password)?;
    let wallet = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;
    let key = exportable_secret(wallet, SecretKind::Key)?;
    begin_reveal(&wallet_id, SecretKind::Key);
    Ok(key)
}

#[tauri::command]
pub async fn wallet_verify_password<R: Runtime>(
    webview: Webview<R>,
    password: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    let mut password = password;
    let opened = open_wallets_limited(&app, &password).map(drop);
    password.zeroize();
    opened?;
    *PASSWORD_VERIFIED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn wallet_end_reveal<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    require_main(&webview)?;
    end_reveal();
    Ok(())
}

#[tauri::command]
pub async fn wallet_rename<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    new_name: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;

    let wallet = wallets
        .iter_mut()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;
    wallet.name = new_name.clone();

    save_wallets(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);
    tlog!("[wallet] wallet_rename: {} -> {}", &wallet_id[..8], new_name);
    drop(wallets);
    Ok(())
}

#[tauri::command]
pub async fn wallet_set_active<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;

    let mut found = false;
    for w in wallets.iter_mut() {
        w.is_active = w.id == wallet_id;
        if w.id == wallet_id {
            found = true;
        }
    }
    if !found {
        return Err("Wallet not found".to_string());
    }

    save_wallets(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);
    tlog!("[wallet] wallet_set_active: {}", &wallet_id[..8]);
    drop(wallets);
    Ok(())
}

#[tauri::command]
pub async fn wallet_reset<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    forget_session();
    set_hell_mode_active(false);
    remove_vault_files(&vault_path(&app))?;

    tlog!("[wallet] wallet_reset: vault deleted, all state cleared");
    Ok(())
}

#[tauri::command]
pub async fn wallet_import_address<R: Runtime>(
    webview: Webview<R>,
    address: String,
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    if !address.starts_with("oct") || address.len() != 47 {
        return Err("Invalid address: must start with 'oct' and be 47 characters".to_string());
    }

    let mut wallet = WalletEntry {
        id: crate::system::uuid::new_v4(),
        name: "Watch Wallet".to_string(),
        address: address.clone(),
        wallet_type: "watch".to_string(),
        is_active: true,
        created_at: now_secs(),
        source: "address".to_string(),
        private_key: None,
        mnemonic: None,
        exportable: false,
        needs_backup: false,
        seal_pending: false,
    };

    let (password, mut wallets) = match read_vault(&app)? {
        Some(_) => (get_session_password()?, get_cached_wallets(&app)?),
        None => (String::new(), vec![]),
    };

    if wallets.iter().any(|w| w.address == address) {
        return Err("This address is already in your wallet list".to_string());
    }

    wallet.name = unique_wallet_name(&wallet.name, wallets.iter().map(|w| w.name.as_str()));
    wallets.iter_mut().for_each(|w| w.is_active = false);
    wallets.push(wallet.clone());
    save_wallets(&app, &wallets, &password)?;

    start_session(password);
    update_wallet_cache(&wallets);

    tlog!("[wallet] wallet_import_address: watching {}", &address[..10]);
    drop(wallets);
    Ok(watch_wallet_json(&wallet))
}

fn watch_wallet_json(wallet: &WalletEntry) -> serde_json::Value {
    serde_json::json!({
        "id": wallet.id, "name": wallet.name, "address": wallet.address,
        "wallet_type": wallet.wallet_type, "is_active": wallet.is_active,
        "created_at": wallet.created_at, "source": wallet.source
    })
}

/// Reads the vault file, not the session cache.
#[tauri::command]
pub async fn wallet_is_hell_mode<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<bool, String> {
    require_main(&webview)?;
    Ok(matches!(read_vault(&app), Ok(Some(vault)) if vault.hell_mode))
}

/// Irreversible: seals every wallet and sets the vault flag.
#[tauri::command]
pub async fn wallet_activate_hell_mode<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;

    seal_entries(&mut wallets, None);

    set_hell_mode_active(true);

    save_wallets_dropping_previous(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);

    tlog!("[wallet] HELL MODE ACTIVATED - all {} wallets sealed", wallets.len());
    drop(wallets);
    Ok(())
}

fn seal_entries(wallets: &mut [WalletEntry], only: Option<&str>) {
    for w in wallets.iter_mut().filter(|w| only.map_or(true, |id| w.id == id)) {
        w.exportable = false;
        if let Some(ref mut words) = w.mnemonic {
            for word in words.iter_mut() {
                word.zeroize();
            }
        }
        w.mnemonic = None;
        w.needs_backup = false;
        w.seal_pending = false;
    }
}

/// The user wrote down the phrase of a wallet waiting for its seal: seal it now. The first one
/// turns the seal on for the vault (every wallet); with the seal already on, only this wallet.
#[tauri::command]
pub async fn wallet_finish_seal<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;
    let wallet = wallets
        .iter()
        .find(|w| w.id == wallet_id)
        .ok_or("Wallet not found")?;
    if !wallet.seal_pending {
        return Err("This wallet is not waiting for a seal".into());
    }
    if is_hell_mode_active() {
        seal_entries(&mut wallets, Some(&wallet_id));
    } else {
        seal_entries(&mut wallets, None);
        set_hell_mode_active(true);
    }
    // save_wallets writes the vault's seal flag from the session flag set above.
    save_wallets_dropping_previous(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);
    tlog!("[wallet] wallet_finish_seal: {} sealed", &wallet_id[..8.min(wallet_id.len())]);
    let result = wallets_to_json(&wallets);
    drop(wallets);
    Ok(result)
}

#[tauri::command]
pub async fn wallet_seal_wallet<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    let password = get_session_password()?;
    let mut wallets = get_cached_wallets(&app)?;

    if !wallets.iter().any(|w| w.id == wallet_id) {
        return Err("Wallet not found".into());
    }
    seal_entries(&mut wallets, Some(&wallet_id));

    save_wallets_dropping_previous(&app, &wallets, &password)?;
    update_wallet_cache(&wallets);

    tlog!("[wallet] wallet_seal_wallet: {} sealed", &wallet_id[..8]);
    drop(wallets);
    Ok(())
}

#[tauri::command]
pub async fn wallet_has_password<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<bool, String> {
    require_main(&webview)?;
    Ok(read_vault(&app)?.ok_or("Vault not found")?.has_password)
}

/// A vault with no password that holds keys: the lock screen asks for a password before it opens.
#[tauri::command]
pub async fn wallet_needs_password<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
) -> Result<bool, String> {
    require_main(&webview)?;
    let vault = read_vault(&app)?.ok_or("Vault not found")?;
    if vault.has_password {
        return Ok(false);
    }
    let wallets = open_vault(&vault, "");
    if SESSION_PASSWORD.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        forget_vault_key();
    }
    Ok(holds_keys(&wallets?))
}

/// The seal flag comes from the vault, not the session: this also runs from the lock screen.
fn reseal_at(
    path: &Path,
    limit: &Mutex<UnlockRateLimit>,
    current_password: &str,
    new_password: &str,
) -> Result<(), String> {
    let vault = read_vault_at(path)?.ok_or("Vault not found")?;
    let wallets = limited(limit, || open_vault(&vault, current_password))?;
    require_password_for_keys(&wallets, new_password)?;
    forget_vault_key();
    let sealed = seal_wallets(&wallets, new_password, vault.hell_mode)?;
    write_vault_at(path, &sealed, false)
}

fn reseal_vault<R: Runtime>(app: &AppHandle<R>, current_password: &str, new_password: &str) -> Result<(), String> {
    reseal_at(&vault_path(app), &UNLOCK_RATE_LIMIT, current_password, new_password)?;
    start_session(new_password.to_string());
    Ok(())
}

#[tauri::command]
pub async fn wallet_change_password<R: Runtime>(
    webview: Webview<R>,
    current_password: String,
    new_password: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    reseal_vault(&app, &current_password, &new_password)?;
    tlog!("[wallet] wallet_change_password: has_password={}", !new_password.is_empty());
    Ok(())
}

/// Only a vault of watch wallets can drop its password: keys always need one.
#[tauri::command]
pub async fn wallet_remove_password<R: Runtime>(
    webview: Webview<R>,
    current_password: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    require_main(&webview)?;
    reseal_vault(&app, &current_password, "")?;
    tlog!("[wallet] wallet_remove_password: password removed");
    Ok(())
}

fn bs58_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut n = num_to_bigint(bytes);
    let mut result = Vec::new();

    while !n.is_empty() {
        let (quotient, remainder) = div_mod_58(&n);
        result.push(ALPHABET[remainder as usize]);
        n = quotient;
    }

    for &b in bytes {
        if b == 0 {
            result.push(b'1');
        } else {
            break;
        }
    }

    result.reverse();
    String::from_utf8(result).unwrap()
}

fn num_to_bigint(bytes: &[u8]) -> Vec<u8> {
    let mut result = vec![];
    for &b in bytes {
        let mut carry = b as u32;
        for digit in result.iter_mut() {
            carry += (*digit as u32) * 256;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            result.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    result
}

fn div_mod_58(digits: &[u8]) -> (Vec<u8>, u8) {
    if digits.is_empty() {
        return (vec![], 0);
    }
    let remainder = digits[0];
    let quotient = digits[1..].to_vec();
    (quotient, remainder)
}

#[tauri::command]
pub fn wallet_rpc_respond(
    webview: Webview,
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    rpc_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    require_main(&webview)?;
    let sender = {
        let mut pending = match state.pending_wallet_rpc.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        pending.remove(&rpc_id)
    };

    match sender {
        Some(tx) => {
            let _ = tx.send(response);
            Ok(())
        }
        None => Err(format!("No pending wallet RPC with id: {}", rpc_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PHRASE: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn words() -> Vec<String> {
        PHRASE.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn unique_wallet_name_keeps_a_free_name() {
        assert_eq!(unique_wallet_name("Imported Wallet", []), "Imported Wallet");
        assert_eq!(unique_wallet_name("Imported Wallet", ["Main Vault", "Watch Wallet"]), "Imported Wallet");
        assert_eq!(unique_wallet_name("Wallet 3", ["Wallet", "Wallet 2"]), "Wallet 3");
    }

    #[test]
    fn unique_wallet_name_numbers_a_taken_name() {
        assert_eq!(unique_wallet_name("Imported Wallet", ["Imported Wallet"]), "Imported Wallet 2");
        assert_eq!(unique_wallet_name("Imported Wallet", ["Imported Wallet", "Imported Wallet 2"]), "Imported Wallet 3");
        assert_eq!(unique_wallet_name("  imported ", ["IMPORTED"]), "imported 2");
        assert_eq!(unique_wallet_name("Imported", [" imported  ", "imported 2 "]), "Imported 3");
    }

    #[test]
    fn unique_wallet_name_continues_a_numbered_base() {
        assert_eq!(unique_wallet_name("Wallet 2", ["Wallet", "Wallet 2"]), "Wallet 3");
        assert_eq!(unique_wallet_name("Wallet 2", ["Wallet 2"]), "Wallet 3");
        assert_eq!(unique_wallet_name("Wallet 2", ["Wallet 2", "Wallet 7"]), "Wallet 8");
        assert_eq!(unique_wallet_name("A", ["A", "A 3"]), "A 4");
        assert_eq!(unique_wallet_name("Main Vault 2", ["Main Vault", "Main Vault 2"]), "Main Vault 3");
    }

    #[test]
    fn unique_wallet_name_ignores_other_bases() {
        assert_eq!(
            unique_wallet_name("Imported", ["Imported", "Imported Wallet 9", "Importer 5"]),
            "Imported 2"
        );
        assert_eq!(unique_wallet_name("  ", ["", "A"]), "");
    }

    #[test]
    fn preview_names_the_address_import_saves() {
        let mut key = key_from_mnemonic(&words());
        let (address, _) = address_of_key(&key);
        let preview = preview_secret(PHRASE).unwrap();
        assert_eq!(preview["kind"], "phrase");
        assert_eq!(preview["address"], address.as_str());

        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let b64 = B64.encode(key);
        key.zeroize();
        let by_key = preview_secret(&b64).unwrap();
        assert_eq!(by_key["kind"], "key");
        assert_eq!(by_key["address"], address.as_str());
    }

    #[test]
    fn preview_returns_no_secret() {
        let preview = preview_secret(PHRASE).unwrap();
        let obj = preview.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["address", "is_padded", "kind"]);
    }

    #[test]
    fn preview_refuses_what_is_neither() {
        assert!(preview_secret("not a key").is_err());
        assert!(preview_secret("bm90IGEga2V5").is_err());
    }

    #[test]
    fn wordlist_is_the_bip39_english_list() {
        let list = bip39::Language::English.word_list();
        assert_eq!(list.len(), 2048);
        assert_eq!(list[0], "abandon");
        assert_eq!(list[2047], "zoo");
    }

    #[test]
    fn lockout_starts_at_the_limit_and_doubles_to_an_hour() {
        assert_eq!(lockout_for(0), 0);
        assert_eq!(lockout_for(MAX_UNLOCK_ATTEMPTS - 1), 0);
        assert_eq!(lockout_for(MAX_UNLOCK_ATTEMPTS), 30);
        assert_eq!(lockout_for(MAX_UNLOCK_ATTEMPTS + 1), 60);
        assert_eq!(lockout_for(MAX_UNLOCK_ATTEMPTS + 20), MAX_LOCKOUT_SECS);
        assert_eq!(lockout_for(u32::MAX), MAX_LOCKOUT_SECS);
    }

    #[test]
    fn status_counts_tries_and_the_running_wait() {
        let now = Instant::now();
        let fresh = UnlockRateLimit { failed_attempts: 0, locked_until: None };
        assert_eq!(
            unlock_status_of(&fresh, now),
            UnlockStatus { attempts_left: 5, next_lockout_seconds: 30, locked_seconds: 0 }
        );
        let three = UnlockRateLimit { failed_attempts: 3, locked_until: None };
        assert_eq!(unlock_status_of(&three, now).attempts_left, 2);
        let locked = UnlockRateLimit {
            failed_attempts: 5,
            locked_until: Some(now + Duration::from_millis(29_500)),
        };
        let status = unlock_status_of(&locked, now);
        assert_eq!(status.locked_seconds, 30);
        assert_eq!(status.attempts_left, 1);
        assert_eq!(status.next_lockout_seconds, 60);
        let expired = UnlockRateLimit { failed_attempts: 5, locked_until: Some(now) };
        assert_eq!(unlock_status_of(&expired, now + Duration::from_secs(1)).locked_seconds, 0);
    }

    fn fresh_limit() -> Mutex<UnlockRateLimit> {
        Mutex::new(UnlockRateLimit { failed_attempts: 0, locked_until: None })
    }

    fn miss() -> Result<(), String> {
        Err("Incorrect password".to_string())
    }

    #[test]
    fn misses_reach_the_limit_then_no_guess_runs_until_the_wait_is_over() {
        let limit = fresh_limit();
        for _ in 1..MAX_UNLOCK_ATTEMPTS {
            assert_eq!(limited(&limit, miss).err().as_deref(), Some("Incorrect password"));
        }
        assert_eq!(limited(&limit, miss).err(), Some(too_many(30)));
        let mut ran = false;
        let blocked = limited(&limit, || {
            ran = true;
            Ok(())
        });
        assert!(!ran);
        assert!(blocked.unwrap_err().starts_with("Too many failed attempts"));

        limit.lock().unwrap().locked_until = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(limited(&limit, miss).err(), Some(too_many(60)));
    }

    #[test]
    fn a_right_password_resets_the_count() {
        let limit = fresh_limit();
        for _ in 0..3 {
            let _ = limited(&limit, miss);
        }
        assert_eq!(limited(&limit, || Ok(7)), Ok(7));
        assert_eq!(limit.lock().unwrap().failed_attempts, 0);
        assert_eq!(unlock_status_of(&limit.lock().unwrap(), Instant::now()).attempts_left, 5);
    }

    fn sealed_under(password: &str, wallets: &[WalletEntry]) -> Vault {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let salt = [7u8; 32];
        let iv = [9u8; 12];
        let key = derive_key(password, &salt);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let data = cipher
            .encrypt(Nonce::from_slice(&iv), serde_json::to_vec(wallets).unwrap().as_ref())
            .unwrap();
        Vault {
            salt: B64.encode(salt),
            iv: B64.encode(iv),
            data: B64.encode(data),
            version: 1,
            has_password: true,
            hell_mode: false,
        }
    }

    #[test]
    fn password_guesses_on_the_vault_file_share_the_limit_and_an_empty_one_is_a_miss() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        let wallet = generate_wallet_entry("A".into(), false).unwrap();
        write_vault_at(&path, &sealed_under("right password", &[wallet.clone()]), true).unwrap();
        let limit = fresh_limit();

        let opened = open_limited_at(&path, &limit, "right password").unwrap();
        assert_eq!(opened[0].id, wallet.id);
        assert_eq!(open_limited_at(&path, &limit, "").err().as_deref(), Some("Incorrect password"));
        assert_eq!(open_limited_at(&path, &limit, "wrong").err().as_deref(), Some("Incorrect password"));
        assert_eq!(limit.lock().unwrap().failed_attempts, 2);

        limit.lock().unwrap().failed_attempts = MAX_UNLOCK_ATTEMPTS - 1;
        assert_eq!(open_limited_at(&path, &limit, "wrong").err(), Some(too_many(30)));
        assert!(open_limited_at(&path, &limit, "right password")
            .err()
            .is_some_and(|e| e.starts_with("Too many failed attempts")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn vault_with_wallet(tag: &str) -> (PathBuf, PathBuf, WalletEntry) {
        let dir = crate::system::atomic_file::scratch_dir(tag);
        let path = dir.join("vault.json");
        let wallet = generate_wallet_entry("A".into(), false).unwrap();
        write_vault_at(&path, &sealed_under("right password", &[wallet.clone()]), true).unwrap();
        (dir, path, wallet)
    }

    fn assert_guesses_are_limited(
        path: &Path,
        guess: impl Fn(&Mutex<UnlockRateLimit>, &str) -> Result<(), String>,
    ) {
        let limit = fresh_limit();
        let before = std::fs::read(path).unwrap();
        assert_eq!(guess(&limit, "wrong").err().as_deref(), Some("Incorrect password"));
        assert_eq!(limit.lock().unwrap().failed_attempts, 1);

        limit.lock().unwrap().failed_attempts = MAX_UNLOCK_ATTEMPTS - 1;
        assert_eq!(guess(&limit, "wrong").err(), Some(too_many(30)));
        assert!(guess(&limit, "right password")
            .err()
            .is_some_and(|e| e.starts_with("Too many failed attempts")));
        assert_eq!(std::fs::read(path).unwrap(), before);

        limit.lock().unwrap().locked_until = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(guess(&limit, "right password"), Ok(()));
        assert_eq!(limit.lock().unwrap().failed_attempts, 0);
    }

    #[test]
    fn creating_another_wallet_counts_password_guesses() {
        let (dir, path, _) = vault_with_wallet("limit-create");
        assert_guesses_are_limited(&path, |limit, password| {
            add_created_wallet(&path, limit, password, false).map(|(wallets, made)| {
                assert_eq!(wallets.len(), 2);
                assert!(made.needs_backup && made.is_active);
            })
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deriving_an_account_counts_password_guesses() {
        let (dir, path, wallet) = vault_with_wallet("limit-derive");
        assert_guesses_are_limited(&path, |limit, password| {
            derive_account_at(&path, limit, &wallet.id, password, 1, false).map(|(wallets, made)| {
                assert_eq!(wallets.len(), 2);
                assert_eq!(made.source, "derived");
                assert_eq!(made.needs_backup, wallet.needs_backup);
            })
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scanning_accounts_counts_password_guesses() {
        let (dir, path, wallet) = vault_with_wallet("limit-scan");
        assert_guesses_are_limited(&path, |limit, password| {
            scan_accounts_at(&path, limit, &wallet.id, password, 3).map(|accounts| {
                assert_eq!(accounts.len(), 3);
                assert_eq!(accounts[0]["address"], wallet.address.as_str());
                assert_eq!(accounts[0]["imported"], true);
                assert_eq!(accounts[1]["imported"], false);
            })
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_the_password_counts_guesses_at_the_current_one() {
        let (dir, path, _) = vault_with_wallet("limit-change");
        assert_guesses_are_limited(&path, |limit, password| {
            reseal_at(&path, limit, password, "a new password")
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn removing_the_password_counts_guesses_and_keys_still_need_one() {
        let (dir, path, _) = vault_with_wallet("limit-remove");
        let limit = fresh_limit();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(reseal_at(&path, &limit, "wrong", "").err().as_deref(), Some("Incorrect password"));
        assert_eq!(limit.lock().unwrap().failed_attempts, 1);
        assert_eq!(reseal_at(&path, &limit, "right password", "").err().as_deref(), Some(PASSWORD_REQUIRED));
        assert_eq!(limit.lock().unwrap().failed_attempts, 0);

        limit.lock().unwrap().failed_attempts = MAX_UNLOCK_ATTEMPTS - 1;
        assert_eq!(reseal_at(&path, &limit, "wrong", "").err(), Some(too_many(30)));
        assert!(reseal_at(&path, &limit, "right password", "")
            .err()
            .is_some_and(|e| e.starts_with("Too many failed attempts")));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn seeded_wallet(seed: [u8; 32], sealed: bool) -> WalletEntry {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        key_wallet_entry(B64.encode(seed), sealed).unwrap().0
    }

    #[test]
    fn wallet_seed_is_the_stored_key_bytes_for_the_matching_address() {
        let a = seeded_wallet([42u8; 32], false);
        let mut b = seeded_wallet([7u8; 32], true);
        b.seal_pending = true;
        let list = [a.clone(), b.clone()];
        assert_eq!(wallet_seed(&list, &a.id, &a.address), Ok([42u8; 32]));
        assert_eq!(wallet_seed(&list, &b.id, &b.address), Ok([7u8; 32]));
        assert!(wallet_seed(&list, &a.id, &b.address).is_err());
        assert!(wallet_seed(&list, &b.id, &a.address).is_err());
        assert!(wallet_seed(&list, &a.id, "").is_err());
        assert!(wallet_seed(&list, &a.id, "oc").is_err());
        assert_eq!(wallet_seed(&list, "missing", &a.address), Err("Wallet not found".to_string()));
    }

    #[test]
    fn wallet_seed_takes_an_unpadded_address_and_refuses_a_stale_stored_one() {
        let a = seeded_wallet([42u8; 32], false);
        let short = format!("oct{}", a.address[3..].trim_start_matches('1'));
        assert_eq!(canonical_address(&short), a.address);
        assert_eq!(canonical_address("octabc"), format!("oct{}abc", "1".repeat(41)));
        assert_eq!(canonical_address("oc"), "oc");
        assert_eq!(wallet_seed(&[a.clone()], &a.id, &short), Ok([42u8; 32]));
        let other = seeded_wallet([7u8; 32], false);
        let mut stale = a.clone();
        stale.address = other.address.clone();
        assert!(wallet_seed(&[stale.clone()], &stale.id, &other.address).is_err());
        assert!(wallet_seed(&[stale.clone()], &stale.id, &a.address).is_err());
    }

    #[test]
    fn wallet_seed_refuses_a_key_that_is_not_32_bytes() {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let mut w = seeded_wallet([42u8; 32], false);
        for stored in [B64.encode([42u8; 64]), B64.encode([42u8; 31]), String::new(), "not base64".to_string()] {
            w.private_key = Some(stored);
            assert!(wallet_seed(&[w.clone()], &w.id, &w.address).is_err());
        }
        w.private_key = None;
        assert!(wallet_seed(&[w.clone()], &w.id, &w.address).is_err());
    }

    static SESSION: Mutex<()> = Mutex::new(());

    fn idle(limit_min: Option<u64>, quiet_min: u64, working_for: Option<Duration>, now: SystemTime) -> Idle {
        Idle {
            limit: limit_min.map(|m| Duration::from_secs(m * 60)),
            active_at: Some(now - Duration::from_secs(quiet_min * 60)),
            working_until: working_for.map(|d| now + d),
        }
    }

    fn set_idle(next: Idle) {
        *IDLE.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    fn unlocked(w: &WalletEntry) -> bool {
        cached_wallets_or(|_| Err("no vault".to_string())).is_ok_and(|list| list.iter().any(|x| x.id == w.id))
    }

    #[test]
    fn the_idle_deadline_counts_only_a_running_session_with_a_limit() {
        let now = SystemTime::now();
        assert!(idle_expired(&idle(Some(15), 15, None, now), now));
        assert!(!idle_expired(&idle(Some(15), 14, None, now), now));
        assert!(!idle_expired(&idle(None, 9000, None, now), now));
        assert!(!idle_expired(&idle(Some(15), 60, Some(Duration::from_secs(1)), now), now));
        assert!(idle_expired(&idle(Some(15), 60, Some(Duration::ZERO), now), now));
        let none = Idle { limit: Some(DEFAULT_IDLE_LIMIT), active_at: None, working_until: None };
        assert!(!idle_expired(&none, now));
        let ahead = Idle { active_at: Some(now + Duration::from_secs(60)), ..idle(Some(1), 0, None, now) };
        assert!(!idle_expired(&ahead, now));
    }

    #[test]
    fn past_the_idle_deadline_the_session_is_refused_and_locked() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let w = seeded_wallet([7u8; 32], true);
        let now = SystemTime::now();
        forget_session();
        start_session("pw".to_string());
        update_wallet_cache(&[w.clone()]);
        set_idle(idle(Some(15), 14, None, now));
        assert!(unlocked(&w));
        assert_eq!(get_session_password(), Ok("pw".to_string()));

        set_idle(idle(Some(15), 16, None, now));
        assert_eq!(cached_wallets_or(|_| Err("no vault".to_string())).err(), Some(LOCKED.to_string()));
        assert!(WALLET_CACHE.lock().unwrap().is_none());
        assert!(SESSION_PASSWORD.lock().unwrap().is_none());
        assert_eq!(get_session_password(), Err(LOCKED.to_string()));
        set_idle(Idle { limit: Some(DEFAULT_IDLE_LIMIT), active_at: None, working_until: None });
    }

    #[test]
    fn auto_lock_off_and_running_work_keep_the_session_open() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let w = seeded_wallet([8u8; 32], true);
        let now = SystemTime::now();
        forget_session();
        start_session("pw".to_string());
        update_wallet_cache(&[w.clone()]);

        set_idle(idle(None, 9000, None, now));
        assert!(unlocked(&w));
        set_idle(idle(Some(1), 30, Some(WORK_HOLD_MAX), now));
        assert!(unlocked(&w));
        assert_eq!(lock_if_idle_at(now + WORK_HOLD_MAX), Err(LOCKED.to_string()));
        assert!(!unlocked(&w));
        set_idle(Idle { limit: Some(DEFAULT_IDLE_LIMIT), active_at: None, working_until: None });
    }

    #[test]
    fn an_idle_report_refreshes_the_deadline_but_never_revives_a_lapsed_one() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let w = seeded_wallet([9u8; 32], true);
        let now = SystemTime::now();
        forget_session();
        start_session("pw".to_string());
        update_wallet_cache(&[w.clone()]);

        set_idle(idle(Some(15), 14, None, now));
        assert_eq!(report_idle(15, true, false, now), Ok(()));
        assert_eq!(lock_if_idle_at(now + Duration::from_secs(14 * 60)), Ok(()));

        assert_eq!(report_idle(0, false, false, now), Ok(()));
        assert_eq!(lock_if_idle_at(now + Duration::from_secs(9000 * 60)), Ok(()));

        assert_eq!(report_idle(1, false, true, now), Ok(()));
        assert_eq!(lock_if_idle_at(now + Duration::from_secs(20 * 60)), Ok(()));
        assert_eq!(report_idle(1, false, false, now), Ok(()));
        assert_eq!(lock_if_idle_at(now + Duration::from_secs(59)), Ok(()));

        let late = now + Duration::from_secs(61);
        assert_eq!(report_idle(1, true, false, late), Err(LOCKED.to_string()));
        assert!(!unlocked(&w));
        assert_eq!(report_idle(1, true, false, late), Ok(()));
        assert!(IDLE.lock().unwrap().active_at.is_none());
        set_idle(Idle { limit: Some(DEFAULT_IDLE_LIMIT), active_at: None, working_until: None });
    }

    #[test]
    fn locking_drops_the_pvac_context() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let state = crate::state::AppState::new();
        state.ctx.lock().unwrap().fp = Some("fp".to_string());
        let held = state.clone();
        on_session_end(move |idle| held.session_ended(idle));
        lock_session();
        assert!(state.ctx.lock().unwrap().fp.is_none());

        state.ctx.lock().unwrap().fp = Some("fp".to_string());
        start_session("pw".to_string());
        set_idle(idle(Some(1), 2, None, SystemTime::now()));
        assert_eq!(lock_if_idle(), Err(LOCKED.to_string()));
        assert!(state.ctx.lock().unwrap().fp.is_none());
        set_idle(Idle { limit: Some(DEFAULT_IDLE_LIMIT), active_at: None, working_until: None });
    }

    #[test]
    fn the_session_gives_a_seed_only_while_unlocked() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let w = seeded_wallet([42u8; 32], true);
        let seed = || {
            cached_wallets_or(|_| Err("no vault".to_string()))
                .and_then(|list| wallet_seed(&list, &w.id, &w.address))
        };
        clear_wallet_cache();
        assert_eq!(seed(), Err("Wallet is locked".to_string()));
        update_wallet_cache(&[w.clone()]);
        assert_eq!(seed(), Ok([42u8; 32]));
        clear_wallet_cache();
        assert_eq!(seed(), Err("Wallet is locked".to_string()));
    }

    #[test]
    fn the_stealth_scan_reads_the_key_only_from_an_unlocked_wallet_of_that_address() {
        let _session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let (seed, outputs) = crate::pvac::stealth::tests::sample_scan();
        let mut w = seeded_wallet(seed, true);
        w.seal_pending = true;
        let other = seeded_wallet([7u8; 32], false);
        let watch = watch_entry();
        let scan = |id: &str, address: &str| {
            crate::pvac::stealth::match_for_wallet(
                || {
                    cached_wallets_or(|_| Err("no vault".to_string()))
                        .and_then(|list| wallet_seed(&list, id, address))
                },
                &outputs,
            )
            .map(|found| found.len())
        };
        let mismatch = Err("Wallet does not match the expected address".to_string());
        let locked = Err("Wallet is locked".to_string());
        clear_wallet_cache();
        assert_eq!(scan(&w.id, &w.address), locked);
        update_wallet_cache(&[w.clone(), other.clone(), watch.clone()]);
        assert_eq!(scan(&w.id, &w.address), Ok(13));
        assert_eq!(scan(&other.id, &other.address), Ok(0));
        assert_eq!(scan(&w.id, &other.address), mismatch);
        assert_eq!(scan(&other.id, &w.address), mismatch);
        assert_eq!(scan(&w.id, ""), mismatch);
        assert_eq!(scan("missing", &w.address), Err("Wallet not found".to_string()));
        assert_eq!(scan("", &w.address), Err("Wallet not found".to_string()));
        assert_eq!(
            scan(&watch.id, &watch.address),
            Err("No private key for this wallet".to_string())
        );
        clear_wallet_cache();
        assert_eq!(scan(&w.id, &w.address), locked);
    }

    #[test]
    fn no_wallet_command_hands_back_a_secret() {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        use crate::guard::command_guard::Coverage;

        const PASSWORD: &str = "known vault password 4711";
        let dir = crate::system::atomic_file::scratch_dir("guard");
        let path = dir.join("vault.json");
        let limit = fresh_limit();
        let key_b64 = B64.encode([0xA7u8; 32]);
        let mut seen = Coverage::new();
        seen.secrets.password(PASSWORD);
        seen.secrets.phrase(&words());
        let seal_apart_from_the_shared_key_cache = |wallets: &[WalletEntry]| {
            write_vault_at(&path, &sealed_under(PASSWORD, wallets), false).unwrap()
        };

        let (phrase_wallet, padded) = phrase_wallet_entry(words(), false).unwrap();
        let phrase_id = phrase_wallet.id.clone();
        let phrase_address = phrase_wallet.address.clone();
        seen.secrets.wallets(&[phrase_wallet.clone()]);
        let wallets = add_imported_wallet(&path, &limit, phrase_wallet, PASSWORD, false).unwrap();
        seal_apart_from_the_shared_key_cache(&wallets);
        seen.see("wallet_import_mnemonic", &imported_phrase_json(&wallets, &phrase_address, padded));
        seen.see("wallet_import_mnemonic", &imported_phrase_json(&wallets, &phrase_address, true));
        seen.see("wallet_import_mnemonic", &phrase_wallet_entry(words()[..11].to_vec(), false).map(|_| ()));

        let (key_wallet, padded) = key_wallet_entry(key_b64.clone(), false).unwrap();
        let key_id = key_wallet.id.clone();
        seen.secrets.wallets(&[key_wallet.clone()]);
        let wallets = add_imported_wallet(&path, &limit, key_wallet, PASSWORD, false).unwrap();
        seal_apart_from_the_shared_key_cache(&wallets);
        seen.see("wallet_import_private_key", &imported_key_json(wallets.last().unwrap(), padded));
        seen.see("wallet_import_private_key", &imported_key_json(wallets.last().unwrap(), true));
        seen.see("wallet_import_private_key", &key_wallet_entry(key_b64[..40].to_string(), false).map(|_| ()));

        let created = generate_wallet_entry("Main Vault".to_string(), true).unwrap();
        seen.secrets.wallets(&[created.clone()]);
        seen.see("wallet_create", &created_wallet_json(&created));

        let (wallets, added) = add_created_wallet(&path, &limit, PASSWORD, false).unwrap();
        seal_apart_from_the_shared_key_cache(&wallets);
        seen.secrets.wallets(&wallets);
        seen.see("wallet_create_additional", &created_wallet_json(&added));

        let (wallets, derived) = derive_account_at(&path, &limit, &phrase_id, PASSWORD, 1, false).unwrap();
        seal_apart_from_the_shared_key_cache(&wallets);
        seen.secrets.wallets(&wallets);
        seen.see("wallet_derive_account", &created_wallet_json(&derived));
        for id in [&phrase_id, &key_id] {
            let again = derive_account_at(&path, &limit, id, PASSWORD, 1, false);
            seen.see("wallet_derive_account", &again.map(|_| ()));
        }

        let accounts = scan_accounts_at(&path, &limit, &phrase_id, PASSWORD, 5).unwrap();
        assert_eq!(accounts.len(), 5);
        seen.see("wallet_scan_hd_accounts", &serde_json::json!({ "accounts": accounts }));
        seen.see("wallet_scan_hd_accounts", &scan_accounts_at(&path, &limit, &key_id, PASSWORD, 5));

        let refused = open_limited_at(&path, &limit, "wrong password").map(drop);
        seen.see("wallet_unlock", &refused);
        seen.see("wallet_verify_password", &refused);
        seen.see("wallet_unlock_status", &unlock_status_of(&limit.lock().unwrap(), Instant::now()));
        let opened = open_limited_at(&path, &limit, PASSWORD);
        seen.see("wallet_verify_password", &opened.as_ref().map(drop));
        let mut wallets = opened.unwrap();
        assert_eq!(wallets.len(), 4);
        seen.secrets.wallets(&wallets);
        seen.see("wallet_unlock", &wallets_to_json(&wallets));

        seen.see("wallet_preview_secret", &preview_secret(PHRASE));
        seen.see("wallet_preview_secret", &preview_secret(&key_b64));
        seen.see("wallet_preview_secret", &preview_secret(&format!("{} zoo", &PHRASE[..PHRASE.len() - 6])));
        seen.see("wallet_preview_secret", &preview_secret(&key_b64[..40]));
        seen.see("wallet_preview_secret", &preview_secret(&PHRASE[..40]));
        seen.see("wallet_mnemonic_wordlist", &bip39::Language::English.word_list().to_vec());

        wallets.push(watch_entry());
        for wallet in wallets.clone() {
            seen.see("wallet_get_public_key", &public_key_of(&wallets, &wallet.id));
            seen.see("wallet_sign_transaction", &sign_with_wallet(&wallets, &wallet.id, "{\"from\":\"oct\"}"));
        }
        seen.see("wallet_get_public_key", &public_key_of(&wallets, "missing"));
        seen.see("wallet_sign_transaction", &sign_with_wallet(&wallets, "missing", ""));
        seen.see("wallet_import_address", &watch_wallet_json(&watch_entry()));

        seen.see("wallet_mark_backed_up", &mark_phrase_backed_up(&mut wallets, &added.id));
        seen.see("wallet_mark_backed_up", &wallets_to_json(&wallets));
        seen.see("wallet_mark_backed_up", &mark_phrase_backed_up(&mut wallets, "missing"));

        seen.see("wallet_change_password", &reseal_at(&path, &limit, "wrong password", "another password"));
        seen.see("wallet_remove_password", &reseal_at(&path, &limit, PASSWORD, ""));

        let mut remaining = wallets.clone();
        remaining.retain(|w| w.id != key_id);
        seen.see("wallet_delete", &wallets_to_json(&remaining));
        seal_entries(&mut wallets, None);
        seen.see("wallet_finish_seal", &wallets_to_json(&wallets));

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(seen.secrets.found_in(&on_disk), None);

        for (wallet, kind) in [(&created, SecretKind::Phrase), (&created, SecretKind::Key)] {
            let mut open = wallet.clone();
            open.seal_pending = false;
            assert!(seen.secrets.found_in(&exportable_secret(&open, kind)).is_some());
        }
        assert!(seen.secrets.found_in(&created.mnemonic).is_some());

        seen.assert_clean(
            "wallet_",
            &[
                "wallet_is_initialized",
                "wallet_lock",
                "wallet_idle_report",
                "wallet_rename",
                "wallet_set_active",
                "wallet_reset",
                "wallet_has_password",
                "wallet_needs_password",
                "wallet_is_hell_mode",
                "wallet_activate_hell_mode",
                "wallet_seal_wallet",
                "wallet_rpc_respond",
                "wallet_end_reveal",
                "wallet_copy_secret",
                "wallet_clear_pasted_secret",
            ],
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn import_candidates() -> [(&'static str, WalletEntry); 2] {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        let mut key = key_from_mnemonic(&words());
        let b64 = B64.encode(key);
        key.zeroize();
        [
            ("limit-import-phrase", phrase_wallet_entry(words(), false).unwrap().0),
            ("limit-import-key", key_wallet_entry(b64, false).unwrap().0),
        ]
    }

    #[test]
    fn importing_into_a_vault_counts_password_guesses_and_shares_the_lockout() {
        for (tag, entry) in import_candidates() {
            let (dir, path, _) = vault_with_wallet(tag);
            assert_guesses_are_limited(&path, |limit, password| {
                add_imported_wallet(&path, limit, entry.clone(), password, false).map(|wallets| {
                    assert_eq!(wallets.len(), 2);
                    assert!(wallets[1].is_active && !wallets[0].is_active);
                })
            });

            let limit = fresh_limit();
            limit.lock().unwrap().failed_attempts = MAX_UNLOCK_ATTEMPTS - 1;
            assert_eq!(
                add_imported_wallet(&path, &limit, entry.clone(), "wrong", false).err(),
                Some(too_many(30))
            );
            assert!(open_limited_at(&path, &limit, "right password")
                .err()
                .is_some_and(|e| e.starts_with("Too many failed attempts")));
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_first_run_import_sets_the_password_and_is_never_limited() {
        for (tag, entry) in import_candidates() {
            let dir = crate::system::atomic_file::scratch_dir(tag);
            let path = dir.join("first-run.json");
            let limit = fresh_limit();
            limit.lock().unwrap().failed_attempts = MAX_UNLOCK_ATTEMPTS;
            limit.lock().unwrap().locked_until = Some(Instant::now() + Duration::from_secs(30));

            let wallets = add_imported_wallet(&path, &limit, entry, "right password", false).unwrap();
            assert_eq!(wallets.len(), 1);
            assert!(read_vault_at(&path).unwrap().is_some_and(|v| v.has_password));
            assert_eq!(limit.lock().unwrap().failed_attempts, MAX_UNLOCK_ATTEMPTS);
            assert!(limit.lock().unwrap().locked_until.is_some());
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn an_imported_wallet_starts_backed_up_and_a_created_one_does_not() {
        for (_, entry) in import_candidates() {
            assert!(!entry.needs_backup);
        }
        assert!(generate_wallet_entry("New".into(), false).unwrap().needs_backup);
    }

    #[test]
    fn a_key_wallet_pending_backup_is_marked_by_its_key() {
        let mut key_only = generate_wallet_entry("Key".into(), false).unwrap();
        key_only.mnemonic = None;
        key_only.source = "private_key".into();
        let mut other_key = generate_wallet_entry("Other".into(), false).unwrap();
        other_key.mnemonic = None;
        let phrase = generate_wallet_entry("Phrase".into(), false).unwrap();
        let mut list = vec![key_only, other_key, phrase];
        let id = list[0].id.clone();

        assert!(needs_backup_of(&list[0], &list));
        assert_eq!(mark_phrase_backed_up(&mut list, &id), Ok(true));
        assert!(!list[0].needs_backup);
        assert!(list[1].needs_backup && list[2].needs_backup);
        assert_eq!(exportable_secret(&list[0], SecretKind::Key).ok(), list[0].private_key.clone());
        assert!(exportable_secret(&list[0], SecretKind::Phrase).is_err());
    }

    #[test]
    fn a_verified_password_allows_one_delete_for_a_minute() {
        let now = Instant::now();
        let mut slot = None;
        assert!(!take_verified(&mut slot, now));
        slot = Some(now);
        assert!(take_verified(&mut slot, now + Duration::from_secs(59)));
        assert!(!take_verified(&mut slot, now + Duration::from_secs(59)));
        slot = Some(now);
        assert!(!take_verified(&mut slot, now + VERIFIED_FOR + Duration::from_secs(1)));
        assert!(slot.is_none());
    }

    #[test]
    fn the_password_check_hands_back_nothing() {
        let checked: Result<(), String> = Ok::<Vec<WalletEntry>, String>(vec![watch_entry()]).map(drop);
        assert_eq!(serde_json::to_string(&checked.unwrap()).unwrap(), "null");
    }

    #[test]
    fn copy_needs_a_reveal_of_the_same_wallet_and_kind_that_is_still_fresh() {
        let now = Instant::now();
        let reveal = Reveal { wallet_id: "w1".into(), kind: SecretKind::Phrase, at: now };
        assert!(reveal_allows(Some(&reveal), "w1", SecretKind::Phrase, now));
        assert!(!reveal_allows(None, "w1", SecretKind::Phrase, now));
        assert!(!reveal_allows(Some(&reveal), "w2", SecretKind::Phrase, now));
        assert!(!reveal_allows(Some(&reveal), "w1", SecretKind::Key, now));
        assert!(!reveal_allows(Some(&reveal), "w1", SecretKind::Phrase, now + REVEAL_FOR + Duration::from_secs(1)));
        assert!(SecretKind::parse("words").is_err());
    }

    #[test]
    fn a_sealed_or_waiting_wallet_gives_no_secret_to_copy() {
        let mut w = generate_wallet_entry("A".into(), true).unwrap();
        assert!(exportable_secret(&w, SecretKind::Phrase).is_ok());
        assert!(exportable_secret(&w, SecretKind::Key).is_err());
        w.seal_pending = false;
        assert_eq!(exportable_secret(&w, SecretKind::Key).ok(), w.private_key.clone());
        assert_eq!(
            exportable_secret(&w, SecretKind::Phrase).ok(),
            w.mnemonic.as_ref().map(|m| m.join(" "))
        );
        let mut list = vec![w];
        seal_entries(&mut list, None);
        assert!(exportable_secret(&list[0], SecretKind::Phrase).is_err());
        assert!(exportable_secret(&list[0], SecretKind::Key).is_err());
    }

    fn derived_from(parent: &WalletEntry, needs_backup: bool) -> WalletEntry {
        let mut child = generate_wallet_entry("Child".into(), false).unwrap();
        child.source = "derived".into();
        child.mnemonic = parent.mnemonic.clone();
        child.needs_backup = needs_backup;
        child
    }

    #[test]
    fn a_derived_account_needs_the_backup_its_phrase_needs() {
        let parent = generate_wallet_entry("A".into(), false).unwrap();
        let old_child = derived_from(&parent, false);
        let other = generate_wallet_entry("B".into(), false).unwrap();
        let mut imported = generate_wallet_entry("C".into(), false).unwrap();
        imported.needs_backup = false;
        let list = vec![parent.clone(), old_child, other, imported, watch_entry()];
        assert!(needs_backup_of(&list[1], &list));
        assert!(needs_backup_of(&parent, &list));
        assert!(!needs_backup_of(&list[3], &list));
        assert!(!needs_backup_of(&list[4], &list));
        let json = wallets_to_json(&list);
        let flags: Vec<bool> = json.iter().map(|w| w["needs_backup"] == true).collect();
        assert_eq!(flags, vec![true, true, true, false, false]);
    }

    #[test]
    fn backing_up_one_account_clears_every_account_of_that_phrase_and_no_other() {
        let parent = generate_wallet_entry("A".into(), false).unwrap();
        let child = derived_from(&parent, true);
        let other = generate_wallet_entry("B".into(), false).unwrap();
        let mut list = vec![parent, child, other];
        let child_id = list[1].id.clone();
        assert_eq!(mark_phrase_backed_up(&mut list, &child_id), Ok(true));
        assert!(!list[0].needs_backup && !list[1].needs_backup);
        assert!(list[2].needs_backup);
        assert!(wallets_to_json(&list)[..2].iter().all(|w| w["needs_backup"] == false));
        assert_eq!(mark_phrase_backed_up(&mut list, &child_id), Ok(false));
        assert!(mark_phrase_backed_up(&mut list, "missing").is_err());
    }

    #[test]
    fn a_created_wallet_needs_a_backup_and_hands_out_no_secret() {
        let w = generate_wallet_entry("Wallet 2".into(), false).unwrap();
        assert!(w.needs_backup);
        assert!(!w.seal_pending);
        assert_eq!(w.mnemonic.as_ref().map(Vec::len), Some(12));
        assert_eq!(w.address.len(), 47);
        let json = created_wallet_json(&w);
        let obj = json.as_object().unwrap();
        assert!(!obj.contains_key("mnemonic"));
        assert!(!obj.contains_key("private_key"));
        assert_eq!(json["needs_backup"], true);
        let text = json.to_string();
        for word in w.mnemonic.as_ref().unwrap() {
            assert!(!text.contains(&format!("\"{}\"", word)));
        }
        assert!(!text.contains(w.private_key.as_ref().unwrap()));
        assert!(!wallets_to_json(&[w.clone()])[0].as_object().unwrap().contains_key("mnemonic"));
    }

    #[test]
    fn a_wallet_made_under_the_seal_waits_for_it() {
        let w = generate_wallet_entry("Wallet 1".into(), true).unwrap();
        assert!(w.seal_pending && w.needs_backup && w.exportable);
        assert_eq!(created_wallet_json(&w)["seal_pending"], true);
    }

    #[test]
    fn sealing_drops_the_phrase_and_the_backup_and_pending_flags() {
        let mut list = vec![
            generate_wallet_entry("A".into(), true).unwrap(),
            generate_wallet_entry("B".into(), false).unwrap(),
        ];
        let first = list[0].id.clone();
        seal_entries(&mut list, Some(&first));
        assert!(list[0].mnemonic.is_none() && !list[0].exportable);
        assert!(!list[0].needs_backup && !list[0].seal_pending);
        assert!(list[1].mnemonic.is_some() && list[1].exportable && list[1].needs_backup);
        seal_entries(&mut list, None);
        assert!(list.iter().all(|w| w.mnemonic.is_none() && !w.exportable && !w.needs_backup));
    }

    #[test]
    fn a_pending_seal_survives_a_reload_of_the_vault() {
        let w = generate_wallet_entry("Wallet 1".into(), true).unwrap();
        let saved = serde_json::to_string(&[w]).unwrap();
        let back: Vec<WalletEntry> = serde_json::from_str(&saved).unwrap();
        assert!(back[0].seal_pending);
        assert!(back[0].mnemonic.is_some());
    }

    #[test]
    fn old_vault_entries_need_no_backup() {
        let json = r#"{"id":"a","name":"W","address":"oct","wallet_type":"hd","is_active":true,
            "created_at":0,"source":"mnemonic","private_key":null,"mnemonic":null}"#;
        let entry: WalletEntry = serde_json::from_str(json).unwrap();
        assert!(!entry.needs_backup);
        assert!(!entry.seal_pending);
        assert!(entry.exportable);
    }

    fn sample_vault(tag: &str) -> Vault {
        Vault {
            salt: tag.into(),
            iv: "iv".into(),
            data: "data".into(),
            version: 1,
            has_password: true,
            hell_mode: false,
        }
    }

    fn watch_entry() -> WalletEntry {
        WalletEntry {
            id: "watch".into(),
            name: "Watch Wallet".into(),
            address: format!("oct{}", "7".repeat(44)),
            wallet_type: "watch".into(),
            is_active: true,
            created_at: 0,
            source: "address".into(),
            private_key: None,
            mnemonic: None,
            exportable: false,
            needs_backup: false,
            seal_pending: false,
        }
    }

    fn salt_at(path: &Path) -> String {
        parse_vault_at(path).unwrap().salt.clone()
    }

    #[test]
    fn a_save_keeps_the_previous_vault_as_the_backup() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        write_vault_at(&path, &sample_vault("one"), true).unwrap();
        assert!(!backup_path(&path).exists());
        write_vault_at(&path, &sample_vault("two"), true).unwrap();
        assert_eq!(salt_at(&path), "two");
        assert_eq!(salt_at(&backup_path(&path)), "one");
        assert!(!dir.join("vault.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_truncated_vault_opens_from_the_backup_and_the_backup_survives_the_next_save() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        write_vault_at(&path, &sample_vault("one"), true).unwrap();
        write_vault_at(&path, &sample_vault("two"), true).unwrap();
        let full = std::fs::read(&path).unwrap();
        std::fs::write(&path, &full[..full.len() / 2]).unwrap();
        assert_eq!(read_vault_at(&path).unwrap().unwrap().salt, "one");
        write_vault_at(&path, &sample_vault("three"), true).unwrap();
        assert_eq!(salt_at(&path), "three");
        assert_eq!(salt_at(&backup_path(&path)), "one");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_vault_after_a_crash_opens_from_the_backup() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        write_vault_at(&path, &sample_vault("one"), true).unwrap();
        write_vault_at(&path, &sample_vault("two"), true).unwrap();
        std::fs::write(&path, b"").unwrap();
        assert_eq!(read_vault_at(&path).unwrap().unwrap().salt, "one");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_vault_is_an_error_and_stays_on_disk() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        std::fs::write(&path, b"{\"salt\":").unwrap();
        assert_eq!(read_vault_at(&path).err().as_deref(), Some(VAULT_UNREADABLE));
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"salt\":");
        std::fs::write(backup_path(&path), b"garbage").unwrap();
        assert_eq!(read_vault_at(&path).err().as_deref(), Some(VAULT_UNREADABLE));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_vault_and_no_backup_is_a_fresh_start() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        assert!(read_vault_at(&dir.join("vault.json")).unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_that_drops_the_previous_vault_leaves_no_older_backup() {
        let dir = crate::system::atomic_file::scratch_dir("vault");
        let path = dir.join("vault.json");
        write_vault_at(&path, &sample_vault("old password"), true).unwrap();
        write_vault_at(&path, &sample_vault("new password"), false).unwrap();
        assert_eq!(salt_at(&path), "new password");
        assert_eq!(salt_at(&backup_path(&path)), "new password");
        remove_vault_files(&path).unwrap();
        assert!(!path.exists() && !backup_path(&path).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keys_are_never_sealed_under_an_empty_password() {
        let created = generate_wallet_entry("A".into(), false).unwrap();
        let mut imported = generate_wallet_entry("B".into(), false).unwrap();
        imported.mnemonic = None;
        for wallets in [vec![created.clone()], vec![watch_entry(), imported]] {
            assert_eq!(seal_wallets(&wallets, "", false).err().as_deref(), Some(PASSWORD_REQUIRED));
            assert!(require_password_for_keys(&wallets, "a real password").is_ok());
        }
    }

    #[test]
    fn watch_wallets_alone_may_stay_without_a_password() {
        assert!(!holds_keys(&[watch_entry()]));
        assert!(require_password_for_keys(&[watch_entry()], "").is_ok());
    }

    #[test]
    fn a_sealed_wallet_still_holds_its_key() {
        let mut list = vec![generate_wallet_entry("A".into(), false).unwrap()];
        seal_entries(&mut list, None);
        assert!(holds_keys(&list));
        assert!(require_password_for_keys(&list, "").is_err());
    }
}
