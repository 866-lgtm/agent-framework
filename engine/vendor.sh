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
# Physical paths, as git gives the repository's, so the one can be taken from the other.
here=$(cd "$(dirname "$0")" && pwd -P)
dest=$here/quickjs-ng
# The command that puts back the committed copy's files, from the commit, from any directory.
top=$(git -C "$here" rev-parse --show-toplevel)
restore="git -C $(printf '%q' "$top") checkout HEAD -- $(printf '%q' "${dest#"$top"/}")"
changes=$(git -C "$here" status --porcelain --untracked-files=all --ignored -- quickjs-ng)
if [ -n "$changes" ]; then
  echo "vendor.sh: engine/quickjs-ng holds changes or files not committed, which replacing it would erase; commit what you mean to keep, or run $restore to put back what's committed and remove any file listed below as untracked (??) or ignored (!!):" >&2
  echo "$changes" >&2
  exit 1
fi
# Whenever the script exits, a committed copy left moved aside goes back, unless the new one is in
# its place, and what was staged goes. bash runs this on a signal that ends the shell too: INT,
# TERM and HUP are trapped below, so they wait for the command in progress, and PIPE, ALRM, USR1,
# USR2 and XCPU were checked to run it as well. Signals are ignored while it runs. SIGKILL, which
# no trap sees, skips it. A signal ignored when the script started, as SIGINT is for a background
# job of a non-interactive shell, stays ignored, and the script carries on.
tmp= stage= old=
finish() {
  trap '' HUP INT PIPE ALRM TERM USR1 USR2 XCPU
  set +e
  if [ -n "$old" ] && [ -e "$old" ]; then
    if [ -e "$dest" ]; then
      rm -rf "$old" || echo "vendor.sh: the new copy is in place, but the committed copy moved aside to $old couldn't be removed; remove it." >&2
    elif mv "$old" "$dest"; then
      echo "vendor.sh: stopped while replacing the copy; the committed copy is back in place." >&2
    else
      echo "vendor.sh: stopped while replacing the copy, and couldn't move the committed copy back from $old; $restore restores it." >&2
    fi
  fi
  [ -n "$tmp" ] && rm -rf "$tmp"
  [ -n "$stage" ] && rm -rf "$stage"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
tmp=$(mktemp -d)
# The new copy is staged beside the old one, on the same filesystem: once it's whole, the old one
# is moved aside, the stage renamed into its place, and only then is the old one removed. Killed
# outright between the two renames, the script leaves the committed copy at $old, and $restore
# puts back what's committed.
stage=$(mktemp -d "$here/.quickjs-ng.XXXXXX")
old=$stage.old
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/quickjs-ng/quickjs.git "$tmp/quickjs-ng"
got=$(git -C "$tmp/quickjs-ng" rev-parse HEAD)
if [ "$got" != "$COMMIT" ]; then
  echo "vendor.sh: $TAG is $got upstream, not the pinned $COMMIT; refusing to copy" >&2
  exit 1
fi
# Patches go into the clone's index, and files come from it, so each file's bytes are the
# commit's with the patches, whatever the clone's checkout settings would make of them on disk.
patched=0
# Every entry, a dot-named one or a link included, is a regular .patch file or refused, and so is
# an engine/patches that isn't a directory.
if { [ -e "$here/patches" ] || [ -L "$here/patches" ]; } && { [ ! -d "$here/patches" ] || [ -L "$here/patches" ]; }; then
  echo "vendor.sh: engine/patches isn't a directory (a symbolic link, even to one, isn't taken); make it one, or remove it. engine/quickjs-ng is unchanged." >&2
  exit 1
fi
shopt -s nullglob dotglob
for patch in "$here"/patches/*; do
  if [ "${patch%.patch}" = "$patch" ] || [ -L "$patch" ] || [ ! -f "$patch" ]; then
    echo "vendor.sh: engine/patches/$(basename "$patch") isn't a regular file named *.patch (a symbolic link, even to one, isn't taken); make it one, or remove it. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  if ! git -C "$tmp/quickjs-ng" apply --cached "$patch"; then
    echo "vendor.sh: engine/patches/$(basename "$patch") doesn't apply to quickjs-ng $TAG; engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  patched=$((patched + 1))
done
# Only FILES are copied, so a patch's change to any other file would be applied and then dropped.
# Each path the patches leave changed is checked by name, a rename's old and new paths both.
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
# The copy writes each file as a plain one, so a listed file that the patches leave executable, a
# link or a submodule is refused rather than written as something else.
for f in "${FILES[@]}"; do
  if ! git -C "$tmp/quickjs-ng" cat-file -e ":$f" 2>/dev/null; then
    echo "vendor.sh: quickjs-ng $TAG has no $f, or a patch removes it; update FILES or the patch. engine/quickjs-ng is unchanged." >&2
    exit 1
  fi
  mode=$(git -C "$tmp/quickjs-ng" ls-files --stage -- ":(literal)$f")
  mode=${mode%% *}
  if [ "$mode" != 100644 ]; then
    echo "vendor.sh: $f has mode $mode after the patches, which the copy can't keep, since it writes plain files; engine/quickjs-ng is unchanged." >&2
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
    echo "vendor.sh: couldn't move the new copy into $dest, nor the committed copy back from $old; $restore restores it." >&2
  fi
  exit 1
fi
if [ -e "$old" ] && ! rm -rf "$old"; then
  echo "vendor.sh: the new copy is in place, but the committed copy moved aside to $old couldn't be removed; remove it." >&2
  exit 1
fi
echo "copied ${#FILES[@]} files from quickjs-ng $TAG ($COMMIT), with $patched patches"
