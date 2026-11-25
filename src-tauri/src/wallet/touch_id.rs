//! Touch ID unlock: the vault password in a keychain item only a current fingerprint opens.
//!
//! The item lives in the data protection keychain under an access control of
//! `BiometryCurrentSet` alone: no `UserPresence`, no device passcode, so the prompt never offers
//! the Mac login password, and a fingerprint added or removed makes the item unreadable. The
//! prompt has one cancel button, titled by the caller, and no fallback button.
//!
//! Wallets from before this kept the password in the biometry plugin's item (`vault_pwd`, under
//! `UserPresence`). The first unlock that finds only that item reads it once, saves the password
//! into this item and deletes the old one. Version 0.5.5 (plugin 0.2.6) wrote that item to the
//! file based login keychain instead, where no query here looks: it is deleted once, and again
//! whenever Touch ID is turned off.
//!
//! On Windows the same commands run Windows Hello. The password is sealed with AES-256-GCM under
//! a key derived from a Windows Hello key credential's signature over a random challenge, and the
//! sealed record sits in the Windows credential vault: only a Hello check in the same call opens
//! it. The biometry plugin kept `vault_pwd` sealed with AES-CBC under its signature over the
//! service name; the first unlock opens it with that one check, reseals it into `vault_pwd_hello`
//! and deletes it. Windows cannot tell when a finger or face is enrolled; a reset Hello PIN or
//! container deletes the key credential, and that turns unlock off like a fingerprint change.
//!
//! The password goes back to the main window only, as the unlock has always needed it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview};

use crate::guard::ipc_guard::require_main;

pub const SERVICE: &str = "com.0xio.desktop";
/// The biometry plugin's item, read once and then deleted.
pub const OLD_ACCOUNT: &str = "vault_pwd";
#[cfg(not(target_os = "windows"))]
pub const ACCOUNT: &str = "vault_pwd_touchid";
#[cfg(target_os = "windows")]
pub const ACCOUNT: &str = "vault_pwd_hello";

pub const USER_CANCEL: &str = "userCancel";
pub const CHANGED: &str = "biometryChanged";
pub const NOT_FOUND: &str = "itemNotFound";
pub const UNSUPPORTED: &str = "unsupported";

const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    Present,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    ReadNew,
    Migrate,
    TurnedOff,
    Nothing,
}

/// The fingerprints set changed when the state recorded at turn on differs from the one now.
/// An unknown state on either side changes nothing.
pub fn fingerprints_changed(recorded: Option<&str>, now: Option<&str>) -> bool {
    matches!((recorded, now), (Some(a), Some(b)) if a != b)
}

pub fn plan(new: Item, old: Item, recorded: Option<&str>, now: Option<&str>) -> Plan {
    match (new, old) {
        (Item::Present, _) if fingerprints_changed(recorded, now) => Plan::TurnedOff,
        (Item::Present, _) => Plan::ReadNew,
        (Item::Missing, Item::Present) => Plan::Migrate,
        (Item::Missing, Item::Missing) => Plan::Nothing,
    }
}

pub fn read_error(status: i32) -> String {
    match status {
        ERR_SEC_USER_CANCELED => USER_CANCEL.into(),
        ERR_SEC_ITEM_NOT_FOUND => CHANGED.into(),
        s => keychain_error(s),
    }
}

pub fn keychain_error(status: i32) -> String {
    format!("keychainError: {status}")
}

fn supported() -> Result<(), String> {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        Ok(())
    } else {
        Err(UNSUPPORTED.into())
    }
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    Some(data_dir(app)?.join("touch_id_state"))
}

fn off_path(app: &AppHandle) -> Option<PathBuf> {
    Some(data_dir(app)?.join("touch_id_turned_off"))
}

fn file_keychain_cleaned_path(app: &AppHandle) -> Option<PathBuf> {
    Some(data_dir(app)?.join("touch_id_file_keychain_cleaned"))
}

fn clean_file_keychain_once(app: &AppHandle) {
    if file_keychain_cleaned_path(app).is_some_and(|p| p.exists()) {
        return;
    }
    match keychain::delete_file_item(OLD_ACCOUNT) {
        Ok(()) => write_file(file_keychain_cleaned_path(app), "1"),
        Err(status) => crate::tlog!("[touch_id] could not remove the old login keychain item: {}", status),
    }
}

fn recorded_state(app: &AppHandle) -> Option<String> {
    std::fs::read_to_string(state_path(app)?).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn write_file(path: Option<PathBuf>, body: &str) {
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, body);
}

fn remove_file(path: Option<PathBuf>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// Unlock was turned off because the fingerprints or Windows Hello changed: Settings says so
/// until it is on again.
fn turn_off(app: &AppHandle) {
    let _ = keychain::delete(ACCOUNT);
    let _ = keychain::delete(OLD_ACCOUNT);
    remove_file(state_path(app));
    write_file(off_path(app), "fingerprints");
    crate::tlog!("[touch_id] fingerprints or Windows Hello changed, biometric unlock turned off");
}

fn remember(app: &AppHandle) {
    match keychain::fingerprint_state() {
        Some(state) => write_file(state_path(app), &state),
        None => remove_file(state_path(app)),
    }
    remove_file(off_path(app));
}

fn store(app: &AppHandle, password: &str) -> Result<(), String> {
    keychain::store(ACCOUNT, password)?;
    let _ = keychain::delete(OLD_ACCOUNT);
    remember(app);
    Ok(())
}

fn read(app: &AppHandle, reason: &str, cancel_title: &str) -> Result<String, String> {
    let new = keychain::exists(ACCOUNT).map_err(keychain_error)?;
    let old = keychain::exists(OLD_ACCOUNT).map_err(keychain_error)?;
    let recorded = recorded_state(app);
    let now = keychain::fingerprint_state();
    match plan(new, old, recorded.as_deref(), now.as_deref()) {
        Plan::Nothing => Err(NOT_FOUND.into()),
        Plan::TurnedOff => {
            turn_off(app);
            Err(CHANGED.into())
        }
        Plan::ReadNew => match keychain::read(ACCOUNT, reason, cancel_title) {
            Ok(pw) => Ok(pw),
            Err(status) => {
                let err = read_error(status);
                if err == CHANGED {
                    turn_off(app);
                }
                Err(err)
            }
        },
        Plan::Migrate => {
            let (pw, moved) = keychain::migrate(reason, cancel_title).map_err(|s| match s {
                ERR_SEC_USER_CANCELED => USER_CANCEL.to_string(),
                ERR_SEC_ITEM_NOT_FOUND => {
                    turn_off(app);
                    CHANGED.to_string()
                }
                s => keychain_error(s),
            })?;
            match moved {
                Ok(()) => {
                    remember(app);
                    crate::tlog!("[touch_id] moved the biometric secret to its own item")
                }
                Err(e) => crate::tlog!("[touch_id] could not move the biometric secret yet: {}", e),
            }
            Ok(pw)
        }
    }
}

#[tauri::command]
pub async fn touch_id_state(webview: Webview, app: AppHandle) -> Result<Value, String> {
    require_main(&webview)?;
    supported()?;
    tauri::async_runtime::spawn_blocking(move || {
        clean_file_keychain_once(&app);
        let new = keychain::exists(ACCOUNT).map_err(keychain_error)?;
        let old = keychain::exists(OLD_ACCOUNT).map_err(keychain_error)?;
        let turned_off = off_path(&app).is_some_and(|p| p.exists());
        Ok(json!({
            "enabled": new == Item::Present || old == Item::Present,
            "turnedOff": turned_off,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turns Touch ID unlock on with the vault password (checked by the caller first).
#[tauri::command]
pub async fn touch_id_store(webview: Webview, app: AppHandle, password: String) -> Result<(), String> {
    require_main(&webview)?;
    supported()?;
    tauri::async_runtime::spawn_blocking(move || store(&app, &password))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether this Mac can check a fingerprint, or this PC has Windows Hello set up; reads no item.
#[tauri::command]
pub async fn touch_id_available(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    supported()?;
    tauri::async_runtime::spawn_blocking(keychain::available).await.map_err(|e| e.to_string())
}

/// A fingerprint or Windows Hello check with nothing read, before unlock is turned on.
#[tauri::command]
pub async fn touch_id_prompt(webview: Webview, reason: String, cancel_title: String) -> Result<(), String> {
    require_main(&webview)?;
    supported()?;
    let reason = clean(&reason, 120);
    let cancel = clean(&cancel_title, 40);
    tauri::async_runtime::spawn_blocking(move || keychain::prompt(&reason, &cancel))
        .await
        .map_err(|e| e.to_string())?
}

fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

#[tauri::command]
pub async fn touch_id_read(
    webview: Webview,
    app: AppHandle,
    reason: String,
    cancel_title: String,
) -> Result<String, String> {
    require_main(&webview)?;
    supported()?;
    let reason = clean(&reason, 120);
    let cancel = clean(&cancel_title, 40);
    tauri::async_runtime::spawn_blocking(move || read(&app, &reason, &cancel))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn touch_id_clear(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_main(&webview)?;
    supported()?;
    tauri::async_runtime::spawn_blocking(move || {
        let a = keychain::delete(ACCOUNT);
        let b = keychain::delete(OLD_ACCOUNT);
        let c = keychain::delete_file_item(OLD_ACCOUNT);
        if c.is_ok() {
            write_file(file_keychain_cleaned_path(&app), "1");
        }
        remove_file(state_path(&app));
        remove_file(off_path(&app));
        a.and(b).and(c).map_err(keychain_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod keychain {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2_core_foundation::{
        kCFCopyStringDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFBoolean, CFData, CFDictionary,
        CFDictionaryKeyCallBacks, CFDictionaryValueCallBacks, CFIndex, CFRetained, CFString, CFType,
    };
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAError, LAPolicy};
    use objc2_security::{
        errSecInteractionNotAllowed, errSecItemNotFound, errSecSuccess, kSecAttrAccessControl,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecMatchLimit, kSecMatchLimitOne, kSecReturnData, kSecUseAuthenticationContext,
        kSecUseDataProtectionKeychain, kSecValueData, SecAccessControl, SecAccessControlCreateFlags, SecItemAdd,
        SecItemCopyMatching, SecItemDelete,
    };

    use super::{Item, ACCOUNT, OLD_ACCOUNT, SERVICE, USER_CANCEL};

    pub fn available() -> bool {
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }.is_ok()
    }

    /// Fingerprint only, one cancel button titled by the caller, no fallback button.
    pub fn prompt(reason: &str, cancel_title: &str) -> Result<(), String> {
        let ctx = unsafe { LAContext::new() };
        let policy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
        if let Err(e) = unsafe { ctx.canEvaluatePolicy_error(policy) } {
            return Err(format!("biometryUnavailable: {}", e.code()));
        }
        unsafe {
            ctx.setLocalizedCancelTitle(Some(&NSString::from_str(cancel_title)));
            ctx.setLocalizedFallbackTitle(Some(&NSString::from_str("")));
            ctx.setTouchIDAuthenticationAllowableReuseDuration(0.0);
        }
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let reply = block2::RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let result = if ok.as_bool() {
                Ok(())
            } else if err.is_null() {
                Err("authenticationFailed".to_string())
            } else {
                match LAError(unsafe { &*err }.code()) {
                    LAError::UserCancel | LAError::SystemCancel | LAError::AppCancel => Err(USER_CANCEL.to_string()),
                    code => Err(format!("authenticationFailed: {}", code.0)),
                }
            };
            let _ = tx.send(result);
        });
        unsafe { ctx.evaluatePolicy_localizedReason_reply(policy, &NSString::from_str(reason), &reply) };
        rx.recv().unwrap_or_else(|_| Err("authenticationFailed".to_string()))
    }

    /// A current fingerprint, and nothing else: no login password, no device passcode.
    pub fn access_flags() -> SecAccessControlCreateFlags {
        SecAccessControlCreateFlags::BiometryCurrentSet
    }

    fn dict(pairs: &[(*const c_void, *const c_void)]) -> Result<CFRetained<CFDictionary>, i32> {
        let keys: Vec<*const c_void> = pairs.iter().map(|p| p.0).collect();
        let values: Vec<*const c_void> = pairs.iter().map(|p| p.1).collect();
        unsafe {
            CFDictionary::new(
                None,
                keys.as_ptr() as *mut *const c_void,
                values.as_ptr() as *mut *const c_void,
                keys.len() as CFIndex,
                &kCFCopyStringDictionaryKeyCallBacks as *const CFDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks as *const CFDictionaryValueCallBacks,
            )
        }
        .ok_or(-50)
    }

    fn cf<T: AsRef<CFType> + ?Sized>(v: &T) -> *const c_void {
        v.as_ref() as *const CFType as *const c_void
    }

    fn ctx_ptr(ctx: &Retained<LAContext>) -> *const c_void {
        Retained::as_ptr(ctx) as *const c_void
    }

    /// The item's address: class, service, account, in the data protection keychain (the only one
    /// that honours an access control).
    fn base(account: &CFString, service: &CFString, yes: &CFBoolean) -> Vec<(*const c_void, *const c_void)> {
        unsafe {
            vec![
                (cf(kSecClass), cf(kSecClassGenericPassword)),
                (cf(kSecAttrService), cf(service)),
                (cf(kSecAttrAccount), cf(account)),
                (cf(kSecUseDataProtectionKeychain), cf(yes)),
            ]
        }
    }

    pub fn exists(account: &str) -> Result<Item, i32> {
        let account = CFString::from_str(account);
        let service = CFString::from_str(SERVICE);
        let yes = CFBoolean::new(true);
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.setInteractionNotAllowed(true) };
        let mut pairs = base(&account, &service, yes);
        unsafe {
            pairs.push((cf(kSecMatchLimit), cf(kSecMatchLimitOne)));
            pairs.push((cf(kSecUseAuthenticationContext), ctx_ptr(&ctx)));
        }
        let query = dict(&pairs)?;
        let status = unsafe { SecItemCopyMatching(&query, std::ptr::null_mut()) };
        if status == errSecSuccess || status == errSecInteractionNotAllowed {
            Ok(Item::Present)
        } else if status == errSecItemNotFound {
            Ok(Item::Missing)
        } else {
            Err(status)
        }
    }

    pub fn read(account: &str, reason: &str, cancel_title: &str) -> Result<String, i32> {
        let account = CFString::from_str(account);
        let service = CFString::from_str(SERVICE);
        let yes = CFBoolean::new(true);
        let ctx = unsafe { LAContext::new() };
        unsafe {
            ctx.setLocalizedReason(&NSString::from_str(reason));
            ctx.setLocalizedCancelTitle(Some(&NSString::from_str(cancel_title)));
            ctx.setLocalizedFallbackTitle(Some(&NSString::from_str("")));
            ctx.setTouchIDAuthenticationAllowableReuseDuration(0.0);
        }
        let mut pairs = base(&account, &service, yes);
        unsafe {
            pairs.push((cf(kSecReturnData), cf(yes)));
            pairs.push((cf(kSecMatchLimit), cf(kSecMatchLimitOne)));
            pairs.push((cf(kSecUseAuthenticationContext), ctx_ptr(&ctx)));
        }
        let query = dict(&pairs)?;
        let mut out: *const CFType = std::ptr::null();
        let status = unsafe { SecItemCopyMatching(&query, &mut out) };
        if status != errSecSuccess {
            return Err(status);
        }
        if out.is_null() {
            return Err(errSecItemNotFound);
        }
        let data: CFRetained<CFData> =
            unsafe { CFRetained::from_raw(std::ptr::NonNull::new_unchecked(out as *mut CFData)) };
        let bytes = unsafe { std::slice::from_raw_parts(data.byte_ptr(), data.len() as usize) };
        String::from_utf8(bytes.to_vec()).map_err(|_| -26275)
    }

    /// Reads the plugin's item and moves it to ours; a failed move still hands back the password.
    pub fn migrate(reason: &str, cancel_title: &str) -> Result<(String, Result<(), String>), i32> {
        let pw = read(OLD_ACCOUNT, reason, cancel_title)?;
        let moved = store(ACCOUNT, &pw).map(|()| {
            let _ = delete(OLD_ACCOUNT);
        });
        Ok((pw, moved))
    }

    pub fn store(account_name: &str, password: &str) -> Result<(), String> {
        delete(account_name).map_err(super::keychain_error)?;
        let account = CFString::from_str(account_name);
        let service = CFString::from_str(SERVICE);
        let yes = CFBoolean::new(true);
        let value = CFData::from_bytes(password.as_bytes());
        let acl = unsafe {
            SecAccessControl::with_flags(
                None,
                kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                access_flags(),
                std::ptr::null_mut(),
            )
        }
        .ok_or_else(|| "Could not create the Touch ID access control".to_string())?;
        let mut pairs = base(&account, &service, yes);
        unsafe {
            pairs.push((cf(kSecValueData), cf(&*value)));
            pairs.push((cf(kSecAttrAccessControl), cf(&*acl)));
        }
        let attrs = dict(&pairs).map_err(super::keychain_error)?;
        let status = unsafe { SecItemAdd(&attrs, std::ptr::null_mut()) };
        if status == errSecSuccess {
            Ok(())
        } else {
            Err(super::keychain_error(status))
        }
    }

    pub fn delete(account: &str) -> Result<(), i32> {
        let account = CFString::from_str(account);
        let service = CFString::from_str(SERVICE);
        let yes = CFBoolean::new(true);
        let query = dict(&base(&account, &service, yes))?;
        let status = unsafe { SecItemDelete(&query) };
        if status == errSecSuccess || status == errSecItemNotFound {
            Ok(())
        } else {
            Err(status)
        }
    }

    /// Deletes an item from the file based login keychain, where the biometry plugin 0.2.6 wrote
    /// (no data protection flag), without a prompt.
    pub fn delete_file_item(account: &str) -> Result<(), i32> {
        let account = CFString::from_str(account);
        let service = CFString::from_str(SERVICE);
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.setInteractionNotAllowed(true) };
        let pairs = unsafe {
            vec![
                (cf(kSecClass), cf(kSecClassGenericPassword)),
                (cf(kSecAttrService), cf(&*service)),
                (cf(kSecAttrAccount), cf(&*account)),
                (cf(kSecUseAuthenticationContext), ctx_ptr(&ctx)),
            ]
        };
        let query = dict(&pairs)?;
        let status = unsafe { SecItemDelete(&query) };
        if status == errSecSuccess || status == errSecItemNotFound {
            Ok(())
        } else {
            Err(status)
        }
    }

    #[allow(deprecated)]
    pub fn fingerprint_state() -> Option<String> {
        use sha2::{Digest, Sha256};
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }.ok()?;
        let data = unsafe { ctx.evaluatedPolicyDomainState() }?;
        let digest = Sha256::digest(data.to_vec());
        Some(digest.iter().map(|b| format!("{b:02x}")).collect())
    }
}

#[cfg(any(target_os = "windows", test))]
mod sealed {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    use zeroize::Zeroizing;

    const VERSION: u8 = 1;
    const TAG: &[u8] = b"0xio windows hello v1";
    const NONCE: usize = 12;

    fn key(signature: &[u8]) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(Sha256::new().chain_update(TAG).chain_update(signature).finalize().into())
    }

    /// The record names the challenge it was sealed under, so an unlock knows what to sign.
    pub fn challenge(record: &str) -> Option<Vec<u8>> {
        let raw = STANDARD.decode(record).ok()?;
        let (&version, rest) = raw.split_first()?;
        let (&len, rest) = rest.split_first()?;
        (version == VERSION && rest.len() > len as usize + NONCE).then(|| rest[..len as usize].to_vec())
    }

    pub fn seal(signature: &[u8], challenge: &[u8], password: &str) -> Option<String> {
        let len = u8::try_from(challenge.len()).ok()?;
        let nonce: [u8; NONCE] = rand::random();
        let cipher = Aes256Gcm::new_from_slice(key(signature).as_slice()).ok()?;
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), password.as_bytes()).ok()?;
        let mut raw = vec![VERSION, len];
        raw.extend_from_slice(challenge);
        raw.extend_from_slice(&nonce);
        raw.extend_from_slice(&sealed);
        Some(STANDARD.encode(raw))
    }

    pub fn open(signature: &[u8], record: &str) -> Option<String> {
        let raw = STANDARD.decode(record).ok()?;
        let len = *raw.get(1)? as usize;
        let rest = raw.get(2 + len..)?;
        if raw[0] != VERSION || rest.len() <= NONCE {
            return None;
        }
        let (nonce, sealed) = rest.split_at(NONCE);
        let cipher = Aes256Gcm::new_from_slice(key(signature).as_slice()).ok()?;
        let plain = Zeroizing::new(cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()?);
        String::from_utf8(plain.to_vec()).ok()
    }

    /// The biometry plugin's key and IV: SHA-256 of its signature, and of `IV_` plus the service.
    pub fn legacy_key_iv(signature: &[u8], service: &str) -> (Zeroizing<[u8; 32]>, [u8; 16]) {
        let key = Zeroizing::new(Sha256::digest(signature).into());
        let iv_hash = Sha256::digest(format!("IV_{service}").as_bytes());
        let mut iv = [0u8; 16];
        iv.copy_from_slice(&iv_hash[..16]);
        (key, iv)
    }
}

/// Windows Hello: a key credential named after the service signs a challenge, and the record
/// sealed under that signature sits in the credential vault (resource = service,
/// username = account). Failures use the status codes the shared code already names.
#[cfg(target_os = "windows")]
mod keychain {
    use windows::core::{Array, HRESULT, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus, PasswordCredential,
        PasswordVault,
    };
    use windows::Security::Cryptography::Core::{
        CryptographicEngine, SymmetricAlgorithmNames, SymmetricKeyAlgorithmProvider,
    };
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Storage::Streams::IBuffer;
    use zeroize::Zeroizing;

    use super::{
        sealed, Item, ACCOUNT, ERR_SEC_ITEM_NOT_FOUND, ERR_SEC_USER_CANCELED, OLD_ACCOUNT, SERVICE, USER_CANCEL,
    };

    const ELEMENT_NOT_FOUND: HRESULT = HRESULT(0x8007_0490_u32 as i32);

    fn code(e: windows::core::Error) -> i32 {
        e.code().0
    }

    /// The Hello dialog of a desktop app can open behind its window; bring it to the front.
    fn raise_dialog() {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        std::thread::spawn(|| {
            for _ in 0..5 {
                std::thread::sleep(std::time::Duration::from_millis(250));
                if let Ok(hwnd) = unsafe { FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()) } {
                    unsafe {
                        if IsIconic(hwnd).as_bool() {
                            let _ = ShowWindow(hwnd, SW_RESTORE);
                        }
                        let _ = BringWindowToTop(hwnd);
                        let _ = SetForegroundWindow(hwnd);
                    }
                    return;
                }
            }
        });
    }

    fn bytes(buffer: &IBuffer) -> Result<Zeroizing<Vec<u8>>, i32> {
        let mut out = Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(buffer, &mut out).map_err(code)?;
        Ok(Zeroizing::new(out.to_vec()))
    }

    pub fn available() -> bool {
        let hello = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join());
        let keys = KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join());
        matches!(hello, Ok(UserConsentVerifierAvailability::Available)) && matches!(keys, Ok(true))
    }

    /// Windows draws its own buttons; the cancel title has no place there.
    pub fn prompt(reason: &str, _cancel_title: &str) -> Result<(), String> {
        let op = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
            .map_err(|e| format!("authenticationFailed: {}", e.code().0))?;
        raise_dialog();
        match op.join().map_err(|e| format!("authenticationFailed: {}", e.code().0))? {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => Err(USER_CANCEL.into()),
            r @ (UserConsentVerificationResult::DeviceNotPresent
            | UserConsentVerificationResult::NotConfiguredForUser
            | UserConsentVerificationResult::DisabledByPolicy) => Err(format!("biometryUnavailable: {}", r.0)),
            r => Err(format!("authenticationFailed: {}", r.0)),
        }
    }

    fn vault_item(account: &str) -> Result<Option<PasswordCredential>, i32> {
        let vault = PasswordVault::new().map_err(code)?;
        match vault.Retrieve(&HSTRING::from(SERVICE), &HSTRING::from(account)) {
            Ok(item) => Ok(Some(item)),
            Err(e) if e.code() == ELEMENT_NOT_FOUND => Ok(None),
            Err(e) => Err(code(e)),
        }
    }

    fn vault_read(account: &str) -> Result<Zeroizing<String>, i32> {
        let item = vault_item(account)?.ok_or(ERR_SEC_ITEM_NOT_FOUND)?;
        item.RetrievePassword().map_err(code)?;
        Ok(Zeroizing::new(item.Password().map_err(code)?.to_string()))
    }

    fn vault_write(account: &str, record: &str) -> Result<(), i32> {
        let vault = PasswordVault::new().map_err(code)?;
        if let Some(old) = vault_item(account)? {
            vault.Remove(&old).map_err(code)?;
        }
        let item = PasswordCredential::CreatePasswordCredential(
            &HSTRING::from(SERVICE),
            &HSTRING::from(account),
            &HSTRING::from(record),
        )
        .map_err(code)?;
        vault.Add(&item).map_err(code)
    }

    fn vault_remove(account: &str) -> Result<(), i32> {
        match vault_item(account)? {
            Some(item) => PasswordVault::new().map_err(code)?.Remove(&item).map_err(code),
            None => Ok(()),
        }
    }

    fn key_status(status: KeyCredentialStatus) -> i32 {
        match status {
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => ERR_SEC_USER_CANCELED,
            KeyCredentialStatus::NotFound => ERR_SEC_ITEM_NOT_FOUND,
            s => s.0,
        }
    }

    fn open_credential() -> Result<KeyCredential, i32> {
        let found = KeyCredentialManager::OpenAsync(&HSTRING::from(SERVICE)).and_then(|op| op.join()).map_err(code)?;
        match found.Status().map_err(code)? {
            KeyCredentialStatus::Success => found.Credential().map_err(code),
            s => Err(key_status(s)),
        }
    }

    fn create_credential() -> Result<KeyCredential, i32> {
        let name = HSTRING::from(SERVICE);
        let op = KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
            .map_err(code)?;
        raise_dialog();
        let created = op.join().map_err(code)?;
        match created.Status().map_err(code)? {
            KeyCredentialStatus::Success => created.Credential().map_err(code),
            s => Err(key_status(s)),
        }
    }

    /// The Windows Hello check: the key credential signs only after the user passes it.
    fn sign(credential: &KeyCredential, challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>, i32> {
        let data = CryptographicBuffer::CreateFromByteArray(challenge).map_err(code)?;
        let op = credential.RequestSignAsync(&data).map_err(code)?;
        raise_dialog();
        let signed = op.join().map_err(code)?;
        match signed.Status().map_err(code)? {
            KeyCredentialStatus::Success => bytes(&signed.Result().map_err(code)?),
            s => Err(key_status(s)),
        }
    }

    fn legacy_open(signature: &[u8], record: &str) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let (key, iv) = sealed::legacy_key_iv(signature, SERVICE);
        let data = STANDARD.decode(record).ok()?;
        let aes = SymmetricKeyAlgorithmProvider::OpenAlgorithm(&SymmetricAlgorithmNames::AesCbcPkcs7().ok()?).ok()?;
        let key = aes.CreateSymmetricKey(&CryptographicBuffer::CreateFromByteArray(key.as_slice()).ok()?).ok()?;
        let plain = CryptographicEngine::Decrypt(
            &key,
            &CryptographicBuffer::CreateFromByteArray(&data).ok()?,
            &CryptographicBuffer::CreateFromByteArray(&iv).ok()?,
        )
        .ok()?;
        String::from_utf8(bytes(&plain).ok()?.to_vec()).ok()
    }

    pub fn exists(account: &str) -> Result<Item, i32> {
        Ok(if vault_item(account)?.is_some() { Item::Present } else { Item::Missing })
    }

    pub fn read(account: &str, _reason: &str, _cancel_title: &str) -> Result<String, i32> {
        let record = vault_read(account)?;
        let challenge = sealed::challenge(&record).ok_or(ERR_SEC_ITEM_NOT_FOUND)?;
        let signature = sign(&open_credential()?, &challenge)?;
        sealed::open(&signature, &record).ok_or(ERR_SEC_ITEM_NOT_FOUND)
    }

    /// Opens the plugin's record with one Hello check and reseals it under the same signature, so
    /// the move asks for nothing more.
    pub fn migrate(_reason: &str, _cancel_title: &str) -> Result<(String, Result<(), String>), i32> {
        let record = vault_read(OLD_ACCOUNT)?;
        let challenge = SERVICE.as_bytes();
        let signature = sign(&open_credential()?, challenge)?;
        let pw = legacy_open(&signature, &record).ok_or(ERR_SEC_ITEM_NOT_FOUND)?;
        let moved = sealed::seal(&signature, challenge, &pw)
            .ok_or_else(|| "sealFailed".to_string())
            .and_then(|r| vault_write(ACCOUNT, &r).map_err(super::keychain_error))
            .map(|()| {
                let _ = vault_remove(OLD_ACCOUNT);
            });
        Ok((pw, moved))
    }

    pub fn store(account: &str, password: &str) -> Result<(), String> {
        let credential = match open_credential() {
            Ok(c) => Ok(c),
            Err(ERR_SEC_ITEM_NOT_FOUND) => create_credential(),
            Err(s) => Err(s),
        };
        let challenge: [u8; 32] = rand::random();
        let signature = credential.and_then(|c| sign(&c, &challenge)).map_err(|s| match s {
            ERR_SEC_USER_CANCELED => USER_CANCEL.to_string(),
            s => super::keychain_error(s),
        })?;
        let record = sealed::seal(&signature, &challenge, password).ok_or_else(|| "sealFailed".to_string())?;
        vault_write(account, &record).map_err(super::keychain_error)
    }

    /// The key credential goes once neither record is left to open.
    pub fn delete(account: &str) -> Result<(), i32> {
        vault_remove(account)?;
        if vault_item(ACCOUNT)?.is_none() && vault_item(OLD_ACCOUNT)?.is_none() {
            let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(SERVICE)).and_then(|op| op.join());
        }
        Ok(())
    }

    pub fn delete_file_item(_: &str) -> Result<(), i32> {
        Ok(())
    }

    pub fn fingerprint_state() -> Option<String> {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod keychain {
    use super::{Item, UNSUPPORTED};

    const NONE: i32 = 1;

    pub fn available() -> bool {
        false
    }

    pub fn prompt(_: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn exists(_: &str) -> Result<Item, i32> {
        Err(NONE)
    }

    pub fn read(_: &str, _: &str, _: &str) -> Result<String, i32> {
        Err(NONE)
    }

    pub fn migrate(_: &str, _: &str) -> Result<(String, Result<(), String>), i32> {
        Err(NONE)
    }

    pub fn store(_: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_: &str) -> Result<(), i32> {
        Ok(())
    }

    pub fn delete_file_item(_: &str) -> Result<(), i32> {
        Ok(())
    }

    pub fn fingerprint_state() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unlock_reads_its_own_item_or_moves_the_old_one_once() {
        use Item::*;
        assert_eq!(plan(Present, Missing, Some("a"), Some("a")), Plan::ReadNew);
        assert_eq!(plan(Present, Present, None, Some("a")), Plan::ReadNew, "the old one is not read again");
        assert_eq!(plan(Missing, Present, None, Some("a")), Plan::Migrate);
        assert_eq!(plan(Missing, Present, Some("a"), Some("b")), Plan::Migrate, "the old item has no recorded set");
        assert_eq!(plan(Missing, Missing, None, None), Plan::Nothing);
    }

    #[test]
    fn a_changed_fingerprint_set_turns_touch_id_off() {
        use Item::*;
        assert_eq!(plan(Present, Missing, Some("a"), Some("b")), Plan::TurnedOff);
        assert_eq!(plan(Present, Missing, Some("a"), None), Plan::ReadNew, "Touch ID unusable now is not a change");
        assert_eq!(plan(Present, Missing, None, Some("b")), Plan::ReadNew, "nothing recorded to compare");
        assert!(!fingerprints_changed(Some("a"), Some("a")));
    }

    #[test]
    fn read_failures_are_named() {
        assert_eq!(read_error(-128), USER_CANCEL);
        assert_eq!(read_error(-25300), CHANGED, "an item that was there and cannot be read");
        assert_eq!(read_error(-34018), "keychainError: -34018", "the dev build keeps its own store");
        assert_eq!(read_error(-25293), "keychainError: -25293", "a failed fingerprint does not turn it off");
    }

    #[test]
    fn a_sealed_record_opens_with_its_signature_only() {
        let record = sealed::seal(b"signature", b"challenge", "vault-pw").unwrap();
        assert_eq!(sealed::challenge(&record).as_deref(), Some(&b"challenge"[..]));
        assert_eq!(sealed::open(b"signature", &record).as_deref(), Some("vault-pw"));
        assert_eq!(sealed::open(b"other", &record), None, "a replaced key credential cannot open it");
        assert_ne!(record, sealed::seal(b"signature", b"challenge", "vault-pw").unwrap(), "fresh nonce");
        assert_eq!(sealed::challenge("AQ=="), None);
        assert_eq!(sealed::open(b"signature", "not base64"), None);
    }

    #[test]
    fn the_plugin_key_and_iv_match_its_derivation() {
        use sha2::{Digest, Sha256};
        let (key, iv) = sealed::legacy_key_iv(b"sig", SERVICE);
        assert_eq!(key.as_slice(), Sha256::digest(b"sig").as_slice());
        assert_eq!(iv, Sha256::digest(b"IV_com.0xio.desktop")[..16]);
        assert_eq!(OLD_ACCOUNT, "vault_pwd", "the plugin's name for the item");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_item_opens_with_a_current_fingerprint_only() {
        use objc2_security::SecAccessControlCreateFlags as F;
        let flags = keychain::access_flags();
        assert_eq!(flags, F::BiometryCurrentSet);
        for never in [F::UserPresence, F::DevicePasscode, F::BiometryAny, F::Or, F::ApplicationPassword] {
            assert!(!flags.contains(never), "{never:?}");
        }
        assert_ne!(ACCOUNT, OLD_ACCOUNT);
    }
}
