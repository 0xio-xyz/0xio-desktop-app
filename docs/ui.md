# UI

Two React 18 apps share one code base: the main window (`index.html` -> `src/main.tsx` -> `src/App.tsx`) and the menu bar panel (`tray.html` -> `src/tray/main.tsx`). Vite builds both (`vite.config.ts`).

## Where the code lives

| Path | What it holds |
|------|---------------|
| `src/App.tsx` | Routes, lock and onboarding redirects, the app frame |
| `src/features/` | Screens by area: `wallet`, `transactions`, `privacy`, `contracts`, `circles`, `dapp`, `nft`, `security`, `settings` |
| `src/shared/ui/` | Shared components (buttons, sheets, review cards, icons) |
| `src/shared/layout/` | Sidebar, top bar, command palette, notice panel, update panel |
| `src/hooks/` | Hooks by area: `app`, `wallet`, `privacy`, `transactions`, `ui` |
| `src/contexts/` | `WalletContext` (wallets, active network, balances) and `ThemeContext` |
| `src/services/` | Domain logic the screens call; see [ARCHITECTURE.md](ARCHITECTURE.md) |
| `src/lib/` | Self-contained helpers: formatting, dates, logger, query defaults, wallet art |
| `src/css/` | Tailwind 4 theme tokens (`globals.css`) and component styles |
| `src/tray/` | The menu bar panel |
| `src/i18n/` | Translations; see [translation.md](translation.md) |

## Main window

Routes are in `src/App.tsx` (React Router with the app's own history, `src/lib/appHistory.ts`). The main screens are Home, Send, Receive, Privacy, History, NFTs, Contracts, Circles, Browser, Wallets, Address book, Automations and Settings.

- **Home:** the balance with a 24 hour value sparkline, tokens found from on-chain data, and a page per token (price chart with a pointer readout, public and encrypted OCT on one page, the token's own activity).
- **Send:** one surface with the amount, one recipient field with a picker (Recent, Contacts, Your wallets, a pasted address, or on devnet a `.oct` name that is looked up, shown with its full address and resolved again before signing) and a message on public OCT, beside a live summary with the network fee to choose (Slow, Normal, Fast or Custom). Bulk sends go to many recipients. Review opens a pop-up over the whole window with Reject and Send; the progress runs in it (Hide tucks it into a toast) and the result is a toast.
- **History:** Mainnet and Testnet pages per address (picking a page never switches the network), each row labelled with its network. Contract calls read as actions (Swap, Approve, List) with the contract's name; the picked row's receipt sits beside the list with its call data. 30 day figures and filters for sent, received, private and contract rows.
- **NFTs:** every collection the wallet holds, newest first, without an import step; hide collections or pieces, transfer, list on Xpectrum, change the price or cancel. An ONS name shows its own artwork read from `token_uri` (a plate drawn by the wallet only when the artwork cannot be loaded) under its chain name with its owner, status and expiry; an expired one carries an Expired tag and has no actions.
- **Wallets:** create, import, derive and watch-only wallets. The address and public key are in each wallet's details.
- **Address book:** contacts with avatars, search, import and export; the picked contact sits beside the list with Send, Copy address and Edit.
- **Contracts:** an editor for AML contracts with files in the app or a folder on disk, written only on Save (Cmd S, Save all with Opt Cmd S, Revert file). Unsaved files carry a dot, the gutter marks changed lines and Compare shows the buffer beside the saved text. Assistant, Build and Deploy sit in a side panel; an edit after a build holds Deploy until the next build. The assistant reads models from each provider's own list (OpenAI, Anthropic, Groq, OpenRouter) with your saved keys, and from local Ollama and LM Studio; its chats are kept locally per project: the history button beside New chat slides the list of chats over the chat, grouped by day, to open one or delete it (Undo until the list closes); New chat or Cmd N starts a fresh chat and keeps the old one. Deploy, call and view contracts, with `enc()` parameters expanded to ciphertexts and encrypted results decrypted. The contracts list shows Yours, Saved and All on chain.
- **Backup:** one surface for the recovery phrase and the private key, behind the password or Touch ID. It shows on one click and is dropped on Hide, on leaving, when the window loses focus or is hidden, and on lock. Copy is done in Rust.
- **Header:** search (Cmd K), the notification bell and Lock (Cmd L) in one group, with a live status beside it (Updated 12 s ago, Refresh on hover, Could not update with Retry).
- **Notifications:** the bell lists, for the open wallet and network, transfers in, private transfers to claim, results of your actions, site and pairing requests, a key update on hold, an update ready and Touch ID turning off, each with one action. Its count only counts what needs you. Kept in `src/services/notices/notifications.ts`, fed by `src/hooks/app/useNoticeSources.ts`; Settings picks which also show as system notifications.
- **Settings:** General, Appearance, Security and Privacy, Network and Advanced, each with a live panel (backups per wallet and paired apps, a drawing of the chosen look, the chain head and latency of every network, cache and log sizes and proof threads in use).

Privacy screens are in [privacy.md](privacy.md); the browser, Circles and connected sites in [sites.md](sites.md).

## Menu bar panel

`src/tray/`. A glass panel (native glass on macOS 26) with one fixed height on every screen:

- A live engine status line and the balance up front (click to hide).
- A command line that reads loose input (`send 10 to 0xio privately`, `pay bob half`, typos included) with a live preview, sends to contacts and your wallets by name, and opens the review.
- Wallet switcher, network, claim, send with review, receive with QR, encrypt and decrypt, migrate the private balance or update the encryption key, turn on private balance, lock and unlock, Open at login.
- Site reviews (`SiteRequests.tsx`, `siteQueue.ts`): Reject and the verb, the full origin, the wallet, the live fee, then Touch ID or the password.
- Eight themes plus a CLI theme (Settings, Appearance, Menu bar theme).

Every fee in the panel is read live on the active network and signed exactly as the review showed it; a failed read blocks with a retry. The menu bar icon shows the lock state, proof work and transfers to claim.

## Themes

Three themes for the main window: Dim (default), Day and Octra. `ThemeContext` sets `data-theme` on `<html>` (`dim`, `light`, `octra`) and keeps the choice in `localStorage`. Colors are CSS variables defined per theme in `src/css/globals.css`; components use these tokens.

## Rules

- Every transaction, approvals included, opens a review before signing. Desktop reviews use a button pair (Reject plus the verb), never a slide. A click outside or Escape rejects a site review.
- Balances, lists, caches and query keys are scoped to network plus address. A value read for another wallet or network is never shown.
- Loading never moves content: slots are reserved and the last content stays, dimmed, while new data loads.
- Server state goes through the shared query cache (`useQuery`), not fetch inside an effect.
- Avoid a direct `useEffect` in components. Use `useMountEffect` (`src/hooks/ui/useMountEffect.ts`), or tag an effect that cannot be avoided with `// effect:audited - <reason>`.
- Every visible string goes through `t()`; see [translation.md](translation.md).
- Prefer a small helper in `src/lib/` over a new package.
