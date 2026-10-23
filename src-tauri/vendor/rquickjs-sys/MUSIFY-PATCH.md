# Windows QuickJS compiler and dispatch patch

This directory contains **all 306 files** from the published `rquickjs-sys 0.14.0`
crate (9,080,571 bytes before local additions), without trimming tests, headers,
bindings, documentation or licenses. The only modified upstream files are
`build.rs` and `quickjs/quickjs.c`.

## Provenance and audit

- Archive: <https://static.crates.io/crates/rquickjs-sys/rquickjs-sys-0.14.0.crate>
- SHA-256: `cee271d0eeba64f0915b846cb7ae02e16faf3dfdffdca91731101d9d30fe3423`
- Upstream commit: `d7ef5eeae702fea24c03643064de454f1c1dd4b0`, directory `sys`,
  as recorded in the unchanged `.cargo_vcs_info.json`.
- `UPSTREAM-PROVENANCE.json` records every original path, size and SHA-256 plus
  the expected hashes of the two patched files. `UPSTREAM.patch` is their diff.
- Run `pwsh -File Verify-Upstream.ps1` in this directory to verify the complete
  vendored inventory. It does not download, compile, or modify files.
- Original licensing and notices remain in place, including `quickjs/LICENSE`
  and `vendor/wasi-libc/NOTICE.md`. Microsoft headers are **not vendored**.

## Changes

1. In the existing `DIRECT_DISPATCH` preprocessor condition, clang-cl is excluded
   from the `_MSC_VER` switch-only branch. MSVC still uses the original switch;
   clang-cl can use computed gotos within the interpreter function. This is
   neither JIT compilation nor a tail-call interpreter. Other targets retain
   their existing branch.
2. For a Windows/MSVC target only, optional build-time environment variable
   `MUSIFY_QUICKJS_CLANG_CL` selects an absolute `clang-cl.exe` path and the
   adjacent `llvm-lib.exe`. Missing or invalid explicitly requested tools fail
   the build. When the variable is absent, upstream compiler discovery remains
   in use. The selected compiler and version are printed in Cargo diagnostics.
3. Visual Studio's discovered SDK/CRT environment is passed to this package's
   compiler processes. No global `CC` or `AR` is changed. When the selected
   compiler identifies itself as Android's NDK clang-cl, its Android-specific
   resource `stdatomic.h` would be wrong for Windows: an unchanged copy of the
   installed Visual Studio header is placed only in `OUT_DIR` and given include
   precedence. Standard Windows LLVM uses its normal headers. Both paths retain
   C11 atomics, the MSVC ABI, assertions and the existing C optimization level.
   Explicit clang-cl omits the MSVC-only `/experimental:c11atomics` flag;
   default MSVC keeps it. Clang implements these C11 atomics directly.
4. Cargo rerun declarations cover compiled C sources, included headers, bundled
   bindings, the compiler selection, Visual Studio/SDK environment, selected
   tools and copied atomics header.
   This prevents a changed dispatch source from silently reusing an old library.

The `cargo:warning` compiler/header lines are intentional provenance messages,
not Rust warnings or reports of disabled sandbox checks.

The application keeps its 192 MiB / 12 s preparation budget, 32 MiB / 1 s decode
budget and 512 KiB JavaScript stack limit. No host I/O, decoder, parser or bundle
changes are part of this patch. It takes a newly built Windows application to
use the new engine; an extractor recipe update cannot change compiled C code.

## Toolchains and scope

The local experiment used NDK 27.3.13750724 clang-cl 18.0.4 with installed Visual
Studio 2022 headers. For example, set `MUSIFY_QUICKJS_CLANG_CL` to the absolute
`toolchains/llvm/prebuilt/windows-x86_64/bin/clang-cl.exe` inside that NDK for the
current build process, then run the usual Cargo/Tauri command. Do not persist
the setting globally or substitute Android headers into a Windows build.

The Windows GitHub workflow selects its already installed
`C:\Program Files\LLVM\bin\clang-cl.exe` before Rust tests and application
compilation; it installs no new compiler. CI LLVM can differ from the locally
measured version, so compatibility and performance must be validated there.
Linux, macOS and Android do not consume this Windows-only selection. Release
signing, artifact publication and workflow triggers are unchanged.

The isolated Windows comparison used the same Rust decoder, JavaScript bundle,
fixture and resource limits: MSVC switch averaged 3620.55 ms, clang-cl switch
3675.5 ms, and clang-cl direct dispatch 2816.6 ms. Each engine passed seven
sandbox tests; direct dispatch also matched four player fixtures and four
formats per fixture. These are harness measurements, not application startup
or Android measurements. The earlier clang-switch run reused the direct binary
and is excluded from this attribution.
