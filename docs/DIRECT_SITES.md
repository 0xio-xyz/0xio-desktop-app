# Direct sites (0xio-site-direct-v1)

A web page talks to 0xio Desktop without the extension: it opens the local WebSocket from its own
origin and sends site requests. Every connect, sign, send and network switch is reviewed in the
menu bar exactly like a site relayed by the extension (protocol `0xio-site-relay-v1`, the
extension's [DESKTOP_RELAY.md](https://github.com/0xio-xyz/0xio-wallet/blob/main/docs/DESKTOP_RELAY.md)). Code: `src-tauri/src/sites/site_direct.rs`, `src-tauri/src/ws/ws_server.rs`,
`src-tauri/src/ws/ws_auth.rs` (`classify`, `ConnCaps`, `HandshakeLimits`), `src-tauri/src/ws/ws_sites.rs` (`web_origin`,
queue and record), `src-tauri/src/sites/site_relay.rs` (subscriptions and events).

## Who the site is

The page opens `ws://127.0.0.1:19345`. The browser sets the `Origin` header of the handshake and a
page cannot change it, so that origin is the site. The desktop never reads a site from a message.

A local program can send any `Origin` header, so the origin alone grants nothing: a connection is
the connected site only once it shows the site token (see Site token). Until then it gets what an
unconnected site gets.

- Accepted: `https://<host>[:port]`. In debug builds also `http://localhost`, `http://127.0.0.1`
  and `http://[::1]` (any port).
- Normalised: lowercase scheme and host, default port dropped (`HTTPS://App.Example.com:443`
  is `https://app.example.com`).
- Refused at the handshake (HTTP 403): `null` and other opaque origins, `file:`, any other scheme,
  `http` on a host that is not this machine, and anything beyond scheme, host and port (a path, a
  trailing `/`, user info, a query or a fragment).
- Refused while Settings, Security & Privacy, **Websites can connect without the extension** is
  off (HTTP 403, as before this feature). Turning it off also closes every open page socket; their
  waiting requests end with `USER_REJECTED`. Turning it on accepts pages again at once. The choice
  is `settings.direct_sites` in `ws_pairings.json` (default `true`).

A page pairs with nothing and is never counted as the extension (the tray's connected client
count and the bridge context ignore it).

## Methods

Every message is JSON with `method` and an optional `_id`, echoed in the reply.

| method | reply |
| --- | --- |
| `ping` | `{"_id", "pong": true}` (no version) |
| `site_hello` `{"site_token"?}` | unless the token proves the connected site: `{"_id", "v": 1, "wallet": "0xio-desktop", "protocol": 2, "kind": "desktop", "capabilities": [...]}`; once it does, also `"version": "0.6.0", "network": "mainnet"` (the network of its newest record). `token_status` (`"valid"` or `"invalid"`) is added whenever `site_token` was sent. A hello without a token leaves the connection unproven |
| `site_request` | see below |
| `site_cancel` `{"id"?, "rid"?}` | `{"_id", "v": 1, "ok": true}`; the request, if this socket sent it and it was not approved yet, ends with `USER_REJECTED` "The request was cancelled." An approved one runs on: `"ok": false`. With `rid`, `result` carries its status as `site_status` reads it |
| `site_status` `{"rid"}` | `{"_id", "v": 1, "result": RequestStatus}` (see Request lifecycle); a malformed `rid` is `INVALID_PARAMS` |
| `sites_subscribe` | `{"_id", "v": 1, "ok": true}`, then a `sites_snapshot` at once and on every change (empty while unproven) |

Anything else (`init`, the proofs, `pair`, `auth_*`, `wallet_rpc`, `site_closed`,
`site_disconnect`, unknown names) gets
`{"_id", "v": 1, "error": {"code": "AUTH_REQUIRED", "message": "A website can only send site requests to 0xio Desktop."}}`.

### site_request

```json
{ "_id": 7, "method": "site_request", "v": 1,
  "id": "<32 hex characters, unique per request>",
  "network": "mainnet",
  "request": { "method": "connect", "params": { "requestPermissions": ["accounts"] } } }
```

- No `site` field is needed; a `site` or `origin` in the body is ignored and replaced by the
  handshake origin (never framed, no top origin; the tab is the socket).
- `id` is 32 hex characters (lowercased by the desktop). An id already waiting is refused with
  `INVALID_PARAMS`.
- `network` is `mainnet` or `devnet`; anything else is `INVALID_PARAMS` "Malformed site request.".
- `request.method` is one of the relay methods (`connect`, `disconnect`, `getAddress`,
  `getBalance`, `getNetworkInfo`, `getConnectionStatus`, `register_dapp`, `switch_network`,
  `send_transaction`, `call_contract`, `contract_call_view`, `deploy_contract`, `signMessage`,
  `sign_transaction`, `broadcast_only`, `send_contract_transaction_sequence`,
  `getTransactionHistory`, `rpc_call` and the private methods; the full list is `RELAY_METHODS` in
  `src-tauri/src/ws/ws_sites.rs`); others get `METHOD_NOT_ALLOWED`.
- Before the site is connected, and on any connection that has not proven it is the site, only
  `connect`, `disconnect`, `register_dapp`, `getNetworkInfo`, `get_network_info`,
  `getConnectionStatus` and the public reads (`contract_call_view`, `get_contract_storage`,
  allowlisted `rpc_call`) run; others get `NOT_CONNECTED`. A contract view runs with the caller the
  page passes or none, never a wallet address. The
  pre-connect reads are answered without unlocking 0xio. On an unproven connection these run as
  for a site with no record: `getConnectionStatus` reads not connected, `connect` opens a fresh
  review, and `disconnect` changes nothing.

The answer comes later on the same socket, never blocking it:

```json
{ "_id": 7, "v": 1, "id": "<the request id>", "result": { ... } }
{ "_id": 7, "v": 1, "id": "<the request id>", "error": { "code": "USER_REJECTED", "message": "Rejected in 0xio Desktop." } }
```

Error codes are the relay's: `INVALID_PARAMS`, `METHOD_NOT_ALLOWED`, `NOT_CONNECTED`,
`RATE_LIMIT_EXCEEDED`, `USER_REJECTED`, `AUTH_REQUIRED`, `REQUEST_ID_REUSED`, and the wallet handler's own codes
(`WALLET_LOCKED`, `NETWORK_CHANGED`, `TRANSACTION_FAILED`, `WATCH_ONLY` and so on).

### Events

Pushed only to the open sockets of that origin that proved the site, from the moment they do (no
subscribe needed):

```json
{ "event": "site_event", "v": 1, "origin": "https://app.example.com", "kind": "accountsChanged", "data": { "accounts": ["oct..."] } }
```

`kind` is `accountsChanged` (`{accounts: []}` on a disconnect), `networkChanged` (data carries
`networkInfo`), `tx` (with `hash` and `status`) or `lock`. A `sites_snapshot` lists only this
origin's own records, with `relayed_by: "direct"`:

```json
{ "event": "sites_snapshot", "v": 1, "sites": [ { "origin": "https://app.example.com", "network": "mainnet", "address": "oct...", "wallet": { "name": "Spending", "seed": "oct..." }, "relayed_by": "direct", "connected_at": 1761000000000 } ] }
```

## Request lifecycle (protocol 2)

The same for direct pages and for sites relayed by the paired extension (the extension sends the
same `site_status` and `site_cancel` over its pairing, with `site: {origin}` or `origin`). Code:
`src-tauri/src/sites/site_lifecycle.rs` (records, digest, limits), `src-tauri/src/ws/ws_sites.rs` (queue),
`src-tauri/src/sites/site_relay.rs` (events, `site_status`, `site_progress`), and the main window's
`src/features/dapp/services/siteLifecycle.ts`.

`site_hello` capabilities: `request_id`, `request_status`, `request_events`, `idempotent`,
`wait_confirmed`, `receipt`, `can_sign`, `kind`. They describe the build, never the user.

The paired extension learns the same from the reply to its pairing proof: `auth_prove` answers
`{"_id", "v": 1, "ok": true, "protocol": 2, "kind": "desktop", "capabilities": [...]}` (the same
list as `site_hello`). An older desktop answers only `{"_id", "v": 1, "ok": true}`: protocol 1.

### Request id

`site_request` may carry a top level `rid`: 32 lowercase hex characters (anything else is
`INVALID_PARAMS` "Malformed request id."). It is kept only for the methods that open a review
(`connect`, `switch_network`, sends, contract calls and deploys, `signMessage`,
`sign_transaction`, `broadcast_only`, sequences and the private writes); reads ignore it.

A record is keyed by carrier (`direct`, or the extension install id), origin and `rid`, and holds
the method, the network the request runs on and the signer address. Records live in memory only
(gone on restart), 24 hours after their last change. Per site at most 64 records and 8 running
(`RATE_LIMIT_EXCEEDED` "8 requests from this site are still running"), 1024 in all; only ended
records are evicted, the oldest of the same site first.

### Same id again

The digest is sha256 of the canonical JSON (keys sorted, no spaces) of
`{method, params, network}`, the network being the one the site asked for.

| Record | Same digest | Other digest |
| --- | --- | --- |
| pending, locked, review_open, signing | joins as another waiter, same answer, no second review | `REQUEST_ID_REUSED` |
| submitted, confirmed, completed | the stored answer at once | `REQUEST_ID_REUSED` |
| failed, rejected, expired | the stored error at once, never a new review | `REQUEST_ID_REUSED` |
| none | a new request | a new request |

A page that has not shown its site token may only reuse an id it sent on the same socket; any
other id it names is `REQUEST_ID_REUSED`. Stored answers never hold `siteToken`.

### Replies and events

The answer to a request with `rid` carries `"rid"` and `"status"` next to `result` or `error`;
an error also gets `details: {requestId, status}`. Every change is pushed as

```json
{ "event": "site_event", "v": 1, "origin": "https://app.example.com", "kind": "request", "data": RequestStatus }
```

to the connections that sent the request and to no one else, even while unproven (it only
describes their own request). For a relayed site the frame adds `"tab_ref"`, so the extension tells
only that tab. `request` is never accepted from the main window's `site_send_event`.

`RequestStatus`: `requestId`, `status`, `method`, `network`, `seq` (grows with every change),
`createdAt`, `updatedAt` (ms), and when known `address`, `hash` (`hashes` for several), `epoch`,
`receipt` or `receiptUnavailable` (`not_contract`, `refused`, `error`), `result` (completed only, at
most 4 KiB), `error` (`code`, `message`, `stage`: `review`, `submit` or `execution`), `watching`.
An id that is not kept, or that this connection may not see, reads
`{"requestId", "status": "unknown", "seq": 0}`.

Who sees what: a proven page or the extension reads any id of its carrier and origin; a page
without its token reads only ids it sent on that socket. Unless the site is connected here (for a
page: on a proven connection), `locked` reads `review_open` and `network` and `address` are left
out; `address` also needs the site to be connected to that signer. `site_status` has its own
budget: 120 per minute per site.

Rate: a web page gets at most 20 messages a second; each one past that is answered at once with
`RATE_LIMITED` (never dropped). Relayed pages are held to the same budget by the extension.

### Moves

| Status | When |
| --- | --- |
| `pending` | queued, the main window prepares the review |
| `locked` | waiting for the unlock (menu bar Unlock stage); a request that needs no review after the unlock shows `review_open` before it ends |
| `review_open` | the review is in the menu bar (also while Touch ID or the password runs) |
| `signing` | approved and authorised, for a method that submits a transaction; reported by the main window (`site_progress`), which runs nothing until the desktop holds it so. `signMessage`, `sign_transaction`, connect, switch and `register_private_view_key` go from `review_open` to `completed` |
| `submitted` | the answer named a transaction hash: the local exact hash (webcli formula), never one the node picks; the node's only when the local one cannot be computed, and a mismatch is logged. The chain watch polls by it |
| `confirmed`, `failed` | the main window's chain watch: `octra_transaction` every 2.5 s for a minute, then every 10 s, for 10 minutes; a rejected or dropped tx is `failed` with stage `execution`. Contract calls and deploys read `contract_receipt` once. At most 32 requests watched at once, 8 per site; the rest stay `submitted` with `watching: false`, and `site_status` then reads the chain again (at most every 5 s), answered by a later event |
| `completed` | connect, switch, signatures and other answers without a transaction |
| `register_private_view_key` | own connected address only (else `INVALID_PARAMS`, no review). With a view key on chain and a confirmed PVAC key: `pending`, `completed` with `{status: "registered", view_pubkey, pvac: true}`, no review, nothing signed. Before any review, in this order: `PVAC_KEY_MISMATCH` when another PVAC key is registered for the account (or the update would not be an empty key_switch), `REGISTRATION_PENDING` while this wallet's registration is unconfirmed, `INSUFFICIENT_BALANCE` when the balance is below the live key_switch fee. Otherwise one review with that fee, the empty key_switch, `signing`, `submitted`, `confirmed` with that result |
| `broadcast_only` | a site's own pre-signed record: `from` must be the connected wallet (else `INVALID_PARAMS`, no review). Not reviewed again, since its `sign_transaction` review counted; the scope is asserted and the record posted exactly as given, hashed as posted. `pending`, `submitted`, `confirmed`, and it runs on if the page closes |
| `rejected` | Reject, a closed page or tab, `site_cancel`, the 5 s cooldown |
| `expired` | the review (unlock included) was open 5 minutes: `USER_REJECTED` "The review in 0xio Desktop was not answered in 5 minutes." with `details.status: "expired"` |

A final status never changes. The watch stops early when the site no longer runs on the network
and address that signed.

### Page close

A page that closes (socket closed, `site_closed`) ends its requests that still wait for the user.
A request already approved and authorised (`signing` or later) is never dropped, rejected, cancelled
or expired: it finishes, changes the record (a connect still connects), and keeps its outcome for
the reloaded page to read with `site_status` or the same `rid`. No answer is sent to a page that is
gone.

## Site token

- Issued when a connect review is approved: 32 random bytes, base64url without padding (43
  characters), added to the connect result as `siteToken`. Each approved connect issues a new one
  and the old one stops working. A connect that is answered from the record (the site was already
  connected on that network) issues none.
- Kept as its SHA-256 only, one per origin, in `ws_sites.json` beside the record (`tokens`, written
  0600 and atomically like the record); never logged, never in `relay-sites` or `site_list`.
- Shown by the page in every `site_hello` as `site_token`. A match (constant-time compare, and
  the site still has a record) makes that connection the site: its requests run on the record, it
  hears the site's events and snapshots. No token, a wrong one or one of another shape leaves it
  unproven; `token_status: "invalid"` tells the page to forget a token it sent.
- An approved connect also proves the connections that waited on it, so a page without a token
  (an older SDK, blocked storage) works after one connect review per connection.
- Revoked when the site sends `disconnect` from a proven connection, and on Disconnect in
  Settings, Connected sites. Revoking forgets the site on every network (nothing could use those
  records without the token) and makes its open sockets unproven at once: they get
  `accountsChanged` with no accounts and an empty `sites_snapshot`.

## Sessions

The record (`ws_sites.json`) keeps a connected site per network with `client_id: "direct"` and
`browser: "web"`. Closing a socket ends its requests that still wait for the user (`USER_REJECTED` "The
page closed before 0xio Desktop answered."; approved ones finish, see Page close) but keeps the record and the token, so a new socket of the same
origin that shows the token restores the session without a new review. A site is forgotten only by
its own `disconnect`, or Disconnect in Settings, Connected sites ("Direct from browser").

Sites relayed by the paired extension are unchanged: the pairing proof on the extension's
connection (`auth_hello`, `auth_prove`) proves them, and they never use a site token.

## Limits

- Open sockets: 32 web pages in all, 6 per origin (HTTP 503 past either); extensions and programs
  keep their own 8.
- Handshakes: 12 per origin per minute, 120 per minute for all web pages (HTTP 429); counted apart
  from the extension's 60.
- Requests: the relay queue's limits per origin: at most 3 waiting (`RATE_LIMIT_EXCEEDED`), 60 per
  minute; repeat connects from one origin merge into one review.
- Reviews close after 5 minutes as expired (see Request lifecycle).
- A socket idle for 5 minutes is closed.

## Reviews

The same as relayed sites: the main window runs each request through the wallet's own dApp
handler on the site's record and network; the review opens in the menu bar with Reject and the
verb, the full origin, **Connection: Direct from browser** in place of the extension row, the
wallet and the live fee (read again before signing); Touch ID or the password follows for anything
that signs; a locked wallet unlocks first; a site's signing scope holds only while its record still
names that network and address. Notifications follow the relay rules.

## Browsers and local network access

Chrome (Local Network Access, fetch since Chrome 142, WebSockets since Chrome 147; Edge the same)
asks the user before a public `https` page reaches `127.0.0.1`: a prompt from the address bar,
"<site> wants to: Access other apps and services on this device" (Chrome 145 and later name the
permission **Apps on device**). Allow lets the socket open; Block makes it fail like a closed port
and the choice is kept per site in the site settings. No preflight is sent for the WebSocket under
Local Network Access. A plain `http` public page cannot reach this machine at all. Browsers that
still send a Private Network Access preflight get `204` with
`Access-Control-Allow-Private-Network: true` to `OPTIONS`; the health `GET` carries the same
header. Neither grants anything: the handshake decides who connects. Firefox and Safari ask
nothing today.
