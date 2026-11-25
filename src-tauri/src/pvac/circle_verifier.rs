//! Circle fhe verifier, ported from webcli main.cpp (circle_verify_zero, circle_verify_proof) and
//! lib/circle_verifier_policy.hpp. A circle page hands these blobs to the wallet, so every limit
//! is enforced here even though the front end checks them first.

use std::sync::atomic::{AtomicBool, Ordering};

use curve25519_dalek::ristretto::CompressedRistretto;
use pvac_rs::core::types::{is_valid_cipher_shape, Cipher, PubKey, RRule};
use pvac_rs::crypto::circuit_prf::secret_profile_matches;
use pvac_rs::ops::verify_zero_circuit::{verify_amount, verify_zero_with_policy, ProofKind};
use pvac_rs::proofs::bulletproofs::ProofPolicy;
use pvac_rs::serialize::format::{deserialize_cipher, deserialize_pubkey, deserialize_zero_proof_raw};

pub const MAX_CIPHERTEXT_ENCODED_BYTES: usize = 96 * 1024;
pub const MAX_PROOF_ENCODED_BYTES: usize = 64 * 1024;
pub const MAX_COMMITMENT_ENCODED_BYTES: usize = 64;
pub const MAX_BASE_LAYERS: usize = 2;
pub const MAX_LAYERS: usize = 8;
pub const MAX_EDGES: usize = 512;

const ZKZP_PREFIX: &str = "zkzp_v2|";
pub const BUSY: &str = "circle verifier busy";

pub fn ciphertext_size_allowed(ciphertext: &str) -> bool {
    !ciphertext.is_empty() && ciphertext.len() <= MAX_CIPHERTEXT_ENCODED_BYTES
}

pub fn proof_size_allowed(proof: &str) -> bool {
    !proof.is_empty() && proof.len() <= MAX_PROOF_ENCODED_BYTES
}

pub fn commitment_size_allowed(commitment: &str) -> bool {
    !commitment.is_empty() && commitment.len() <= MAX_COMMITMENT_ENCODED_BYTES
}

pub fn encoded_size_allowed(ciphertext: &str, proof: &str) -> bool {
    ciphertext_size_allowed(ciphertext) && proof_size_allowed(proof)
}

/// webcli pvac_cipher_inspect_public plus pvac_cipher_base_layer_count, as the policy reads them.
pub fn cipher_shape_allowed(ct: &Cipher) -> bool {
    if !is_valid_cipher_shape(ct) {
        return false;
    }
    if ct.slots > 65536 || ct.c0.len() > 65536 || ct.l.len() > 4096 || ct.e.len() > 1_200_000 {
        return false;
    }
    let base_layers = ct.l.iter().filter(|layer| layer.rule == RRule::Base).count();
    ct.slots == 1
        && ct.c0.len() == 1
        && !ct.l.is_empty()
        && ct.l.len() <= MAX_LAYERS
        && ct.e.len() <= MAX_EDGES
        && base_layers > 0
        && base_layers <= MAX_BASE_LAYERS
}

/// webcli crypto_utils.hpp base64_decode, byte for byte: no padding or alphabet checks, a
/// trailing partial quad is dropped. The verifier must read exactly what webcli reads.
pub fn webcli_base64_decode(s: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut digits = [-1i32; 256];
    for (i, c) in TABLE.iter().enumerate() {
        digits[*c as usize] = i as i32;
    }
    digits[b'=' as usize] = 0;
    let s = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut i = 0;
    while i + 3 < s.len() {
        let d = |k: usize| digits[s[i + k] as usize];
        let n = (d(0).wrapping_shl(18) | d(1).wrapping_shl(12) | d(2).wrapping_shl(6) | d(3)) as u32;
        out.push((n >> 16) as u8);
        if s[i + 2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if s[i + 3] != b'=' {
            out.push(n as u8);
        }
        i += 4;
    }
    out
}

/// webcli circle_verifier_policy::Lane: one verification at a time, a second is refused.
pub struct Lane {
    busy: AtomicBool,
}

pub struct Lease<'a> {
    busy: &'a AtomicBool,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

impl Lane {
    pub const fn new() -> Self {
        Self { busy: AtomicBool::new(false) }
    }

    pub fn try_acquire(&self) -> Option<Lease<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .ok()
            .map(|_| Lease { busy: &self.busy })
    }
}

pub static LANE: Lane = Lane::new();

/// webcli PvacBridge::init_registered: the registered key is used only when our secret derived it.
pub fn registered_key(own_pk: &PubKey, sk: &pvac_rs::core::types::SecKey, pubkey_b64: &str) -> Option<PubKey> {
    let raw = webcli_base64_decode(pubkey_b64);
    let remote = deserialize_pubkey(&raw).ok()?;
    secret_profile_matches(&remote, own_pk, sk).then_some(remote)
}

pub fn proof_policy(bits: u8) -> Result<ProofPolicy, String> {
    ProofPolicy::from_bits(bits as i64).ok_or_else(|| "invalid proof policy".to_string())
}

fn verifier_cipher(ciphertext_b64: &str) -> Result<Cipher, String> {
    if !ciphertext_size_allowed(ciphertext_b64) {
        return Err("circle ciphertext exceeds resource policy".into());
    }
    let raw = webcli_base64_decode(ciphertext_b64);
    if raw.is_empty() {
        return Err("invalid ciphertext".into());
    }
    let ct = deserialize_cipher(&raw).map_err(|_| "invalid ciphertext".to_string())?;
    if !cipher_shape_allowed(&ct) {
        return Err("circle verifier ciphertext exceeds resource policy".into());
    }
    Ok(ct)
}

fn decode_zero_proof(encoded: &str) -> Result<pvac_rs::proofs::bound_proof::ZeroProof, String> {
    let body = encoded.strip_prefix(ZKZP_PREFIX).ok_or("invalid zero proof prefix")?;
    let raw = webcli_base64_decode(body);
    if raw.is_empty() {
        return Err("invalid zero proof encoding".into());
    }
    deserialize_zero_proof_raw(&raw).map_err(|_| "invalid zero proof".to_string())
}

/// webcli circle_verify_zero.
pub fn verify_zero(pk: &PubKey, ciphertext_b64: &str, zero_proof_b64: &str, policy: ProofPolicy) -> Result<(), String> {
    if !encoded_size_allowed(ciphertext_b64, zero_proof_b64) {
        return Err("circle verifier input exceeds resource policy".into());
    }
    let ct = verifier_cipher(ciphertext_b64)?;
    let proof = decode_zero_proof(zero_proof_b64)?;
    if verify_zero_with_policy(pk, &ct, &proof, policy) {
        Ok(())
    } else {
        Err("zero proof verification failed".into())
    }
}

/// webcli circle_verify_proof: the bound zero proof against a 32-byte amount commitment.
pub fn verify_bound(
    pk: &PubKey,
    ciphertext_b64: &str,
    zero_proof_b64: &str,
    amount_commitment_b64: &str,
    policy: ProofPolicy,
) -> Result<(), String> {
    if !encoded_size_allowed(ciphertext_b64, zero_proof_b64) {
        return Err("circle verifier input exceeds resource policy".into());
    }
    if !commitment_size_allowed(amount_commitment_b64) {
        return Err("invalid amount commitment".into());
    }
    let commitment: [u8; 32] = webcli_base64_decode(amount_commitment_b64)
        .try_into()
        .map_err(|_| "invalid amount commitment".to_string())?;
    let ct = verifier_cipher(ciphertext_b64)?;
    let proof = decode_zero_proof(zero_proof_b64)?;
    let point = CompressedRistretto(commitment);
    if verify_amount(pk, &ct, &proof, &point, ProofKind::Amount, policy) {
        Ok(())
    } else {
        Err("cipher proof verification failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use curve25519_dalek::scalar::Scalar;
    use pvac_rs::core::types::{Edge, Layer};
    use pvac_rs::ops::encrypt::{enc_value, enc_zero};
    use pvac_rs::ops::verify_zero_circuit::{make_zero_proof_with_policy, prove_amount};
    use pvac_rs::proofs::ristretto_map::bp_pedersen_commit;
    use pvac_rs::serialize::format::{serialize_cipher, serialize_pubkey, serialize_zero_proof_raw};

    const POLICY: u8 = 3;

    fn context() -> pvac_handler::Context {
        pvac_handler::Context::from_seed(&[0x5Au8; 32]).0
    }

    fn zero_case(ctx: &pvac_handler::Context) -> (String, String) {
        let ct = enc_zero(&ctx.pk, &ctx.sk);
        let proof = make_zero_proof_with_policy(&ctx.pk, &ctx.sk, &ct, proof_policy(POLICY).unwrap());
        (
            B64.encode(serialize_cipher(&ct)),
            format!("{ZKZP_PREFIX}{}", B64.encode(serialize_zero_proof_raw(&proof))),
        )
    }

    #[test]
    fn decodes_like_webcli() {
        assert_eq!(webcli_base64_decode("aGVsbG8="), b"hello");
        assert_eq!(webcli_base64_decode("aGVsbG8"), b"hel");
        assert_eq!(webcli_base64_decode(""), b"");
        assert_eq!(webcli_base64_decode("abc"), b"");
        assert_eq!(webcli_base64_decode("====").len(), 1);
        assert_eq!(webcli_base64_decode("!!!!"), vec![0xff, 0xff, 0xff]);
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(webcli_base64_decode(&B64.encode(&bytes)), bytes);

        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/test/fixtures/circle-verifier-vectors.json")).unwrap();
        for v in vectors["base64"].as_array().unwrap() {
            let hex: String = webcli_base64_decode(v["in"].as_str().unwrap()).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, v["hex"].as_str().unwrap(), "{}", v["in"]);
        }
    }

    #[test]
    fn size_caps_match_the_policy() {
        assert!(ciphertext_size_allowed(&"A".repeat(96 * 1024)));
        assert!(!ciphertext_size_allowed(&"A".repeat(96 * 1024 + 1)));
        assert!(!ciphertext_size_allowed(""));
        assert!(proof_size_allowed(&"A".repeat(64 * 1024)));
        assert!(!proof_size_allowed(&"A".repeat(64 * 1024 + 1)));
        assert!(commitment_size_allowed(&"A".repeat(64)));
        assert!(!commitment_size_allowed(&"A".repeat(65)));
        assert!(!encoded_size_allowed("A", ""));

        let ctx = context();
        let pk = &ctx.pk;
        let policy = proof_policy(POLICY).unwrap();
        let big = "A".repeat(96 * 1024 + 4);
        assert_eq!(
            verify_zero(pk, &big, "zkzp_v2|AAAA", policy).unwrap_err(),
            "circle verifier input exceeds resource policy"
        );
        assert_eq!(
            verify_bound(pk, "AAAA", "zkzp_v2|AAAA", &"A".repeat(68), policy).unwrap_err(),
            "invalid amount commitment"
        );
        assert_eq!(verify_bound(pk, "AAAA", "zkzp_v2|AAAA", "AAAA", policy).unwrap_err(), "invalid amount commitment");
        assert_eq!(verify_zero(pk, "!", "zkzp_v2|AAAA", policy).unwrap_err(), "invalid ciphertext");
        assert_eq!(verify_zero(pk, "AAAA", "zkzp_v2|AAAA", policy).unwrap_err(), "invalid ciphertext");
    }

    #[test]
    fn shape_refuses_what_webcli_refuses() {
        let ctx = context();
        let ct = enc_value(&ctx.pk, &ctx.sk, 7);
        assert!(cipher_shape_allowed(&ct), "a fresh cipher is in policy");

        let mut wide = ct.clone();
        wide.slots = 2;
        assert!(!cipher_shape_allowed(&wide));

        let mut deep = ct.clone();
        let first = deep.l[0].clone();
        while deep.l.len() <= MAX_LAYERS {
            deep.l.push(first.clone());
        }
        assert!(!cipher_shape_allowed(&deep));

        let mut bases = ct.clone();
        bases.l.push(first.clone());
        bases.l.push(first.clone());
        assert!(!cipher_shape_allowed(&bases));

        let mut edges = ct.clone();
        let edge: Edge = edges.e[0].clone();
        while edges.e.len() <= MAX_EDGES {
            edges.e.push(edge.clone());
        }
        assert!(!cipher_shape_allowed(&edges));

        let mut empty = ct.clone();
        empty.l = Vec::<Layer>::new();
        empty.e.clear();
        assert!(!cipher_shape_allowed(&empty));

        let policy = proof_policy(POLICY).unwrap();
        let (_, proof) = zero_case(&ctx);
        assert_eq!(
            verify_zero(&ctx.pk, &B64.encode(serialize_cipher(&deep)), &proof, policy).unwrap_err(),
            "circle verifier ciphertext exceeds resource policy"
        );
    }

    #[test]
    fn verifies_a_zero_proof_and_refuses_a_bad_one() {
        let ctx = context();
        let policy = proof_policy(POLICY).unwrap();
        let (cipher, proof) = zero_case(&ctx);
        assert_eq!(verify_zero(&ctx.pk, &cipher, &proof, policy), Ok(()));
        assert_eq!(
            verify_zero(&ctx.pk, &cipher, &proof, proof_policy(1).unwrap()).unwrap_err(),
            "zero proof verification failed"
        );
        let other = B64.encode(serialize_cipher(&enc_value(&ctx.pk, &ctx.sk, 1)));
        assert_eq!(verify_zero(&ctx.pk, &other, &proof, policy).unwrap_err(), "zero proof verification failed");
        assert_eq!(
            verify_zero(&ctx.pk, &cipher, proof.trim_start_matches(ZKZP_PREFIX), policy).unwrap_err(),
            "invalid zero proof prefix"
        );
        assert_eq!(verify_zero(&ctx.pk, &cipher, "zkzp_v2|ab", policy).unwrap_err(), "invalid zero proof encoding");
        assert_eq!(verify_zero(&ctx.pk, &cipher, "zkzp_v2|AAAA", policy).unwrap_err(), "invalid zero proof");
    }

    #[test]
    fn verifies_a_bound_proof_against_its_commitment() {
        let ctx = context();
        let policy = proof_policy(POLICY).unwrap();
        let amount = 4_200u64;
        let ct = enc_value(&ctx.pk, &ctx.sk, amount);
        let blinding = Scalar::from_bytes_mod_order([3u8; 32]);
        let proof = prove_amount(&ctx.pk, &ctx.sk, &ct, amount, &blinding, ProofKind::Amount, policy);
        let commitment = B64.encode(bp_pedersen_commit(&Scalar::from(amount), &blinding).compress().as_bytes());
        let cipher = B64.encode(serialize_cipher(&ct));
        let proof = format!("{ZKZP_PREFIX}{}", B64.encode(serialize_zero_proof_raw(&proof)));
        assert_eq!(verify_bound(&ctx.pk, &cipher, &proof, &commitment, policy), Ok(()));
        let wrong = B64.encode(bp_pedersen_commit(&Scalar::from(amount + 1), &blinding).compress().as_bytes());
        assert_eq!(
            verify_bound(&ctx.pk, &cipher, &proof, &wrong, policy).unwrap_err(),
            "cipher proof verification failed"
        );
    }

    #[test]
    fn uses_only_a_registered_key_our_secret_made() {
        let ctx = context();
        let ours = B64.encode(serialize_pubkey(&ctx.pk));
        assert!(registered_key(&ctx.pk, &ctx.sk, &ours).is_some());
        let other = pvac_handler::Context::from_seed(&[0x11u8; 32]).0;
        assert!(registered_key(&ctx.pk, &ctx.sk, &B64.encode(serialize_pubkey(&other.pk))).is_none());
        assert!(registered_key(&ctx.pk, &ctx.sk, "AAAA").is_none());
        assert_eq!(proof_policy(4).unwrap_err(), "invalid proof policy");
    }

    #[test]
    fn the_lane_refuses_a_second_verification() {
        let lane = Lane::new();
        let first = lane.try_acquire().expect("free lane");
        assert!(lane.try_acquire().is_none());
        drop(first);
        assert!(lane.try_acquire().is_some());
    }
}
