use std::collections::BTreeSet;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Serialize;

use crate::wallet::wallet_commands::WalletEntry;

const BUILD_SCRIPT: &str = include_str!("../../build.rs");
const HANDLERS: &str = include_str!("../lib.rs");
const MAIN_WINDOW: &str = include_str!("../../permissions/main-window.toml");
const TRAY_WINDOW: &str = include_str!("../../permissions/tray-window.toml");
const DAPP_WINDOW: &str = include_str!("../../capabilities/dapp.json");
const COMMAND_SOURCES: &[&str] = &[
    include_str!("../wallet/wallet_commands.rs"),
    include_str!("../wallet/secret_clipboard.rs"),
    include_str!("../pvac/pvac_commands.rs"),
    include_str!("../pvac/stealth.rs"),
];

const EXPORT_GATED: &[&str] = &["wallet_export_mnemonic", "wallet_export_private_key"];

const PASSWORD_AFTER_TOUCH_ID: &[&str] = &["touch_id_read"];

const NO_SECRET: &[&str] = &[
    "stage_frame_document",
    "stage_frame_asset",
    "circle_pick",
    "circle_read_picked",
    "nft_fetch",
    "node_rpc_post",
    "pvac_init_wallet",
    "pvac_destroy",
    "pvac_encrypt",
    "pvac_decrypt",
    "pvac_make_range_proof",
    "pvac_make_parallel_range_proofs",
    "pvac_make_bound_proof",
    "pvac_pedersen_commit",
    "pvac_serialize_pubkey",
    "pvac_matches_secret_profile",
    "pvac_make_bound_range_proof",
    "pvac_check_bound_provable",
    "pvac_diagnose_cipher",
    "pvac_make_bound_key_switch_proof",
    "pvac_make_bound_key_switch_proof_with_pubkey",
    "pvac_verify_bound_key_switch_proof_with_pubkey",
    "pvac_verify_bound_proof",
    "pvac_circle_verify_zero",
    "pvac_circle_verify_bound",
    "pvac_make_key_owner_proof",
    "pvac_build_cipher_proof_migration",
    "pvac_ct_sub",
    "pvac_commit",
    "pvac_aes_kat",
    "stealth_match_outputs",
    "wallet_is_initialized",
    "wallet_create",
    "wallet_import_mnemonic",
    "wallet_import_private_key",
    "wallet_unlock",
    "wallet_unlock_status",
    "wallet_preview_secret",
    "wallet_mnemonic_wordlist",
    "wallet_mark_backed_up",
    "wallet_lock",
    "wallet_idle_report",
    "wallet_get_public_key",
    "wallet_sign_transaction",
    "wallet_delete",
    "wallet_create_additional",
    "wallet_derive_account",
    "wallet_scan_hd_accounts",
    "wallet_rename",
    "wallet_set_active",
    "wallet_reset",
    "wallet_has_password",
    "wallet_needs_password",
    "wallet_change_password",
    "wallet_remove_password",
    "wallet_import_address",
    "wallet_is_hell_mode",
    "wallet_activate_hell_mode",
    "wallet_seal_wallet",
    "wallet_rpc_respond",
    "wallet_finish_seal",
    "wallet_verify_password",
    "wallet_end_reveal",
    "wallet_copy_secret",
    "wallet_clear_pasted_secret",
    "ws_pair_pending",
    "ws_pair_respond",
    "ws_paired_list",
    "ws_pair_forget",
    "ws_pair_settings",
    "ws_pair_set_settings",
    "site_list",
    "site_queue",
    "site_review_open",
    "site_stage",
    "site_respond",
    "site_progress",
    "site_frame_open",
    "site_frame_update",
    "site_frame_status",
    "site_wallet_hello",
    "site_disconnect",
    "site_send_event",
    "site_lock_event",
    "site_answer",
    "site_reject",
    "site_notify_permission",
    "site_notify_open_settings",
    "notice_post",
    "dapp_open_window",
    "dapp_bridge_request",
    "dapp_bridge_respond",
    "dapp_set_windows_hidden",
    "dapp_emit_event",
    "touch_id_state",
    "touch_id_store",
    "touch_id_prompt",
    "touch_id_available",
    "touch_id_clear",
    "frontend_log",
    "restart_app",
    "get_log_path",
    "open_log_folder",
    "set_proof_threads",
    "system_info",
    "workspace_list",
    "workspace_read",
    "workspace_write",
    "workspace_mkdir",
    "workspace_delete",
    "workspace_rename",
    "tray_publish",
    "tray_progress",
    "tray_get_state",
    "tray_action",
    "tray_unlock",
    "tray_approve_send",
    "tray_auth_hold",
    "tray_hide",
    "main_close_hold",
    "window_theme",
];

fn quoted(text: &str) -> Vec<&str> {
    text.split('"').skip(1).step_by(2).collect()
}

pub(crate) fn manifest_commands() -> Vec<&'static str> {
    let list = BUILD_SCRIPT
        .split_once("const COMMANDS: &[&str] = &[")
        .and_then(|(_, rest)| rest.split_once("];"))
        .map(|(list, _)| list)
        .unwrap();
    quoted(list)
}

fn handler_commands() -> Vec<&'static str> {
    let list = HANDLERS
        .split_once("tauri::generate_handler![")
        .and_then(|(_, rest)| rest.split_once("])"))
        .map(|(list, _)| list)
        .unwrap();
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.rsplit("::").next().unwrap())
        .collect()
}

fn granted(permissions: &'static str) -> Vec<String> {
    quoted(permissions)
        .into_iter()
        .filter_map(|entry| entry.strip_prefix("allow-"))
        .map(|command| command.replace('-', "_"))
        .collect()
}

fn signature(command: &str) -> &'static str {
    COMMAND_SOURCES
        .iter()
        .find_map(|source| {
            let at = ["(", "<"]
                .iter()
                .find_map(|open| source.find(&format!("fn {command}{open}")))?;
            source[at..].split_once('{').map(|(signature, _)| signature)
        })
        .unwrap_or_else(|| panic!("{command} has no source"))
}

fn returns_no_value(command: &str) -> bool {
    let signature: String = signature(command).split_whitespace().collect();
    signature.ends_with("->Result<(),String>") || signature.ends_with("->Result<bool,String>")
}

pub(crate) struct Secrets {
    exact: Vec<(String, String)>,
    hex: Vec<(String, String)>,
}

impl Secrets {
    pub(crate) fn new() -> Self {
        Self { exact: Vec::new(), hex: Vec::new() }
    }

    fn add(&mut self, what: &str, needle: String) {
        if !self.exact.iter().any(|(_, known)| *known == needle) {
            self.exact.push((what.to_string(), needle));
        }
    }

    fn bytes(&mut self, what: &str, bytes: &[u8]) {
        let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        if !self.hex.iter().any(|(_, known)| *known == hex) {
            self.hex.push((what.to_string(), hex));
        }
        self.add(what, STANDARD.encode(bytes));
        self.add(what, STANDARD_NO_PAD.encode(bytes));
        self.add(what, URL_SAFE_NO_PAD.encode(bytes));
        self.add(what, bytes.iter().map(u8::to_string).collect::<Vec<_>>().join(","));
    }

    pub(crate) fn key(&mut self, seed: &[u8; 32]) {
        self.bytes("the key", seed);
        self.bytes("the PVAC master seed", &pvac_rs::crypto::keygen::master_seed(seed));
        self.bytes("the view secret key", &crate::pvac::stealth::view_secret(seed));
    }

    fn whole_phrase(&mut self, words: &[String]) {
        self.add("the phrase", words.join(" "));
        self.add("the phrase", words.join("\",\""));
    }

    pub(crate) fn phrase(&mut self, words: &[String]) {
        self.whole_phrase(words);
        for pair in words.windows(2) {
            self.add("a run of phrase words", format!("{} {}", pair[0], pair[1]));
            self.add("a run of phrase words", format!("\"{}\",\"{}\"", pair[0], pair[1]));
        }
    }

    pub(crate) fn password(&mut self, password: &str) {
        self.add("the password", password.to_string());
    }

    pub(crate) fn wallets(&mut self, wallets: &[WalletEntry]) {
        for wallet in wallets {
            if let Some(key) = &wallet.private_key {
                let seed: [u8; 32] = STANDARD.decode(key).unwrap().try_into().unwrap();
                self.key(&seed);
            }
            if let Some(words) = &wallet.mnemonic {
                self.whole_phrase(words);
            }
        }
    }

    pub(crate) fn found_in<T: Serialize + ?Sized>(&self, value: &T) -> Option<&str> {
        let text = serde_json::to_string(value).unwrap();
        let lower = text.to_lowercase();
        let hex = self.hex.iter().find(|(_, needle)| lower.contains(needle));
        let exact = self.exact.iter().find(|(_, needle)| text.contains(needle));
        hex.or(exact).map(|(what, _)| what.as_str())
    }
}

pub(crate) struct Coverage {
    pub(crate) secrets: Secrets,
    seen: BTreeSet<&'static str>,
    results: Vec<(&'static str, String)>,
}

impl Coverage {
    pub(crate) fn new() -> Self {
        Self { secrets: Secrets::new(), seen: BTreeSet::new(), results: Vec::new() }
    }

    pub(crate) fn see<T: Serialize>(&mut self, command: &'static str, result: &T) {
        self.seen.insert(command);
        self.results.push((command, serde_json::to_string(result).unwrap()));
    }

    pub(crate) fn assert_clean(&self, prefix: &str, by_type: &[&'static str]) {
        assert!(self.secrets.hex.len() >= 3);
        for (command, text) in &self.results {
            assert_eq!(self.secrets.found_in(text), None, "{command} returned {text}");
        }
        for command in by_type {
            assert!(returns_no_value(command), "{command} returns a value");
            assert!(!self.seen.contains(command), "{command}");
        }
        let covered: BTreeSet<&str> = self
            .seen
            .iter()
            .chain(by_type)
            .chain(EXPORT_GATED.iter().filter(|command| command.starts_with(prefix)))
            .copied()
            .collect();
        let all: BTreeSet<&str> =
            manifest_commands().into_iter().filter(|command| command.starts_with(prefix)).collect();
        assert_eq!(covered, all);
    }
}

#[test]
fn every_command_is_classified_once() {
    let manifest = manifest_commands();
    assert!(manifest.len() > 100);
    for command in &manifest {
        let places = [NO_SECRET, EXPORT_GATED, PASSWORD_AFTER_TOUCH_ID]
            .iter()
            .filter(|list| list.contains(command))
            .count();
        assert_eq!(places, 1, "{command}");
    }
    for command in NO_SECRET.iter().chain(EXPORT_GATED).chain(PASSWORD_AFTER_TOUCH_ID) {
        assert!(manifest.contains(command), "{command} is not a command");
    }
    let unique: BTreeSet<&str> = manifest.iter().copied().collect();
    assert_eq!(unique.len(), manifest.len());
    assert_eq!(NO_SECRET.len() + EXPORT_GATED.len() + PASSWORD_AFTER_TOUCH_ID.len(), manifest.len());
}

#[test]
fn only_the_two_exports_and_the_touch_id_read_hand_back_a_secret() {
    assert_eq!(EXPORT_GATED, ["wallet_export_mnemonic", "wallet_export_private_key"]);
    assert_eq!(PASSWORD_AFTER_TOUCH_ID, ["touch_id_read"]);
    for command in EXPORT_GATED {
        assert!(signature(command).contains("password: String"), "{command}");
        assert!(!returns_no_value(command), "{command}");
    }
}

#[test]
fn the_manifest_is_the_handler_list() {
    let manifest: BTreeSet<&str> = manifest_commands().into_iter().collect();
    let handlers: BTreeSet<&str> = handler_commands().into_iter().collect();
    assert_eq!(manifest, handlers);
}

#[test]
fn the_removed_key_commands_are_gone_everywhere() {
    for gone in ["wallet_get_private_key", "pvac_init"] {
        assert!(!manifest_commands().contains(&gone));
        assert!(!handler_commands().contains(&gone));
        assert!(!granted(MAIN_WINDOW).iter().any(|command| command == gone));
        for source in COMMAND_SOURCES {
            assert!(!source.contains(&format!("fn {gone}(")) && !source.contains(&format!("fn {gone}<")));
        }
    }
}

#[test]
fn secret_commands_are_granted_to_the_main_window_only() {
    let manifest = manifest_commands();
    let main = granted(MAIN_WINDOW);
    let tray = granted(TRAY_WINDOW);
    let dapp = granted(DAPP_WINDOW);
    for command in main.iter().chain(&tray).chain(&dapp) {
        assert!(manifest.contains(&command.as_str()), "{command} is not a command");
    }
    assert_eq!(dapp, ["dapp_bridge_request"]);
    for command in &tray {
        let key_use = ["wallet_", "pvac_", "stealth_", "touch_id_", "workspace_"];
        assert!(!key_use.iter().any(|prefix| command.starts_with(prefix)), "{command}");
    }
    for command in EXPORT_GATED.iter().chain(PASSWORD_AFTER_TOUCH_ID).chain(&["stealth_match_outputs"]) {
        assert!(main.iter().any(|granted| granted == command), "{command}");
    }
}

#[test]
fn the_detector_finds_each_kind_of_secret() {
    let seed = [0xA7u8; 32];
    let words: Vec<String> = "legal winner thank year wave sausage".split(' ').map(str::to_string).collect();
    let mut secrets = Secrets::new();
    secrets.key(&seed);
    secrets.phrase(&words);
    secrets.password("a vault password");
    let master = pvac_rs::crypto::keygen::master_seed(&seed);
    let view = crate::pvac::stealth::view_secret(&seed);
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{:02X}", b)).collect::<String>();
    assert_eq!(secrets.found_in(&STANDARD.encode(seed)), Some("the key"));
    assert_eq!(secrets.found_in(&hex(&seed)), Some("the key"));
    assert_eq!(secrets.found_in(&seed), Some("the key"));
    assert_eq!(secrets.found_in(&seed.to_vec()), Some("the key"));
    assert_eq!(secrets.found_in(&hex(&master)), Some("the PVAC master seed"));
    assert_eq!(secrets.found_in(&STANDARD.encode(master)), Some("the PVAC master seed"));
    assert_eq!(secrets.found_in(&master), Some("the PVAC master seed"));
    assert_eq!(secrets.found_in(&hex(&view)), Some("the view secret key"));
    assert_eq!(secrets.found_in(&URL_SAFE_NO_PAD.encode(view)), Some("the view secret key"));
    assert_eq!(secrets.found_in(&view), Some("the view secret key"));
    assert_eq!(secrets.found_in(&words.join(" ")), Some("the phrase"));
    assert_eq!(secrets.found_in(&words), Some("the phrase"));
    assert_eq!(secrets.found_in(&words[2..4]), Some("a run of phrase words"));
    assert_eq!(secrets.found_in(&"wave sausage"), Some("a run of phrase words"));
    assert_eq!(secrets.found_in(&"wrong: a vault password"), Some("the password"));
    assert_eq!(secrets.found_in(&serde_json::json!({ "address": "oct", "words": ["legal", "year"] })), None);
    assert_eq!(secrets.found_in(&[0xA7u8; 31]), None);
}
