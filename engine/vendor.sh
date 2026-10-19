#!/usr/bin/env bash
# Copies quickjs-ng's engine source into engine/quickjs-ng/ at the release pinned below: the four C
# files the module compiles and the headers they include, with upstream's LICENSE. Then it applies
# the patches in engine/patches/, in the byte order of their names: fixes made here before a
# release carries them, each a `git diff` made in a clone of quickjs-ng at COMMIT and saved with
# a .patch name, changing only files FILES lists. Anything else there is refused. There are no
# patches today.
#
# CI runs this script and fails if what it copies differs from what's committed, so the copy is
# always the pinned release with the committed patches: the engine changes through the pin or a
# patch, never through an edit in engine/quickjs-ng.
#
# To bump: change TAG and COMMIT to the new release, and FILES if the release adds, drops or
# renames a file the four C files include, and delete each patch the release has taken in. To
# patch: add the patch to engine/patches/. Either way, run this, then build.sh, and commit the
# copied source, the patches and src/code-execution/quickjs.wasm together. It replaces
# engine/quickjs-ng only once every file is copied and patched, and refuses while the directory
# holds changes or files not committed, which it would erase.
set -euo pipefail
# Byte order for the patches' names, whatever this machine's locale.
export LC_ALL=C
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
changes=$(git -C "$here" status --porcelain --untracked-files=all --ignored -- quickjs-ng)
if [ -n "$changes" ]; then
  echo "vendor.sh: engine/quickjs-ng holds changes or files not committed, which replacing it would erase; commit or remove them first:" >&2
  echo "$changes" >&2
  exit 1
fi
tmp=$(mktemp -d)
# The new copy is staged beside the old one, on the same filesystem: once it's whole, the old one
# is moved aside, the stage renamed into its place, and only then is the old one removed.
stage=$(mktemp -d "$here/.quickjs-ng.XXXXXX")
old=$stage.old
trap 'rm -rf "$tmp" "$stage"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/quickjs-ng/quickjs.git "$tmp/quickjs-ng"
got=$(git -C "$tmp/quickjs-ng" rev-parse HEAD)
if [ "$got" != "$COMMIT" ]; then
  echo "vendor.sh: $TAG is $got upstream, not the pinned $COMMIT; refusing to copy" >&2
  exit 1
fi
# Patches go into the clone's index, and files come from it, so each file's bytes are the
# commit's with the patches, whatever the clone's checkout settings would make of them on disk.
patched=0
# Every entry, a dot-named one or a dangling link included, is a regular .patch file or refused.
shopt -s nullglob dotglob
for patch in "$here"/patches/*; do
  if [ "${patch%.patch}" = "$patch" ] || [ ! -f "$patch" ]; then
    echo "vendor.sh: engine/patches/$(basename "$patch") isn't a regular .patch file; rename or remove it. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  if ! git -C "$tmp/quickjs-ng" apply --cached "$patch"; then
    echo "vendor.sh: engine/patches/$(basename "$patch") doesn't apply to quickjs-ng $TAG; engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  patched=$((patched + 1))
done
# Only FILES are copied, so a patch's change to any other file would be applied and then dropped.
# Each path the patches leave changed is checked whole, a rename's old and new paths both.
git -C "$tmp/quickjs-ng" diff --cached --name-only --no-renames -z > "$tmp/changed"
while IFS= read -r -d '' f; do
  listed=false
  for want in "${FILES[@]}"; do
    if [ "$want" = "$f" ]; then listed=true; fi
  done
  if [ "$listed" = false ]; then
    echo "vendor.sh: the patches change $f, which FILES doesn't list, so the copy would drop that change. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
done < "$tmp/changed"
for f in "${FILES[@]}"; do
  if ! git -C "$tmp/quickjs-ng" cat-file -e ":$f" 2>/dev/null; then
    echo "vendor.sh: quickjs-ng $TAG has no $f, or a patch removes it; update FILES or the patch. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  if ! git -C "$tmp/quickjs-ng" show ":$f" > "$stage/$f"; then
    echo "vendor.sh: couldn't write $f into the new copy; engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
done
chmod 755 "$stage"
if [ -e "$dest" ] && ! mv "$dest" "$old"; then
  echo "vendor.sh: couldn't move $dest aside to replace it; it is unchanged." >&2
  exit 1
fi
if ! mv "$stage" "$dest"; then
  if [ -e "$old" ] && mv "$old" "$dest"; then
    echo "vendor.sh: couldn't move the new copy into $dest; the committed copy is back in place." >&2
  else
    echo "vendor.sh: couldn't move the new copy into $dest, nor the committed copy back from $old; git checkout -- $dest restores it." >&2
  fi
  exit 1
fi
if [ -e "$old" ] && ! rm -rf "$old"; then
  echo "vendor.sh: the new copy is in place, but the committed copy moved aside to $old couldn't be removed; remove it." >&2
  exit 1
fi
echo "copied ${#FILES[@]} files from quickjs-ng $TAG ($COMMIT), with $patched patches"
