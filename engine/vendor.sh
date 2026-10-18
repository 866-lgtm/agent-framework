#!/usr/bin/env bash
# Copies quickjs-ng's engine source, unedited, into engine/quickjs-ng/ at the release pinned below:
# the four C files the module compiles and the headers they include, with upstream's LICENSE.
# To bump: change TAG and COMMIT to the new release, run this, run build.sh, and commit both the
# copied source and src/code-execution/quickjs.wasm together.
set -euo pipefail
TAG=v0.17.0
COMMIT=6d46d07d04041b40f4f49eaa7fdebe44c314c699
FILES=(
  LICENSE
  quickjs.c dtoa.c libregexp.c libunicode.c
  quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h
  cutils.h list.h dtoa.h
  libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h
  builtin-array-fromasync.h builtin-iterator-zip.h builtin-iterator-zip-keyed.h
)
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/quickjs-ng/quickjs.git "$tmp/quickjs-ng"
got=$(git -C "$tmp/quickjs-ng" rev-parse HEAD)
if [ "$got" != "$COMMIT" ]; then
  echo "vendor.sh: $TAG is $got upstream, not the pinned $COMMIT; refusing to copy" >&2
  exit 1
fi
rm -rf "$here/quickjs-ng"
mkdir -p "$here/quickjs-ng"
for f in "${FILES[@]}"; do cp "$tmp/quickjs-ng/$f" "$here/quickjs-ng/$f"; done
echo "copied ${#FILES[@]} files from quickjs-ng $TAG ($COMMIT)"
