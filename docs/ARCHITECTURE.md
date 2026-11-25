# Architecture

A public overview of how 0xio Desktop holds keys, runs the PVAC privacy engine, signs transactions, splits work between windows and talks to websites. For build steps see the [README](../README.md). Guides by area: [Rust core](core.md), [UI](ui.md), [transactions](transactions.md), [privacy](privacy.md), [sites](sites.md), [translation](translation.md), [direct sites protocol](DIRECT_SITES.md).

## Code map

| Path | Holds |
|------|-------|
| `src-tauri/src/lib.rs` | App setup, plugins and the list of every command |
| `src-tauri/src/wallet/` | Vault, keys and signing (`wallet_commands.rs`), Touch ID (`touch_id.rs`), secret clipboard |
| `src-tauri/src/pvac/` | PVAC commands, the proof thread pool, stealth output matching |
| `src-tauri/src/ws/` | Local socket server, pairing (`ws_auth.rs`), site queue (`ws_sites.rs`) |
| `src-tauri/src/sites/` | Site records and request lifecycle, relayed and direct sites, sandboxed frames, notifications |
| `src-tauri/src/dapp/` | dApp windows, their injected provider and the bridge to the main window |
| `src-tauri/src/net/` | Node RPC (`node_rpc.rs`) and NFT media fetch (`nft_fetch.rs`) |
| `src-tauri/src/guard/` | Window checks (`ipc_guard.rs`) and the command access tests (`command_guard.rs`) |
| `src-tauri/src/system/` | Menu bar icon and panel, autostart, single instance, logs, workspace files |
| `src-tauri/capabilities/`, `src-tauri/permissions/` | What each window may call |
| `src/features/` | Screens by area: `wallet`, `transactions`, `privacy`, `contracts`, `circles`, `dapp`, `nft`, `security`, `settings` |
| `src/services/` | Domain logic: `network`, `transactions`, `pvac`, `wallet`, `crypto`, `names`, `contracts`, `notices`, `sites`, `storage`, `ai`, `app` |
| `src/hooks/`, `src/contexts/` | Hooks by area (`app`, `wallet`, `privacy`, `transactions`, `ui`) and React contexts |
| `src/shared/ui/`, `src/shared/layout/` | Shared components and the app frame (sidebar, top bar, command palette, notices) |
| `src/lib/` | Self-contained helpers with no wallet knowledge |
| `src/tray/` | The menu bar panel |
| `src/i18n/` | Translations |

## Processes and windows

0xio Desktop is one Rust process with these web views:

| Window | Label | Loads | May call |
|--------|-------|-------|----------|
| Main window | `main` | `index.html` | The `main-window` set: every command the wallet UI uses |
| Menu bar panel | `tray` | `tray.html` | The `tray-window` set: panel state, actions, unlock, site reviews |
| dApp windows | `dapp-*` | An `https` site (or a local development server) | `dapp_bridge_request` only |
| `oct://` windows | `dapp-oct-*` | An `oct://` page from the frame listener | `dapp_bridge_request` only |

The main window is the only owner of wallet state. The panel and dApp windows never hold it: they ask Rust, and Rust forwards to the main window.

## Keys

| Component | Spec |
|-----------|------|
| Mnemonic | BIP39; a phrase that does not parse as BIP39 is read with raw PBKDF2-SHA512 (2048 rounds, salt `mnemonic`) |
| Octra key | `HMAC-SHA512("Octra seed", seed)`: the first 32 bytes are the Ed25519 private key seed |
| Derived accounts | Index N > 0: `HMAC-SHA512("Octra seed", seed \|\| N as 4 bytes little endian)`, first 32 bytes |
| Signing | Ed25519 (`ed25519-dalek`) in Rust |
| Octra address | `oct` + Base58(SHA-256(public key)) |
| Imported key | A base64 32-byte Ed25519 seed |

Keys live only in Rust. The main window names a wallet by id; Rust signs, returns the public key and starts the PVAC engine for that wallet. No command returns a key or a phrase except `wallet_export_mnemonic` and `wallet_export_private_key`, which need the password. `touch_id_read` hands the password back to the main window after Touch ID, as the unlock needs it.

## Vault

- Wallets at rest are one AES-256-GCM sealed file, `vault.json` in the app data folder, under a key derived from the password with PBKDF2-SHA256, 600,000 iterations.
- The file is written atomically (temp file, fsync, rename) and readable by this user only. The previous vault is kept as `vault.json.bak` and opened when the vault does not parse; a vault that cannot be read is never replaced.
- A wallet with a key always needs a password. Only a vault of watch-only wallets opens without one.
- While unlocked, Rust holds the password and the derived vault key in memory; lock clears them.
- After 5 failed unlocks the password waits 30 seconds, doubling with each further miss up to an hour. The lock screen and the menu bar panel count against the same limit, and so do the password checks before export, derive and password changes.
- Auto-lock is enforced in Rust: the main window reports activity (`wallet_idle_report`) and Rust locks once the chosen time passes without it, holding off while proofs or sends run (at most 30 minutes).

### Touch ID and Windows Hello

On macOS the password sits in a data protection keychain item of 0xio's own (`src-tauri/src/wallet/touch_id.rs`) that only a current fingerprint opens (`BiometryCurrentSet`). The prompt never offers the Mac login password, and a fingerprint added or removed turns Touch ID off. The fingerprint check before turning it on (`touch_id_prompt`) and the availability check (`touch_id_available`) live there too. On Windows the same commands run Windows Hello on Microsoft's `windows` crate: a Windows Hello key credential signs a random challenge, the password is sealed with AES-256-GCM under a key derived from that signature, and the sealed record sits in the Windows credential vault, so only a Windows Hello check in the same call opens it. Windows cannot tell when a finger or face is enrolled; a reset Windows Hello PIN or container removes the key credential and turns unlock off. The first unlock after the update opens the old plugin record with one check, reseals it and deletes it.

## PVAC privacy engine

PVAC-HFHE keeps an account's private balance on chain as a ciphertext (`hfhe_v1|<base64>`). The network adds and subtracts ciphertexts without reading them; only the key holder decrypts. Each private operation carries a Pedersen commitment, a zero proof binding the ciphertext to it and, where a balance shrinks, range proofs.

The engine is the `pvac-rs` and `pvac-handler` crates, a Rust port of the PVAC engine in Octra Labs' [webcli](https://github.com/octra-labs/webcli). These crates are not public; this repository links them as path dependencies.

Where proofs run:

- **For this app:** in Rust. `pvac_init_wallet` starts a context from the session's wallet seed, checked against the address the window expects; the `pvac_*` commands run on a Rayon pool (`src-tauri/src/pvac/proof_pool.rs`) sized by Settings (default: the number of cores, at most 4). The main window calls them through `src/services/pvac/pvacBridge.ts`.
- **For the 0xio extension:** a paired extension sends its own PVAC seed (`init`) and proof calls over the local socket and gets native speed. It never sends its signing key.

Stealth outputs addressed to a wallet are matched in Rust with that wallet's key (`stealth_match_outputs`, at most 512 outputs per call). See [privacy.md](privacy.md).

## Signing and review

Every Octra transaction is signed with Ed25519 over the text the node rebuilds (webcli `signing_json`, `buildSignaturePayload` in `src/services/network/transactionBuilder.ts`):

```
{from, to_, amount, nonce, ou, timestamp, op_type[, encrypted_data][, message]}
```

- `amount` and `ou` are plain digits with no leading zeros; every control character and DEL is escaped as `\u00xx`. The submitted fields are the signed ones.
- The window builds the text and calls `wallet_sign_transaction`; Rust signs with the named wallet's key.
- Before signing, the sender must be the reviewed wallet and the network the reviewed one (`TxScope` in `src/services/network/networkService.ts`). Octra transactions carry no chain id, so this check keeps a transaction on the network it was reviewed for.
- Every transaction, approvals included, shows a review first. Main window reviews are a pop-up with Reject and the verb; site reviews open in the menu bar panel. Touch ID or the password follows for anything that signs.

Fees, nonces, hashes and submit errors are in [transactions.md](transactions.md).

## Permission model

Tauri lets a window call only the commands its capability grants:

- `src-tauri/capabilities/default.json` gives the main window the `main-window` set (`src-tauri/permissions/main-window.toml`) plus core, shell open, dialog, store, HTTP and updater permissions.
- `src-tauri/capabilities/tray.json` gives the panel the `tray-window` set: no wallet, PVAC or file commands.
- `src-tauri/capabilities/dapp.json` gives `dapp-*` windows on `https://*` and `http://localhost:*` only `dapp_bridge_request`. The `dapp-oct-*` capability is added at start for the frame listener's origin with the same single permission.
- Behind the ACL, wallet, vault, workspace and window commands check the caller again (`require_main`), panel commands `require_tray` and the bridge `require_dapp` (`src-tauri/src/guard/ipc_guard.rs`).
- `src-tauri/src/guard/command_guard.rs` tests that the command list in `lib.rs` matches the build manifest, that every command is classified once, that only the two exports and `touch_id_read` hand back a secret, and that the panel and dApp windows are granted no wallet, PVAC, Touch ID or workspace command.

A new command is listed in `src-tauri/permissions/` and granted only to the window that needs it, never to a window that loads remote content.

## Untrusted content

- Living NFTs and `oct://` pages load from a listener inside the app (`src-tauri/src/sites/frame_protocol.rs`), bound to `127.0.0.1` on a random port with a random 256-bit path per document. Each document gets its own Content Security Policy and an opaque-origin sandbox. A seed-only living NFT gets no network access; one that reads the chain may reach only its own network's RPC.
- NFT metadata and images on hosts outside the app's CSP are read by Rust (`nft_fetch`): `https` only, no credentials, local and private addresses refused with the checked address pinned, at most 3 checked redirects, 15 seconds, size caps and a content-type allowlist. Images reach the page as `data:` URLs.
- The app's own CSP (`src-tauri/tauri.conf.json`) limits connections to the Octra and 0xio hosts it uses and allows frames only from `https` sites and local development servers.

## Networks and RPC

| Network | RPC | Explorer |
|---------|-----|----------|
| Mainnet | `https://octra.network` | `https://octrascan.io` |
| Devnet | `https://devnet.octrascan.io` | `https://devnet.octrascan.io` |
| Custom | User configured | User configured |

Networks are defined in `src/services/network/config.ts`. A custom node gets no token list, market or bridge features; privacy follows its own setting.

Every node call goes through one exchange (`src/services/network/rpcRetry.ts`) and is posted by Rust (`node_rpc_post`, `src-tauri/src/net/node_rpc.rs`), which tells a request that never left from one that did:

- **Repeat:** reads repeat on capacity (429, 503), gateway (408, 425, 502, 504, 520 to 524), connection and timeout faults and on -32012 (committed state changed during read). A write repeats only when it provably never left (no connection made, or a 429 refusal), and otherwise reports the error, with "nothing was sent" when it never left. A certificate error, a 500 and an ordinary node error are never repeated.
- **Pause:** 0.25, 0.5, 1, 2 then 4 seconds, or Retry-After (capped at 5 seconds), plus up to 20% jitter, inside a 25 second window.
- **Gate:** at most 4 node calls in flight; background reads hold at most 2 and only while no user call waits. Calls with a timeout above 60 seconds (large proof submits) are not gated.

There is no fallback endpoint. The optional 0xio RPC proxy (Settings) is used only when turned on, for mainnet and devnet, and a node you add never goes through it.

| Method | Purpose |
|--------|---------|
| `octra_balance` | Public balance and nonce |
| `staging_view` | Pending transactions, for the next nonce |
| `octra_transaction`, `octra_transactionsByAddress` | Transactions and history |
| `octra_submit`, `octra_submitBatch` | Broadcast signed transactions |
| `octra_recommendedFee` | Live fee quote per operation |
| `octra_pvacPubkey`, `octra_registerPvacPubkey`, `octra_pvacMigrationStatus` | PVAC key and private balance state |
| `octra_encryptedBalance` | Encrypted balance ciphertext |
| `octra_viewPubkey` | View key for stealth sends |
| `octra_stealthOutputs`, `octra_stealthOutputsPage`, `octra_stealthOutputsById` | Stealth outputs |
| `octra_tokensByAddress` | Token holdings |
| `octra_contractAbi`, `contract_receipt` | Contract interfaces and receipts |

## Local socket

`src-tauri/src/ws/ws_server.rs` listens on `127.0.0.1:19345`, never on another interface. Who may connect is decided at the handshake (`ws_auth.rs`):

- **The 0xio extension**, by its exact origin, and **local programs** with no Origin. Both must pair. The extension pairs once with an X25519 exchange whose 6 digit code both sides show (`0xio-pair-v1`); after that, every connection proves the 32 byte pairing secret with an HMAC over fresh nonces from both sides before anything runs. A program pairs with a token the user approves; only its hash is kept.
- **Web pages** from their own `https` origin, while Websites can connect without the extension is on. They pair with nothing and may only send site requests ([DIRECT_SITES.md](DIRECT_SITES.md)).
- Everything else (`null`, `file`, plain `http` pages on other hosts) is refused.

A handshake must finish within 5 seconds. Messages are capped at 1 MiB from web pages and 16 MiB from the extension and programs (key switch proofs carry a 4 MB public key). Pairings and connection settings live in `ws_pairings.json`, connected sites in `ws_sites.json`, both in the app data folder and readable by this user only. The relay, the direct protocol and the request lifecycle are in [sites.md](sites.md).
