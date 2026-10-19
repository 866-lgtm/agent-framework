#!/usr/bin/env bash
# Copies quickjs-ng's engine source, unedited, into engine/quickjs-ng/ at the release pinned below:
# the four C files the module compiles and the headers they include, with upstream's LICENSE.
# The copy is exactly the pinned commit's files, and CI runs this script and fails if what it
# copies differs from what's committed, so the engine changes through this script's pin, never
# through an edit in engine/quickjs-ng.
#
# To bump: change TAG and COMMIT to the new release, and FILES if the release adds, drops or
# renames a file the four C files include; run this, then build.sh, and commit the copied source
# and src/code-execution/quickjs.wasm together. It replaces engine/quickjs-ng only once every file
# is copied, and refuses while the directory has changes not committed, which it would erase.
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
dest=$here/quickjs-ng
changes=$(git -C "$here" status --porcelain -- quickjs-ng)
if [ -n "$changes" ]; then
  echo "vendor.sh: engine/quickjs-ng has changes not committed, which replacing it would erase; commit or discard them first:" >&2
  echo "$changes" >&2
  exit 1
fi
tmp=$(mktemp -d)
# The new copy is staged beside the old one, on the same filesystem, so it replaces it by a rename.
stage=$(mktemp -d "$here/.quickjs-ng.XXXXXX")
trap 'rm -rf "$tmp" "$stage"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/quickjs-ng/quickjs.git "$tmp/quickjs-ng"
got=$(git -C "$tmp/quickjs-ng" rev-parse HEAD)
if [ "$got" != "$COMMIT" ]; then
  echo "vendor.sh: $TAG is $got upstream, not the pinned $COMMIT; refusing to copy" >&2
  exit 1
fi
# Each file's bytes as the commit holds them, whatever the clone's checkout settings would make
# of them on disk.
for f in "${FILES[@]}"; do
  if ! git -C "$tmp/quickjs-ng" show "$COMMIT:$f" > "$stage/$f"; then
    echo "vendor.sh: quickjs-ng $TAG has no $f; update FILES. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
done
chmod 755 "$stage"
rm -rf "$dest"
mv "$stage" "$dest"
echo "copied ${#FILES[@]} files from quickjs-ng $TAG ($COMMIT)"
