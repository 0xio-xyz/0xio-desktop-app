# Privacy

Octra accounts have a public balance and an encrypted balance. The encrypted balance is a PVAC-HFHE ciphertext: the network adds and subtracts ciphertexts without reading them, and only the key holder can decrypt. In 0xio Desktop every encryption, decryption and proof runs natively in Rust on this computer.

The engine is the `pvac-rs` and `pvac-handler` crates, a Rust port of the PVAC engine in Octra Labs' [webcli](https://github.com/octra-labs/webcli). These crates are not public, so the Rust side does not build without them; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Operations

| Operation | `op_type` | What happens |
|-----------|-----------|--------------|
| Encrypt | `encrypt` | Public -> private. The amount is encrypted, committed (Pedersen) and bound to the commitment with a zero proof. |
| Decrypt | `decrypt` | Private -> public. Adds a range proof that the remaining encrypted balance is not negative. |
| Private send | `stealth` | Sends an encrypted amount to a stealth address, with range proofs for the amount and the new balance. |
| Claim | `claim` | Moves a stealth output addressed to this wallet into its encrypted balance. |
| Key switch | `key_switch` | Registers or refreshes the account's PVAC key on chain. |

## Where the code lives

| Path | What it does |
|------|--------------|
| `src-tauri/src/pvac/pvac_commands.rs` | The `pvac_*` commands: encrypt, decrypt, commitments, range, bound and key switch proofs |
| `src-tauri/src/pvac/proof_pool.rs` | The Rayon pool proofs run on; Settings picks the threads (default: the number of cores, at most 4) |
| `src-tauri/src/pvac/stealth.rs` | Matches stealth outputs with the wallet's key |
| `src/services/pvac/pvacBridge.ts` | The main window's calls into the engine |
| `src/services/pvac/fhe.ts` | `enc()` parameters in contract calls and ciphertext helpers |
| `src/features/privacy/services/proofQueue.ts`, `proofJobs.ts` | The proof queue |
| `src/features/privacy/services/proofPolicy.ts` | The network's proof policy |
| `src/features/privacy/services/claimLedger.ts`, `claimBudget.ts`, `scanCursor.ts` | Claims per network and address, how many fit, where the scan resumes |
| `src/features/privacy/services/keySwitchService.ts`, `keyUpdate.ts`, `keyUpdatePolicy.ts` | Key registration, refresh and migration |
| `src/features/privacy/`, `src/hooks/privacy/` | The Privacy screen, set up private, automations and their hooks |

## Screens

- **Encrypt and decrypt:** laid out like Send: Encrypt or Decrypt in the header, the amount with Max, a live summary with both balances after and the fee to choose, and an action bar. The review is a pop-up with Reject and the verb.
- **Claim:** waiting transfers oldest first under the amount, each with its own Claim, or Claim all up to what the balance's layers allow (one review, one Touch ID, each claim its own job). The same list switches to Recent.
- **Proof queue:** one queue for encrypt, decrypt, claim, private send, key refresh and turning private on, one job at a time. Its progress shows in a pop-up or a small toast and a strip lists what runs and what is next. A failed proof stays on top with Remove and Try again and pauses the jobs behind it; a key update on hold holds them.
- **Automations:** auto-claim and auto-decrypt with intervals, thresholds and presets.
- **Set up private:** Home shows a tag once a wallet with no private key on chain holds enough OCT for the one-time network fee. It opens a review, then registers the key after Touch ID or the password.
- **Key switch:** the PVAC key is rotated when a foreign key is found on chain for the account. The private balance can be migrated, or the encryption key updated, from the main window and the menu bar.

## Claims

Each claim is kept per network and address (`claimLedger.ts`).

- Before a claim is proved and again before it is sent, its output is read from the node (`octra_stealthOutputsById`, or the one-shot `octra_stealthOutputs` from its epoch where the node has no by-id method). Only an unspent output is claimed; a spent or unreadable one sends nothing.
- A claim still pending or confirmed is returned instead of sent again. One with no clear result stays so until its nonce is spent or 600 seconds pass without the node staging it.
- A dropped or released claim is sent again with the same signed bytes only while the app holds them, its output reads unspent, its nonce is still the next one and its fee equals the reviewed fee; otherwise a fresh claim is built.
- A confirmed claim the node no longer finds while its output reads unspent blocks the output; 600 seconds later it counts as missing and the output can be claimed again.

## Proofs for the 0xio extension

A paired 0xio extension sends its proof work here instead of running it in the browser. It sends its own PVAC seed (`init`), never a signing key, and only after both sides proved the pairing. The extension's context is kept apart from the app's own. Extensions 3.0.3 and older, which cannot pair, may still run their proof calls while Settings, Paired apps, Allow older extensions without pairing is on (the default). See [sites.md](sites.md).

## Rules

- The engine follows the PVAC implementation in webcli exactly; proof bytes must match it.
- One proof job at a time, in confirm order, keeps nonces and the balance's layers in order.
- Private operations read their fee live; each has a floor (`encrypt`, `decrypt`, `stealth` and `key_switch` 5,000 OU, `claim` 3,000 OU).
- The PVAC context is started in Rust from the session's wallet seed and checked against the address the window expects. The seed never reaches a window.
