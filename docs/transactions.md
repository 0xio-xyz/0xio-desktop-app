# Transactions

How an Octra transaction goes from a form, the menu bar or a site request to the network, and the checks on the way. Signing, fees, nonces and hashes follow the Octra webcli reference client. The signed text and the permission model are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where the code lives

| Path | What it does |
|------|--------------|
| `src/services/network/transactionBuilder.ts` | Builds the signed text (`buildSignaturePayload`), signs through Rust, broadcasts |
| `src/services/network/txHash.ts` | Escaping, plain digits, timestamps and the transaction hash (`computeTxHash`) |
| `src/services/network/txTimestamp.ts` | Transaction timestamps that never land on a whole second |
| `src/services/network/networkService.ts` | Node reads, nonces and the transaction scope (`TxScope`, `captureScope`, `assertScope`) |
| `src/services/network/feePolicy.ts` | Live fee quotes and floors per operation |
| `src/services/network/submitErrors.ts` | Reads submit errors from the JSON-RPC code |
| `src/services/network/rpcRetry.ts`, `rpcTransport.ts` | Every node call, with the retry policy; posted by Rust |
| `src/services/transactions/` | The reviewed fee, spend checks and fee wording |
| `src/hooks/transactions/` | Fees, Touch ID or password before signing, history |
| `src/features/wallet/hooks/useSendFlow.ts`, `useBatchSend.ts` | Send and bulk send |
| `src-tauri/src/wallet/wallet_commands.rs` | `wallet_sign_transaction`: Ed25519 with the named wallet's key |

## Lifecycle

1. **Review.** Every transaction, approvals included, shows a review with the amount, the recipient or contract and the live fee. The scope (network and address) is captured when the review opens.
2. **Authorise.** Touch ID or the password before anything is signed.
3. **Nonce.** The next nonce follows `octra_balance` `pending_nonce`, else the highest of the confirmed nonce and this wallet's transactions in `staging_view`. Local tracking is kept per network and address.
4. **Fee check.** The fee is read again; the reviewed fee is signed as shown while the node's live minimum is not above it. A higher minimum asks for a new review, and a failed read blocks with a retry.
5. **Scope check and sign.** The sender must be the reviewed wallet and the network the reviewed network, else nothing is signed. The window builds the exact text the node rebuilds and Rust signs it. Amount and fee are plain digits; the submitted fields are the signed ones.
6. **Submit.** `octra_submit` to the scoped network. The hash is computed locally first (webcli `hash_json`, sha256 of the submitted record); the node's hash is tracked, a different one is logged, and the local one is used when the node returns none.

## Fees

- Fees are read live per operation, never a stand-in number.
- A quote is used when one of recommended, base_fee and minimum (first valid, in that order) is 1 to 10,000,000 OU, with the minimum not above it. Fast is shown only when the node quotes it at or above the recommended fee.
- Floors: key update, encrypt, decrypt and private send 5,000 OU; claim 3,000 OU. A Custom fee below the floor or the live minimum is refused.
- Contract deploys pay webcli's size fee on what is signed (the program package for a v2 `program_deploy`, the bytecode for a v1 `deploy`): 200,000 OU plus 1,000 per started KiB, or the node's `program_deploy` minimum when it is exactly 1, 2 or 5 times that. Sites may set up to 10,000,000 OU.

## Submit errors

| Code | Meaning | What happens |
|------|---------|--------------|
| 107, 110, 117, -32005 | Not accepted | The same signed transaction is sent again, 3 tries in all |
| 112 | Nonce already used | The nonce is read again and the transaction goes back to review, never re-signed |
| 100 to 105, 108, 109, 111, 113 to 116, 118, -32600, -32602 | Rejected | Final |
| HTTP 413 | Too large | Final |

## Site requests

A site's transaction runs through the main window's dApp handler (`src/features/dapp/services/dappRequest.ts`) on the site's own record and network. Its review opens in the menu bar panel with the live fee, read again before signing; its signing scope holds only while the site's record still names that network and address. See [sites.md](sites.md).

## Rules

- A review shows exactly what gets signed.
- A send whose result is unclear never offers a resend.
- Not accepted resends the same signed bytes; nonce used asks for a new review. Every other rejection is final.
- Every cache, queue, cursor and query key is scoped to network plus address.
- Claims follow their own ledger and resend rules; see [privacy.md](privacy.md).
