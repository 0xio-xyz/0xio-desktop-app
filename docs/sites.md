# Sites

How websites reach the wallet: the in-app browser, dApp windows, Octra Circles, sites relayed by the 0xio extension and sites that connect straight from a browser. Every path ends in the same dApp handler in the main window and the same review.

## Where the code lives

| Path | What it does |
|------|--------------|
| `src/features/dapp/services/dappRequest.ts` | The one dApp handler every site request runs through |
| `src/features/dapp/hooks/useDappBridge.ts` | Takes requests from the browser frame, dApp windows and the local socket |
| `src/features/dapp/screens/BrowserScreen.tsx` | The in-app browser |
| `src/features/dapp/services/siteLifecycle.ts`, `frameLifecycle.ts` | Request status and the chain watch |
| `src/features/dapp/services/circleBridgeService.ts`, `circleRead.ts` | The Circle bridge for `oct://` pages |
| `src/features/circles/` | The Circles page: your circles and publishing |
| `src/tray/SiteRequests.tsx` | Site reviews in the menu bar panel |
| `src-tauri/src/dapp/` | dApp windows, their provider and the bridge |
| `src-tauri/src/sites/` | Site records, lifecycle, relayed and direct sites, frames, notifications |
| `src-tauri/src/ws/` | The local socket, pairing and the site queue |

## In-app browser and dApp windows

- **Browser:** sites load in a frame inside the main window and talk to the wallet over `postMessage`. Only the page loaded in the browser can make wallet requests; frames nested inside it cannot.
- **dApp windows:** a site can open in its own window (`dapp-*`) with an injected provider whose surface matches the extension's (`window.octra`, `window.wallet0xio`). The window may call only `dapp_bridge_request`; Rust reads the site from the window's URL and the main window answers.
- **Rejections** from `window.octra` and `wallet0xio` carry a numeric `code`, a `message` and the wallet code in `data.code`: 4001 `USER_REJECTED`; 4100 `UNAUTHORIZED`, `NOT_CONNECTED`, `WALLET_LOCKED`, `WATCH_ONLY` and `PERMISSION_DENIED`; 4900 `DISCONNECTED`; 4901 `NETWORK_ERROR`; -32602 `INVALID_PARAMS`; -32603 `INTERNAL_ERROR` (also an answer with no code); 4200 for any other code.
- **Claims:** `claim_private_transfer` refuses with nothing sent as `CLAIM_OUTPUT_SPENT`, `CLAIM_OUTPUT_UNREADABLE`, `CLAIM_CONFLICT` (a confirmed claim the node lost, up to 10 minutes), `RATE_LIMIT_EXCEEDED` or `NETWORK_ERROR` (after the retry window). Outputs already claimed here return their earlier hashes without a review.

Pages in the browser and in dApp windows speak wallet protocol 2 over the same channel: `wallet_hello`, request ids (`rid`), `request_status`, `cancel_request` and `requestUpdate` events to the asking page only. Their records live in the same request log as socket sites under the carrier `frame`. A page reload or a closed dApp window counts as a closed page. A request without `rid` runs as before.

## Octra Circles

Circles are on-chain sites opened as `oct://`. Pages load in sandboxed frames from a listener inside the app (`src-tauri/src/sites/frame_protocol.rs`) and reach the wallet through the Circle bridge (wallet, program, sealed slot, policy, object and relay reads); a page is told only the methods that are served.

- Each circle counts as its own site, by Circle ID. An `oct://` page opened in a window speaks as its circle, so the connection and the reviews are the same as in the browser frame.
- On devnet a Circle opens by its `.oct` name (`oct://0xio.oct/docs/intro.html`). The name is read again on every open, reload and bookmark, only a confirmed Circle opens, and the site, its connection and its passphrase belong to the Circle ID, so a name that moves opens as a new site.
- The Circles page keeps the circles a wallet deployed and the files it published, per network and wallet, and publishes several files under one review, one transaction per file: public files up to 2 MiB, encrypted files up to 32 MiB.

## Connected sites

- A site keeps the wallets connected to it, per network. It follows the open wallet when that is one of them, keeps its own otherwise, and only ever sees the wallet it uses.
- Wallet events go only to the sites connected to the wallet concerned, and a transaction's outcome only to the site that asked for it. Watch-only wallets report `canSign: false` and every signing request answers `WATCH_ONLY`.
- Sites can deploy contracts (`deploy_contract`) after a review of the contract address, code, constructor params and fee.
- Settings and the browser list connected sites. The picked site shows what it can see and ask, with Manage and Disconnect.

## Reviews

Every site request is reviewed before signing: the site, the facts, the wallet under Signing with, and Reject beside the verb (Connect, Sign, Send, Deploy). A click outside or Escape rejects. Requests from the local socket are reviewed in the menu bar panel: the first one opens the panel when it is closed; later ones raise the count on the icon. A locked wallet unlocks first. Anything that signs then asks for Touch ID or the password.

While the panel is closed, a later request also posts one system notification for its site, in the app's language. Never for the first request (the panel opens) and never while the panel is open. Clicking it opens the panel on that site's review. Settings, Paired apps, Notify me about site requests turns them off.

## Pairing with the 0xio extension

The local socket on `127.0.0.1:19345` serves the 0xio extension (its Chrome Web Store id, or a Firefox install origin) and local programs that send no Origin, which pair.

- **Once:** the extension asks to pair (`auth_pair`, protocol `0xio-pair-v1` in `src-tauri/src/ws/ws_auth.rs`). Both sides run an X25519 exchange and work out the same 6 digit code from the shared secret and the transcript; the desktop shows it in the pairing review and the extension asks its user to pick it from three. A program in the middle would make the two codes differ. Nothing is kept until both the desktop's Pair and the extension's `auth_pair_confirm` arrive, in either order. A cancel, a wrong pick, Reject, the 2 minute timeout or a closed socket keeps nothing.
- **Every connection:** both sides prove the 32 byte pairing secret with an HMAC over a fresh nonce from each (`auth_hello`, `auth_prove`) before anything else runs. The extension sends no key material to a desktop that has not proved it, and the desktop runs nothing for an extension that has not proved it.
- **Older extensions:** 3.0.3 and older cannot pair. While Settings, Paired apps, Allow older extensions without pairing is on (the default), one that has not begun the handshake may send `init` with its own PVAC key and run its proof calls, and nothing else. Turned off, they are refused and run proofs locally.
- **Programs:** `{"method":"pair","name":"..."}` opens a review with a code the program shows; approving gives it a token to present next time (only its hash is kept).
- **Unpair:** Settings, Paired apps, Remove forgets the client and closes its connections at once. Pairings unused for longer than the chosen time (7, 30 or 90 days, or Never; 90 by default) are forgotten.

## Sites through the extension

Protocol `0xio-site-relay-v1`, in full in the extension's [DESKTOP_RELAY.md](https://github.com/0xio-xyz/0xio-wallet/blob/main/docs/DESKTOP_RELAY.md). It runs on top of a proven pairing; web pages still never reach the socket.

- Site messages are answered only on a connection of the 0xio extension that proved its pairing. The site is the origin the extension names, checked again: `https`, or `http` on localhost in debug builds.
- A `site_request` is queued and answered later by its id, so the socket never blocks while a review is open.
- `ws_sites.json` keeps each connected site per network, address, origin and the extension install that relayed it. Events go only to the sites that extension relayed.
- At most 3 requests wait per site (the next is refused with `RATE_LIMIT_EXCEEDED`), 60 per minute per site; repeat connects merge.
- A relayed site keeps its own network; a switch is its own review and moves only that site.

## Sites straight from the browser

Protocol `0xio-site-direct-v1`, in full in [DIRECT_SITES.md](DIRECT_SITES.md). A web page opens `ws://127.0.0.1:19345` from its own `https` origin; the handshake Origin, which the page cannot forge, is the site. An approved connect returns a site token that proves the site on later connections. Settings, Security and Privacy, Websites can connect without the extension (on by default) turns this off and closes open pages at once.

## Request lifecycle (protocol 2)

Requests that carry a request id (`rid`) get a record with a status (`pending`, `locked`, `review_open`, `signing`, `submitted`, `confirmed`, `failed`, `completed`, `rejected`, `expired`), status reads and events to the asking connection only. The same id with the same request joins it or returns its stored answer; a different request under that id gets `REQUEST_ID_REUSED`. An approved request finishes even when its page closes. The full rules are in [DIRECT_SITES.md](DIRECT_SITES.md#request-lifecycle-protocol-2).

The moves follow the shared transitions in the SDK's conformance vectors; `cargo test` checks them and the digest vectors byte for byte. `scripts/conformance.sh` runs the shared suite against the real socket, queue and request log through a Rust test server (`src-tauri/src/ws/ws_server_conformance.rs`) that stands in for the main window, the person and the chain. Both read the vectors from the [0xio SDK](https://github.com/0xio-xyz/0xio-sdk) (`conformance/vectors.json`) checked out beside this repository.
