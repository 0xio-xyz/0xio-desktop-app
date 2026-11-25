# Third-Party Notices

0xio Desktop is licensed under the MIT License (see [LICENSE](LICENSE)). It includes the following third-party components, whose licenses and attributions are reproduced here.

## PVAC-HFHE privacy engine

The privacy engine linked into the app is built from pvac-rs by 0xio Labs, a Rust port of the PVAC-HFHE engine in Octra Labs' reference client [webcli](https://github.com/octra-labs/webcli). webcli and its PVAC code are released by Octra Labs under the BSD 3-Clause License:

```
BSD 3-Clause License

Copyright (c) 2023-2026, Octra Labs <dev@octra.org>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Fonts

[Inter](https://github.com/rsms/inter) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), bundled in `src/assets/fonts/`, are under the SIL Open Font License 1.1. The full texts are in [Inter-OFL.txt](src/assets/fonts/Inter-OFL.txt) and [JetBrainsMono-OFL.txt](src/assets/fonts/JetBrainsMono-OFL.txt).

## npm dependencies

The runtime packages are listed in `package.json`. Their licenses are MIT (React, CodeMirror and its vim mode, Lezer) or Apache-2.0 and MIT (the Tauri API and plugins), and Unlicense for tweetnacl. Full license texts are in each package directory under `node_modules/`.

## Rust crates

The crates in `src-tauri/Cargo.toml` are under the MIT, Apache-2.0, BSD-3-Clause or Unicode licenses. Full license texts ship with each crate.

- `windows` (Microsoft, MIT or Apache-2.0): Windows Hello unlock, built for Windows only.
