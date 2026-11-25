#!/usr/bin/env bash
# The shared protocol 2 suite (../0xio-sdk/conformance) against the Rust test server.
set -euo pipefail
cd "$(dirname "$0")/.."
file="$(mktemp -t oxio-conformance).json"
rm -f "$file" "$file.done"
(cd src-tauri && CONFORMANCE_FILE="$file" CARGO_INCREMENTAL=0 cargo test --lib conformance_server -- --ignored --exact ws::ws_server::conformance::conformance_server >/dev/null 2>&1) &
server=$!
trap 'touch "$file.done"; wait "$server" 2>/dev/null || true; rm -f "$file" "$file.done"' EXIT
for _ in $(seq 1 600); do [ -s "$file" ] && break; sleep 0.5; done
[ -s "$file" ] || { echo "the conformance server did not start" >&2; exit 1; }
DESKTOP_CONFORMANCE_FILE="$file" npx vitest run src/__tests__/protocol2.conformance.test.ts "$@"
