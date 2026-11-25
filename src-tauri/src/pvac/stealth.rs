use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use curve25519_dalek::montgomery::MontgomeryPoint;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use tauri::{AppHandle, Runtime, Webview};
use zeroize::Zeroize;

use crate::guard::ipc_guard::require_main;
use crate::tlog;
use crate::wallet::wallet_commands::session_wallet_seed;

pub(crate) const MAX_OUTPUTS: usize = 512;
const TOO_MANY_OUTPUTS: &str = "Too many outputs in one call";

const STEALTH_TAG_DOMAIN: &[u8] = b"OCTRA_STEALTH_TAG_V1";
const CLAIM_SECRET_DOMAIN: &[u8] = b"OCTRA_CLAIM_SECRET_V1";

const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanOutput {
    id: u64,
    eph_pub: String,
    stealth_tag: String,
    enc_amount: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct StealthMatch {
    id: u64,
    amount: String,
    claim_secret: String,
    blinding: String,
}

// Decodes exactly what the webview's atob accepts: the scan has always read outputs with it.
fn atob(text: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = text
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    FORGIVING.decode(&data).ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub(crate) fn view_secret(seed: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha512::digest(seed);
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&hash[..32]);
    hash.as_mut_slice().zeroize();
    secret[0] &= 248;
    secret[31] &= 127;
    secret[31] |= 64;
    secret
}

fn shared_secret(view: &[u8; 32], eph_pub: [u8; 32]) -> Option<[u8; 32]> {
    let mut raw = MontgomeryPoint(eph_pub).mul_clamped(*view);
    let low_order = raw.as_bytes().iter().fold(0u8, |any, b| any | b) == 0;
    let shared = (!low_order).then(|| Sha256::digest(raw.as_bytes()).into());
    raw.zeroize();
    shared
}

fn tagged(shared: &[u8; 32], domain: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(shared);
    hasher.update(domain);
    hasher.finalize().into()
}

fn open_amount(shared: &[u8; 32], enc_amount: &str) -> Option<(u64, [u8; 32])> {
    let raw = atob(enc_amount)?;
    if raw.len() != 68 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(shared).ok()?;
    let mut plain = cipher.decrypt(Nonce::from_slice(&raw[..12]), &raw[12..]).ok()?;
    let opened = match (plain.get(..8), plain.get(8..40)) {
        (Some(amount), Some(blinding)) if plain.len() == 40 => {
            let amount: [u8; 8] = amount.try_into().ok()?;
            let blinding: [u8; 32] = blinding.try_into().ok()?;
            Some((u64::from_le_bytes(amount), blinding))
        }
        _ => None,
    };
    plain.zeroize();
    opened
}

fn match_output(view: &[u8; 32], output: &ScanOutput) -> Option<StealthMatch> {
    let eph_pub: [u8; 32] = atob(&output.eph_pub)?.try_into().ok()?;
    let mut shared = shared_secret(view, eph_pub)?;
    let found = if hex(&tagged(&shared, STEALTH_TAG_DOMAIN)[..16]) == output.stealth_tag {
        open_amount(&shared, &output.enc_amount)
            .filter(|(amount, _)| *amount > 0)
            .map(|(amount, mut blinding)| {
                let mut claim_secret = tagged(&shared, CLAIM_SECRET_DOMAIN);
                let found = StealthMatch {
                    id: output.id,
                    amount: amount.to_string(),
                    claim_secret: hex(&claim_secret),
                    blinding: STANDARD.encode(blinding),
                };
                claim_secret.zeroize();
                blinding.zeroize();
                found
            })
    } else {
        None
    };
    shared.zeroize();
    found
}

fn match_outputs(seed: &[u8; 32], outputs: &[ScanOutput]) -> Vec<StealthMatch> {
    let mut view = view_secret(seed);
    let found = outputs.iter().filter_map(|output| match_output(&view, output)).collect();
    view.zeroize();
    found
}

pub(crate) fn match_for_wallet(
    seed: impl FnOnce() -> Result<[u8; 32], String>,
    outputs: &[ScanOutput],
) -> Result<Vec<StealthMatch>, String> {
    if outputs.len() > MAX_OUTPUTS {
        return Err(TOO_MANY_OUTPUTS.to_string());
    }
    let mut seed = seed()?;
    let found = match_outputs(&seed, outputs);
    seed.zeroize();
    Ok(found)
}

#[tauri::command]
pub async fn stealth_match_outputs<R: Runtime>(
    webview: Webview<R>,
    wallet_id: String,
    expect_address: String,
    outputs: Vec<ScanOutput>,
    app: AppHandle<R>,
) -> Result<Vec<StealthMatch>, String> {
    require_main(&webview)?;
    tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let found = match_for_wallet(
            || session_wallet_seed(&app, &wallet_id, &expect_address),
            &outputs,
        )?;
        tlog!(
            "[stealth] {} of {} output(s) matched in {}ms",
            found.len(),
            outputs.len(),
            t0.elapsed().as_millis()
        );
        Ok(found)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/test/fixtures/stealth-scan-vectors.json"
    ));
    const CLAIM_BIND_DOMAIN: &[u8] = b"OCTRA_CLAIM_BIND_V1";
    const SAFE_INTEGER_END: u64 = 1 << 53;

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len() / 2)
            .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn wallets() -> Vec<Value> {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        doc["wallets"].as_array().unwrap().clone()
    }

    fn seed_of(wallet: &Value) -> [u8; 32] {
        unhex(wallet["seed_hex"].as_str().unwrap()).try_into().unwrap()
    }

    fn scan_output(vector: &Value) -> ScanOutput {
        serde_json::from_value(json!({
            "id": vector["id"],
            "eph_pub": vector["eph_pub"],
            "stealth_tag": vector["stealth_tag"],
            "enc_amount": vector["enc_amount"],
        }))
        .unwrap()
    }

    fn expected(vector: &Value) -> Option<StealthMatch> {
        let expect = &vector["expect"];
        (!expect.is_null()).then(|| StealthMatch {
            id: vector["id"].as_u64().unwrap(),
            amount: expect["amount"].as_str().unwrap().to_string(),
            claim_secret: expect["claim_secret"].as_str().unwrap().to_string(),
            blinding: expect["blinding"].as_str().unwrap().to_string(),
        })
    }

    pub(crate) fn sample_scan() -> ([u8; 32], Vec<ScanOutput>) {
        let wallet = &wallets()[0];
        let outputs = wallet["outputs"].as_array().unwrap().iter().map(scan_output).collect();
        (seed_of(wallet), outputs)
    }

    #[test]
    fn the_vectors_cover_every_special_case() {
        let all = wallets();
        assert_eq!(all.len(), 5);
        let outputs: Vec<&Value> =
            all.iter().flat_map(|w| w["outputs"].as_array().unwrap()).collect();
        assert_eq!(outputs.len(), 50);
        assert_eq!(outputs.iter().filter(|o| !o["expect"].is_null()).count(), 21);
        let cases: Vec<&str> = outputs.iter().map(|o| o["case"].as_str().unwrap()).collect();
        for case in [
            "tag of another wallet",
            "wrong authentication tag",
            "ephemeral key with the high bit set",
            "low-order ephemeral point (zero)",
            "match at 2^64 - 1",
            "zero amount",
        ] {
            assert!(cases.contains(&case), "{case}");
        }
    }

    #[test]
    fn the_view_key_is_the_one_the_vectors_name() {
        for wallet in wallets() {
            let view = view_secret(&seed_of(&wallet));
            let view_pub = MontgomeryPoint::mul_base_clamped(view).to_bytes();
            assert_eq!(STANDARD.encode(view_pub), wallet["view_pub"].as_str().unwrap());
        }
    }

    #[test]
    fn every_vector_matches_one_at_a_time() {
        for wallet in wallets() {
            let seed = seed_of(&wallet);
            for vector in wallet["outputs"].as_array().unwrap() {
                let found = match_outputs(&seed, &[scan_output(vector)]);
                let want: Vec<StealthMatch> = expected(vector).into_iter().collect();
                assert_eq!(found, want, "{}", vector["case"]);
            }
        }
    }

    #[test]
    fn a_whole_list_gives_the_matches_in_order() {
        for wallet in wallets() {
            let vectors = wallet["outputs"].as_array().unwrap();
            let outputs: Vec<ScanOutput> = vectors.iter().map(scan_output).collect();
            let want: Vec<StealthMatch> = vectors.iter().filter_map(expected).collect();
            assert!(want.len() >= 2);
            assert_eq!(match_for_wallet(|| Ok(seed_of(&wallet)), &outputs), Ok(want));
        }
    }

    #[test]
    fn another_wallet_matches_only_its_own_output() {
        let all = wallets();
        let other = seed_of(&all[1]);
        for vector in all[0]["outputs"].as_array().unwrap() {
            let case = vector["case"].as_str().unwrap();
            let found = match_outputs(&other, &[scan_output(vector)]);
            assert_eq!(found.len(), usize::from(case == "tag of another wallet"), "{case}");
        }
    }

    #[test]
    fn a_low_order_ephemeral_point_matches_no_wallet() {
        let all = wallets();
        let zero_tag = hex(&tagged(&Sha256::digest([0u8; 32]).into(), STEALTH_TAG_DOMAIN)[..16]);
        let mut low_order = 0;
        for vector in all.iter().flat_map(|w| w["outputs"].as_array().unwrap()) {
            let case = vector["case"].as_str().unwrap();
            if !case.starts_with("low-order ephemeral point (") && !case.ends_with("low-order ephemeral point") {
                continue;
            }
            let output = scan_output(vector);
            assert_eq!(output.stealth_tag, zero_tag, "{case}");
            let eph_pub: [u8; 32] = atob(&output.eph_pub).unwrap().try_into().unwrap();
            for wallet in &all {
                let seed = seed_of(wallet);
                assert_eq!(shared_secret(&view_secret(&seed), eph_pub), None, "{case}");
                assert_eq!(match_outputs(&seed, &[scan_output(vector)]), vec![], "{case}");
            }
            low_order += 1;
        }
        assert_eq!(low_order, 9);
    }

    #[test]
    fn the_claim_secret_binds_the_address_as_the_vectors_say() {
        for wallet in wallets() {
            let address = wallet["address"].as_str().unwrap();
            for vector in wallet["outputs"].as_array().unwrap() {
                let Some(found) = match_outputs(&seed_of(&wallet), &[scan_output(vector)]).pop()
                else {
                    continue;
                };
                let mut hasher = Sha256::new();
                hasher.update(unhex(&found.claim_secret));
                hasher.update(address.as_bytes());
                hasher.update(CLAIM_BIND_DOMAIN);
                assert_eq!(hex(&hasher.finalize()), vector["expect"]["claim_pub"].as_str().unwrap());
            }
        }
    }

    #[test]
    fn amounts_below_two_to_the_53_are_the_numbers_the_scan_always_gave() {
        let mut below = 0;
        let mut above = 0;
        for wallet in wallets() {
            for vector in wallet["outputs"].as_array().unwrap() {
                let Some(want) = expected(vector) else { continue };
                let exact: u64 = want.amount.parse().unwrap();
                let legacy = vector["expect"]["legacy_amount"].as_f64().unwrap();
                if exact < SAFE_INTEGER_END {
                    assert_eq!(exact as f64, legacy);
                    assert_eq!(legacy as u64, exact);
                    below += 1;
                } else {
                    above += 1;
                }
            }
        }
        assert_eq!((below, above), (17, 4));
    }

    #[test]
    fn too_many_outputs_are_refused_before_the_key_is_read() {
        let (seed, mut outputs) = sample_scan();
        while outputs.len() <= MAX_OUTPUTS {
            outputs.extend(sample_scan().1);
        }
        outputs.truncate(MAX_OUTPUTS + 1);
        let refused = match_for_wallet(|| panic!("seed read"), &outputs);
        assert_eq!(refused, Err(TOO_MANY_OUTPUTS.to_string()));
        outputs.truncate(MAX_OUTPUTS);
        assert!(match_for_wallet(|| Ok(seed), &outputs).is_ok());
    }

    #[test]
    fn a_refused_wallet_matches_nothing() {
        let (_, outputs) = sample_scan();
        for reason in ["Wallet is locked", "Wallet not found", "Wallet does not match the expected address"] {
            assert_eq!(
                match_for_wallet(|| Err(reason.to_string()), &outputs),
                Err(reason.to_string())
            );
        }
        assert_eq!(match_for_wallet(|| Err("Wallet is locked".to_string()), &[]), Err("Wallet is locked".to_string()));
    }

    #[test]
    fn an_output_takes_the_four_fields_and_nothing_else() {
        let good = json!({ "id": 7, "eph_pub": "", "stealth_tag": "", "enc_amount": "" });
        assert!(serde_json::from_value::<ScanOutput>(good.clone()).is_ok());
        for (field, value) in [
            ("claimed", json!(0)),
            ("epoch_id", json!(1)),
            ("sender_addr", json!("oct")),
            ("amount_commitment", json!("")),
        ] {
            let mut whole = good.clone();
            whole[field] = value;
            assert!(serde_json::from_value::<ScanOutput>(whole).is_err(), "{field}");
        }
        for field in ["id", "eph_pub", "stealth_tag", "enc_amount"] {
            let mut missing = good.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ScanOutput>(missing).is_err(), "{field}");
        }
        for (field, value) in [
            ("id", json!(-1)),
            ("id", json!(1.5)),
            ("id", json!("7")),
            ("id", Value::Null),
            ("eph_pub", json!(7)),
            ("eph_pub", Value::Null),
            ("stealth_tag", json!(["a"])),
            ("enc_amount", json!({ "a": 1 })),
        ] {
            let mut wrong = good.clone();
            wrong[field] = value;
            assert!(serde_json::from_value::<ScanOutput>(wrong).is_err(), "{field}");
        }
    }

    #[test]
    fn malformed_text_is_no_match_and_never_a_failure() {
        let (seed, outputs) = sample_scan();
        let real = &outputs[0];
        let long = "A".repeat(1 << 20);
        for (eph_pub, stealth_tag, enc_amount) in [
            ("", "", ""),
            ("\u{0}", "\u{0}", "\u{0}"),
            ("é".repeat(44).as_str(), real.stealth_tag.as_str(), real.enc_amount.as_str()),
            (long.as_str(), long.as_str(), long.as_str()),
            (real.eph_pub.as_str(), real.stealth_tag.as_str(), ""),
            (real.eph_pub.as_str(), real.stealth_tag.as_str(), "===="),
            (real.eph_pub.as_str(), real.stealth_tag.as_str(), long.as_str()),
            (real.eph_pub.as_str(), "", real.enc_amount.as_str()),
            ("====", real.stealth_tag.as_str(), real.enc_amount.as_str()),
            ("A", real.stealth_tag.as_str(), real.enc_amount.as_str()),
        ] {
            let output = ScanOutput {
                id: 1,
                eph_pub: eph_pub.to_string(),
                stealth_tag: stealth_tag.to_string(),
                enc_amount: enc_amount.to_string(),
            };
            assert_eq!(match_for_wallet(|| Ok(seed), &[output]), Ok(vec![]));
        }
    }

    #[test]
    fn atob_reads_what_the_webview_reads() {
        assert_eq!(atob("TWFu"), Some(b"Man".to_vec()));
        assert_eq!(atob("TWE="), Some(b"Ma".to_vec()));
        assert_eq!(atob("TWE"), Some(b"Ma".to_vec()));
        assert_eq!(atob("TQ=="), Some(b"M".to_vec()));
        assert_eq!(atob("TQ"), Some(b"M".to_vec()));
        assert_eq!(atob("TR=="), Some(b"M".to_vec()));
        assert_eq!(atob(" T W\tF\nu\r\x0c"), Some(b"Man".to_vec()));
        assert_eq!(atob(""), Some(vec![]));
        assert_eq!(atob("    "), Some(vec![]));
        for refused in ["T", "TWFuT", "TQ=", "TWE==", "T=Fu", "TWFu=", "TWFu====", "====", "TW-_", "TWF\u{b}u", "TWFé"] {
            assert_eq!(atob(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn a_match_carries_its_four_fields_and_no_wallet_secret() {
        for wallet in wallets() {
            let mut seen = crate::guard::command_guard::Coverage::new();
            let seed = seed_of(&wallet);
            seen.secrets.key(&seed);
            let outputs: Vec<ScanOutput> =
                wallet["outputs"].as_array().unwrap().iter().map(scan_output).collect();
            let found = match_for_wallet(|| Ok(seed), &outputs);
            for one in serde_json::to_value(&found).unwrap()["Ok"].as_array().unwrap() {
                let mut keys: Vec<&String> = one.as_object().unwrap().keys().collect();
                keys.sort();
                assert_eq!(keys, ["amount", "blinding", "claim_secret", "id"]);
            }
            seen.see("stealth_match_outputs", &found);
            for refusal in ["Wallet is locked", "Wallet does not match the expected address"] {
                let refused = match_for_wallet(|| Err(refusal.to_string()), &outputs);
                seen.see("stealth_match_outputs", &refused);
            }
            seen.assert_clean("stealth_", &[]);
        }
    }
}
