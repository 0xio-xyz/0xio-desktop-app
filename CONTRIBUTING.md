# Contributing

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License and sign-off

0xio Desktop is MIT licensed. By submitting a contribution you agree it is licensed under MIT and that you have the right to submit it. Sign off every commit with `git commit -s` to certify the [Developer Certificate of Origin](https://developercertificate.org).

## Building

Prerequisites: Node 22 (`.nvmrc`), a stable Rust toolchain and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

The privacy engine comes from the `pvac-rs` and `pvac-handler` crates, which are not public. The Rust build expects them beside this repo (`../pvac-rs` and `../pvac-handler`), so without them only the front end (`npm run build`, `npm test`) builds. `pvac-rs` is a Rust port of the PVAC engine in Octra Labs' [webcli](https://github.com/octra-labs/webcli).

```
npm ci
npm run tauri:dev      # run the app
npm run tauri build    # release bundle -> src-tauri/target/release/bundle/
```

## Before opening a PR

```
npx tsc --noEmit
npm run format:check
npm test
cd src-tauri && cargo test   # needs the privacy engine crates and 0xio-sdk beside this repo
```

Match the surrounding code. A few 0xio rules that aren't obvious:

- Direct `useEffect` in components is avoided - use `useMountEffect`, or tag a genuinely unavoidable effect with `// effect:audited - <reason>`.
- Server state goes through the shared query cache (`useQuery`), not hand-rolled fetch-in-effect.
- Every new app command is listed in `src-tauri/permissions/` and granted only to the window that needs it, never to a window that loads remote content.
- No new runtime dependency (npm package or crate) without a maintainer's agreement first; prefer a small helper.
