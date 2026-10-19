#!/usr/bin/env bash
# Builds src/code-execution/quickjs.wasm, code_execution's engine, from the vendored quickjs-ng
# (engine/quickjs-ng, copied by vendor.sh) and engine/interface.c, with a pinned toolchain:
# wasi-sdk 32, checked against the sha256 below, and binaryen 130.0.0's wasm-opt from npm, pinned
# by version (npm checks it against the registry's integrity hash), which runs once. The toolchain
# is fetched into ENGINE_TOOLCHAIN_DIR (default ~/.cache/agent-framework-engine).
#
# On x86_64 Linux, the same sources and toolchain have given the same bytes on two machines, and CI
# rebuilds there and compares the result with the committed module. The pinned wasi-sdk is the
# x86_64 Linux build; elsewhere, set WASI_SDK to an install of wasi-sdk 32, whose output may then
# differ from the committed module.
#
# Usage: engine/build.sh [OUT]   (OUT defaults to src/code-execution/quickjs.wasm)
set -euo pipefail

WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-32/wasi-sdk-32.0-x86_64-linux.tar.gz
WASI_SDK_SHA256=55fc523ebfbc98f69d1034fcfcb83d1ff5610cd9ab7eceef6cd097a30ba4ef93
BINARYEN_VERSION=130.0.0

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
# Paths given relative to where this was run from, since it changes directory before it uses them.
absolute() { case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }
out=$(absolute "${1:-$root/src/code-execution/quickjs.wasm}")
cache=$(absolute "${ENGINE_TOOLCHAIN_DIR:-$HOME/.cache/agent-framework-engine}")
if [ -n "${WASI_SDK:-}" ]; then WASI_SDK=$(absolute "$WASI_SDK"); fi
mkdir -p "$cache"

if [ -z "${WASI_SDK:-}" ]; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "build.sh: the pinned wasi-sdk is the x86_64 Linux build; set WASI_SDK to an install of wasi-sdk 32" >&2
    exit 1
  fi
  WASI_SDK=$cache/wasi-sdk-32
  if [ ! -x "$WASI_SDK/bin/clang" ]; then
    tarball=$cache/wasi-sdk-32.tar.gz
    curl -fsSL -o "$tarball" "$WASI_SDK_URL"
    echo "$WASI_SDK_SHA256  $tarball" | sha256sum -c --quiet -
    rm -rf "$WASI_SDK.tmp"
    mkdir -p "$WASI_SDK.tmp"
    tar -xzf "$tarball" -C "$WASI_SDK.tmp" --strip-components=1
    rm "$tarball"
    mv "$WASI_SDK.tmp" "$WASI_SDK"
  fi
fi
WASM_OPT=$cache/binaryen-$BINARYEN_VERSION/node_modules/.bin/wasm-opt
if [ ! -x "$WASM_OPT" ]; then
  # npm checks the package against the registry's integrity hash. The directory gets a
  # package.json of its own first: without one, npm installs into the nearest directory above
  # that has one.
  rm -rf "$cache/binaryen-$BINARYEN_VERSION"
  mkdir -p "$cache/binaryen-$BINARYEN_VERSION"
  echo '{ "private": true }' > "$cache/binaryen-$BINARYEN_VERSION/package.json"
  (cd "$cache/binaryen-$BINARYEN_VERSION" && npm install --silent --no-audit --no-fund --no-save "binaryen@$BINARYEN_VERSION" >/dev/null)
fi

CC=$WASI_SDK/bin/clang
SYSROOT=$WASI_SDK/share/wasi-sysroot
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

# Relative paths, so nothing of this machine's layout reaches the module.
cd "$here"
CFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT" -Oz -flto
  -Iquickjs-ng -D_GNU_SOURCE -DQJS_BUILD_LIBC=0
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL
  -fvisibility=hidden
  -Wall -Wno-implicit-fallthrough -Wno-sign-compare -Wno-missing-field-initializers
  -Wno-unused-parameter -Wno-unused-but-set-variable
)
for f in quickjs dtoa libregexp libunicode; do
  "$CC" "${CFLAGS[@]}" -c "quickjs-ng/$f.c" -o "$build/$f.o"
done
"$CC" "${CFLAGS[@]}" -Werror -c interface.c -o "$build/interface.o"

# A reactor whose memory the host makes, so the host sets its maximum, the child's budget.
# The stack sits first in memory, at [0, 1 MiB), growing down from its top. QuickJS's limit is
# set below the top as engine_init finds it, 192 KiB at most, and recursion its checks don't see
# that runs past the stack's bottom wraps below address 0, past the memory's end, and traps
# rather than writing over data.
"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -Oz -flto -mexec-model=reactor \
  -lwasi-emulated-process-clocks -lwasi-emulated-signal \
  -Wl,--import-memory -Wl,--stack-first -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  "$build"/*.o -o "$build/linked.wasm"

"$WASM_OPT" -Oz --strip-debug --strip-producers "$build/linked.wasm" -o "$build/quickjs.wasm"
mkdir -p "$(dirname "$out")"
cp "$build/quickjs.wasm" "$out"
# macOS has shasum, not sha256sum.
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$out"); else sum=$(shasum -a 256 "$out"); fi
size=$(wc -c < "$out")
echo "${sum%% *}  ${size// /} bytes  $out"
