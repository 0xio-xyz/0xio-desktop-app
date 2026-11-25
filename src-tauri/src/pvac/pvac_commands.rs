use std::sync::Arc;
use serde_json::{json, Value};
use tauri::{AppHandle, State, Webview};
use zeroize::Zeroize;

use crate::guard::ipc_guard::require_main;
use crate::pvac::circle_verifier;
use crate::state::{context_fingerprint, AppState};
use crate::tlog;
use crate::wallet::wallet_commands::session_wallet_seed;

type ArcState = Arc<AppState>;

const CONTEXT_CHANGED: &str = "PVAC context belongs to another wallet. Try again.";

fn into_result(result: Value) -> Result<Value, String> {
    if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
        Err(err.to_string())
    } else {
        Ok(result)
    }
}

fn with_ctx<F>(state: &ArcState, ctx_id: &str, f: F) -> Result<Value, String>
where
    F: FnOnce(&pvac_handler::Context) -> Value + Send,
{
    crate::wallet::wallet_commands::lock_if_idle()?;
    let guard = state.ctx.lock().unwrap_or_else(|e| e.into_inner());
    let hit = match (guard.ctx.as_ref(), guard.fp.as_deref()) {
        (Some(ctx), Some(fp)) if fp == ctx_id => Some(std::sync::Arc::clone(ctx)),
        _ => None,
    };
    let desktop_initialized = guard.ctx.is_some();
    drop(guard);
    if let Some(ctx) = hit {
        return into_result(crate::pvac::proof_pool::install(|| f(&ctx)));
    }

    // The extension bridge may hold the same key material (same fingerprint).
    let ws_guard = state.ws_ctx.lock().unwrap_or_else(|e| e.into_inner());
    match (ws_guard.ctx.as_ref(), ws_guard.fp.as_deref()) {
        (Some(ctx), Some(fp)) if fp == ctx_id => into_result(crate::pvac::proof_pool::install(|| f(ctx))),
        _ if desktop_initialized => Err(CONTEXT_CHANGED.into()),
        _ => Err("PVAC not initialized. Call pvac_init first.".into()),
    }
}

fn init_context(state: &AppState, seed: &mut [u8; 32]) -> Value {
    tlog!("[pvac] init starting...");
    let t0 = std::time::Instant::now();
    let mut master = pvac_rs::crypto::keygen::master_seed(seed);
    seed.zeroize();
    let fp = context_fingerprint(&master);
    let (ctx, init_ms) = pvac_handler::Context::from_master(&master);
    master.zeroize();

    let threads = rayon::current_num_threads();
    let mut guard = state.ctx.lock().unwrap_or_else(|e| e.into_inner());
    guard.set(fp.clone(), std::sync::Arc::new(ctx));

    tlog!("[pvac] init done in {}ms (Rust: {}ms, threads: {})", t0.elapsed().as_millis(), init_ms, threads);
    json!({
        "ready": true,
        "init_ms": init_ms,
        "threads": threads,
        "ctx": fp
    })
}

fn init_wallet_context(state: &AppState, seed: Result<[u8; 32], String>) -> Result<Value, String> {
    let mut seed = seed?;
    Ok(init_context(state, &mut seed))
}

#[tauri::command]
pub async fn pvac_init_wallet(
    webview: Webview,
    wallet_id: String,
    expect_address: String,
    app: AppHandle,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();

    tokio::task::spawn_blocking(move || {
        init_wallet_context(&state, session_wallet_seed(&app, &wallet_id, &expect_address))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn pvac_destroy(webview: Webview, state: State<'_, ArcState>) -> Result<(), String> {
    require_main(&webview)?;
    let mut guard = state.ctx.lock().unwrap_or_else(|e| e.into_inner());
    guard.clear();
    tlog!("[pvac] context destroyed");
    Ok(())
}

#[tauri::command]
pub async fn pvac_encrypt(
    webview: Webview,
    value: u64,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] encrypt(***redacted***)");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_encrypt(ctx, &json!({ "value": value }))
        });
        tlog!("[pvac] encrypt done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_decrypt(
    webview: Webview,
    cipher: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();
    let cipher_len = cipher.len();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] decrypt (cipher={}B)", cipher_len);
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_decrypt(ctx, &json!({ "cipher": cipher }))
        });
        tlog!("[pvac] decrypt done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_make_bound_range_proof(
    webview: Webview,
    cipher: String,
    value: u64,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();
    let cipher_len = cipher.len();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeBoundRangeProof(cipher={}B)", cipher_len);
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_bound_range_proof(
                ctx,
                &json!({ "cipher": cipher, "value": value, "policy": policy }),
            )
        });
        let elapsed = t0.elapsed().as_millis();
        match &r {
            Ok(v) => {
                let proof_len = v.get("proof").and_then(|p| p.as_str()).map(|s| s.len()).unwrap_or(0);
                tlog!("[pvac] makeBoundRangeProof done in {}ms (proof={}B)", elapsed, proof_len);
            }
            Err(e) => tlog!("[pvac] makeBoundRangeProof FAILED in {}ms: {}", elapsed, e),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_check_bound_provable(
    webview: Webview,
    cipher: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_check_bound_provable(ctx, &json!({ "cipher": cipher }))
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;
    result
}

#[tauri::command]
pub async fn pvac_diagnose_cipher(webview: Webview, cipher: String) -> Result<Value, String> {
    require_main(&webview)?;
    tokio::task::spawn_blocking(move || {
        pvac_handler::handle_diagnose_cipher(&json!({ "cipher": cipher }))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub async fn pvac_make_bound_key_switch_proof(
    webview: Webview,
    cipher: String,
    amount: u64,
    blinding: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeBoundKeySwitchProof(amount=***)");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_bound_key_switch_proof(
                ctx,
                &json!({ "cipher": cipher, "amount": amount, "blinding": blinding, "policy": policy }),
            )
        });
        tlog!("[pvac] makeBoundKeySwitchProof done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

// Migration `old_zero_proof`: the KeySwitchRefresh proof over the deep on-chain cipher, under the
// old registered pubkey so the proof binds to it (webcli make_zero_proof_bound_key_switch_with_pubkey).
#[tauri::command]
pub async fn pvac_make_bound_key_switch_proof_with_pubkey(
    webview: Webview,
    cipher: String,
    amount: u64,
    blinding: String,
    pubkey: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeBoundKeySwitchProofWithPubkey(amount=***)");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_bound_key_switch_proof_with_pubkey(
                ctx,
                &json!({
                    "cipher": cipher,
                    "amount": amount,
                    "blinding": blinding,
                    "pubkey": pubkey,
                    "policy": policy
                }),
            )
        });
        tlog!("[pvac] makeBoundKeySwitchProofWithPubkey done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_verify_bound_key_switch_proof_with_pubkey(
    webview: Webview,
    cipher: String,
    proof: String,
    commitment: String,
    pubkey: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_verify_bound_key_switch_proof_with_pubkey(
                ctx,
                &json!({
                    "cipher": cipher,
                    "proof": proof,
                    "commitment": commitment,
                    "pubkey": pubkey,
                    "policy": policy
                }),
            )
        });
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_verify_bound_proof(
    webview: Webview,
    cipher: String,
    proof: String,
    commitment: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_verify_bound_proof(
                ctx,
                &json!({ "cipher": cipher, "proof": proof, "commitment": commitment, "policy": policy }),
            )
        });
        tlog!("[pvac] verifyBoundProof done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

fn circle_verify(
    state: &ArcState,
    ctx_id: &str,
    pubkey: &str,
    policy: u8,
    verify: impl FnOnce(&pvac_rs::core::types::PubKey, pvac_rs::proofs::bulletproofs::ProofPolicy) -> Result<(), String> + Send,
) -> Result<Value, String> {
    let _lease = circle_verifier::LANE.try_acquire().ok_or(circle_verifier::BUSY)?;
    with_ctx(state, ctx_id, |ctx| {
        let checked = circle_verifier::proof_policy(policy).and_then(|policy| {
            let pk = circle_verifier::registered_key(&ctx.pk, &ctx.sk, pubkey)
                .ok_or("registered pvac key profile is unavailable")?;
            verify(&pk, policy)
        });
        match checked {
            Ok(()) => json!({ "ok": true }),
            Err(error) => json!({ "error": error }),
        }
    })
}

#[tauri::command]
pub async fn pvac_circle_verify_zero(
    webview: Webview,
    ciphertext: String,
    zero_proof: String,
    pubkey: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let r = circle_verify(&state, &ctx_id, &pubkey, policy, |pk, policy| {
            circle_verifier::verify_zero(pk, &ciphertext, &zero_proof, policy)
        });
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pvac_circle_verify_bound(
    webview: Webview,
    ciphertext: String,
    zero_proof: String,
    amount_commitment: String,
    pubkey: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let r = circle_verify(&state, &ctx_id, &pubkey, policy, |pk, policy| {
            circle_verifier::verify_bound(pk, &ciphertext, &zero_proof, &amount_commitment, policy)
        });
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_make_range_proof(
    webview: Webview,
    cipher: String,
    value: u64,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();
    let cipher_len = cipher.len();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeRangeProof(cipher={}B)", cipher_len);
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_range_proof(ctx, &json!({ "cipher": cipher, "value": value }))
        });
        let elapsed = t0.elapsed().as_millis();
        match &r {
            Ok(v) => {
                let proof_len = v.get("proof").and_then(|p| p.as_str()).map(|s| s.len()).unwrap_or(0);
                tlog!("[pvac] makeRangeProof done in {}ms (proof={}B)", elapsed, proof_len);
            }
            Err(e) => tlog!("[pvac] makeRangeProof FAILED in {}ms: {}", elapsed, e),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_make_parallel_range_proofs(
    webview: Webview,
    cipher1: String,
    value1: u64,
    cipher2: String,
    value2: u64,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();
    let c1_len = cipher1.len();
    let c2_len = cipher2.len();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeParallelRangeProofs(c1={}B, c2={}B)", c1_len, c2_len);
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_parallel_range_proofs(
                ctx,
                &json!({
                    "cipher1": cipher1,
                    "value1": value1,
                    "cipher2": cipher2,
                    "value2": value2
                }),
            )
        });
        let elapsed = t0.elapsed().as_millis();
        match &r {
            Ok(v) => {
                let p1_len = v.get("proof1").and_then(|p| p.as_str()).map(|s| s.len()).unwrap_or(0);
                let p2_len = v.get("proof2").and_then(|p| p.as_str()).map(|s| s.len()).unwrap_or(0);
                tlog!("[pvac] makeParallelRangeProofs done in {}ms (p1={}B, p2={}B)", elapsed, p1_len, p2_len);
            }
            Err(e) => tlog!("[pvac] makeParallelRangeProofs FAILED in {}ms: {}", elapsed, e),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_make_bound_proof(
    webview: Webview,
    cipher: String,
    amount: u64,
    blinding: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] makeBoundProof(***)");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_bound_proof(
                ctx,
                &json!({ "cipher": cipher, "amount": amount, "blinding": blinding, "policy": policy }),
            )
        });
        tlog!("[pvac] makeBoundProof done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

fn policy_bits(policy: u8) -> Result<u8, String> {
    if policy > 3 {
        return Err("policy must be an integer 0..3".into());
    }
    Ok(policy)
}

fn key_owner_msg(address: &str, policy: u8) -> Result<Value, String> {
    if address.is_empty() {
        return Err("address must be a non-empty string".into());
    }
    Ok(json!({ "address": address, "policy": policy_bits(policy)? }))
}

fn cipher_proof_migration_msg(
    pubkey: &str,
    source: &str,
    amount: u64,
    policy: u8,
) -> Result<Value, String> {
    if pubkey.is_empty() {
        return Err("pubkey must be a base64 string".into());
    }
    // The source hash the node checks is over the encoded on-chain string, prefix included.
    if !source.starts_with("hfhe_v1|") {
        return Err("source must be the hfhe_v1| cipher string".into());
    }
    Ok(json!({
        "pubkey": pubkey,
        "source": source,
        "amount": amount,
        "policy": policy_bits(policy)?
    }))
}

/// key_switch `owner_cipher` + `owner_proof` for a network whose policy binds proofs to the key.
#[tauri::command]
pub async fn pvac_make_key_owner_proof(
    webview: Webview,
    address: String,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let msg = key_owner_msg(&address, policy)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_make_key_owner_proof(ctx, &msg)
        });
        tlog!("[pvac] makeKeyOwnerProof done in {}ms", t0.elapsed().as_millis());
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

/// The `cipher_proof` key_switch migration fields for a balance under the historical key.
#[tauri::command]
pub async fn pvac_build_cipher_proof_migration(
    webview: Webview,
    pubkey: String,
    source: String,
    amount: u64,
    policy: u8,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let msg = cipher_proof_migration_msg(&pubkey, &source, amount, policy)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] buildCipherProofMigration(amount=***)");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_build_cipher_proof_migration(ctx, &msg)
        });
        match &r {
            Ok(_) => tlog!("[pvac] buildCipherProofMigration done in {}ms", t0.elapsed().as_millis()),
            Err(e) => tlog!(
                "[pvac] buildCipherProofMigration FAILED in {}ms: {}",
                t0.elapsed().as_millis(),
                e
            ),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_pedersen_commit(
    webview: Webview,
    amount: u64,
    blinding: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] pedersenCommit(***)");
        with_ctx(&state, &ctx_id, |_| {
            pvac_handler::handle_pedersen_commit(&json!({ "amount": amount, "blinding": blinding }))
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_serialize_pubkey(
    webview: Webview,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] serializePubkey starting...");
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_serialize_pubkey(ctx)
        });
        let elapsed = t0.elapsed().as_millis();
        match &r {
            Ok(v) => {
                let len = v.get("pubkey").and_then(|p| p.as_str()).map(|s| s.len()).unwrap_or(0);
                tlog!("[pvac] serializePubkey done in {}ms (len={})", elapsed, len);
            }
            Err(e) => tlog!("[pvac] serializePubkey FAILED in {}ms: {}", elapsed, e),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_matches_secret_profile(
    webview: Webview,
    pubkey: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    state.begin_compute();

    let result = tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let msg = serde_json::json!({ "pubkey": pubkey });
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_matches_secret_profile(ctx, &msg)
        });
        let elapsed = t0.elapsed().as_millis();
        match &r {
            Ok(v) => tlog!("[pvac] matchesSecretProfile done in {}ms: {}", elapsed, v),
            Err(e) => tlog!("[pvac] matchesSecretProfile FAILED in {}ms: {}", elapsed, e),
        }
        state.end_compute();
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_ct_sub(
    webview: Webview,
    a: String,
    b: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    let a_len = a.len();
    let b_len = b.len();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] ctSub(a={}B, b={}B)", a_len, b_len);
        let t0 = std::time::Instant::now();
        let r = with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_ct_sub(ctx, &json!({ "a": a, "b": b }))
        });
        tlog!("[pvac] ctSub done in {}ms", t0.elapsed().as_millis());
        r
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[tauri::command]
pub async fn pvac_aes_kat(webview: Webview) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(pvac_handler::handle_aes_kat())
}

#[tauri::command]
pub async fn pvac_commit(
    webview: Webview,
    cipher: String,
    ctx_id: String,
    state: State<'_, ArcState>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let state = state.inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        tlog!("[pvac] commit(cipher={}B)", cipher.len());
        with_ctx(&state, &ctx_id, |ctx| {
            pvac_handler::handle_commit(ctx, &json!({ "cipher": cipher }))
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    use crate::wallet::wallet_commands::{key_wallet_entry, wallet_seed, WalletEntry};

    const MASTER_42: &str = "af297eff7d3e8969a28450deeef6bb197ab31df220fcdcbde2fd4446e605c1dd";
    const PUBKEY_SHA256_42: &str = "798f921798f4ded2443d028c49616e49183bbc29d3c33c921562d6e7580e7618";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn fixed_seeds() -> [[u8; 32]; 5] {
        let mut counting = [0u8; 32];
        for (i, b) in counting.iter_mut().enumerate() {
            *b = i as u8;
        }
        [[42u8; 32], [7u8; 32], [0u8; 32], [0xffu8; 32], counting]
    }

    fn wallet_of(seed: &[u8; 32], sealed: bool) -> WalletEntry {
        let mut w = key_wallet_entry(B64.encode(seed), sealed).unwrap().0;
        w.seal_pending = sealed;
        w
    }

    fn init_by_seed(seed: &[u8; 32]) -> (ArcState, Value) {
        let state = AppState::new();
        let mut copy = *seed;
        let result = init_context(&state, &mut copy);
        assert_eq!(copy, [0u8; 32]);
        (state, result)
    }

    fn init_by_wallet(wallets: &[WalletEntry], id: &str, address: &str) -> Result<(ArcState, Value), String> {
        let state = AppState::new();
        let result = init_wallet_context(&state, wallet_seed(wallets, id, address))?;
        Ok((state, result))
    }

    fn pubkey_sha256(state: &ArcState, result: &Value) -> String {
        let out = with_ctx(state, result["ctx"].as_str().unwrap(), pvac_handler::handle_serialize_pubkey).unwrap();
        hex(&Sha256::digest(B64.decode(out["pubkey"].as_str().unwrap()).unwrap()))
    }

    #[test]
    fn init_by_wallet_builds_the_same_context_as_init_by_seed() {
        for (i, seed) in fixed_seeds().iter().enumerate() {
            let sealed = i % 2 == 1;
            let wallet = wallet_of(seed, sealed);
            let others: Vec<WalletEntry> =
                fixed_seeds().iter().filter(|s| *s != seed).map(|s| wallet_of(s, false)).collect();
            let mut wallets = others;
            wallets.insert(i.min(wallets.len()), wallet.clone());

            let (seed_state, by_seed) = init_by_seed(seed);
            let (wallet_state, by_wallet) = init_by_wallet(&wallets, &wallet.id, &wallet.address).unwrap();

            let master = pvac_rs::crypto::keygen::master_seed(seed);
            assert_eq!(by_seed["ctx"], json!(context_fingerprint(&master)));
            assert_eq!(by_wallet["ctx"], by_seed["ctx"]);
            assert_eq!(by_wallet["ready"], json!(true));
            assert_eq!(by_wallet["threads"], by_seed["threads"]);
            let by_seed_pubkey = pubkey_sha256(&seed_state, &by_seed);
            assert_eq!(pubkey_sha256(&wallet_state, &by_wallet), by_seed_pubkey);

            let (direct, _) = pvac_handler::Context::from_seed(seed);
            let direct_pubkey = pvac_rs::serialize::format::serialize_pubkey(&direct.pk);
            assert_eq!(hex(&Sha256::digest(&direct_pubkey)), by_seed_pubkey);

            if *seed == [42u8; 32] {
                assert_eq!(hex(&master), MASTER_42);
                assert_eq!(by_seed_pubkey, PUBKEY_SHA256_42);
            }
        }
    }

    #[test]
    fn a_context_from_one_path_reads_a_cipher_from_the_other() {
        let seed = [42u8; 32];
        let wallet = wallet_of(&seed, true);
        let (seed_state, by_seed) = init_by_seed(&seed);
        let (wallet_state, by_wallet) =
            init_by_wallet(&[wallet.clone()], &wallet.id, &wallet.address).unwrap();
        let ctx_id = by_wallet["ctx"].as_str().unwrap();
        let sealed = with_ctx(&wallet_state, ctx_id, |ctx| {
            pvac_handler::handle_encrypt(ctx, &json!({ "value": 123_456_789u64 }))
        })
        .unwrap();
        let opened = with_ctx(&seed_state, by_seed["ctx"].as_str().unwrap(), |ctx| {
            let cipher = sealed["cipher"].as_str().unwrap();
            pvac_handler::handle_decrypt(ctx, &json!({ "cipher": cipher.trim_start_matches("hfhe_v1|") }))
        })
        .unwrap();
        assert_eq!(opened["value"], json!(123_456_789u64));
    }

    #[test]
    fn init_by_wallet_refuses_another_address_and_sets_no_context() {
        let a = wallet_of(&[42u8; 32], false);
        let b = wallet_of(&[7u8; 32], false);
        let wallets = [a.clone(), b.clone()];
        let state = AppState::new();
        let attempt = |id: &str, address: &str| init_wallet_context(&state, wallet_seed(&wallets, id, address));
        assert!(attempt(&a.id, &b.address).is_err());
        assert!(attempt(&b.id, &a.address).is_err());
        assert!(attempt("missing", &a.address).is_err());
        assert!(init_wallet_context(&state, Err("Wallet is locked".to_string())).is_err());
        assert!(state.ctx.lock().unwrap().ctx.is_none());

        let ready = attempt(&a.id, &a.address).unwrap();
        assert!(attempt(&a.id, &b.address).is_err());
        assert_eq!(state.ctx.lock().unwrap().fp.as_deref(), ready["ctx"].as_str());
    }

    #[test]
    fn init_result_carries_no_key_material() {
        let seed = fixed_seeds()[4];
        let wallet = wallet_of(&seed, false);
        let (_, result) = init_by_wallet(&[wallet.clone()], &wallet.id, &wallet.address).unwrap();
        let mut keys: Vec<&str> = result.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["ctx", "init_ms", "ready", "threads"]);

        let master = pvac_rs::crypto::keygen::master_seed(&seed);
        let text = result.to_string();
        let as_array = |bytes: &[u8]| serde_json::to_string(bytes).unwrap();
        for secret in [
            B64.encode(seed),
            hex(&seed),
            as_array(&seed),
            B64.encode(master),
            hex(&master),
            as_array(&master),
            wallet.private_key.clone().unwrap(),
        ] {
            assert!(!text.contains(&secret));
        }
        assert_eq!(result["ctx"].as_str().unwrap().len(), 32);
    }

    #[test]
    fn the_wallet_init_command_is_granted_to_the_main_window_only() {
        let permission = "\"allow-pvac-init-wallet\"";
        assert!(include_str!("../../build.rs").contains("\"pvac_init_wallet\""));
        assert!(include_str!("../../permissions/main-window.toml").contains(permission));
        for other in [
            include_str!("../../permissions/tray-window.toml"),
            include_str!("../../capabilities/dapp.json"),
            include_str!("../../capabilities/tray.json"),
        ] {
            assert!(!other.contains("pvac"));
        }
    }

    #[test]
    fn policy_bits_takes_only_the_webcli_range() {
        for p in 0..=3u8 {
            assert_eq!(policy_bits(p), Ok(p));
        }
        assert!(policy_bits(4).is_err());
        assert!(policy_bits(u8::MAX).is_err());
    }

    #[test]
    fn key_owner_msg_carries_address_and_policy() {
        let msg = key_owner_msg("oct1abc", 2).unwrap();
        assert_eq!(msg, json!({ "address": "oct1abc", "policy": 2 }));
        assert!(key_owner_msg("", 2).is_err());
        assert!(key_owner_msg("oct1abc", 4).is_err());
    }

    #[test]
    fn cipher_proof_migration_msg_needs_the_encoded_source() {
        let msg = cipher_proof_migration_msg("cGs=", "hfhe_v1|Y3Q=", 7, 3).unwrap();
        assert_eq!(
            msg,
            json!({ "pubkey": "cGs=", "source": "hfhe_v1|Y3Q=", "amount": 7, "policy": 3 })
        );
        assert!(cipher_proof_migration_msg("cGs=", "Y3Q=", 7, 3).is_err());
        assert!(cipher_proof_migration_msg("", "hfhe_v1|Y3Q=", 7, 3).is_err());
        assert!(cipher_proof_migration_msg("cGs=", "hfhe_v1|Y3Q=", 7, 9).is_err());
    }

    #[test]
    fn key_owner_proof_verifies_under_the_policy_it_was_built_with() {
        let (ctx, _) = pvac_handler::Context::from_seed(&[7u8; 32]);
        let address = "oct1keyowner";
        let owner = pvac_handler::handle_make_key_owner_proof(&ctx, &key_owner_msg(address, 3).unwrap());
        assert!(owner.get("error").is_none(), "{owner}");
        let cipher = owner["owner_cipher"].as_str().unwrap();
        let blinding = pvac_rs::ops::migration::key_owner_blinding(address);
        let commitment = pvac_handler::handle_pedersen_commit(&json!({
            "amount": 0,
            "blinding": base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                blinding.to_bytes()
            ),
        }));
        let verify = |policy: u8| {
            pvac_handler::handle_verify_amount(
                &ctx,
                &json!({
                    "cipher": cipher.strip_prefix("hfhe_v1|").unwrap(),
                    "proof": owner["owner_proof"],
                    "commitment": commitment["commitment"],
                    "kind": 0,
                    "policy": policy
                }),
            )
        };
        assert_eq!(verify(3)["valid"], json!(true));
        assert_eq!(verify(1)["valid"], json!(false));
    }

    #[test]
    fn no_pvac_command_hands_back_a_secret() {
        use crate::guard::command_guard::Coverage;

        const AMOUNT: u64 = 5_000;
        const POLICY: u8 = 1;
        let seed = [0xA7u8; 32];
        let wallet = wallet_of(&seed, true);
        let mut seen = Coverage::new();
        seen.secrets.wallets(&[wallet.clone()]);

        let (state, init) = init_by_wallet(&[wallet.clone()], &wallet.id, &wallet.address).unwrap();
        seen.see("pvac_init_wallet", &init);
        let refused = init_by_wallet(&[wallet.clone()], &wallet.id, "oct").map(|(_, result)| result);
        seen.see("pvac_init_wallet", &refused);
        let ctx = init["ctx"].as_str().unwrap().to_string();

        let mut failed: Vec<&str> = vec![];
        let mut run = |command: &'static str, f: &(dyn Fn(&pvac_handler::Context) -> Value + Sync)| {
            let result = with_ctx(&state, &ctx, f);
            seen.see(command, &result);
            if result.is_err() {
                failed.push(command);
            }
            result.unwrap_or(Value::Null)
        };
        let text = |value: &Value, field: &str| value[field].as_str().unwrap_or_default().to_string();

        let blinding = B64.encode([9u8; 32]);
        let enc = run("pvac_encrypt", &|c| pvac_handler::handle_encrypt(c, &json!({ "value": AMOUNT })));
        let other = run("pvac_encrypt", &|c| pvac_handler::handle_encrypt(c, &json!({ "value": 1 })));
        let source = text(&enc, "cipher");
        let cipher = source.trim_start_matches("hfhe_v1|").to_string();
        let cipher2 = text(&other, "cipher").trim_start_matches("hfhe_v1|").to_string();

        run("pvac_decrypt", &|c| pvac_handler::handle_decrypt(c, &json!({ "cipher": cipher })));
        run("pvac_commit", &|c| pvac_handler::handle_commit(c, &json!({ "cipher": cipher })));
        run("pvac_check_bound_provable", &|c| {
            pvac_handler::handle_check_bound_provable(c, &json!({ "cipher": cipher }))
        });
        run("pvac_diagnose_cipher", &|_| pvac_handler::handle_diagnose_cipher(&json!({ "cipher": cipher })));
        let commit = run("pvac_pedersen_commit", &|_| {
            pvac_handler::handle_pedersen_commit(&json!({ "amount": AMOUNT, "blinding": blinding }))
        });
        let commitment = text(&commit, "commitment");
        run("pvac_ct_sub", &|c| pvac_handler::handle_ct_sub(c, &json!({ "a": cipher, "b": cipher2 })));
        run("pvac_make_range_proof", &|c| {
            pvac_handler::handle_make_range_proof(c, &json!({ "cipher": cipher, "value": AMOUNT }))
        });
        run("pvac_make_parallel_range_proofs", &|c| {
            pvac_handler::handle_make_parallel_range_proofs(
                c,
                &json!({ "cipher1": cipher, "value1": AMOUNT, "cipher2": cipher2, "value2": 1 }),
            )
        });
        run("pvac_make_bound_range_proof", &|c| {
            pvac_handler::handle_make_bound_range_proof(
                c,
                &json!({ "cipher": cipher, "value": AMOUNT, "policy": POLICY }),
            )
        });
        let bound = run("pvac_make_bound_proof", &|c| {
            pvac_handler::handle_make_bound_proof(
                c,
                &json!({ "cipher": cipher, "amount": AMOUNT, "blinding": blinding, "policy": POLICY }),
            )
        });
        run("pvac_verify_bound_proof", &|c| {
            pvac_handler::handle_verify_bound_proof(
                c,
                &json!({ "cipher": cipher, "proof": text(&bound, "proof"), "commitment": commitment, "policy": POLICY }),
            )
        });
        run("pvac_make_bound_key_switch_proof", &|c| {
            pvac_handler::handle_make_bound_key_switch_proof(
                c,
                &json!({ "cipher": cipher, "amount": AMOUNT, "blinding": blinding, "policy": POLICY }),
            )
        });
        let pubkey = text(&run("pvac_serialize_pubkey", &|c| pvac_handler::handle_serialize_pubkey(c)), "pubkey");
        let switched = run("pvac_make_bound_key_switch_proof_with_pubkey", &|c| {
            pvac_handler::handle_make_bound_key_switch_proof_with_pubkey(
                c,
                &json!({ "cipher": cipher, "amount": AMOUNT, "blinding": blinding, "pubkey": pubkey, "policy": POLICY }),
            )
        });
        run("pvac_verify_bound_key_switch_proof_with_pubkey", &|c| {
            pvac_handler::handle_verify_bound_key_switch_proof_with_pubkey(
                c,
                &json!({ "cipher": cipher, "proof": text(&switched, "proof"), "commitment": commitment, "pubkey": pubkey, "policy": POLICY }),
            )
        });
        run("pvac_matches_secret_profile", &|c| {
            pvac_handler::handle_matches_secret_profile(c, &json!({ "pubkey": pubkey }))
        });
        let owner = key_owner_msg(&wallet.address, POLICY).unwrap();
        run("pvac_make_key_owner_proof", &|c| pvac_handler::handle_make_key_owner_proof(c, &owner));
        let migration = cipher_proof_migration_msg(&pubkey, &source, AMOUNT, POLICY).unwrap();
        run("pvac_build_cipher_proof_migration", &|c| {
            pvac_handler::handle_build_cipher_proof_migration(c, &migration)
        });
        run("pvac_aes_kat", &|_| pvac_handler::handle_aes_kat());
        run("pvac_decrypt", &|c| pvac_handler::handle_decrypt(c, &json!({ "cipher": "not a cipher" })));
        let zero = run("pvac_encrypt", &|c| {
            let ct = pvac_rs::ops::encrypt::enc_zero(&c.pk, &c.sk);
            let policy = circle_verifier::proof_policy(POLICY).unwrap();
            let zp = pvac_rs::ops::verify_zero_circuit::make_zero_proof_with_policy(&c.pk, &c.sk, &ct, policy);
            json!({
                "cipher": B64.encode(pvac_rs::serialize::format::serialize_cipher(&ct)),
                "proof": pvac_handler::encode_zero_proof(&pvac_rs::serialize::format::serialize_zero_proof_raw(&zp)),
            })
        });
        let verified = circle_verify(&state, &ctx, &pubkey, POLICY, |pk, policy| {
            circle_verifier::verify_zero(pk, &text(&zero, "cipher"), &text(&zero, "proof"), policy)
        });
        assert_eq!(verified, Ok(json!({ "ok": true })));
        seen.see("pvac_circle_verify_zero", &verified);
        let bound_ok = circle_verify(&state, &ctx, &pubkey, POLICY, |pk, policy| {
            circle_verifier::verify_bound(pk, &cipher, &text(&bound, "proof"), &commitment, policy)
        });
        assert_eq!(bound_ok, Ok(json!({ "ok": true })));
        seen.see("pvac_circle_verify_bound", &bound_ok);
        let held = circle_verifier::LANE.try_acquire().unwrap();
        let busy = circle_verify(&state, &ctx, &pubkey, POLICY, |_, _| Ok(()));
        assert_eq!(busy, Err(circle_verifier::BUSY.to_string()));
        drop(held);
        let foreign = pvac_handler::Context::from_seed(&[0x33u8; 32]).0;
        let foreign_key = B64.encode(pvac_rs::serialize::format::serialize_pubkey(&foreign.pk));
        assert_eq!(
            circle_verify(&state, &ctx, &foreign_key, POLICY, |_, _| Ok(())),
            Err("registered pvac key profile is unavailable".to_string())
        );
        seen.see("pvac_encrypt", &with_ctx(&state, "another context", |c| pvac_handler::handle_encrypt(c, &json!({ "value": 1 }))));

        assert_eq!(failed, ["pvac_build_cipher_proof_migration", "pvac_decrypt"]);
        seen.assert_clean("pvac_", &["pvac_destroy"]);
    }
}
