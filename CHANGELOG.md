# Changelog

## [0.7.4] - unreleased

### Security

- The app window reaches other servers over https only; plain http is allowed only to this computer (local nodes and AI models). Adding a network checks it the same way as every other node call.
- Circles ask once per site before any bridge call but circle.context (wallet reads, signed circle reads, relay calls, fhe verifiers); the grant is per network, wallet and circle, listed in Connected sites and removed there.

### Added

- Contract editor: Save, Save all and Revert file; unsaved dots on tabs and files, gutter change marks, Compare with saved (split or inline).
- Contract editor: unsaved files ask Save all, Don't save or Cancel before leaving Contracts, switching project or closing the window.
- Contract editor: a file changed on disk reloads when clean, else offers Compare, Reload or Keep mine.
- Contracts: Assistant, Build and Deploy in one resizable side panel; it folds to a rail and opens over the editor on narrow windows.
- AI assistant: models detected from each provider's list and from local Ollama and LM Studio, picked in the chat header.
- AI assistant: chats are saved locally per project (last 100 messages, about 500 KB each) and the newest is restored when the project opens; failed replies are not kept.
- AI assistant: chat history beside New chat lists the project's chats by day (open, delete with Undo); New chat and Cmd N keep the old chat; up to 50 chats per project.
- AI assistant: prompt caching on Anthropic (prompt, file and earlier chat marked) and a stable prefix for OpenAI-compatible providers; token and cache usage in the log.
- Circles: fhe.verify_zero and fhe.verify_bound check a cipher proof under the wallet's registered key, with webcli's circle hfhe policy, size caps, cipher shape limits and one verification at a time.

### Changed

- Own query cache, router, translator, QR code, class merge, date helpers, calendar, popover, select and switch replace the external packages; same query keys and scopes, same look and keyboard.
- Touch ID and Windows Hello run in Rust (Windows Hello on Microsoft's windows crate); the biometry plugin is gone and its stored item moves on the first unlock.
- Ids are made by an own UUID v4 helper on the OS random source; the external id crate is gone.
- The date picker opens with focus on the selected day and shows that day's month.
- Licensed under MIT.
- Source tree grouped by domain like the extension (`src/lib`, `src/shared`, `src/services/<domain>`, `src/hooks/<area>`, Rust modules per area).
- Contract editor: no autosave; files are written only on save.
- Build and Audit name their source (saved file or unsaved changes); an edit after a build holds Deploy until the next build; the deploy review shows the source.
- AI settings hold keys and endpoints only; a saved model stays picked while its provider still lists it.
- Contracts on a narrow window: an expanded sidebar floats over the editor instead of squeezing it.
- Own icon set replaces the external icon package; copy shows "Copied" and a picked option is a filled row instead of a tick.
- Sidebar: solid icons with the 0xio slash cut in the list and the rail; the cut draws open when an item becomes active; the rail is a fixed 76 px.
- AI assistant: answers are either the whole file or one whole function, so Apply never replaces a file with a shortened one; Manual mode has its own rules.
- AI assistant and Audit follow the current AML rules (`||` works, `transfer` results are checked, amounts are unsigned and guarded) and say when they are unsure instead of inventing a built-in.
- AI assistant: text inside the open file or the selection is treated as code, never as instructions.
- Faster start: the lock screen's first frame paints before any script; other languages and the open-wallet parts load on demand; startup checks wait until the lock screen shows.
- Inter and JetBrains Mono ship with the app; nothing is fetched from Google Fonts.
- Crash reporting removed; the app sends no error reports.
- One copy at a time: opening the app again shows the running window.

### Fixed

- Unlock (and finishing a new wallet) could leave the lock screen up although the wallet was open; the app now moves on the first time.
- AI assistant: shows Thinking with seconds while the model reasons, and the wait only ends on real silence.
- AI assistant: a provider that stays silent ends with "No answer from <provider>" after 90 seconds (60 seconds between parts), an error sent inside the answer is shown, and an empty answer says so, instead of loading forever.
- AI assistant: Plan mode pointed to an "Agent mode" that does not exist; it names Auto mode.

## [0.7.3] - 2026-11-20

### Added

- Contract deploy: the network fee is Default (the required fee) or Custom (never under it), on v1 and v2 alike.

### Fixed

- Contract deploy bar: Review deploy no longer runs out of the card; on a narrow pane the bar stacks.

### Changed

- Build info (size, instructions, verifier, source hash) is a compact grid, so the outline gets more room.

## [0.7.2] - 2026-11-20

### Added

- Contract deploy: v2 programs go out as program_deploy with the compiler's package and its exact fee; v1 bytecode still deploys as before. The kind is picked from the build and shown in the review.
- Log: every submit, and any node call over 64 KB, records its method, size, status and time.

### Fixed

- Touch ID on: a signing prompt opens Touch ID first; the password form no longer flashes before it.
- Contract deploy bar: Preview address no longer runs over the code size and fee.

### Changed

- Proof threads: a new setting applies to the next proof, no restart; Settings shows the threads in use.
- Key update and balance refresh build their proofs side by side (about 1.2x faster on an idle M3); a proof no longer holds the key context lock.

## [0.7.1] - 2026-11-20

### Security

- TLS (rustls 0.23.46, webpki 0.103.17, roots 1.0.12), HTTP/2 and the updater archive reader (zip 9.7) updated past known advisories.
- A write is repeated only when it provably never reached the node; a 429 on submit no longer resends.
- A claim reads its output from the node before proving and before sending, and sends only for an unspent output.
- A confirmed claim the node lost while its output reads unspent blocks a new claim for 600 s, then counts as missing.
- A dropped or released claim is sent again with its saved bytes only while its output reads unspent, its nonce is still the next one and its fee equals the reviewed fee; otherwise a fresh claim is built.

### Fixed

- Network fee: the fee choice grows with its value instead of running into the label.
- A claim already pending or confirmed returns its hash instead of claiming the output again.
- A site claim whose outputs were all claimed here returns the earlier hashes without a review.
- A site claim refused after an earlier output was sent answers `partial` with the hashes sent.
- Stealth page reads, network detection, ping and Circle reads share the node call path.
- A never-used address reads as 0 OCT through the RPC proxy instead of failing to read the balance.
- A call with an empty field is stopped and names the missing input instead of sending 0 or an empty string.
- Picking another method clears the last method's result.
- A contract's methods use the full ABI saved at deploy or compiled from source on this computer; the chain's ABI names methods without inputs and marks every one a view, so those are listed under Methods with a JSON parameters box, Run and Review call.
- Contracts Yours lists every contract the active address deployed, read from its own deploy transactions; the chain's contract list leaves contracts out.

### Added

- Node calls are sent from Rust (`node_rpc_post`), which tells a request that never left from one that may have.
- -32012 (committed state changed during read) is read again.
- Site claim codes: `CLAIM_OUTPUT_SPENT`, `CLAIM_OUTPUT_UNREADABLE`, `CLAIM_CONFLICT`, and `RATE_LIMIT_EXCEEDED` or `NETWORK_ERROR` after the retry window.

### Changed

- Privacy uses the Send layout: Encrypt or Decrypt in the header, claims and Recent under the amount, live summary, action bar.
- One retry policy for every node call: classified faults, 0.25 to 4 s pauses with jitter, Retry-After capped at 5 s, a 25 s window.
- Node call gate: 4 in flight, background reads at most 2 and only while no user call waits; calls above 60 s are not gated.
- Private proofs about 1.3x faster (pvac-rs 0.3, pvac-handler 0.2).
- Contracts Build: an Actions card beside the editor holds the stages (Write, Build, Deploy), Build, Audit with its result, the last build and Continue to deploy; nothing moves while building (the last build stays dimmed). Deploy takes the editor's place with the constructor in two columns (or one JSON array, a value per line) and a fixed bar with the address, size, fee and Review deploy; Back to code returns to the file as it was. The outline (searchable) and the Assistant sit below the Actions card. Templates, Import and Clear sit in the File menu.
- Contracts list: one table with Yours (deployed by the active address), Saved and All, showing version, code hash and balance; Add by address saves a contract.
- Contract page: name, address, version, balance, verified state and creator on top, with Save, Source, Verify and Open in Build; methods from the ABI split into Read and Write, one method at a time with fields or one JSON array (Parameters as JSON switch), Amount on every write and the editable fee beside Review call.
- Source shows code this computer deployed or verified (kept per network and contract address), else the ABI from the chain; Verify takes a Build file or pasted source; Open in Build adds the source as a new file and never overwrites one.

## [0.7.0] - 2026-11-14

### Security

- Browser: a site, its connection, its bridge and a sealed Circle's passphrase belong to the Circle ID, never to the `.oct` name; a name that now points to another Circle opens it as a new site. The passphrase was tried on the next sealed Circle.
- Browser: a page speaks as its Circle only while it is the page in the frame. It spoke as the Circle still loading, and a web page reached with Back spoke as the Circle it replaced.
- Recovery phrase and private key: one click shows, they stay shown until Hide; Hide, leaving the screen, the window losing focus, a hidden or minimised app and lock drop them from the page, and showing again asks for the password or Touch ID.
- The main window's own focus event (`onFocusChanged`) hides a shown phrase or key as well as the page's blur, so hiding or minimising the app hides it; a blur while the password sheet or Touch ID is up drops nothing, and a secret that arrives on a hidden page is dropped.
- Copy for the recovery phrase and private key is written by Rust (`wallet_copy_secret`, main window only), never by the page: this Mac only (no Universal Clipboard), marked concealed for clipboard managers, cleared after 60 s only if the clipboard still holds it. Windows: kept out of clipboard history and cloud sync.
- Password guesses on `wallet_export_mnemonic`, `wallet_export_private_key`, the new `wallet_verify_password`, `wallet_create_additional`, `wallet_derive_account`, `wallet_scan_hd_accounts`, `wallet_import_private_key` and `wallet_import_mnemonic` (into an existing vault; a first-run import sets the password and is not counted), `wallet_change_password` and `wallet_remove_password` count against the unlock limit: same counter, same lockout.
- The private key never reaches the page: PVAC init takes the wallet id (`pvac_init_wallet`) and incoming private transfers are matched in Rust (`stealth_match_outputs`, four fields per output in, matches out), both main window only with the address checked against the key; `wallet_get_private_key` and the seed form of `pvac_init` are removed; every `pvac_*` command refuses any window but the main one.
- Tests fail on a command not classed as returning no secret and on a key, phrase, password, PVAC master seed or view key in a wallet, PVAC or stealth result; only `wallet_export_mnemonic` and `wallet_export_private_key` (password) and `touch_id_read` (fingerprint, the vault password) hand one back.
- Claim log lines no longer carry part of the claim secret or blinding.
- Wallet delete checks the password with `wallet_verify_password` (returns nothing) instead of reading the private key, and `wallet_delete` itself refuses without that check in the last 60 s.
- Import paste clears the pasted phrase or key from the clipboard when it still holds it.
- Used nonce (112) goes back to review; the silent re-sign on nonce errors is gone.
- Private ops follow the network proof policy (octra_pvacMigrationStatus proof_math and proof_key, else the listed devnet runtime) and refuse without one; the policy is read again before submit and a change sends nothing.
- Site reviews (menu bar and main window) show everything signed: each step of a contract sequence (contract, method, exact args, amount) with the OCT total, a call's exact args, a deploy's constructor params and any memo, in full.
- Site sign_transaction signs standard transfers only; another op_type or encrypted_data is INVALID_PARAMS before any review.
- Site messages and memos over 4000 characters are INVALID_PARAMS before the review, never cut; contract params must be an array.
- Connect reviews list every scope the site is granted, private ones included, from the same list connect stores.
- Direct sites need a site token, not only the Origin header: an approved connect returns `siteToken` (SHA-256 kept, constant-time check), `site_hello` must carry it as `site_token`; without it a page gets no grant and no events, and a connect is a fresh review.
- Disconnecting a direct site (from the site or in Settings) revokes its token; a page that has not shown the token cannot disconnect or move the site.
- Extension pairing is kept only after both the desktop's Pair and the extension's `auth_pair_confirm` (its user picked the code); `auth_pair_cancel`, a wrong pick, a timeout or a closed socket keeps nothing. Pair pressed first shows Waiting.
- One pairing review at a time, and the next opens 3 s after one closes.
- Local socket messages capped: web pages 1 MiB, the extension and programs 16 MiB (was 64 MiB); site request params 896 KiB.
- Handshakes time out after 5 s; only finished handshakes count toward the open connection cap.
- After a site review is rejected, that site's next reviews are refused without one for 5 s.
- Menu bar queue updates no longer carry the raw site params; the main window builds the review from them.
- Touch ID: the 0.5.5 password copy in the login keychain is deleted once and on turning Touch ID off; release builds never read biometric.json and delete one left behind.
- Menu bar panel may listen to events but no longer emit them.
- A site request id (`rid`) never opens a second review or signs twice: the same request joins the running one or gets its stored answer, a different one under the id is `REQUEST_ID_REUSED`, a failed, rejected or expired id never runs again.
- Request status and `request` events go only to the connection that sent the request; a page without its site token reads only ids it sent on that socket, and sees `locked` as `review_open` and no address.
- An approved site request runs only once the desktop holds it as running; a request that ended meanwhile (page closed, expired) is answered not approved and nothing is signed.
- A site that is not connected gets no address keys from getConnectionStatus, `NOT_CONNECTED` for wallet capabilities and pending transfers, and its contract views run with the caller it passes or none, never the open wallet's address; public reads (contract views, storage, allowlisted `rpc_call`) are answered to it on every channel.
- A request from a site that is not connected is never marked `locked`, so the unlock changes nothing it can see (same `seq` and `updatedAt`, no event); connected sites still go `locked` to `review_open`.
- A site that is not connected no longer learns that 0xio is locked: getConnectionStatus answers it as when unlocked (no `locked` flag), and its other requests are refused `NOT_CONNECTED` at once instead of waiting for the unlock; connected sites still hear `locked`.
- An unclear submit (timeout, lost reply, an unknown node error) is answered to sites on every channel as success with the local exact hash and status `submitted`, never an error that invites a resend; the chain watch settles it. Only a clear node refusal is an error. A key update in that state is held as pending, so it is never paid twice.
- A running site request can no longer be rejected or cancelled into a false `USER_REJECTED` while it signs.
- Every submit (wallet and sites) is tracked by the local exact hash, so a node cannot make the wallet or a site watch a hash of its choosing; a node hash that differs is logged and ignored, used only when the local one cannot be computed.
- Site `register_private_view_key`: own connected address only (else `INVALID_PARAMS` before any review); answered from the free reads (`octra_viewPubkey` and the confirmed PVAC key) with no review when both exist; otherwise one review with the live key_switch fee, then the empty key_switch (submitted, confirmed, `view_pubkey` in the confirmed result); `INSUFFICIENT_BALANCE` before the review when the balance is below the fee.
- `register_private_view_key` refuses before any review with `PVAC_KEY_MISMATCH` when another PVAC key is registered for the account (or the update would not be an empty key_switch) and with `REGISTRATION_PENDING` while this wallet's registration is unconfirmed, a repeat included.
- A review asked for while another is open in the browser or a dApp window answers `RATE_LIMIT_EXCEEDED` with `details.reason: "review_pending"` and the open review's status (and request id when it has one), not `REQUEST_PENDING`.
- `octra_registerViewPubkey` is never called (devnet answers method not found); the stealth send no longer tries it.
- The private send no longer takes the raw private key it did not use.
- `broadcast_only` takes only a record from the site's connected wallet (else `INVALID_PARAMS`, no review), is not reviewed again (its `sign_transaction` review counts), asserts the scope and posts the record exactly as given; it runs to its end even if the page closes.
- A web page over 20 messages a second gets `RATE_LIMITED` for each extra one, never silence.
- Request status and events leave out `network` (like `address`) for a site that is not connected.
- Keys are never sealed under an empty password: onboarding has no Skip password, Rust refuses it on every save, and only a vault of watch wallets may stay without one.
- Adding a key to a vault without a password (create, import, derive) asks for a password first and re-seals every wallet under it.
- A vault from an older version with keys and no password asks for a password on the lock screen before it opens; Remove password is offered only for a vault of watch wallets.
- A removed wallet, a seal or a new password also rewrites the vault backup, so no older copy stays on disk.
- Sealed circle uploads publish the keyed digest (HMAC-SHA256 under a passphrase-derived key) as `plaintext_hash`, never a plain SHA-256 of the content.
- Sealed circle reads accept only the three reference hash forms (SHA-256, keyed digest, keyed digest with the unescaped salt); an asset with no hash or no key id is refused.
- Circle uploads are checked before the review: 32 MiB cap, public files over 2 MiB refused (no chunked upload yet), path canonical (percent-decoded, UTF-8, no `.`, `..` refused, 1024 bytes, `/.octra/` reserved); the review shows the path that is signed.
- A transaction message over its limit is refused, never cut (circle uploads 8192 bytes, other private and circle ops 1024).
- Circle pages are told only the bridge methods that are served; writes and `fhe.*` are not listed and answer `Method not supported` with code `UNSUPPORTED_METHOD`.
- Circles are kept per network and wallet; the old shared recent list is dropped and the scoped one is carried over.
- A circle upload whose result is unclear is never offered again: it is followed by its hash and offers only Check again.
- An encrypted circle asks for its read passphrase again after a restart and checks it against a published file before sealing more with it; the passphrase is never stored.
- Circle pages, circle files and living NFTs shown in the main window load from a loopback listener (`http://127.0.0.1:<random port>/<256-bit random path>`) instead of the `oxioframe` scheme, so Tauri counts them as remote and its permission check refuses every command from them; the scheme is no longer registered.
- The listener binds 127.0.0.1 only, answers GET only, refuses any Host but its own, sends no CORS headers, serves staged documents only (same headers and content policies as before) and keeps nothing on disk; lock drops every staged document.
- A circle page in a window of its own loads from the same listener; dApp windows are remote-only again, and that origin is granted the bridge command for `dapp-oct-*` windows at start.
- A staged file's content type that is not plain printable text is served as `application/octet-stream`.
- A circle page's bookmark and System browser use its `oct://` address, never the staged URL.
- Main page `frame-src` drops the scheme entries; `connect-src` gains `ipc:` and `http://ipc.localhost` (Tauri's own request path, blocked until now).
- An incoming private transfer whose one-time key is a low-order point (all-zero X25519 result) is ignored, and a private send to such a view key is refused, as the reference client does.
- Auto-lock has a Rust deadline as well as the page timer: past it, every command that needs the vault, a key or the PVAC context refuses, locks and shows the lock screen (`wallet_idle_report`, `wallet-idle-locked`); 0 still means off.
- A page reload (or a restarted web process) ends the Rust session before the lock screen shows.
- Lock drops the PVAC context in Rust itself, and the page drops claim secrets and the private balance.
- The private balance is no longer saved in the persisted query cache; saved copies are dropped on start.
- Activity after the auto-lock time has passed locks instead of keeping the wallet open.
- The menu bar panel can no longer hide its own window; it asks Rust (`tray_hide`).
- NFT metadata and images on https hosts outside the window policy are read by the app (`nft_fetch`, main window only) and handed to the page as JSON text or a `data:` image; the window policy is unchanged. https only on the default port, no credentials, cookies or proxy, nothing about the wallet sent; loopback, private, link-local, unique-local, CGNAT, multicast and unspecified addresses refused (IPv4-mapped and number forms too), `localhost` and local names refused; the request connects to the address that was checked; at most 3 redirects, each checked the same way; 15 s; metadata 256 KiB (`application/json` or `text/plain`, strict JSON), images 2 MiB (png, jpeg, webp, gif, svg, only ever shown as an image).

### Fixed

- Browser Back and Forward load a Circle page again (the `oct://` address went into the frame and showed nothing); bookmarking names the page on screen, not an address that failed to load; a Circle address typed after text that was not an address opens (the notice stayed).
- Accounts derived from a wallet that is not backed up show Back up too, and one backup clears every account of that phrase.
- A finished backup says Backed up; an already backed up phrase closes with Done.
- Backup: helper lines removed; the wallet options label is translated.
- Password prompts in Wallets and Settings (create, import, derive, scan, delete, change and remove password) and the onboarding import are translated and say Incorrect password or Too many attempts in the app's language, not the backend's English.
- Wallets: Scan Accounts, Load more and the address search work on a vault with a password. Each asks once in the centred sheet (Touch ID when it is on) and scans with that password; before, the password went to Derive (it added an account) and the scan never ran, and the address search sent an empty password.
- History: a failed transaction the node lists several times shows once
- Circle pages with inline scripts render: asset references are resolved in markup and styles only, script text is no longer rewritten.
- Public circle pages load their own files as the reference client does: stylesheets (with their imports and images), scripts, images, icons and posters by relative, absolute or `oct://` path, and links between pages of a circle open in the browser. A public page showed bare markup with dead links; sealed pages could not run a script kept in its own file. The page policy now accepts scripts given as `data:` URLs.
- Send: a typed .oct name becomes the recipient as soon as it resolves, with no pick from the list, and its address stays on one line (cut in the middle). The review still shows the full address and reads the name again before signing.
- Send: a typed name is taken only after the text stayed unchanged for one second; Enter or a pick takes it at once.
- NFT ownership scan: a storage read the node failed to answer no longer falls into a one by one scan of up to 200 calls, and a scan stops after three reads in a row the node did not answer.
- NFT ownership: with the owned count unchanged, the ids known before are asked for again (one read each) instead of scanning the whole collection every 10 minutes and after a restart.
- NFT media: one more try after a not found or a server error from the host.
- Home: Receive, Privacy and History are the same width.
- The network fee chooser opens upward when there is no room under it (it was cut off in the Circles upload bar, showing only Slow), and a fee is named Normal when Slow and Normal are the same amount.
- An `oct://` page opened in a window reaches the wallet: same site, same reviews as in the browser tab (every wallet request failed there with no code or message).
- Wallet request rejections from the browser tab and dApp windows always carry a code and a message (4001 rejected, 4100 unauthorized, -32602 invalid params, -32603 internal).
- Contracts: loading the ABI of a contract deployed from the editor no longer crashes Interact; compiler, node and saved ABIs are read as one method list, and octra_contractAbi's `methods` answer is read (it was always "No ABI found").
- The vault is written atomically (temp file, fsync, rename, directory fsync), readable by this user only; the previous vault stays as `vault.json.bak` and unlock opens it when the vault does not parse.
- An import, a watch add or Create never replaces a vault it cannot read: it stops with an error and keeps the vault and its backup.
- Adding a watch wallet while locked no longer replaces the vault with that one wallet.
- Pairing and site stores are synced to disk before they replace the old file.

- Token amounts in Send, bulk send and their reviews are exact whole units, never floating point.
- Signing text escapes DEL and strips leading zeros in amount and fee, as webcli does.
- Nonce follows pending_nonce, else staging_view.
- Submit hash computed locally (webcli formula).
- Local tx hash follows the node: an optional field sent as "" is hashed as "" (was null) and the hash is taken over the exact record posted; records the wallet builds leave empty public_key, message and encrypted_data out, as the reference client does, and a site's pre-signed record is posted as given.
- A site request approved before its page closed now finishes and keeps its outcome (connect record and token included); only unanswered reviews close with their page.
- Public circle deploys use `browser_mode: native_sealed` and `resource_mode: public_resources`; the node rejected the old `native` and `public_read` ("unknown browser mode").
- Circle deploys and uploads wait for the chain: a rejection shows its reason, and a rejected circle is not offered for upload.
- Circle read signatures use the `octra_circle_auth_v2` length-prefixed framing.
- Sealed circle pages, slots and states are read with the signed owner read (key id and hash come only with it), the public read as fallback; circle info falls back to the signed read.
- Sealed reads no longer keep a key from a wrong passphrase; `program.view` sends `include_storage`.
- Large circle uploads no longer fail in base64 encoding; a 32 MiB circle file is no longer refused on read.
- Circle uploads by file name: `; charset=utf-8` for html, css, js and json, and `image/webp`.
- Unlock no longer repeats its reads: the PVAC key is serialised once, `octra_pvacPubkey` is asked once (30 s cache per network and address, dropped on a key switch, wallet or network change and lock; signing paths always ask the node), and `octra_pvacMigrationStatus` and `octra_transactionsByAddress` share a read already under way.
- `contract_receipt` is not asked again in a session for a call the node says has no receipt (per network and hash); a busy node or a failed request is still retried.
- The claimable scan reads pages of 256 (was 64), halves on -32013 and keeps the size the node took.
- A reply whose body never arrives times out and frees its node call slot; six of them no longer stop every read and send until restart.
- Auto-lock waits for a running or queued proof job, send or menu bar operation and locks when the last one ends (30 min at most without progress).
- Unlocking counts as activity: a menu bar unlock no longer locks again within 30 s.
- Claim scan interval is capped at one hour after a scan that ran through sleep.
- A first private balance setup the node no longer holds stops reading as pending after 30 min, in the menu bar too.
- Started hidden at login, the window reads as hidden at once, so polling stays paused.
- Every way the menu bar panel closes tells the main window, so background balance reads stop.
- An unreadable `ws_pairings.json` is set aside (`.unreadable-<time>`) instead of being overwritten.

### Added
- Browser opens a Circle by `.oct` name (devnet): `oct://0xio.oct/docs/intro.html` loads the confirmed Circle the name points to and keeps the name in the address bar, with a tag that shows the Circle ID (full ID and Copy Circle ID behind it). The name is read again on every open, reload, Back, Forward and bookmark (kept 60 s at most); links inside the Circle keep the name form and load that Circle without reading the name; bookmarks and Recent store the name form. A name that does not open shows why and loads nothing: not registered, expired, reserved, not valid, points to a wallet, no Circle set, Circle still waiting to be confirmed, not available on this network, or the name service could not be read (Try again).
- Intel Macs: the macOS build is universal (Apple silicon and Intel), one .dmg and one update for both.
- Circles library: the circles this wallet deployed and the files it published to each, kept across restarts, so an older circle takes new files.
- The scan for waiting private transfers keeps a cursor per network and address and reads only what is new (it read every output on the chain each time: 1,012 outputs took 21 s). It starts at the oldest transfer still waiting, moves only after a complete scan, starts over when the chain was reset or the head cannot be read, and reads everything again once a day.
- Circles: Choose takes files and folders. On Mac one window selects both; on Windows the button offers Files or Folder. A chosen folder keeps its paths like a dropped one (the folder's own name dropped when it is the only pick, hidden files and links inside skipped, 200 files at most). The window is opened and the files are read by the app (`circle_pick`, `circle_read_picked`, main window only); the page never names a path.
- Several files in one upload: drop or choose files or a folder, edit each path, a file over a cap or with a bad path is refused in its row, a path already published shows Replace.
- One review for a batch (every file, its transaction and fee, the total), one authorization, then one transaction at a time with a dot per file ending Confirmed, Rejected with its reason or Not confirmed.
- A deploy ends with Deployed and a batch with Uploaded as result toasts; a rejection shows its reason.
- Send to a `.oct` name (devnet): a name typed in the recipient picker is looked up and shown as a row with its full address; it has to be picked. Public and private sends.
- A send picked by name shows one To card (name over the full address), resolves the name again at confirm and signs only to that address; a moved name shows was and now and waits for Use new address; a failed read sends nothing.
- A private send picked by name checks the name once more in the proof queue before it signs.
- Primary `.oct` name beside the address for your wallet in the sidebar, contacts, History rows, Transaction details and Home activity; read per visible row, address alone when there is none.
- ONS names in the NFT gallery (Octra names), `0xio.oct` in full, with collection, owner, status and expiry read from the contract on its page and the usual transfer; an expired name has no actions.
- Menu bar panel and command line refuse a `.oct` name as a recipient.
- Contracts: rename a tracked contract from its header
- The in-app browser and the dApp windows speak wallet protocol 2: `wallet_hello`, `rid` forwarded, status records in the same request log (per origin, network and address), `request_status`, `cancel_request`, `requestUpdate` only to the asking page, the same-id rules with `REQUEST_ID_REUSED`, the 5 minute review window, page close (an unanswered review closes, an approved one finishes), network and signer hidden from a site that is not connected; protocol 1 pages keep today's behaviour.

- Wallet protocol 2 for direct and relayed sites: `site_hello` and the paired extension's `auth_prove` reply carry `protocol: 2`, `kind: "desktop"` and `capabilities`; `site_request` takes a top level `rid`.
- Request status per carrier, origin and `rid` (memory only, 24 h, 64 per site, 8 running, 1024 in all) with network and address: pending, locked, review_open, signing, submitted (local exact hash), confirmed or failed from `octra_transaction`, completed, rejected, expired.
- `site_status {rid}` for pages and the paired extension, 120 per minute per site; `site_cancel` takes `rid` and answers with the status.
- `site_event` kind `request` to the sending connection only (relayed ones name the tab); replies to a request with `rid` carry `rid` and `status`.
- Submitted site transactions are watched on chain (2.5 s for a minute, then 10 s, 10 minutes; 32 at once, 8 per site), with the contract receipt for calls and deploys; later the chain is read when the site asks (at most every 5 s).
- `scripts/conformance.sh` runs the shared protocol 2 suite against the real socket through a Rust test server; `cargo test` checks the shared digest and transition vectors.

### Changed

- ONS names in NFTs show their own artwork from `token_uri` like any NFT, with Refresh metadata and the metadata traits that do not repeat chain facts; an expired name (in grace or lapsed) carries an Expired tag and its status reads Active or Expired; the wallet-drawn plate shows only when the artwork cannot be loaded. `ons.expired` reworded in Indonesian and Chinese.
- NFT images and metadata on any https host now load (through the app, see Security); they were blocked by the window policy, the `ipfs.io` gateway included.
- Token page is one view per token: price to 6 decimals with its change, ranges and a tall chart on the left; a panel on the right with the balance, Send, Receive and the token's activity.
- Public and encrypted OCT are one page with both rows under one total and Encrypt and Decrypt together; the two old links open it with the matching row filled.
- Chart pointer reads the price, change and time in the price's own place; the scale is 6 decimals.
- A token with no price has no chart: its activity takes the left column and the panel shows the contract with Copy, decimals and Remove token for tokens you added.
- Token page balance follows the live balance and token reads (it came from the link and never updated); activity is the token's own on this network and address, newest first, with names and the Testnet tag.
- Token page loading holds every slot; a failed read keeps the last figures dimmed with Last updated and Retry in the header.
- Watch-only wallets get Receive only on the token page.
- NFTs say Transfer where they said Send: the detail page button, the drawer title, its review button and its progress and result words.
- Wallets: Derive account is one centred sheet in the current look: parent wallet, one Index or address field with Search, filled-row pick, Show balances, Load more up to the 50 account limit (the copy said 100), failures with Retry in place, Add account N ending with Account N added.
- Backup is one surface for the recovery phrase and the private key at the screen's width: 12 words in 4 columns, 24 in 6, the key whole in two lines, one risk line, then Show or Hide, Copy and the closing button in fixed slots (I wrote them down, I wrote it down or Done).
- The password or Touch ID step of the backup is the centred sheet over the page (Touch ID first when it is on); Cancel goes back. Wallets and Settings password prompts use the same sheet.
- Entries are named Recovery phrase and Private key in Settings and Wallets (was Key info, Export key, Export phrase); Key info is gone, the address and public key sit in the wallet's details in Wallets, each with Copy.
- A wallet imported by private key starts as Backed up, like one imported by phrase; its Private key entry is a plain view closed with Done. Only wallets the app creates start as Not backed up.
- The one-time phrase of a sealed wallet uses the same surface, centred, with Copy and the line This is the only time this computer shows these words.
- macOS 13 is the minimum; older versions refuse the app at install.
- Direct sites without a token (SDK 2.11.0, cleared storage) pass a connect review on each new connection; disconnecting a direct site forgets it on every network.
- Site reviews (unlock included) close after 5 minutes as `USER_REJECTED` with `details.status: "expired"`; before, a direct review stayed open until the SDK gave up.
- Site `signing` status only for methods that submit a transaction; signatures and `register_private_view_key` go from review to `completed`; a failed-on-chain id answers repeats with `EXECUTION_FAILED`.
- Submit reads JSON-RPC codes: resend-safe codes retry the same transaction (3 tries), rejected and too large say so.
- Fee floors: key update, encrypt, decrypt and private send 5000 OU, claim 3000 OU; a quote without fast is valid and hides Fast only.
- Deploy fee follows webcli's size rule; the 50,000,000 OU site cap is now 10,000,000.
- Fast preset only from the live quote (no doubled default).
- Key update adds owner_cipher and owner_proof when the policy binds proofs to the key; a historical key balance migrates with cipher_proof when the node allows it.
- Mainnet explorer links and oct://explorer open octrascan.io; oct://stats removed.
- Circles is for publishing only: the Browse step and its preview are gone, Open in browser opens the built-in browser.
- Circles page is a list and a detail pane: New circle first, then each circle with its address, Open in browser, published files and the drop bar; public or encrypted is picked as two tiles; the How it works guide and the recent chips are gone.
- A circle whose deploy is not confirmed takes no files until Check again confirms it.
- Circles status and error copy goes through the five languages; the Browser prompt says Encrypted circle.
- One fee read per network and op type, shared by the screens and the menu bar panel (60 s); the panel reads fees, quotes and private status only while it is open. The check before signing still asks the node.
- Polling stops while the main window is hidden or minimised and stale reads refresh once when it is back; an unfocused window that is still on screen keeps updating.
- The public balance polls in the background only while the menu bar panel is open or a site waits on a confirmation (and 60 s after).
- The scheduled claimable scan is skipped while hidden or locked and runs once on return when one was missed.
- Price is one shared read (30 s, 5 min on the lock screen); the price curve is read only by the screens that draw it.
- Private setup status is checked every 60 s (was 20 s) and pending transactions every 20 s (was 10 s).
- Queries retry once, and never on a 429.
- Logs: files untouched for 14 days are deleted at start and at midnight; a long run moves to a new file each day.
- ONS names follow the name contract's interface 6: a name is resolved with one `resolve` call, held names come from `names_of`, expiry from the eight-field `get_name_info`; years are 1 to 5.
- The name contract is no longer built in: it is read from the token-lists name list (`octra.namelist.json`, one `.oct` entry per network, every 10 minutes), checked on chain with `get_contract_info` (Octra Name System, ONS, interface 6) once per session and per address, and the last address that passed is kept for when the list cannot be reached; no entry or a failed check means no names on that network. A send stops at confirm when the listed contract changed since the name was typed.

## [0.6.0] - 2026-10-23

### Security

- Contracts: deploying, calling a contract and sending a token from Tokens now ask for Touch ID or the password before signing, like every other transaction; before they signed right after the review.
- Debug builds accept an unpacked 0xio extension (any Chrome extension id), still only after pairing; release builds keep the Web Store id only.
- Build tools patched: vite 6.4.5 and vitest 4.1.12.
- Touch ID unlock no longer accepts the Mac login password: the password sits in an item of its own that only a current fingerprint opens; the prompt has one button (Cancel, or Use password where a password field waits) and no fallback. A fingerprint added or removed turns Touch ID off with a notice in Settings. The first unlock after updating moves the password out of the old item and deletes it.
- Updates install only when their signature names the version the update server announced; a signature without a version or for another version is refused.

- Sites relayed by the extension: only a proven paired extension may carry one; legacy extensions and programs get AUTH_REQUIRED; the site origin is checked again (https, or localhost http in debug builds only).
- Relayed requests sign only on the network and address their review showed, rechecked before submit.
- Removing a paired extension disconnects its sites (accountsChanged with no accounts) before forgetting them.
- Direct sites: the handshake Origin is the site (https only; localhost http in debug builds); body site and origin ignored; only ping, site_hello, site_request, site_cancel and sites_subscribe; site_hello says nothing until the site is connected; events only to pages of that origin.
- Web pages are capped apart from the extension (32 open, 6 per origin, own handshake limit) and do not count as a connected extension.
- Site review amounts: raw micro-OCT amounts were shown as OCT (1 OCT read 1000000 OCT); labels are now exact OCT, and a non-integer or negative raw amount is INVALID_PARAMS.
- Site fees: a site's own fee is kept only when it is a whole number at or above the live minimum, else the live recommendation; no live fee, no review.

- Private operations no longer run side by side: encrypt, decrypt, claim, private send, key refresh and turning private on run one at a time in one proof queue, in the order confirmed, and the fee each review showed is read again before its job starts.
- Create showed the recovery phrase and the private key in plain text with Copy All. Create no longer shows either: the wallet carries a Back up flag in the vault until its phrase is written down on the Backup screen (password or Touch ID first, words blurred until held, no copy, no private key).
- The lock screen opened the Touch ID prompt by itself, also on a cold start. Touch ID now runs only on a tap.
- wallet_create no longer returns the recovery phrase to the UI.
- dApp events went to every connected site; each now goes only to the sites connected to the wallet concerned (account, balance, network, lock), and a transaction's outcome only to the site that asked for it while it is still on the signing wallet. Native dApp windows get no event unless it names their site.
- The local WebSocket (127.0.0.1:19345) took any extension, opaque (null) origin or local program, and every wallet request shared one site, ws://localhost. Rust now reads the handshake Origin: web pages, null, file and other origins are refused; only the 0xio extension (its Chrome id or a Firefox install origin) and programs without an Origin connect, and each request is answered under that client's own site. Handshakes, pairing requests and wallet requests are rate limited.
- Any program on 127.0.0.1 could pose as the desktop or the extension. The extension and the desktop now pair once (X25519 exchange, the same 6 digit code shown on both, approved in a desktop review) and prove the pairing secret to each other with HMAC over fresh nonces on every connection before any proof or key material; the Origin header alone unlocks nothing. Extensions 3.0.3 and older, which cannot pair, may still run their own proofs (init with their own key and the proof calls they always made, nothing else) while Allow older extensions without pairing is on; turned off, they are refused and run proofs locally. Programs pair with a token after a review that shows their name and a code. Paired apps in Settings lists them with Remove, which also closes their open connections at once.
- Bulk send without a password signed every row with no review. It now always opens a review (wallet, every recipient and amount, total, fee per send and in total, network) with Reject and Send; Touch ID or the password follows when set.
- Settings showed the recovery phrase in plain text with Copy, and Key Info showed the private key with Copy. Recovery phrase now opens the Backup screen (password first, hold to show, no copy); Key Info asks for the password first, keeps the private key blurred until held, has no copy for it and says plainly what it controls. Export phrase and Export private key on the Wallets page take the same paths.
- A new wallet from the Wallets page showed its phrase and private key with Copy. It now works like Create: Rust keeps the phrase, the wallet opens with Back up on Home, and the backup runs from there.
- A sealed Create left an unsealed wallet with Back up on when the app quit on the phrase step. The vault now marks the wallet as waiting for its seal; after the next unlock the app opens only the Backup screen for it (password, hold to show) and seals it once the words are written down. A private key cannot be exported while the seal waits.
- Claim signed with no review. Each Claim now opens a review of that one transfer (amount, sender, live fee, private balance after) with Reject and Claim; Touch ID or the password follows when set.
- Fees fell back to 1,000 or 1,000,000 OU while loading or after a failed read, and transaction builders, contract calls and site requests made one up when none was passed. No fee is ever made up now: reviews wait for a live read and the signer refuses a missing fee.
- Site send, contract call, sequence, sign and claim requests signed a made-up fee; they now sign the site's own fee or a live read, shown in the review.
- Send, encrypt, decrypt and claim sign the reviewed fee only while the live minimum is not above it; otherwise the review shows the new fee and asks again.
- Contract deploy and call in the editor, token transfers, Circles create and upload and NFT send signed with no review at fixed fees (50,000,000, 1,000, 200,000, 5,000 OU and NFT presets). Each now opens a review with Reject and the verb at the live fee for its op (deploy, call, deploy_circle, circle_asset_put by encoded size) and signs nothing until that fee is read.
- Site claim_private_transfer approved up to 25 claims with no amount. The review now shows the total, the count, each transfer of a short batch and the fee per claim and in total; the cap of 25 holds.
- Site deploys fell back to the size rule when the fee read failed; they now refuse with no review.
- The page provider sent a 3,000 OU fee on every callContract without one; the wallet now prices it live.

### Added

- Notification centre under the bell, per wallet and network: transfers in, private transfers to claim, results of your actions (failed ones with Try again), site and pairing requests, a key update on hold, an update ready and Touch ID turned off; unread rows filled, one action each, Mark all read; the count only counts what needs you; the gear sets which also show on macOS.
- Sites through the extension (0xio-site-relay-v1): reviews in the menu bar, Reject and the verb, Touch ID or password after.
- Menu bar Requests list grouped by site with Reject all; repeat connects merged; the first request opens the panel, later ones raise the icon count.
- Relayed site queue: 3 waiting per site, per-site rate limit, tab close and Cancel drop requests; requests no longer block the socket.
- Settings, Connected sites per network for relayed sites with Disconnect; Remove in Paired apps says how many sites it forgets.
- macOS notification for a site request that waits while the menu bar panel is closed: one per site, never for the first request or with the panel open; a newer request of the site replaces it; a click opens the panel on that site's request or its group in the Requests list; removed once the panel opens or the site has nothing waiting.
- Settings, Paired apps: Notify me about site requests (on by default); shows Off in macOS settings with Open settings when macOS blocks them.
- Sites straight from the browser (0xio-site-direct-v1): a web page connects without the extension and every request is reviewed in the menu bar like a relayed one; Connected sites and the review say Direct from browser.
- Settings, Security & Privacy, Connections: Websites can connect without the extension (on by default; off closes open pages at once). The status panel shows it and Forget unused pairings after.
- OPTIONS preflights answered with Access-Control-Allow-Private-Network.

- Proofs strip on Privacy in a reserved slot: what runs and what is next when two or more jobs wait, or the proof that stopped with Remove and Try again.
- Progress pop-up for every send and proof, with Hide to a small progress toast that opens it again; results come as toasts (plain words, avatar and name, View opens the History row, five seconds, hover holds, a swipe right closes, three at most).
- Network fee choice on every send, encrypt, decrypt and claim: Slow (live minimum), Normal (live recommended), Fast or Custom at or above the live minimum, in the form and in the review.
- Claim all: one review and one Touch ID for every waiting transfer the balance's layers allow, each claim its own job, one toast when the last lands.
- Turn on private balance, migrate and refresh key reviews as pop-ups; a key update on hold pauses the move field and the claims with Check again.
- Send recipient as one field: a press opens the picker with Recent, Contacts and Your wallets and a search that takes a pasted address (Use this address).
- Layers mood on the desktop mascot.
- Settings shows a live panel beside each tab: Touch ID, auto-lock, paired apps with their last use, older extensions, connected sites and backups per wallet with Back up; a live drawing of the app, the menu bar panel and the lock screen; the latest epoch (read every 15 s while Network is open), latency with recent calls, hosts and one ping per network; version, update status and last check; cache sizes, PVAC checks in memory, proof threads of the cores and the size of today's log.
- system_info command (read only): proof threads in use, cores and today's log size.
- Update checks keep when they last ran.
- Settings, Paired apps: Allow older extensions without pairing (on by default) and Forget unused pairings after 7, 30 or 90 days or Never (90 by default); each paired app shows when it was last used.
- Sites keep their own wallets per network: several wallets per site, the open one used when it is among them, the last one kept otherwise, never disconnected by a wallet switch. Sites approved before move over with the wallet open at the time, on every network.
- canSign on connect, connection status, wallet info and account changes; watch-only wallets answer every signing request and getPublicKey with WATCH_ONLY (SDK 2.10.0).
- deploy_contract for sites: review of contract address, code size, constructor params and fee (node fee, at least 200,000 OU plus 1,000 per KiB, a site may set up to 50,000,000 OU), then Touch ID or password; refused if the contract address moved.
- Connected sites page (Settings and the browser): sites with their wallet in use, a site page to remove a wallet, connect another or disconnect, each with a confirm.
- Site chip in the browser bar: the site with its wallet, or Not connected, which opens the connect review.

### Changed

- Circles: deploy and upload reviews are the review pop-up with the fee chooser; the circle id, path and address fields, the file drop, the status note (no close X, no green or blue tint), the encrypted switch and the guide use the new look; the duplicate Browser button is gone; the guide has no ticks or tinted tiles; copy translated (the guide's long text stays English).
- Contracts: the editor, problems, audit and output panels, the deploy card and the Contracts list, Interact, Verify and Tokens use the new look (pill tabs, no tinted chips, ticks, close X or bordered boxes); deploy, call and token transfer reviews are the review pop-up; tracking a contract is a pop-up; copy translated.
- Automations: the preview behind Coming soon uses the settings look (raised groups, plain rows, switches, segmented choices, no tinted chips or status pills); auto encrypt and auto decrypt share one card; running a preset opens the review pop-up; copy translated.
- Turning on the private balance from Home's tag opens the same review pop-up as Privacy (wallet, network, live one-time fee, public after, Reject and Turn on); the sealed circle passphrase is a pop-up in the new look with an elapsed clock while it decrypts.
- NFTs: the detail page sits on the shared frame (art on the page, facts and actions in the panel beside it); send, list, change price, cancel and import open as a side sheet with no outline or close X, reviews as rows with Reject and the verb, and the send fee uses the fee chooser; card badges are neutral dark pills; all copy translated.
- Ciphertext map: picking a layer only lights it and its path; the map no longer re-centres on it (only Focus deepest moves the view).
- Browser: each ecosystem logo and its name sit centred in their tile.
- Browser: the open-site toolbar, the address field and the loading line are in the new look (no outlines, a fixed slot for the loading line); the wrong network notice for a circle floats over the page in neutral grey with Switch and open, names the network (Octra Testnet), and clears on the next navigation or once the wallet is on that network; the landing notices float the same way and have no close X; Browser settings is a new-look pop-up (Sites, Data, Security) that closes on outside click or Escape. Browser copy goes through the five languages.
- Ciphertext map: the radial map sits on the black page and fills the space under the summary (no fixed height, nothing cut off); the picked layer, its spokes and the layers it was built from are white, everything else grey; hovering a lit spoke names the index; the picked layer's facts (rule, depth, parents, edges, sigma density, R commitment, slot bindings) and the layer list sit beside the map, or in a strip under it in a narrow window; it opens on the deepest layer. The info icons are gone.
- NFTs, Wallets, Address book and Browser put their main content straight on the black page like Home and Receive (side panels keep their card); ecosystem and bookmark tiles have no background at rest, only a light fill on hover; the NFT shelf menu and undo bar lost their outlines.
- Receive: Waiting to claim shows on both the Mainnet and Testnet tabs (read for that tab's network); on the tab that is not the active network it offers Switch to that network. The code sits higher, under the title, and the side panel keeps its card while the code stays on the black page.
- Receive in the new look: the code centred on the page (wallet, code, address, Copy address, Add amount, Save QR), a request turns the code and Copy into octra:<address>?amount=<OCT> as the app builds it, Copied changes in place; beside it at wider windows the address's type, network, private transfers, waiting to claim and recent incoming for Mainnet or Testnet. The classic look and its top bar and bell are removed.
- Address book: a star on every contact row (shown on hover, always shown when set) and beside the contact's name in its panel marks favorites, which list first; the Favorite On/Off row is gone.
- Ciphertext map: the summary is one compact row above the map (base layers, layers, edges, size, wire hash, Open Privacy), and the map gets the full width; sigma and slots stay in the map's layer details.
- Home actions sized for the desktop: the white Send key on the balance's left edge with Receive, Privacy and History right after it (words at full width, round buttons with tooltips in a small window), the claims count on Privacy, and ⌘S, ⌘R, ⌘E and ⌘Y.
- Privacy shows where each balance lands under the balance itself while you type (After 11,245.77 OCT), instead of a Public after and Private after line that a small window cut off.
- Taglines, helper lines and secondary labels removed across Home, Send, Privacy, Settings, History, NFTs, Contracts, Wallets, Address Book, Browser, Circles, Ciphertext map, Automations, Connected sites, the reviews, the password sheet and the lock screen; the watch-only screen is in the new look.
- The command palette (Cmd+K) is a list with a preview: pages, actions, contacts, wallets, tokens and transactions; a pasted hash or address leads; Enter runs the row, Cmd+Enter its second action; recent items per wallet and network; money actions open their screen and review.
- Header: Search, the bell and Lock sit in one quiet group at the top right; the Refresh button is gone for a status beside it (Updated 12 s ago, Refresh on hover, Could not update with Retry); Lock has ⌘L; the bell count is white and its panel uses the new look.
- History, NFTs, Contracts, Wallets, Address Book, Browser, Circles, Ciphertext map, Automations and Connected sites share the look of Home and Settings: black surface, the same title row and pill tabs, raised cards with no outlines, black and white controls.
- History, Wallets, Address Book and Connected sites keep a panel beside the list for the picked row (receipt, wallet details, contact, site); History adds day groups and filters for sent, received, private and contract rows.
- NFTs shows a collection summary beside the shelves, and an empty state with where to find NFTs; Browser shows recent and connected sites beside the ecosystem, with Try again when the list cannot be reached.
- Circles moves deploy into a panel (from, visibility, network fee, Review deploy); Ciphertext map gets an empty state and a summary panel beside the graph; Automations shows Coming soon with Open Privacy over a dimmed preview.
- Confirming with a password is a small sheet in the middle of the window over the review (where the Touch ID panel shows): the password, Use Touch ID, Reject and Confirm; a wrong password says so in its own line and shakes the field, with nothing moving. Titles in sentence case.
- Tauri 2.10 -> 2.12 with its plugins (notification 2.7, updater 2.14, http 2.8, dialog 2.8, store 2.5, shell 2.5, biometry 0.2.8).
- Notification clicks are reported by the system now; switching to the app with Cmd-Tab or the Dock no longer opens the panel.
- Send rebuilt like Home: the amount, the recipient and the message on the left, the live summary with the fee on the right, an action bar with the reason Review waits; Review opens a pop-up over the whole window, Send turns it into the progress, the result is a toast and the form clears. Bulk keeps its tab.
- Privacy rebuilt: public and private balances side by side with one move field between them (the arrow turns Encrypt into Decrypt), Waiting for you and Recent below, every action reviewed in a pop-up.
- Proof steps name the real step (encrypting, proof, range proof, signing, broadcasting) with elapsed time only; encrypt has four steps, decrypt, claim and private send five.
- No close X on the fee picker, Touch ID or password prompt and key update dialog; the key update dialog is neutral with Not now beside the verb.
- Home in the extension's look as a sample (Dim, Day and Octra, Home only): USD total over a trend coloured day line, Encrypted tag on private OCT, Send key with a Receive, Privacy and History dock, activity opens its details in place.
- History has Mainnet and Testnet pages for the address; picking a page no longer switches the active network. Each row names its network (Octra Mainnet, Octra Testnet, a custom node on Mainnet while active) and test rows carry the Testnet tag.
- History contract calls read as actions (Swap, Approve, Revoke, Mint, Transfer, Bridge, Claim, List, Buy, or the method in words) with the contract's name or a middle cut address; calls that moved nothing show no amount.
- Transaction details open in a side panel that closes on a click outside or Escape: Status, Type, Method, Contract, named arguments (SwapVault lock, OCT bridge), Network fee, Network and explorer link, with View call data listing every argument.
- Site reviews show the site, the facts and the wallet under Signing with, with Reject beside Connect, Sign, Send or Deploy; a click outside or Escape rejects. Connecting with a watch-only wallet says so and offers the wallets that can sign.
- Browser settings point to Connected sites instead of the old hover-only list.
- Onboarding steps match the extension: secret, password, confirm password on its own step, Touch ID or Windows Hello offer, then Your wallet is ready with the Octra address. One primary button in the same place on every step, text Show and Hide on password fields.
- Import is one field for a recovery phrase, a private key or an Octra address (watch-only). It names what it found, offers the close word for a mistyped one, and previews the wallet with its balance; Rust derives the address before anything is saved.
- Hell mode moved to Advanced options as Seal recovery phrase. A sealed Create shows the phrase once (hold to show) before the seal goes on; a sealed import is sealed after it is saved.
- The lock screen says how many attempts are left before a lockout and counts the lockout down, from the unlock limit kept in Rust.
- Settings in the extension's look: five tabs in a pill switch (arrow keys move between them, the open one is remembered), raised groups of rows, Home's wider canvas above 1600 wide.
- Settings: sidebar size and groups, Key info, the AI contract assistant and the network form open one level down with Back.
- Settings wording: Light is Day, Danger zone is This computer with Reset wallet in plain red, Check Now is Check for updates, Export and Import settings are one Settings file row, labels in sentence case.
- Accent presets drop orange and purple; a saved one falls back to the theme accent once. Custom network colours drop amber, purple and orange.
- Hell Mode and Reset wallet reviews show Reject beside the action; Settings dialogs have no close X.
- The PVAC key status card left Settings, Advanced; it stays on Automations.
- Settings, Security and Privacy marks Recovery phrase Not backed up while the active wallet's phrase is not written down, and the panel lists every wallet's backup state.
- Home shows Back up first in its tag slot while the wallet's phrase is not written down, ahead of the private tags, as in the extension.
- Lock screen background is a combination dial in the top left: three rings of teeth (the outer one is the OCT price over the chosen range, today lit with the price beside it), a notch ticks with each typed character, Unlock dials the rings onto their marks and slides the bolt back without delaying the unlock, a wrong password spins them back. Two tones plus the lit tooth in Dim, Day and Octra, 30 frames a second only while a ring moves, one still frame under reduced motion. The Appearance preview draws it too.
- Default wallet names match the extension: Main Vault for the first wallet (was Wallet 1), then Wallet 2, Wallet 3; a derived account is the parent's name and account number (Main Vault 2, was Main Vault #1).
- New, imported, watched and derived wallets get a numbered name (Imported Wallet 2) when the name is already taken; numbers go past the highest one in use.

### Fixed

- Privacy offered Review migrate again while a migration (or key refresh, or turning on) was already running; the slot now shows it running with Show progress.
- App messages share the result toasts at the bottom right (no X, no coloured outline, hover holds them); the network upgrade notice on Privacy no longer shows twice.
- On a small window the Send and Privacy amount showed one digit; the figure now shrinks to the space it has as digits are added, and Max and the token picker sit on the Amount caption row.
- Page titles no longer clip letters that drop below the line (the g in Settings).
- The Settings status panel scrolls on its own, so a long Backups list is not cut off; its labels wrap instead of ending in an ellipsis.
- frontend_log runs off the main thread, so a stalled stderr pipe under tauri dev cannot block the app.
- Site connect reads requestPermissions (the SDK's name) as well as permissions.
- Pre-connect reads (register_dapp, getConnectionStatus, getNetworkInfo, get_private_capabilities) no longer ask to unlock; a connected site keeps its session while 0xio is locked.
- Settings showed 15 minutes as the PVAC verification cache default while the app used 30; both read one default now.
- Dropped and expired transactions were missing from History; they show as Failed with Replaced or dropped in the details. A transaction pending for over 5 minutes reads Still pending.
- Contract method names were cached by hash alone, so a hash on the other network could take its name; they are kept per network and hash (400 at most) and read on the row's own network.
- README listed History filters that do not exist.
- Max ignored the fee. Public send and encrypt Max leave the live fee; token sends, decrypt and private sends check that public OCT covers it; bulk send fits the total plus a fee per send; Review stays off with a plain error otherwise.
- Claim Private after added every waiting transfer though one is claimed per press; it now adds only the transfer being claimed. Any waiting transfer can be claimed, oldest first.
- While a fee loads the slot shows the last live fee dimmed or a placeholder; a failed read shows Unavailable with Retry.
- Fee reads are no longer kept across restarts.
- Dropped the BLS12-381 and 18 second claims from the privacy screens.
- Menu bar Max waits for the live fee.
- The NFT market review showed " OU each" while the fee loaded; it shows the fee slot and List stays off until the fee is read.
- Preview address in the editor reserved a nonce it never released.
- Fee and balance refusals (fee changed, fee short, insufficient balance, fee unavailable, wallet or network changed) show in all five languages, in the menu bar too.

## [0.5.5] - 2026-10-17

### Fixed

- Menu bar encrypt, decrypt, private send, migration, key update and setup no longer fail with "The network fee changed. Review again." on almost every try: the recommended fee moves on each read, so the reviewed fee is signed as shown while the network still takes it, and the review is asked again only when the network's minimum is above it. Same rule in the key update dialog, Migrate balance popup and setup review.
- Menu bar CLI: a review whose fee lapsed is shown again with the new fee, one y signs it.

## [0.5.4] - 2026-10-17

### Security

- Menu bar private send is refused before the review unless the private balance is ready: a due migration, key update, setup, waiting or stuck balance shows its status with Migrate, Update or Turn on in both themes.
- Menu bar private send re-reads the private balance after approval and stops before any proof work when it is not set up, needs a migration or key update, or is waiting for the network.
- Set up private balance on Send, Encrypt and Decrypt no longer submits the paid setup at once: it opens the Home setup review with the wallet, network and live one-time fee, then Touch ID or password. The reviewed fee is the one signed; a changed fee, wallet or network is refused, and a failed fee read blocks with a retry.
- Main window private send is disabled before the confirm while the private balance can't be proven, with its status in the Send button slot.
- Encryption key update dialog (key rotation, legacy balance migration, empty legacy balance reset, key-bound migration) shows the wallet, network and live key_switch fee, then asks for Touch ID or password. The fee shown is the one signed; a changed fee, wallet, network or update is refused, and a failed fee read blocks with a retry.
- Migrate balance popup shows the wallet and network, asks for Touch ID or password, and signs the fee it showed. It no longer signs a fee quoted at submit when its own read failed; a changed fee, wallet or network is refused before any proof work.
- Every key update, migration and setup signs only a reviewed fee; none quotes a fee of its own at submit.

### Fixed

- Menu bar panel opens over other apps' full-screen Spaces (macOS 13+).
- Menu bar icon click brings a panel left open without focus to the front instead of closing it; a second click closes it.
- Menu bar panel opens on the display that was clicked, at the right position on mixed-scale displays.
- Menu bar errors: migration, setup and unprovable balance guards and a recipient without private receive show plain copy.
- Main window private send is disabled while the encryption key differs from the chain's, like encrypt and decrypt.
- Encrypt and Decrypt are disabled before the confirm while the private balance can't be proven, with its status in the button slot, like Send.

## [0.5.3] - 2026-10-17

### Security

- No service keys in the build: price, history and RPC proxy calls go without a key.
- Menu bar: a send, encrypt or decrypt approved with Touch ID could sign on a network switched to during the prompt. Every approved request now runs on the wallet and network its review showed, or is refused.
- Menu bar: fees are read live on the active network and never fall back to a default. A failed read blocks with "Network fee unavailable. Try again." and a retry.
- Menu bar send and private send carry the reviewed fee; a different live fee is refused, the reviewed fee is the one signed.
- Key updates, migrations and Turn on read the key_switch fee strictly; no 1,000,000 OU fallback anywhere.
- Menu bar CLI: Ctrl+C at a password prompt no longer prints the typed password; an empty Enter no longer spends a password try.
- Menu bar CLI: a review lapses when the wallet, network, lock or fee changes before y; one signing job at a time; Ctrl+C no longer reports a cancel for a transaction already running.
- Menu bar CLI: amounts past 6 decimals, a decimal comma (1,5), 0, negatives and exponents are refused instead of truncated, misread or read as a name.

### Fixed

- Menu bar Migrate and key update fees no longer get stuck on Checking; a failed read shows a retry, and the quote follows a network switch.
- Menu bar balances load for the active wallet and network whichever screen the window shows.
- Menu bar private send checks that public OCT covers its network fee.
- Menu bar errors show plain copy instead of node or RPC text.
- Menu bar copy: Insufficient balance, Insufficient public OCT for network fee; Turn on shows its fee in OU; encrypt, decrypt, Migrate and Turn on reviews show the network.
- Menu bar messages, fee placeholders and private status lines keep their space, so buttons no longer move; the key update confirm resets on a wallet or network change.
- Menu bar CLI: Ctrl+L clears without locking the wallet; quit needs the whole word, no prefix or typo.
- Menu bar CLI: scrollback, history and a running job survive hiding the panel and a theme switch; an unanswered review lapses on reopen.
- Menu bar CLI: yes signs at [y/N]; 0xio foo names foo; Down keeps a typed line; Tab is off at password prompts; no doubled password line; Touch ID is offered only when on; no wallet no longer reads as watch-only; an unloaded balance says so.
- Menu bar CLI: review, status and header values wrap in their own column; the scrollback stays where you scrolled while balances update; fee errors use the standard copy; contact names with filler words (Bank of Mom) resolve.
- Menu bar CLI: the field is labelled Password at password prompts, only the scrollback is a live region, and the busy dot stops under Reduce Motion.

### Changed

- The Tasks screen (developer FHE tools and sample contract calls) is removed; saved sidebar layouts drop it.
- NFT gallery: a hide can be undone for four seconds.

## [0.5.2] - 2026-10-15

### Added

- Menu bar panel: Private, next to Send, Receive and Lock. Encrypt or decrypt with the live fee, a review before anything is signed, then Touch ID or your password. When the private balance is due for its refresh, the review says so and runs it first (2 transactions). A balance only the app can fix opens 0xio Desktop.
- Menu bar Private: Refresh balance on its own when the refresh is due, with a review of the live fee, approval, and a wait until the network serves the refreshed balance.
- Menu bar Private: Turn on private balance for a wallet with no key yet, at the same live one-time fee as the Home tag. Without enough OCT it says how much to add.
- Menu bar Private: setup and refresh waiting on the network, and key updates the network holds, show a status line in the panel instead of sending you to the app.
- Menu bar Private: Migrate balance in every case the app offers it. The Migrate balance popup's migration (also for a held balance once the network opens it) and the key dialog's updates (key rotation, legacy balance migration, empty legacy balance reset, key-bound migration) each get a one-line review with the live fee, the same confirm the app asks for, Touch ID or the password, progress, then Migrated. The app runs the same code and checks wallet, network, fee and mode again before signing.
- Menu bar Private: a wallet whose key differs from the network's gets Update encryption key when the node takes it, instead of "Nothing to do right now".

### Changed

- Menu bar panel redesign: liquid glass (native glass on macOS 26, the system material before it) with a live engine status line, the balance up front (click to hide) and a command line: send 10 to oct..., receive, private, claim, lock, open. A command only fills the form; every send still goes through review. Network, Lock now, Open at login, Open and Quit move into the ••• menu.
- Menu bar panel keeps one fixed height on every screen; long screens scroll inside it. Cmd+L locks.
- Menu bar themes in Settings > Appearance: Match app, Original (solid, the app's colours), Smoke, Frost, Octra, Clear, Phosphor, Ember and CLI. CLI turns the panel into a terminal: no buttons, 0xio --help lists commands, / commands, history, tab completion, a review and y before anything is signed, QR code, theme switching.
- Menu bar command line: any word order, typos, amounts as max, half, 25% or 1.5k, private or public words, recipients by contact or wallet name or address prefix, a live line saying what return will do; a complete send opens straight on review.
- Long balances and amounts shrink to fit. The wallet list and the ••• menu close on a click outside.
- Menu bar status says Private proofs on instead of Engine ready.
- Closing the window, Cmd+W or Cmd+Q keeps the app in the menu bar and hides the Dock icon. Opening the window (menu bar, Finder, Spotlight, Dock) brings the Dock icon back.
- Open at login starts in the menu bar with no Dock icon.
- Menu bar Private: no balance sends you to 0xio Desktop any more. Past the layer limit and unprovable balances show the reason as a status line, since no wallet can migrate them.
- Menu bar Migrate balance pays the popup's live quote (the fast tier when a prepared migration is reused).

### Fixed

- Contracts: in a short window the code editor no longer collapses under the Build and Audit bar.
- Token details: in a short window the price chart no longer runs under Send, Receive and Encrypt.
- Clicking the menu bar icon on another desktop closed the panel left open on the first one instead of showing it.
- The menu bar panel closed when the Touch ID prompt appeared, leaving the approval with nowhere to show the password step or progress. It stays open through the prompt.
- Locking (window, command palette or menu bar) fired the Touch ID prompt right away on the lock screen.
- Quit in the menu bar menu and panel did nothing; it now quits.
- Reopening the app from Finder or Spotlight while it runs in the menu bar shows the window.
- The menu bar engine card said "A private proof for the extension" for this wallet's own encrypt and decrypt. It now names the extension only for the extension's proofs.

## [0.5.1] - 2026-10-12

### Added

- Set up private: a blue tag on Home once a wallet with no private key on chain holds enough OCT for the one-time network fee. It opens a review with the live fee; Turn on registers the key after Touch ID or the password, and the tag goes away.

## [0.5.0] - 2026-10-11

### Fixed

- Touch ID could not be turned on in the installed macOS app ("Failed to store credentials in the OS keystore"): the app was not allowed to use the protected keychain. It now ships with a Developer ID provisioning profile that allows it, and a password kept by an earlier Touch ID setup moves into the keychain on the next unlock.
- A transaction timed on an exact second (about 1 in 1000) could fail the node's signature check. Signing never uses a whole-second time now.
- NFTs could go missing from the gallery: a busy node answer ("Program view busy") was read as "not yours", and the empty result was kept. Busy answers are asked again, a scan that cannot finish keeps the pieces it knew, and the scan stops at the contract's own next id instead of a fixed 200.
- The node's holdings list was read as one page only; every page is read now.

### Security

- A page in a dApp or browser window could call every app command: read the private key, sign, reset the vault, write files. App commands now need a capability; dApp windows reach only the wallet bridge.
- Wallet, vault, workspace and window commands refuse any caller but the wallet window.
- A dApp could take the bridge answer meant for another dApp by reusing its request id. Answers are also dropped once the window has left the requesting site.
- A send, claim, contract call or dApp request started on one wallet or network could finish on another after a switch. Every flow now stays on the wallet and network it started on, and caches are kept per network.

### Added

- Menu bar panel: click the 0xio icon for your wallet at a glance. Switch wallet or network, copy the address, show the balance (hidden until you ask), claim private transfers, send (with a review before anything is signed, then Touch ID or your password), receive with a QR code, lock, turn on Open at login, open the app or quit. When locked, unlock there with Touch ID or the password. It opens over full-screen apps too.
- The menu bar icon shows what the app is doing: an outline when locked, the slash turning while a private proof runs, and the number of transfers waiting to be claimed.
- Open at login starts 0xio Desktop quietly in the menu bar.
- Every NFT collection the wallet holds shows up without an import, including collections on the 0xio NFT list (and, on mainnet, the 0xio indexer) that the node does not list. Import stays for any other contract.
- Hide a collection or a single piece from the gallery, with Undo; hidden ones wait on the Hidden shelf, per network and wallet.
- Living NFTs that read the chain reach only their own network's RPC; gallery thumbnails stay offline.
- Change price for a listed NFT: cancels, approves again when needed and relists, with every signature shown on the review first.

### Changed

- The lock screen has the 0xio mascot: it wakes when you move the mouse, follows the pointer, dozes when left alone and turns its dial while unlocking.
- New 0xio logo on the app icon, the menu bar icon, the lock screen and the sidebar. The menu bar icon is drawn at its real Retina size, so it is sharp instead of slightly blurred.
- NFT gallery: the newest piece leads, then one shelf per collection, newest first. A piece opens as a page with its status, who holds it and two actions; listing, changing the price and cancelling run in a drawer behind a review.
- Expected contract reverts and busy views no longer fill the log as errors.

## [0.4.2] - 2026-09-23

### Fixed

- Web dApps in the built-in browser showed "This content is blocked" in the installed app: its security policy never allowed https pages in the browser frame, so they only ever loaded in development builds. They load in the frame now, as do local development servers.
- Hosts the browser wrongly learned as refusing to be embedded while every frame was blocked are forgotten, so dApps that do load in the frame are no longer pushed into a separate window.
- System browser, Search the web and the NFT docs link opened nothing: they used a browser call the app window ignores. They open your system browser now.

### Security

- Only the page loaded in the browser can make wallet requests. A frame nested inside it, such as an ad or an embed, could raise connection and signing prompts, and the wallet's answers went to the page with no target check.
- Each Octra circle is its own site for dApp permissions. Staged circle pages shared one opaque origin, so a permission given to one circle held for every circle.

## [0.4.1] - 2026-09-23

### Fixed

- Living NFTs never played in an installed app: the program ran in a frame the app's own security policy blocked, which showed as an empty square on Mac and "This content is blocked" on Windows (it only ever worked in development builds, which have no such policy). Each program is now served from the app's own address with a policy of its own: its code runs and it can reach nothing on the network, so it still reads the chain only through the app.
- oct:// sites in the built-in browser, and the Circles preview, were blocked the same way in installed builds and now open. Sites stay isolated from each other and from the wallet.
- One slow answer from the node while loading a living NFT was remembered for the rest of the session, so it never retried and every NFT of that collection showed no picture. It retries now.

### Security

- A site's message signature signed the raw text, so a site could pass transaction JSON as a "message" and receive a valid transaction signature. Messages are now signed in the 0xio Signed Message format, the one the extension, the app and the SDK verify.
- A connected site could move 0xio to another network without asking. The switch now asks, naming both networks.
- Approvals come one at a time: a second site request while one is on screen is refused instead of replacing it. An approval given after the wallet or network changed signs nothing and says so.

## [0.4.0] - 2026-09-22

### Changed

- The update prompt shows real release notes when a release is published with them.
- The lock screen backdrop has volume. The cipher field is drawn as 3D line work instead of flat outlines: the four layers are wireframe globes threaded on a tube ring, their edges are tubes that leave the side of each globe, and the disc underneath is a perspective grid. The work moves as one continuous queue you can follow: the light arriving at a globe spreads round its outline, fills its tubes one after another, then runs along the ring into the next globe. It stays dimmed and clear in the middle behind the unlock controls, follows the Dim, Day and Octra themes, redraws at 30 frames a second, and holds still under reduced motion.
- The 0xio logo on the lock screen and in the sidebar follows the theme: white on black in Dim, blue on white in Day and Octra. It is drawn from the brand artwork, so it stays sharp at any size.
- The lock screen shows the OCT price quietly: the price over a day, a week or a month (Settings > Appearance > Lock screen price chart) drawn as a low outlined ridge on the far edge of the backdrop, standing still while the disc turns, with the price and its change in small type at its end. It is market data from the 0xio oracle the app already uses, never anything from the wallet, and it appears once the first price is known. The chart is kept on this device, so it shows at once when the app locks and refreshes in the background (every 5 minutes for a day, 30 for a week, an hour for a month). In Day it is drawn in the theme blue, in Octra in white.
- The app calls itself 0xio Desktop everywhere: the window title, the lock and onboarding screens, the version line and the biometric prompts all said "0xio Wallet". The name is a product name, so the translated locales carry it untranslated too.
- Type scales with the window instead of stepping at two breakpoints: one fluid root size drives every rem-based size in the app, and it follows the smaller of window width and height so a short window does not get oversized text. Roughly 14px at 960 wide, 16px at 1440, 18px at 1920 and above.
- Every hardcoded font size in the app (466 of them, 53 files) is now relative, so all of it scales. Sizes are unchanged at the 16px baseline; the smallest labels can grow but never shrink below what they were.
- Transaction cards lead with what happened: the label first, then who and when on one quiet line, and the amount inline with its symbol on the right instead of stacked.
- The Home balance figure was oversized: 85.5px at 1440 and 96px at 1920 against the 76px the design calls for. It now reads 76px on any large window and scales down from there.
- The fluid type ceiling drops from 18px to 17px, so a large screen no longer inflates every label past its intended size.
- Fixed: closing the read passphrase dialog left the circle switched to Encrypted with no passphrase, a state where every deploy and upload failed. Closing it now turns encryption back off. The upload step used a second, inline passphrase field; both steps use the one dialog.
- Token details joins the Home style, and its activity list names the contract method and stops showing "-0".
- Circles is rebuilt: the numbered step list becomes Build / Browse pills in the title row, the form sits in one panel, the floating help button becomes a "How it works" link, and the decorative icons are gone.
- Settings joins the Home style: pill tabs in the title row, recessed panels, and rows without icon tiles.
- Address Book, Circles, Dev Tools and Automations join the Home style, and the command palette now uses the sidebar's icons rather than its own set.
- Add wallet lost its icon tiles: each choice is a plain row with its name and what it does.
- The shared button is a pill everywhere: one filled primary, a raised second weight, text for the rest.
- Receive no longer stretches to the height of the window, and its QR shrinks on short ones.
- Screens hold their chrome still and scroll only their content: the wallet pill, screen title, tabs and the figures above a list stay put while the list moves under them. Applies to History, Wallets, Receive, Send and Privacy; nothing scrolls the page itself any more.
- Opening a transaction no longer resizes the dialog: it renders at once from what the list row already knows, and only the two values the node still owes (fee and epoch) sit as placeholders until they land. Measured identical, 633px in both states.
- Transaction details are rebuilt as an amount and status at the top, then who, then the chain facts, each in its own panel. The hash and both addresses copy on click, and a contract call is named by its method rather than "call".
- Modals lost their border and heavier header rule.
- History, Receive, NFTs, Contracts and Wallets join the Home style: wallet pill top bar, screen title with pill tabs, recessed panels instead of bordered cards, and quiet text where chips and uppercase micro-labels used to be. The shared Tabs control is a pill group now, so Contracts and anything else using it follow along.
- Send and Privacy are rebuilt in the Home style: no borders, one recessed panel per group, pill controls and actions, the wallet pill top bar, and screen titles with pill tabs instead of segmented boxes. Uppercase micro-labels are gone.
- Shared parts of that style live in `src/components/ui/flat.tsx`, so the next screen inherits it rather than copying class strings.
- The amount field, the FHE transform card and the fee line lost their borders and now use the same fills and type scale.
- Home is rebuilt without borders or cards: the balance sits on the page as one large figure with the 24h value line under it, a quiet accent chart below that, and the six actions as pills in three weights (Send filled, Receive / Encrypt / Decrypt raised, Claim / Swap as text). Assets and Activity share one recessed panel. Actions that a network cannot do are dimmed instead of removed.
- Hovering the chart now swaps the value line for the value and time under the pointer, instead of a floating tooltip.
- New top bar on Home: wallet name, address and network in one pill. The name or network opens a menu to switch wallet or network; the address copies. Search, recent activity, hide balances, refresh and lock sit on the right.
- Sidebar: opens expanded with Pinned, Browse and Advanced groups, collapses to an icon rail, no border. Receive moved to Pinned and Dapp Browser to Browse (saved custom layouts keep their own order). Simpler line icons, larger default label and icon sizes. The wallet card, network chip, search field and bell left the sidebar; the extension status stays at the bottom.
- Dim theme sits on a lighter charcoal (#141519 ground, #1d1e24 raised, #0f1014 recessed) with muted text lifted to keep contrast; the accent is unchanged.
- The "Key update blocked" reminder is a small amber text link beside the balance switcher.
- Recent activity (the bell) is also available from every screen header.
- Home fits the window at any size: nothing scrolls the page. The balance figure, chart and spacing scale with the window, and the Assets and Activity lists scroll inside their own columns.
- The encryption key dialog lost its warning icon, and closes on a click outside it or Escape as well as Close.

### Fixed

- The extension bridge gave up after 3 seconds when another copy of 0xio Desktop held its port, and stayed off even after that copy quit. It now keeps trying in the background and connects as soon as the port is free.
- Updating from inside the app got stuck on "Installing..." on macOS. The update was already installed; the prompt was waiting for a restart that never came. It now shows the download (size and percent), then says the update is installed with a Restart now button. A failed update says what went wrong in plain words, with the raw error under it and a Try again button, and every step is written to the log.
- Settings > Check for updates downloaded and installed on its own with no progress and the same stuck ending. It now only checks, and an update opens the same prompt.
- Restarting straight into a new version could leave the extension bridge off, because the old copy was still letting go of its port. The bridge now waits for the port.
- Turning off biometric unlock in Settings now asks for Touch ID first, or your password if you cancel it. Anyone at an unlocked app could switch it off without proving it was them.
- A wrong password on the lock screen is said in a line under the field instead of a faint floating label over the Unlock button.
- The fingerprint button on the lock screen is smaller.
- Locking and unlocking into the same wallet left the private balance failing with "PVAC not initialized" until you switched wallets. The lock tears the FHE context down; the balance hook then saw the wallet as already set up and never rebuilt it. It now re-initializes whenever the context is gone.
- The refresh icon in the top bar drew its arrowhead away from its arc.
- The encryption key dialog took longer than it needed to appear: the key check now runs alongside the balance decrypt instead of after it, and the dialog's two lookups run together instead of one after the other.
- Asset and activity rows could slide under the Activity panel and clip their amount in a narrow window.
- Every contract call read as "Contract call". History rows now name the method the transaction actually called (Unlock trusted, Lock to ETH, List NFT), read straight from the transaction instead of a per-transaction receipt lookup.
- A transaction that moves no OCT showed "-0". Rows with nothing to show now show no amount, and a contract call that does carry OCT shows it instead of hiding it.
- Sent (30d) on History counted only plain transfers, so OCT paid into a contract (a bridge lock) was missing from the total.
- A network you added (your own node) read as "Devnet" in History, where touching the toggle moved you off it, used mainnet's token list, and linked NFT contracts to octrascan. It now has its own History tab, no borrowed token list, and uses the explorer you configured. Sites are told it is a test network unless it is mainnet.

### Security

- The extension bridge no longer receives the wallet key. Extension 2.5.6 and later send a one-way hash of it, and the app derives the same private-balance keys from that hash, so whatever answers on the bridge port can no longer learn the key that signs transactions. Older extensions still send the key and are still accepted.

## [0.3.1] - 2026-09-12

### Fixed

- The macOS build could not be opened: the app carried the Secure Enclave keychain entitlement without the Developer ID provisioning profile that authorises it, so macOS killed it at launch with no message beyond "can't be opened". The entitlement is out of the distributed build for now; biometric unlock uses the same file-backed store 0.2.3 used, and Secure Enclave storage returns once the profile is embedded.

## [0.3.0] - 2026-09-12

### Added

- Lock screen backdrop is a real scene: the cipher field's disc is tilted in perspective and turns slowly on a turntable, the construction grid and a far index scale sit on deeper planes, and the whole stage leans a few degrees after the pointer so the planes separate. Layer labels stand upright wherever their layer is; each theme sets its own ink weight. Reduced motion gets the static tilted field.
- NFT overhaul: full-width gallery with side-drawer import/send, split-view detail screen, living-NFT (EUINT) renderer with poster-capture thumbnails, XNS-1 labeling with a click-to-learn hint, owned tokens visible in collections larger than 200.
- Xpectrum marketplace: list / cancel listings with USD pricing, per-token approval reads (`get_approved`), persistent operator-grant approval, mint-state pre-flight, confirm-and-verify on writes, mainnet listing enabled.
- Ciphertext Map screen: webcli-style SVG hypergraph of the balance's cipher structure, hover paths, energy pulses, one-click view of your own balance.
- Privacy guardrails: pre-flight checks on every private op, compact refresh before private ops, and a per-account claim budget that stops a claim batch before it can push a balance past the recoverable layer limit.
- Balance migration: key_switch migration with mode resolver and payload builder, v3 key-bound migration, unified Migrate balance flow (fee-quoted confirm popup, cached payload reuse, in-flight guard, "Upgrade in progress" state), and a bulk stealth-send layer budget.
- Key-bound proofs on decrypt and bound range proofs for stealth send (fixes 413 request-too-large).
- Custom networks: add your own RPC endpoint with validation, live endpoint preview, chain detection, and app-wide resolution.
- Global slow-network toast, RPC circuit breaker, 429 backoff with capped concurrency.
- Release pipeline: signed + notarized macOS builds, Windows in the R2 auto-update channel, classic drag-to-Applications dmg, Prettier format check in CI.
- Contracts IDE overhaul: real code editor (CodeMirror) with AML/OASM syntax highlighting, autocomplete for builtins, search, bracket matching, compile-error line highlighting, and an optional Vim mode.
- AI contract assistant rebuilt Cursor-style: streaming responses, three modes (Chat / Agent that applies the full updated file to the editor / Plan), Cmd+K inline edit on the selection with accept-reject preview, per-code-block Insert and Replace-file actions, and selection-aware context.
- AI providers: OpenRouter added (any aggregator via the custom endpoint still works), current Anthropic models, API keys auto-detect their provider on paste.
- Sidebar auto-collapses on the Contracts workspace and restores your preference on leave.
- The contracts IDE is now a real auditor: live compile-as-you-type (Problems updates on a pause, no Build needed), inline squiggles for instant AML rule checks (missing Program wrapper, register cap with a live regs meter, flat-args call(), unchecked transfer()), the node's formal verification report rendered in a new Audit panel, and AI security audits returned as structured findings - severity, line (click to jump), and a one-click "Fix with AI" that pre-fills the inline edit.
- Deploying is gated: formal-verifier errors and high-severity audit findings pause the deploy behind an explicit "Deploy anyway".
- Starter templates (empty, counter, token, escrow) written to the canonical AML shape; the editor buffer survives restarts; bytecode size deltas show after each build.
- Contracts tabs consolidated: Interact, My Contracts, Browse, and Verify merge into one full-width master-detail hub - tracked and on-chain contracts in a searchable list on the left, the selected contract's Interact and Verify workspace on the right, with owner/version at a glance, one-click tracking, and deploys landing directly in the hub.
- AML language surface synced with the canonical reference: payable/nonreentrant/match/assert, cipher/pubkey/u256 types, the full 60-builtin set in highlighting, autocomplete, and the AI's knowledge.

### Changed

- History rebuilt as a flat extension-style list with network tabs and correct stats.
- Token detail screen rebuilt; fee UI overhauled with every fetched preset kept dynamic; theme tokens, screen widths, and segmented pills unified.
- Settings split into a module; sidebar reorganized (notification bell moved in, network badge tightened, labeled "0xio Desktop").
- Devnet endpoint moved to devnet.octrascan.io; one endpoint per network instead of a fallback chain.
- Stealth-class ops fall back to the 1,000,000 OU fee standard; key_switch fee is queried from the node instead of hardcoded.
- Ciphertext Map restyled minimalist flat-3D: lit spheres with gradient contact shadows and per-depth perspective, hairline orbits, glow filters and centroid markers retired (pan parallax and hover energy pulses stay).
- Sidebar wallet switcher rows drop the tinted letter chips.

### Fixed

- PVAC key-status honesty: held/blocked states explained (awaiting network migration vs key mismatch), no re-prompt for an already-submitted rotation, registration goes through a key_switch tx (the bare register RPC is rejected by the node).
- Legacy cipher decrypt fallback after the canonical parity update; placeholder ciphers skipped in spend-readiness checks.
- Stealth scan paginated (survives past a thousand outputs), no longer drops its one matched output or re-runs before finishing.
- Claim panel overhaul with unified fee display on summary cards.
- Pending mempool amounts, quota-tolerant localStorage on WKWebView, HFHE writes get the tx timeout instead of the 30s read budget, clear network-timeout message instead of "Request canceled".

### Security

- Wallet deletion requires the wallet password; biometric secret stored in the OS keystore.
- dApp consent boundary enforced in the bridge; bridge key-context wiped when the last WebSocket client disconnects.
- No trust inferred from a custom RPC endpoint; untrusted token name/symbol sanitized; sealed-read hardened (integrity verified, size bounded); Sentry usage aligned with the privacy policy.

## [0.2.3] - 2026-06-09

### Added — Labz private-token RFP (dapp bridge)

Full RFP private-primitive surface, wired to the desktop's PVAC/FHE engine. Private
and FHE secret material stays in the Rust backend; only ciphertexts, proofs, public
commitments/blindings, and tx hashes are returned to the dapp.

- `octra_getPrivateCapabilities` — feature discovery (dapps fail closed when a capability is unsupported).
- FHE primitives (return-only, no broadcast):
  - `octra_encryptValue` → `hfhe_v1` ciphertext
  - `octra_decryptValue`
  - `octra_makeZeroProof` → `zkzp_v2` (returns `{ proof, commitment, blinding }` — the bound-proof scheme needs the commitment+blinding)
  - `octra_makeRangeProof` → `rp_v1` (self-contained)
  - `octra_getPrivateBalance` → decrypted private OCT
- Private broadcasting (each behind an approval popup bound to the origin):
  - `octra_sendPrivateTransfer`, `octra_claimPrivateTransfer`, `octra_registerPrivateViewKey`
- `octra_sendContractTransactionSequence` — ordered multi-step public flow under one approval.
- `octra_callContractView` alias.

PVAC is initialized on demand from the unlocked wallet's in-memory key (never leaves the process).

### Changed

- Version synced across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (were `0.2.2` / `0.2.1` / `0.1.0`).
