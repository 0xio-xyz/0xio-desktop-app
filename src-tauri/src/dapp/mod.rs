// dApps load in a top-level WebviewWindow, not an iframe: X-Frame-Options and frame-ancestors
// refuse a wallet iframe, and do not apply to a top-level browsing context.
//
// Security: the injected provider exposes one function that forwards {method, params}. The page
// can still reach Tauri's raw IPC, so capabilities/dapp.json and the app manifest in build.rs keep
// it to that one command. The origin is read from the webview's own URL, never from the page, and
// every request goes through the same approval-gated handler as the iframe bridge.

pub mod bridge;
pub mod provider;
pub mod window;

// No re-exports of the commands: generate_handler! needs each command's defining module.
