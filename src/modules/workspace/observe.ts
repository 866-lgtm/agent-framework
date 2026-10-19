/**
 * How the workspace observes disk for reconciliation, under the mount's
 * boundary.
 *
 * Observation honors the boundary the way openContainedFile does: the lexical
 * path is lstat'd first, a symlink is refused unless the mount follows
 * symlinks, and a followed one must resolve inside the canonical mount root.
 * Anything that isn't a regular file inside the mount is `unobserved` — it
 * proves nothing either way, and reconciliation leaves the path alone.
 *
 * Reads go through one descriptor that is fstat'd, located inside the mount
 * and then read, so what is read and the fingerprint recorded with its hash
 * describe the same file, inside the mount. A hard link is a name inside the
 * mount like any other, and reading through it shows what that path holds;
 * only a write in place reaches a file's other names, so effects.ts refuses
 * that instead.
 *
 * Directories are checked (CheckedDir): located inside the mount, with their
 * identity, and what they showed — a listing, an absence — is accepted only
 * if each is still the directory its logical path names afterwards. A walk records which
 * directories it listed completely, and only those prove a file absent: an
 * unreadable directory, an ignored subtree, the walk cap, a symlink the walk
 * doesn't descend, or a directory that changed while it was listed leave
 * everything beneath them unproven. Outside a walk, absence is proven the
 * same way: by a directory inside the mount, still at its path, that lacks
 * the entry (confirmAbsent). A missing parent alone proves nothing, since a
 * dangling symlink or a swapped directory looks just like one.
 *
 * Each check is made where the operation happens, against what is there at
 * that moment, so the boundary holds against what is in the mount, including
 * what appears while an operation runs. Node has no openat or fdopendir, so
 * a directory is checked by its canonical path and identity, not held open:
 * a parent replaced concurrently in the window between a check and its use
 * (or replaced and restored around it) can still redirect a listing or
 * lookup there. File contents are bound regardless: a file is read only
 * through a descriptor bound to its path first.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { sameRootIdentity, type Fingerprint, type RootIdentity } from './disk-agreement.js';

export interface MountView {
  /** Mount root as configured. */
  root: string;
  /** The mount's name, which a tool puts before a path in the mount. */
  name: string;
  /**
   * The root directory disk last agreed under, once the mount has evidence.
   * A root that resolves to any other directory is unavailable.
   */
  rootIdentity?: RootIdentity;
  followSymlinks: boolean;
  /** Text above this size is not ingested. */
  maxFileSize: number;
  ignore: string[];
  /** The mount's `include`: files and links it doesn't cover are outside the mount. Absent, everything is inside. */
  include?: readonly string[];
  /**
   * Other mounts' directories nested inside this one, mount-relative. Every
   * pass passes over them, named or not, as another mount's directory.
   */
  others: readonly string[];
  /**
   * The same mounts, each by its directory, its name, its own include and,
   * where it has one, its real root (NestedMount), for a refusal that names
   * the mount a path leads into: through a symlink this mount doesn't follow
   * (linkWords), or through one it follows, or a root configured through one
   * (nestedAtReal). Without it, no path is refused for where its links lead,
   * and a link's refusal names no mount.
   */
  nested?: readonly NestedMount[];
}

/**
 * A mount nested in another: its directory in one of its spellings,
 * mount-relative and `/`-separated, its name, its real root, which every
 * spelling shares, and its own include. The real root is the root as
 * realpath resolves it (the nearest existing directory's, where the root
 * isn't made yet) once the module's start has read it, and the root as
 * configured until then. There's none where it's this mount's own or holds
 * it: the mount is nested by its configured path alone, since through its
 * real root it would claim this mount's every path.
 */
export type NestedMount = { dir: string; name: string; real?: string; include?: readonly string[] };

export type StatFingerprint = Omit<Fingerprint, 'hashedAt'>;

/**
 * Opened with every open of a workspace path that may already be there, a
 * read, a write in place or a directory's sync, where the platform has it:
 * for a regular file or a directory it changes nothing, and a FIFO or other
 * special file swapped in at the path neither blocks the open nor passes the
 * check of its kind that follows. A create needs none: O_CREAT | O_EXCL fails
 * at once on anything already at the path.
 */
export const NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

export type Observation =
  | { kind: 'absent' }
  /** `mode`: the file's permission bits (`st_mode & 0o777`). */
  | { kind: 'file'; size: number; mtimeMs: number; mode: number; fp: StatFingerprint }
  | { kind: 'unobserved'; reason: string };

export interface ReadResult {
  kind: 'read';
  size: number;
  mtimeMs: number;
  /** The permission bits of the inode the bytes were read from. */
  mode: number;
  fp: Fingerprint;
  hash: string;
  /** The whole file, when it is at most the requested limit. */
  bytes: Buffer | null;
  /** First bytes, for binary detection and MIME sniffing. */
  head: Buffer;
}

/** The first bytes of a file and its size: nothing else was read or hashed. */
export interface HeadResult {
  kind: 'head';
  size: number;
  mtimeMs: number;
  head: Buffer;
}

/** Bytes hashed per read when streaming a file larger than the read limit. */
const HASH_CHUNK = 1 << 20;
/** Bytes kept for binary detection and MIME sniffing. */
export const HEAD_BYTES = 8192;
/** Timestamps this close to the hashing time can't vouch for the bytes. */
export const RACY_WINDOW_MS = 2000;

export const OUTSIDE_PARENT = 'a parent directory resolves outside the mount';
export const NOT_FOLLOWED = 'a symlink, which this mount does not follow';
export const ROOT_UNAVAILABLE = 'the mount root is unavailable';
export const ROOT_REPLACED =
  'the mount root is not the directory disk last agreed with (an unmounted drive, or a replaced directory): ' +
  'reconnect it; if it was replaced on purpose, sync the mount with acceptRoot to take it as it is now';
const CHANGED = 'it changed while it was observed';
const CHANGED_WALK = 'the directory changed while the walk ran';
const BENEATH_SYMLINK = 'beneath a symlink that does not lead to a directory inside the mount';

export function errno(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export function contained(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

/** The mount-relative parent of a path ('' for the root). */
export function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
}

/** The last component of a mount-relative path. */
export function nameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

function lexicalOf(view: MountView, rel: string): string {
  return rel === '' ? view.root : join(view.root, rel);
}

/**
 * What linkOnTheWay found on a path's way beneath the mount's root: a
 * symlink (`link`, mount-relative), or a directory there the walk couldn't
 * ask (`unsure`, with the errno it got).
 */
export type LinkFound = { link: string } | { unsure: string; code: string };

const UNSURE_PREFIX = 'cannot tell whether "';

/**
 * On a mount that doesn't follow symlinks, what is on the way to a
 * mount-relative path: the first directory, from beneath the mount's root
 * down to the path itself (or, `through` 'parents', down to its parent), that
 * is a symlink, or one the walk couldn't ask. Null when there is none, or
 * when the mount follows symlinks. The path is
 * walked as the lookups that follow resolve it, with `.` and `..` taken out,
 * so a `..` after a name that isn't there hides nothing beyond it, and the
 * root, which is the configured path whatever it resolves to, is never on the
 * way, even where the path names it on its way back into the mount. Each
 * directory is asked only whether it is a link, by readlink, from the root
 * down. EINVAL means it isn't, and the walk goes on. Nothing there, a file in
 * the way, or a directory this user can't search (ENOENT, ENOTDIR, EACCES)
 * ends it with nothing found, since nothing beneath is reached through a link
 * and the caller's own lookup meets the same answer. Any other answer, EPERM
 * included, leaves it unsure of what's beneath, and the path is refused for
 * that.
 */
export async function linkOnTheWay(
  view: Pick<MountView, 'root' | 'followSymlinks'>,
  rel: string,
  through: 'path' | 'parents' = 'path',
): Promise<LinkFound | null> {
  if (view.followSymlinks) return null;
  const resolved = relative(resolve(view.root), resolve(view.root, rel));
  if (resolved === '' || resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) return null;
  const parts = resolved.split(sep);
  const last = through === 'path' ? parts.length : parts.length - 1;
  for (let i = 1; i <= last; i++) {
    const at = parts.slice(0, i).join('/');
    try {
      await readlink(join(view.root, at));
      return { link: at };
    } catch (err) {
      const code = errno(err);
      if (code === 'EINVAL') continue; // not a link: on to the next directory
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return null;
      return { unsure: at, code: code ?? String(err) };
    }
  }
  return null;
}

/**
 * On a mount that doesn't follow symlinks, what refuses the mount-relative
 * `rel`, which realpath resolved to `real` (or, `through` 'parents', whose
 * parent it resolved to `real`): the first symlink on its way, or a
 * directory there the walk couldn't ask. Null when the mount follows
 * symlinks, or there's none. Where `real` is the root's canonical path joined
 * with what was resolved (`rel`, or with `through` 'parents', its parent),
 * nothing beneath the root resolved through a link, and nothing more is
 * asked: that is every path through ordinary directories, at no cost
 * per path. Otherwise each directory is asked in turn (linkOnTheWay), since a
 * name spelled otherwise than disk spells it, on a file system that ignores
 * case or Unicode normalization, also resolves to another string, and isn't
 * a link.
 */
export async function linkRefusal(
  view: Pick<MountView, 'root' | 'followSymlinks'>,
  rootReal: string,
  rel: string,
  real: string,
  through: 'path' | 'parents' = 'path',
): Promise<LinkFound | null> {
  if (view.followSymlinks) return null;
  const resolvedAt = through === 'path' ? rel : parentOf(rel);
  if (resolvedAt === '' || real === join(rootReal, resolvedAt)) return null;
  return linkOnTheWay(view, rel, through);
}

/**
 * Where a symlink the walk found leads, for its refusal: to a path inside
 * the mount (mount-relative, and whether it's a directory), outside the
 * mount, or nowhere it can be resolved to. One realpath and one stat, made
 * only when refusing.
 */
export type LinkLeads = { kind: 'inside'; target: string; directory: boolean } | { kind: 'outside' } | { kind: 'nowhere' };

export async function linkLeads(root: string, rootReal: string, link: string): Promise<LinkLeads> {
  const leads = await realpath(join(root, link)).catch(() => null);
  if (leads === null) return { kind: 'nowhere' };
  if (!contained(rootReal, leads)) return { kind: 'outside' };
  const directory = await stat(leads).then((info) => info.isDirectory(), () => false);
  return { kind: 'inside', target: relative(rootReal, leads).split(sep).join('/'), directory };
}

/**
 * The nested mount whose directory holds `target` (mount-relative), the
 * innermost where nested mounts nest, as #460 picks one; undefined when none
 * does.
 */
export function nestedHolder<N extends { dir: string; name: string }>(target: string, nested: readonly N[]): N | undefined {
  return nested
    .filter((n) => target === n.dir || target.startsWith(`${n.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/**
 * Whether a link's refusal names `holder`, the nested mount whose directory
 * holds the link's target. The target's path is one of that mount's own, so
 * its include decides: the refusal names a directory, or a file the include
 * covers. A refusal's code follows the same test (linkReadError's
 * `other_mount`), so the code says no more than the message.
 */
export function namesHolder(leads: { target: string; directory: boolean }, holder: { dir: string; include?: readonly string[] }): boolean {
  return namesNestedPlace(leads.target.slice(holder.dir.length + 1), holder.include, leads.directory);
}

/**
 * Whether a refusal names a place in a nested mount's directory, `rest`
 * beneath that mount's root, as a place of that mount's: a directory, or a
 * file its include covers. The place is one of that mount's own paths, so
 * its include decides, and a refusal's code follows the same test, so the
 * code says no more than the message. Anywhere else the place is no mount's:
 * the outer mount passes over the nested directory, and the nested mount's
 * include leaves it out. So a link the outer mount doesn't follow is refused
 * as one it doesn't follow (namesHolder), and a path that reaches the place
 * through one it follows is refused as one that leaves the mount, in the
 * words each such refusal already has (nestedAtReal's callers).
 */
export function namesNestedPlace(rest: string, include: readonly string[] | undefined, directory: boolean): boolean {
  return directory || insideMount(rest, include);
}

/**
 * Why a path is refused for what linkOnTheWay found, given where a link
 * leads (linkLeads). For a link, the link is the subject, with where it
 * leads: for a link inside the mount, its target, and for a link to a
 * directory there, the setting the mount's host can change (the link stands
 * among the path's directories, so following a link to a file can't make the
 * path beneath it exist); for one leading outside the mount, that it does;
 * for one that can't be resolved, nothing more. A target in a nested mount's
 * directory (`nested`) is that mount's: the refusal names the mount and the
 * path to use there in place of the link, and offers no setting, since
 * following the link would only reach into another mount's directory. For a
 * directory the walk couldn't ask, which one, and the answer it got. Paths
 * are spelled as the tools take them, from the mount's name. On a mount with
 * an include, an inside target is named only where a tool could name it: a
 * file the include covers, or a directory, which a listing names whatever
 * lies beneath it. Anywhere else the refusal says only that the link isn't
 * followed, so no tool names what lies outside the include.
 */
export function linkWords(name: string, found: LinkFound, leads: LinkLeads | null, nested: readonly NestedMount[] = [], include?: readonly string[]): string {
  const spell = (rel: string) => `"${rel === '' ? name : `${name}/${rel}`}"`;
  if (!('link' in found)) return `${UNSURE_PREFIX}${name}/${found.unsure}" is a symlink (${found.code})`;
  const link = `${spell(found.link)} is a symlink`;
  if (leads === null || leads.kind === 'nowhere') return `${link}, which this mount does not follow`;
  if (leads.kind === 'outside') return `${link} leading outside the mount, which this mount does not follow`;
  const holder = nestedHolder(leads.target, nested);
  if (holder) {
    if (!namesHolder(leads, holder)) return `${link}, which this mount does not follow`;
    const rest = leads.target.slice(holder.dir.length + 1);
    return `${link} to ${spell(leads.target)}, which this mount does not follow; it lies in mount "${holder.name}", ` +
      `nested in mount "${name}": use "${rest ? `${holder.name}/${rest}` : holder.name}" in place of ${spell(found.link)}`;
  }
  if (!leads.directory && !insideMount(leads.target, include)) return `${link}, which this mount does not follow`;
  const setting = leads.directory ? "; the mount's host can set followSymlinks: true" : '';
  return `${link} to ${spell(leads.target)}, which this mount does not follow${setting}`;
}

/** Why a path is refused for what linkOnTheWay found (linkWords, with where the link leads). */
export async function linkReason(view: Pick<MountView, 'root' | 'name' | 'nested' | 'include'>, rootReal: string, found: LinkFound): Promise<string> {
  return linkWords(view.name, found, 'link' in found ? await linkLeads(view.root, rootReal, found.link) : null, view.nested, view.include);
}

/**
 * The nested mount whose root holds `real`, a canonical path, the innermost,
 * with the path to use there, the path beneath its root (`rest`) and its
 * include; undefined when none does. A path the lexical checks pass
 * (inOtherMount, the tools' holderOf) reaches another mount's directory this
 * way through a symlink the mount follows, so each check that resolves a
 * path canonically asks this too. Where the nested mount has an include, a
 * mount that follows links asks landing first, which judges the place by
 * that mount's view; this names the mount for one without an include, and
 * judges an opened file's place by name (namesNestedPlace) where an open
 * followed a link its mount doesn't follow.
 */
export function nestedAtReal(real: string, nested: readonly NestedMount[] = []): { name: string; use: string; rest: string; include?: readonly string[] } | undefined {
  const holder = nested
    .flatMap((n) => (n.real !== undefined && contained(n.real, real) ? [{ name: n.name, real: n.real, include: n.include }] : []))
    .sort((a, b) => b.real.length - a.real.length)[0];
  if (!holder) return undefined;
  const rest = relative(holder.real, real).split(sep).join('/');
  return { name: holder.name, use: rest ? `${holder.name}/${rest}` : holder.name, rest, include: holder.include };
}

/** How many links a landing follows before it stops, as the kernel's limit does. */
const LINKS_FOLLOWED = 40;

/**
 * Where a path of a mount that follows symlinks lands, where a link on its
 * way leads into the directory of a nested mount with an include: that
 * mount, with the path to use there and the path beneath its root (as
 * nestedAtReal gives them), and whether the place is that mount's to show.
 * Undefined where no link on the way leads into such a directory, or where
 * the path reaches nothing before it would.
 *
 * The path is walked from the mount's real root a name at a time, as the
 * kernel walks it: a link is followed from where it stands, a `..` climbs
 * from the real directory it's in, and a nested mount's root is known by
 * which directory it is, in whatever spelling the path reaches it. Inside
 * the directory of a nested mount with an include, the walk reads that
 * mount's names as it shows them: a directory there is entered, and the
 * walk stops at any other name, whatever is there or whether anything is, a
 * link included, since where a link there leads is that mount's to show,
 * through its own paths. Where it stops, the place is shown only where it's
 * the path's last name and the include covers it (namesNestedPlace); a path
 * that would go on past a file, a link or a name that isn't there reaches
 * no place of that mount's. A place where the walk ends at a directory is
 * shown, as a listing shows every directory. So a refusal of a place the
 * include leaves out is the same whether anything is there, and shows no
 * name the walk didn't read as shown. A nested mount without an include
 * shows every place in its directory, so the walk goes through it as it
 * does outside, and judges again in any mount with an include it reaches.
 * Names are judged as the path and its links spell them, as
 * resolveAbsolutePath judges a path as given: on a disk that folds names,
 * an include that spells a name otherwise than disk does can withhold a
 * covered file reached in another spelling, or name a place that mount then
 * refuses, and neither answer depends on what's there.
 *
 * A caller walks only where its path follows a link, or where the kernel
 * couldn't resolve it: a path whose real place is its own spelling reaches a
 * nested mount's directory only by name, which the lexical checks judge.
 */
export async function landing(
  root: string,
  relativePath: string,
  nested: readonly NestedMount[] = [],
): Promise<{ name: string; use: string; rest: string; include?: readonly string[]; shown: boolean } | undefined> {
  if (!nested.some((n) => n.real !== undefined && n.include !== undefined)) return undefined;
  let dir = await realpath(root).catch(() => null);
  if (dir === null) return undefined;
  // Each nested root by which directory it is, so the walk knows one in
  // whatever spelling it reaches it, as a disk that folds names lets it.
  // A nested mount can be listed once for each spelling of its directory,
  // with one real root, which is read once.
  const roots = (await Promise.all([...new Map(nested.flatMap((n) => (n.real === undefined ? [] : [[n.real, n] as const]))).values()].map(async (n) => {
    const at = await stat(n.real!, { bigint: true }).catch(() => null);
    return at === null ? [] : [{ mount: n, dev: at.dev, ino: at.ino }];
  }))).flat();
  const separators = sep === '\\' ? /[\\/]/ : /\//;
  const todo = relativePath.split('/');
  let links = 0;
  let followed = false;
  // The nested mounts' directories the walk is in, outermost first, each with
  // the names taken beneath its root; the last is the one that holds `dir`.
  // One with an include is read as that mount shows its names. One without
  // shows every place in it, so it's walked as the outer mount's directories
  // are, links followed, until the walk reaches a mount with an include.
  const within: Array<{ mount: NestedMount; names: string[] }> = [];
  while (todo.length > 0) {
    const name = todo.shift()!;
    if (name === '' || name === '.') continue;
    const inside = within.at(-1);
    if (name === '..') {
      // A `..` takes back a name, or at a nested root climbs out of that
      // mount's directory into the one that holds it, as the kernel climbs.
      if (inside !== undefined && inside.names.length > 0) inside.names.pop();
      else within.pop();
      dir = dirname(dir);
      continue;
    }
    const at = join(dir, name);
    const info = await lstat(at, { bigint: true }).catch(() => null);
    if (inside?.mount.include !== undefined && !info?.isDirectory()) {
      // The walk stops at a name that isn't a directory, whatever is there
      // or whether anything is, a link included: where a link there leads is
      // that mount's to show. The place is shown only where the path ends
      // here, with nothing after it, not even a `/` or a `.`, which the
      // kernel can't take past a file.
      const rest = [...inside.names, name].join('/');
      const { mount } = inside;
      return { name: mount.name, use: `${mount.name}/${rest}`, rest, include: mount.include, shown: todo.length === 0 && namesNestedPlace(rest, mount.include, false) };
    }
    if (info === null) return undefined;
    if (info.isSymbolicLink()) {
      if (++links > LINKS_FOLLOWED) return undefined;
      const target = await readlink(at).catch(() => null);
      if (target === null) return undefined;
      followed = true;
      // An absolute target is walked from its root, whose own parts, such as
      // a drive or a share, aren't names to look up beneath it, and it lies
      // in whichever mounts' directories the walk then enters.
      const top = isAbsolute(target) ? parse(target).root : '';
      if (top !== '') {
        dir = top;
        within.length = 0;
      }
      todo.unshift(...target.slice(top.length).split(separators));
      continue;
    }
    if (!info.isDirectory()) return undefined;
    const root = roots.find((r) => r.dev === info.dev && r.ino === info.ino);
    if (root !== undefined) {
      // A nested mount's root, entered by a path that followed a link on its
      // way; one entered by name alone is the lexical checks'.
      if (!followed) return undefined;
      within.push({ mount: root.mount, names: [] });
    } else if (inside !== undefined) {
      inside.names.push(name);
    }
    dir = at;
  }
  // A path that ends in a nested mount's directory with an include ends at a
  // directory there, which that mount shows. Anywhere else, the place is
  // resolved as without an include.
  const inside = within.at(-1);
  if (inside?.mount.include === undefined) return undefined;
  const rest = inside.names.join('/');
  return { name: inside.mount.name, use: rest ? `${inside.mount.name}/${rest}` : inside.mount.name, rest, include: inside.mount.include, shown: true };
}

/**
 * On a mount that follows symlinks, what the walk says of a path (landing)
 * before a site tells what the kernel answered for it: where the path's
 * real place, `real`, isn't its spelling beneath the root, or where the
 * site has no real place to compare (`real` null), as where the kernel
 * couldn't resolve the path, a lookup or open failed, or a read met
 * something that isn't a regular file. So the site's own answer, such as an
 * errno, a place outside the mount or a file's kind, is told only where the
 * walk reached no place of a nested mount with an include. A path that
 * resolves to its own spelling isn't walked; one with `real` null is, on
 * those error paths only.
 */
export async function landedFor(view: Pick<MountView, 'root' | 'followSymlinks' | 'nested'>, rootReal: string, rel: string, real: string | null): Promise<Awaited<ReturnType<typeof landing>>> {
  if (!view.followSymlinks || (real !== null && real === join(rootReal, rel))) return undefined;
  return landing(view.root, rel, view.nested);
}

/**
 * Why a mount-relative path that resolves into a nested mount's directory is
 * refused (nestedAtReal): what it leads into, and the path to use in its
 * place. Spelled as the tools take paths, from the mount's name.
 */
export function leadsInto(name: string, rel: string, holder: { name: string; use: string }): string {
  return `"${rel === '' ? name : `${name}/${rel}`}" leads into mount "${holder.name}", nested in mount "${name}": use "${holder.use}" in its place`;
}

// ===========================================================================
// Disk's spelling of a path
// ===========================================================================

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/** A letter's other case: its upper case if it's in lower case, else its lower case. */
const otherCase = (c: string): string => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

/**
 * The name with each letter's case flipped, where its other case is one
 * letter whose own other case is the letter again, so the flip changes only
 * pairs that any folding disk folds together. `ß`, whose upper case is `SS`,
 * and dotless `ı`, whose upper case `I` lowers to `i`, stay as they are.
 */
const flippedCase = (name: string): string =>
  [...name].map((c) => {
    const other = otherCase(c);
    return [...other].length === 1 && otherCase(other) === c ? other : c;
  }).join('');

/**
 * How the directory holding one level of a path compares names: whether it
 * folds case, and whether it folds Unicode normalization (NFC against NFD).
 */
export interface LevelFolds { case: boolean; normalization: boolean }

/**
 * For each segment of the directory `relativePath` beneath `root`, how the
 * directory holding it compares names (foldsAtEach's LevelFolds): a variant
 * of that segment alone, its letters' case flipped or its other Unicode
 * normalization form, reaches the same entry (device and inode), as
 * listedName tests one. Where a level can't be tested, because the segment
 * has no such variant or isn't on disk, it's taken to fold, so a comparison
 * errs toward the directory: resolveAbsolutePath then gives null for a path
 * it can't tell apart from one into the directory.
 */
export async function foldsAtEach(root: string, relativePath: string): Promise<LevelFolds[]> {
  const segments = relativePath.split('/');
  const levels: LevelFolds[] = segments.map(() => ({ case: true, normalization: true }));
  let dir = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const own = await lstat(join(dir, segment), { bigint: true }).catch(() => null);
    if (own === null) break;
    const reaches = async (variant: string): Promise<boolean> => {
      const other = await lstat(join(dir, variant), { bigint: true }).catch(() => null);
      return other !== null && sameFile(other, own);
    };
    const flipped = flippedCase(segment);
    if (flipped !== segment) levels[i]!.case = await reaches(flipped);
    const forms = [segment.normalize('NFC'), segment.normalize('NFD')].filter((f) => f !== segment);
    if (forms.length > 0) levels[i]!.normalization = await reaches(forms[0]!);
    dir = join(dir, segment);
  }
  return levels;
}

/** A name as a level compares it (LevelFolds), strictly or, for case, through upper case and back too. */
const foldedAt = (name: string, at: LevelFolds, loosely: boolean): string => {
  const n = at.normalization ? name.normalize('NFC') : name;
  return !at.case ? n : loosely ? n.toLowerCase().toUpperCase().toLowerCase() : n.toLowerCase();
};

/**
 * Whether a path's segments begin with a directory's, compared level by
 * level: as each level's directory compares names (`levels[i]`, from
 * foldsAtEach), and exactly where nothing is known of the level. Case is
 * compared as listedName compares it, strictly and then more loosely, but
 * with no same-file check, so on a disk that folds case and keeps `ß` apart
 * from `ss`, or `ı` from `i`, a distinct directory spelled with one of them
 * matches too, and resolveAbsolutePath, the one caller that folds, gives
 * null for it.
 */
export function beginsWithDir(segments: readonly string[], dir: readonly string[], levels: readonly LevelFolds[]): boolean {
  if (segments.length < dir.length) return false;
  return dir.every((d, i) => {
    const s = segments[i]!;
    const at = levels[i];
    return s === d || (at !== undefined && [false, true].some((loosely) => foldedAt(s, at, loosely) === foldedAt(d, at, loosely)));
  });
}

/** Names compared as NFC in lower case. */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * Names compared more loosely, through upper case and back, which also folds
 * `ß` with `ss`, `ſ` with `s` and `ς` with `σ`, as a disk that folds fully
 * does. It also folds dotless `ı` with `i`, which a disk may keep apart;
 * the same-file check keeps that from naming another file.
 */
const foldedLoosely = (name: string): string => name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();

/**
 * The name `dir` lists for `segment`: `segment` itself, unless disk folds it
 * there and lists it otherwise. `dir` is listed only where a variant of
 * `segment`, its case flipped or its other Unicode normalization form, finds
 * the same file (device and inode) as `given`, the segment's own entry, as on
 * a disk that folds names. The last segment isn't looked up as given unless
 * the listing must settle it, so for it any variant found leads to the
 * listing: on a disk that tells spellings apart, that's only where `dir`
 * holds a variant as a name of its own. The name as given wins if it's
 * listed; otherwise the segment takes the listed name that folds to it and is
 * the same file, so the name returned reaches the file the segment does, or
 * is the segment as given. Names are compared as NFC in lower case first, and
 * only where none of those is the file, more loosely (foldedLoosely). A
 * directory that can't be listed, or a name that can't be looked up, leaves
 * the segment as given.
 */
async function listedName(dir: string, segment: string, given: BigIntStats | null): Promise<string> {
  const variants = new Set([flippedCase(segment), segment.normalize('NFC'), segment.normalize('NFD')]);
  variants.delete(segment);
  let folds = false;
  for (const variant of variants) {
    const other = await lstat(join(dir, variant), { bigint: true }).catch(() => null);
    if (other !== null && (given === null || sameFile(other, given))) { folds = true; break; }
  }
  if (!folds) return segment;
  const listed = await readdir(dir).catch(() => null);
  if (listed === null || listed.includes(segment)) return segment;
  const target = given ?? await lstat(join(dir, segment), { bigint: true }).catch(() => null);
  if (target === null) return segment;
  for (const fold of [folded, foldedLoosely]) {
    for (const name of listed) {
      if (fold(name) !== fold(segment)) continue;
      const info = await lstat(join(dir, name), { bigint: true }).catch(() => null);
      if (info !== null && sameFile(info, target)) return name;
    }
  }
  return segment;
}

/**
 * `relativePath` as disk spells it. On a disk that folds names, as macOS's
 * does by default (case and Unicode normalization), `SRC/a.ts` reaches
 * `src/a.ts`, and whatever names what it finds from the spelling it was
 * given takes the file in a second time, under a name disk doesn't list. So
 * each segment, from the mount's root down, takes the name its directory
 * lists for it (listedName). The walk goes on beneath a segment only if it's
 * a directory, a symlink not included, so nothing past a link is read. It
 * passes over an empty or `.` segment, which names the directory reached,
 * and goes back up at `..`, to the directory it came from. At the mount's
 * root a `..` stops it, keeping the rest as given: a path can climb above
 * the root and come back in, as `../proj/x` does for a root named `proj`, and
 * walking that would list the directory above the root. An absolute path
 * keeps its spelling too: it names a place from the filesystem's root, not
 * the mount's, so walking it from the mount's root would respell it against
 * other directories, and the path returned could lead outside the mount.
 */
export async function diskSpelling(root: string, relativePath: string): Promise<string> {
  if (relativePath === '' || isAbsolute(relativePath)) return relativePath;
  const segments = relativePath.split('/');
  // The directories walked into, the mount's root first.
  const dirs = [root];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (dirs.length === 1) break;
      dirs.pop();
      continue;
    }
    const dir = dirs[dirs.length - 1]!;
    const last = i === segments.length - 1;
    const given = last ? null : await lstat(join(dir, segment), { bigint: true }).catch(() => null);
    if (!last && given === null) break;
    segments[i] = await listedName(dir, segment, given);
    if (given === null || !given.isDirectory()) break;
    dirs.push(join(dir, segments[i]!));
  }
  return segments.join('/');
}

// ===========================================================================
// Checked directories
// ===========================================================================

export type DirCheck =
  | { kind: 'checked'; dir: CheckedDir }
  /**
   * No directory there, proven: nothing can exist beneath the path. `by` is
   * the directory whose entries prove it — the one that lacks it, or that
   * holds the non-directory in its place.
   */
  | { kind: 'absent'; by: string }
  /** Unproven either way; `outside` when it resolves outside the mount. */
  | { kind: 'unobserved'; reason: string; outside?: true };

/** Errors meaning a directory can't be synced on this filesystem, not that syncing it failed. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP']);

/**
 * A directory inside the mount, as it was checked: its canonical path and
 * its identity. Its entries are named through that path, and what it showed
 * is accepted only while it is still the directory its logical path names
 * (see the module doc for what that does and doesn't bind).
 */
export class CheckedDir {
  constructor(
    /** Mount-relative path ('' for the root). */
    readonly rel: string,
    /** Its canonical location when checked. */
    readonly real: string,
    private readonly lexical: string,
    private readonly dev: bigint,
    private readonly ino: bigint,
  ) {}

  /** Which directory it is. */
  identity(): RootIdentity {
    return { dev: String(this.dev), ino: String(this.ino) };
  }

  /** A path that reaches `name` in this directory. */
  at(name: string): string {
    return join(this.real, name);
  }

  /** Whether it is still the directory its logical path names: same location, same directory. */
  async stillHere(): Promise<boolean> {
    if ((await realpath(this.lexical).catch(() => null)) !== this.real) return false;
    const info = await lstat(this.real, { bigint: true }).catch(() => null);
    return info !== null && info.isDirectory() && info.dev === this.dev && info.ino === this.ino;
  }

  /**
   * Make its entries durable: this very directory, never one that replaced
   * it at its path. Throws if it can't; a filesystem that can't sync
   * directories (or Windows, where a directory can't be opened for it) is
   * not a failure.
   */
  async sync(): Promise<void> {
    if (process.platform === 'win32') return;
    // NONBLOCK: a FIFO put at its path since it was checked opens at once,
    // and is refused below as not this directory, instead of holding the
    // open, and with it the mount's turn, until something opens it for
    // writing.
    const handle = await open(this.real, fsConstants.O_RDONLY | NONBLOCK);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || info.dev !== this.dev || info.ino !== this.ino) throw new Error(CHANGED);
      try {
        await handle.sync();
      } catch (err) {
        if (!DIRECTORY_SYNC_UNSUPPORTED.has(errno(err) ?? '')) throw err;
      }
    } finally {
      await handle.close();
    }
  }
}

/** Check the directory at a canonical location, if one is there. */
async function checkedAt(view: MountView, rel: string, real: string): Promise<CheckedDir | null> {
  const info = await lstat(real, { bigint: true }).catch(() => null);
  if (!info?.isDirectory()) return null;
  return new CheckedDir(rel, real, lexicalOf(view, rel), info.dev, info.ino);
}

/**
 * Where a mount directory is now: checked; missing — nothing there, or not a
 * directory, either way for confirmAbsent to prove; or not inside the mount.
 */
async function locateDir(view: MountView, rootReal: string, rel: string): Promise<DirCheck | { kind: 'missing' }> {
  const lexical = lexicalOf(view, rel);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return rel === '' ? { kind: 'unobserved', reason: ROOT_UNAVAILABLE } : { kind: 'missing' };
    // Where the kernel couldn't resolve it, as through a loop, the walk tells
    // first where the path went (landedFor).
    const landed = rel === '' ? undefined : await landedFor(view, rootReal, rel, null);
    if (landed) return landed.shown ? { kind: 'unobserved', reason: leadsInto(view.name, rel, landed) } : { kind: 'missing' };
    // A link on the way that can't be resolved, such as a loop, is still a
    // link this mount doesn't follow.
    const found = rel === '' ? null : await linkOnTheWay(view, rel);
    if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
    return { kind: 'unobserved', reason: `cannot resolve the directory (${code ?? String(err)})` };
  }
  // A mount that doesn't follow symlinks goes through none on the way to a
  // directory, inside the mount or out of it.
  const found = await linkRefusal(view, rootReal, rel, real);
  if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
  // Through a link this mount follows, a directory can be a nested mount's,
  // which the mount neither reads nor writes. Where that mount has an
  // include, its view decides first (landedFor), wherever the kernel ended:
  // a place it doesn't show is no directory here, as at any file.
  const landed = rel === '' ? undefined : await landedFor(view, rootReal, rel, real);
  if (landed) return landed.shown ? { kind: 'unobserved', reason: leadsInto(view.name, rel, landed) } : { kind: 'missing' };
  if (rel === '') {
    // The root is whatever the configured path names, and it must still be
    // the root the pass was given.
    if (real !== rootReal) return { kind: 'unobserved', reason: ROOT_UNAVAILABLE };
  } else if (!contained(rootReal, real)) {
    return { kind: 'unobserved', reason: OUTSIDE_PARENT, outside: true };
  } else {
    const linked = view.followSymlinks && real !== join(rootReal, rel);
    const holder = nestedAtReal(real, view.nested);
    // Through a link, a nested mount with an include that the walk reached
    // no place of shows nothing here.
    if (holder && linked && holder.include !== undefined) return { kind: 'missing' };
    if (holder) return { kind: 'unobserved', reason: leadsInto(view.name, rel, holder) };
  }
  const checked = await checkedAt(view, rel, real);
  if (checked) {
    // A root that isn't the directory disk last agreed under proves nothing
    // about the files that agreed: an empty mountpoint where a drive was
    // would otherwise read as every file deleted.
    if (rel === '' && view.rootIdentity && !sameRootIdentity(checked.identity(), view.rootIdentity)) {
      return { kind: 'unobserved', reason: ROOT_REPLACED };
    }
    return { kind: 'checked', dir: checked };
  }
  return rel === '' ? { kind: 'unobserved', reason: ROOT_UNAVAILABLE } : { kind: 'missing' };
}

/**
 * The mount root as it is now: its identity if it is available (a directory,
 * the one the pass was given, and the one disk last agreed under), else why not.
 */
export async function locateRoot(view: MountView, rootReal: string): Promise<{ identity: RootIdentity } | { reason: string }> {
  const found = await checkRoot(view, rootReal);
  return 'dir' in found ? { identity: found.dir.identity() } : found;
}

/** The mount root as locateRoot finds it, checked, so a caller can ask later whether it's still there. */
export async function checkRoot(view: MountView, rootReal: string): Promise<{ dir: CheckedDir } | { reason: string }> {
  const found = await locateDir(view, rootReal, '');
  if (found.kind === 'checked') return { dir: found.dir };
  return { reason: found.kind === 'unobserved' ? found.reason : ROOT_UNAVAILABLE };
}

/**
 * Check the directory at a mount-relative path. With `create`, missing
 * directories are made one at a time beneath the deepest one that exists;
 * the mount root itself is never created (a missing root is an unavailable
 * mount). Without it, a missing directory is `absent` only where that can be
 * proven (confirmAbsent).
 */
export async function checkDir(view: MountView, rootReal: string, rel: string, opts: { create?: boolean } = {}): Promise<DirCheck> {
  const found = await locateDir(view, rootReal, rel);
  if (found.kind !== 'missing') return found;
  if (opts.create) return createDir(view, rootReal, rel);
  const proof = await confirmAbsent(view, rootReal, rel, 'beneath');
  return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent', by: proof.by };
}

async function createDir(view: MountView, rootReal: string, rel: string): Promise<DirCheck> {
  const parts = rel.split('/');
  let base: CheckedDir | null = null;
  let depth = parts.length - 1;
  for (; depth >= 0; depth--) {
    const found = await locateDir(view, rootReal, parts.slice(0, depth).join('/'));
    if (found.kind === 'checked') {
      base = found.dir;
      break;
    }
    if (found.kind !== 'missing') return found;
  }
  if (base === null) return { kind: 'unobserved', reason: ROOT_UNAVAILABLE };
  for (let i = depth; i < parts.length; i++) {
    const childRel = parts.slice(0, i + 1).join('/');
    // Nothing is made in a nested mount's directory, its root included where
    // it isn't made yet, by a path that reaches it through a link. `base` is
    // a checked directory, which locateDir names or withholds anywhere inside
    // a nested mount's directory, so the place here is only ever a nested
    // mount's root, which is that mount's, and nothing need be asked of it
    // (namesNestedPlace).
    const holder = nestedAtReal(base.at(parts[i]!), view.nested);
    if (holder) return { kind: 'unobserved', reason: leadsInto(view.name, childRel, holder) };
    try {
      await mkdir(base.at(parts[i]!));
    } catch (err) {
      const code = errno(err);
      if (code !== 'EEXIST') return { kind: 'unobserved', reason: `cannot create the directory ${childRel} (${code ?? String(err)})` };
    }
    // Made, or there already (made meanwhile, or not a directory): it must
    // be a real directory now, never a symlink or file in its place.
    const checked = await checkedAt(view, childRel, base.at(parts[i]!));
    if (!checked) {
      // A symlink in the way, such as one that leads nowhere, on a mount that
      // doesn't follow symlinks, is named as one.
      const there = view.followSymlinks ? null : await lstat(base.at(parts[i]!)).catch(() => null);
      if (there?.isSymbolicLink()) return { kind: 'unobserved', reason: await linkReason(view, rootReal, { link: childRel }) };
      return { kind: 'unobserved', reason: 'a parent path is not a directory' };
    }
    base = checked;
  }
  return { kind: 'checked', dir: base };
}

/**
 * Prove that nothing exists at a mount-relative path (`entry`), or that no
 * directory does, so nothing can exist beneath it (`beneath`). Walking down
 * from the root through checked directories: some directory lacks the next
 * component; or a component is a non-directory, still the same one, beneath
 * which nothing can exist. Either proves it only while every directory the
 * walk went through, the root included, is still the one its path names
 * afterwards: a root or parent replaced during the walk would otherwise lend
 * its replacement's absence to the original's path. On a mount that follows
 * symlinks, symlinked directories inside the mount are followed as parents;
 * on one that doesn't, a symlinked directory on the way proves nothing, and
 * the reason says so (linkReason). Any other symlink proves nothing.
 * Returns the directory whose entries prove it, or why absence couldn't be
 * shown.
 */
export async function confirmAbsent(view: MountView, rootReal: string, rel: string, target: 'entry' | 'beneath' = 'entry'): Promise<{ by: string } | string> {
  const root = await locateDir(view, rootReal, '');
  if (root.kind !== 'checked') return ROOT_UNAVAILABLE;
  let cur: CheckedDir = root.dir;
  /** Every directory the walk went through, the root first. */
  const walked: CheckedDir[] = [cur];
  const proven = async (): Promise<{ by: string } | string> => {
    for (const dir of walked) if (!(await dir.stillHere())) return CHANGED;
    return { by: cur.rel };
  };
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const last = i === parts.length - 1;
    const childRel = parts.slice(0, i + 1).join('/');
    let info;
    try {
      info = await lstat(cur.at(name), { bigint: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOTDIR') return CHANGED;
      if (code !== 'ENOENT') return `cannot stat (${code ?? String(err)})`;
      // Absent from a directory that, like each above it, is still the one its path names.
      return proven();
    }
    if (info.isDirectory()) {
      if (last) return CHANGED; // present after all
      cur = new CheckedDir(childRel, cur.at(name), lexicalOf(view, childRel), info.dev, info.ino);
      walked.push(cur);
      continue;
    }
    if (info.isSymbolicLink()) {
      if (last && target === 'entry') return CHANGED; // present: the link itself
      // A mount that doesn't follow symlinks goes through none on the way.
      if (!view.followSymlinks) return linkReason(view, rootReal, { link: childRel });
      const located = await locateDir(view, rootReal, childRel);
      if (located.kind !== 'checked') return BENEATH_SYMLINK;
      if (last) return CHANGED; // a directory there after all
      cur = located.dir;
      walked.push(cur);
      continue;
    }
    if (last && target === 'entry') return CHANGED; // present after all
    // A non-directory: nothing can exist beneath it, while it is still this
    // same one, in the directory still at its path.
    const again = await lstat(cur.at(name), { bigint: true }).catch(() => null);
    if (again === null || again.isDirectory() || again.isSymbolicLink() || again.dev !== info.dev || again.ino !== info.ino) return CHANGED;
    return proven();
  }
  return CHANGED;
}

async function absence(view: MountView, rootReal: string, rel: string): Promise<Exclude<Observation, { kind: 'file' }>> {
  const proof = await confirmAbsent(view, rootReal, rel);
  return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent' };
}

// ===========================================================================
// Fingerprints
// ===========================================================================

function statFingerprint(st: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint }): StatFingerprint {
  return {
    size: Number(st.size),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
    ino: st.ino.toString(),
    dev: st.dev.toString(),
  };
}

/** Same file, same bytes, as far as stat can tell. */
export function sameFingerprint(a: StatFingerprint, b: StatFingerprint): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev;
}

/**
 * Whether a recorded fingerprint vouches that the current file still holds
 * the bytes hashed with it: the filesystem maintains ctime (so no user-space
 * tool can restore the old stamps after a write), every field matches, and
 * the file's timestamps were already more than the racy window old when it
 * was hashed (a write in the same timestamp tick can't hide behind them).
 * Device and inode are part of it, so a stat that reached another file — a
 * path whose parent was swapped, say — can never vouch for P's bytes.
 */
export function fingerprintVouches(recorded: Fingerprint | undefined, current: StatFingerprint, trusted: boolean): boolean {
  if (!trusted || !recorded || !sameFingerprint(recorded, current)) return false;
  const newest = Math.max(Number(BigInt(current.mtimeNs) / 1_000_000n), Number(BigInt(current.ctimeNs) / 1_000_000n));
  return recorded.hashedAt - newest > RACY_WINDOW_MS;
}

/**
 * Linux filesystems known to maintain ctime on every content write (statfs
 * f_type). Elsewhere a fingerprint can't vouch, and every observation rehashes.
 */
const CTIME_TRUSTED_FS_TYPES = new Set<number>([
  0xef53, // ext2/ext3/ext4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x01021994, // tmpfs
  0xf2f52010, // f2fs
  0x2fc12fc1, // zfs
  0x794c7630, // overlayfs
]);

/** Whether a statfs f_type is one of those filesystems. */
export function fsTypeTrustsCtime(type: number | bigint): boolean {
  return CTIME_TRUSTED_FS_TYPES.has(Number(type) >>> 0);
}

export async function filesystemTrustsCtime(root: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    return fsTypeTrustsCtime((await statfs(root)).type);
  } catch {
    return false;
  }
}

// ===========================================================================
// Paths and files
// ===========================================================================

/**
 * Where a path's parent directory canonically lies: inside the mount, gone
 * (absence is then proven separately), or somewhere a no-follow open would
 * still reach through — O_NOFOLLOW guards only the final component — which
 * on a mount that doesn't follow symlinks is any symlink on the way.
 */
async function parentPlacement(view: MountView, rootReal: string, relativePath: string): Promise<'inside' | 'gone' | { reason: string }> {
  const parentRel = parentOf(relativePath);
  // Through a link, the nested mount's view decides first (landedFor),
  // wherever the kernel ended: a place it doesn't show holds nothing, as
  // beneath any file.
  const fromLanding = (landed: NonNullable<Awaited<ReturnType<typeof landing>>>): 'gone' | { reason: string } =>
    landed.shown ? { reason: leadsInto(view.name, parentRel, landed) } : 'gone';
  try {
    const parent = await realpath(dirname(join(view.root, relativePath)));
    const found = await linkRefusal(view, rootReal, relativePath, parent, 'parents');
    if (found !== null) return { reason: await linkReason(view, rootReal, found) };
    const landed = await landedFor(view, rootReal, parentRel, parent);
    if (landed) return fromLanding(landed);
    if (!contained(rootReal, parent)) return { reason: OUTSIDE_PARENT };
    const holder = nestedAtReal(parent, view.nested);
    // Through a link, a nested mount with an include that the walk reached
    // no place of shows nothing here.
    const linked = view.followSymlinks && parent !== join(rootReal, parentRel);
    if (holder && linked && holder.include !== undefined) return 'gone';
    return holder ? { reason: leadsInto(view.name, parentRel, holder) } : 'inside';
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    const landed = await landedFor(view, rootReal, parentRel, null);
    if (landed) return fromLanding(landed);
    // A link on the way that can't be resolved, such as a loop, is still a
    // link this mount doesn't follow.
    const found = await linkOnTheWay(view, relativePath, 'parents');
    if (found !== null) return { reason: await linkReason(view, rootReal, found) };
    return { reason: `cannot resolve the parent directory (${code ?? String(err)})` };
  }
}

/**
 * Observe a mount-relative path without reading it. A `file` here is only a
 * stat — anything decided on its bytes is read through a located descriptor,
 * or vouched for by a fingerprint of the very inode P was recorded from — so
 * only `absent` needs proof beyond the path lookup, and gets it.
 */
export async function observePath(view: MountView, rootReal: string, relativePath: string): Promise<Observation> {
  const lexical = join(view.root, relativePath);
  const placement = await parentPlacement(view, rootReal, relativePath);
  if (placement === 'gone') return absence(view, rootReal, relativePath);
  if (placement !== 'inside') return { kind: 'unobserved', reason: placement.reason };
  let info;
  try {
    info = await lstat(lexical, { bigint: true });
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot stat (${code ?? String(err)})` };
  }
  if (info.isSymbolicLink()) {
    if (!view.followSymlinks) return { kind: 'unobserved', reason: NOT_FOLLOWED };
    // Where the link leads into a nested mount's directory with an include,
    // that mount's view decides, before anything is read there (landing): a
    // place it shows is named, and any other leaves the mount, whatever is
    // there or whether anything is.
    const landed = await landing(view.root, relativePath, view.nested);
    if (landed) return { kind: 'unobserved', reason: landed.shown ? leadsInto(view.name, relativePath, landed) : 'a symlink that leaves the mount' };
    let target;
    try {
      target = await stat(lexical, { bigint: true });
    } catch (err) {
      return { kind: 'unobserved', reason: `a symlink whose target cannot be read (${errno(err) ?? String(err)})` };
    }
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (err) {
      return { kind: 'unobserved', reason: `a symlink that cannot be resolved (${errno(err) ?? String(err)})` };
    }
    if (!contained(rootReal, real)) return { kind: 'unobserved', reason: 'a symlink that leaves the mount' };
    const holder = nestedAtReal(real, view.nested);
    // A nested mount with an include that the walk above reached no place of
    // shows nothing here.
    if (holder) return { kind: 'unobserved', reason: holder.include === undefined ? leadsInto(view.name, relativePath, holder) : 'a symlink that leaves the mount' };
    if (!target.isFile()) {
      return { kind: 'unobserved', reason: target.isDirectory() ? 'a symlink to a directory, not walked' : 'not a regular file' };
    }
    info = target;
  } else if (info.isDirectory()) {
    return { kind: 'unobserved', reason: 'a directory' };
  } else if (!info.isFile()) {
    return { kind: 'unobserved', reason: 'not a regular file' };
  }
  return { kind: 'file', size: Number(info.size), mtimeMs: Number(info.mtimeMs), mode: Number(info.mode & 0o777n), fp: statFingerprint(info) };
}

/**
 * Open a mount-relative file for reading, located: a regular file that
 * canonically lies inside the mount, whatever the symlink policy, since
 * O_NOFOLLOW guards only the final component; on a mount that doesn't follow
 * symlinks, reached through no symlinked directory either (linkRefusal); and
 * the file the canonical path names now. The handle is the caller's to close.
 */
async function openContained(
  view: MountView,
  rootReal: string,
  relativePath: string,
): Promise<{ handle: FileHandle; info: BigIntStats } | Exclude<Observation, { kind: 'file' }>> {
  const lexical = join(view.root, relativePath);
  const noFollow = !view.followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number';
  if (!view.followSymlinks && !noFollow) {
    // No O_NOFOLLOW (Windows): refuse a symlink by lstat before opening.
    const seen = await observePath(view, rootReal, relativePath);
    if (seen.kind !== 'file') return seen;
  }
  let handle;
  try {
    // O_NONBLOCK: a FIFO swapped in since any lstat opens at once instead of
    // waiting for a writer, and the regular-file check below refuses it.
    handle = await open(lexical, fsConstants.O_RDONLY | NONBLOCK | (noFollow ? fsConstants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return absence(view, rootReal, relativePath);
    if (code === 'ELOOP' && !view.followSymlinks) {
      // The link at the path, or a looping one on its way.
      const found = await linkOnTheWay(view, relativePath, 'parents');
      return { kind: 'unobserved', reason: found === null ? NOT_FOLLOWED : await linkReason(view, rootReal, found) };
    }
    // Where the open failed otherwise, as through a loop, the walk tells
    // first where the path went (landedFor).
    const landed = await landedFor(view, rootReal, relativePath, null);
    if (landed) return { kind: 'unobserved', reason: landed.shown ? leadsInto(view.name, relativePath, landed) : 'a symlink that leaves the mount' };
    if (code === 'EISDIR') return { kind: 'unobserved', reason: 'a directory' };
    return { kind: 'unobserved', reason: `cannot open (${code ?? String(err)})` };
  }
  let keep = false;
  try {
    const info = await handle.stat({ bigint: true });
    const real = await realpath(lexical).catch(() => null);
    if (real === null) return { kind: 'unobserved', reason: 'the file changed while it was read' };
    // O_NOFOLLOW guards only the final component: a mount that doesn't
    // follow symlinks goes through none among the directories on the way
    // either. Asked of what the path resolved to after the open, which the
    // check below holds to the descriptor's file, and before what the
    // descriptor holds, so a link gets its own answer whatever it leads to.
    const found = await linkRefusal(view, rootReal, relativePath, real);
    if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
    const leaves = view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT;
    // Through a link this mount follows, the nested mount's view decides
    // first (landedFor), as where the path was checked before the open,
    // whatever the file is.
    const landed = await landedFor(view, rootReal, relativePath, real);
    if (landed) return { kind: 'unobserved', reason: landed.shown ? leadsInto(view.name, relativePath, landed) : leaves };
    if (!info.isFile()) return { kind: 'unobserved', reason: info.isDirectory() ? 'a directory' : 'not a regular file' };
    if (!contained(rootReal, real)) return { kind: 'unobserved', reason: leaves };
    const holder = nestedAtReal(real, view.nested);
    // A place a nested mount's include leaves out is no mount's. Reached
    // through a link this mount doesn't follow, the link is what's refused.
    if (holder) return { kind: 'unobserved', reason: namesNestedPlace(holder.rest, holder.include, false) ? leadsInto(view.name, relativePath, holder) : view.followSymlinks ? leaves : NOT_FOLLOWED };
    const named = await stat(real, { bigint: true }).catch(() => null);
    if (named === null || named.dev !== info.dev || named.ino !== info.ino) {
      return { kind: 'unobserved', reason: 'the file changed while it was read' };
    }
    if (!view.followSymlinks) {
      // Where no symlink is followed, the path itself must be the file the
      // descriptor holds: without O_NOFOLLOW, a link swapped in after the
      // lstat above is followed by the open.
      const entry = await lstat(lexical, { bigint: true }).catch(() => null);
      if (entry?.isSymbolicLink()) return { kind: 'unobserved', reason: NOT_FOLLOWED };
      if (entry === null || !entry.isFile() || entry.dev !== info.dev || entry.ino !== info.ino) {
        return { kind: 'unobserved', reason: 'the file changed while it was read' };
      }
    }
    keep = true;
    return { handle, info };
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot read (${code ?? String(err)})` };
  } finally {
    if (!keep) await handle.close();
  }
}

/**
 * Read an open file from its start, at most `limit` bytes, and whether it
 * goes on past them. Where the file ends is what the reads find: `sizeHint`,
 * the size its fstat gave, only sizes the first buffer. Once a buffer is
 * full, one byte read past it tells whether the file goes on. At the limit,
 * that byte says it does, and isn't kept. Short of it, the file has grown
 * since its fstat: the byte is kept, and the read goes on in a larger buffer,
 * up to the limit. A file that has shrunk ends where the reads find its end.
 * A fractional `limit` allows the whole bytes in it.
 */
export async function readPrefix(handle: FileHandle, limit: number, sizeHint: number): Promise<{ bytes: Buffer; more: boolean }> {
  const cap = Math.floor(limit);
  const next = Buffer.alloc(1);
  let bytes = Buffer.alloc(Math.min(cap, sizeHint));
  let length = 0;
  for (;;) {
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) return { bytes: bytes.subarray(0, length), more: false };
      length += bytesRead;
    }
    if ((await handle.read(next, 0, 1, length)).bytesRead === 0) return { bytes, more: false };
    if (length === cap) return { bytes, more: true };
    // Longer than its fstat said: read on, up to the limit.
    const grown = Buffer.alloc(Math.min(cap, Math.max(2 * length, length + 64 * 1024)));
    bytes.copy(grown, 0, 0, length);
    grown[length++] = next[0];
    bytes = grown;
  }
}

/**
 * Read and hash a mount-relative file through one located descriptor. The
 * whole file is returned when it is at most `limit` bytes, both at its fstat
 * and as read; any other file, including one that grew past `limit` since its
 * fstat, is hashed in chunks and only its head is kept.
 */
export async function readPath(
  view: MountView,
  rootReal: string,
  relativePath: string,
  limit: number,
): Promise<ReadResult | Exclude<Observation, { kind: 'file' }>> {
  const opened = await openContained(view, rootReal, relativePath);
  if (!('handle' in opened)) return opened;
  const { handle, info } = opened;
  try {
    const hashedAt = Date.now();
    const size = Number(info.size);
    const fp: Fingerprint = { ...statFingerprint(info), hashedAt };
    // A file within the limit at its fstat is read no further than the limit,
    // so one that has grown past it since is hashed below, from its start,
    // never loaded whole. One over the limit at its fstat is hashed below
    // without that read.
    const within = size <= limit ? await readPrefix(handle, limit, size) : null;
    if (within && !within.more) {
      const { bytes } = within;
      return {
        kind: 'read',
        size: bytes.byteLength,
        mtimeMs: Number(info.mtimeMs),
        mode: Number(info.mode & 0o777n),
        fp: { ...fp, size: bytes.byteLength },
        hash: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        head: bytes.subarray(0, HEAD_BYTES),
      };
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(HASH_CHUNK);
    let head: Buffer | null = null;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK, offset);
      if (bytesRead === 0) break;
      if (head === null) head = Buffer.from(chunk.subarray(0, Math.min(bytesRead, HEAD_BYTES)));
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return {
      kind: 'read',
      size: offset,
      mtimeMs: Number(info.mtimeMs),
      mode: Number(info.mode & 0o777n),
      fp: { ...fp, size: offset },
      hash: hash.digest('hex'),
      bytes: null,
      head: head ?? Buffer.alloc(0),
    };
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot read (${code ?? String(err)})` };
  } finally {
    await handle.close();
  }
}

/**
 * The first bytes of a mount-relative file and its size, through the same
 * located descriptor as readPath — for listing a file nothing tracks, which
 * needs a MIME type, not a hash.
 */
export async function readHead(
  view: MountView,
  rootReal: string,
  relativePath: string,
): Promise<HeadResult | Exclude<Observation, { kind: 'file' }>> {
  const opened = await openContained(view, rootReal, relativePath);
  if (!('handle' in opened)) return opened;
  const { handle, info } = opened;
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return { kind: 'head', size: Number(info.size), mtimeMs: Number(info.mtimeMs), head: head.subarray(0, bytesRead) };
  } catch (err) {
    return { kind: 'unobserved', reason: `cannot read (${errno(err) ?? String(err)})` };
  } finally {
    await handle.close();
  }
}

/** Null bytes in the first 8 KB: the store holds text only from disk. */
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, HEAD_BYTES).includes(0);
}

/** Image MIME type from magic bytes, for listing disk-only files. */
export function sniffImageMime(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

// ===========================================================================
// Walks
// ===========================================================================

export interface Walk {
  /** Regular files the walk took: the pass observes each one. */
  files: Set<string>;
  /**
   * Regular files a listing showed that the walk didn't take, past its cap
   * or outside the stretch a resumed walk covered: present, and not
   * observed by this pass.
   */
  seen: Set<string>;
  /**
   * The names in `others` that it doesn't pass over by design and that the walk took, as it
   * takes files, against its cap: the pass observes these by path. The rest
   * are present, and not observed by this pass.
   */
  othersTaken: Set<string>;
  /** Directories seen. */
  dirs: Set<string>;
  /**
   * Names seen that are neither (symlinks, sockets…), or that the walk passes
   * over by design (another mount's directory, the ignore list, an editor's
   * file name): present, unproven.
   */
  others: Map<string, string>;
  /**
   * The regular files in `others` that the mount's include doesn't cover:
   * present, unproven, and holding nothing beneath them. Only provenAbsent
   * reads it, for a directory listed whole. A path beneath a name passed
   * over by design is never decided (reconcile), so those need no such
   * record.
   */
  otherFiles: Set<string>;
  /**
   * Directories whose listing the walk read whole, and that were still the
   * directory at their path once it had: every name in one is in `files`,
   * `seen`, `dirs` or `others`, so a name in none of them is absent.
   */
  complete: Set<string>;
  /** Directories that don't exist (everything beneath them is absent). */
  missing: Set<string>;
  /**
   * Where the walk didn't reach, and why. `error` and `cap` regions may hide
   * files the listing would show. An `ignored` region is passed over by
   * design: one that hides a tracked entry, or is the pass's whole scope, is
   * reported as incomplete, and any other is counted as passed over. A
   * `symlink` region is never walked; the pass reports the link itself by
   * path.
   */
  incomplete: Array<{ path: string; reason: string; kind: 'error' | 'cap' | 'ignored' | 'symlink' }>;
  /**
   * When the walk cap stopped the walk, the last entry it took. A walk that
   * resumes after it takes the entries after it first, in the walk's order
   * (`compareInWalk`), then wraps to the start of its scope.
   */
  stoppedAfter?: string;
}

/** Names compare by UTF-16 code unit, the same on every platform and filesystem. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Where file `a` falls against file `b` in the walk's order: in each
 * directory, its files by name, then its subdirectories by name, each with
 * everything beneath it. A resumed walk relies on visiting files in the
 * order it compares positions by, so the walk sorts each listing itself
 * rather than take `readdir`'s order, which is the platform's (Node returns
 * UTF-8 byte order on Linux, which differs from this one for some names).
 */
function compareInWalk(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; ; i++) {
    const lastX = i === x.length - 1;
    const lastY = i === y.length - 1;
    if (x[i] !== y[i]) {
      if (lastX && lastY) return compareNames(x[i]!, y[i]!);
      if (lastX) return -1; // a directory's files come before its subdirectories
      if (lastY) return 1;
      return compareNames(x[i]!, y[i]!);
    }
    if (lastX && lastY) return 0;
    if (lastX) return -1;
    if (lastY) return 1;
  }
}

/**
 * Where the subtree of directory `dir` falls against file `at` in the walk's
 * order: wholly before it, holding it (an ancestor of it), or wholly after it.
 */
function subtreeAgainst(dir: string, at: string): 'before' | 'holds' | 'after' {
  if (dir === '') return 'holds';
  const d = dir.split('/');
  const p = at.split('/');
  for (let i = 0; i < d.length; i++) {
    // `at` is a file in the directory above d[i], whose files come first.
    if (i === p.length - 1) return 'after';
    if (d[i] !== p[i]) return compareNames(d[i]!, p[i]!) < 0 ? 'before' : 'after';
  }
  return 'holds';
}

/**
 * Whether a mount's ignore list covers a mount-relative path: the path itself
 * or any directory above it, as the walk's own test reads each entry by its
 * path and name.
 */
export function coveredByIgnore(relativePath: string, patterns: string[]): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (isIgnored(segments.slice(0, i + 1).join('/'), segments[i]!, patterns)) return true;
  }
  return false;
}

/** Why a walk passes over a file or link the mount's `include` doesn't cover, and a push leaves one alone. */
export const OUTSIDE_INCLUDE = "outside the mount's include";

/**
 * The segments of a path after its mount's name, as the workspace reads them
 * everywhere: split at `/`, and at `\` too where that's the platform's
 * separator, with no empty or `.` segment. A `..` segment stays, for the
 * path's mount to refuse or resolve.
 */
export function pathSegments(path: string, platformSep: string = sep): string[] {
  return (platformSep === '\\' ? path.replaceAll('\\', '/') : path).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * Whether a mount-relative path is spelled as the workspace's parsing spells
 * one: segments between single `/`, none empty, `.` or `..`, with no `\`
 * where that's the separator, or '' for the root. A walk and the watcher name
 * paths this way. An earlier version stored a path as it was written, so the
 * store can hold a key such as `a//b.txt` or `c/`, which no spelling names.
 */
export function parsedSpelling(relativePath: string, platformSep: string = sep): boolean {
  if (relativePath === '') return true;
  const segments = pathSegments(relativePath, platformSep);
  return !segments.includes('..') && segments.join('/') === relativePath;
}

/**
 * Whether a mount-relative path is inside its mount: spelled as parsing spells
 * one (parsedSpelling), and covered by the mount's `include` when it has one.
 * The mount's root, '', is inside. A store key no spelling names is outside,
 * as an entry the include doesn't cover is: nothing lists, counts, syncs or
 * writes it, and history keeps it as it was.
 */
export function insideMount(relativePath: string, include: readonly string[] | undefined): boolean {
  if (!parsedSpelling(relativePath)) return false;
  if (include === undefined || relativePath === '') return true;
  return coveredByInclude(relativePath, include);
}

/**
 * Whether the include's matcher can read `pattern`: a name or an `*.ext` glob,
 * which covers a file by its own name, or a `dir/**` glob, with no empty, `.`
 * or `..` segment, since those name no entry a path reaches. Where `\` is the
 * platform's separator, as on Windows, a pattern holding one can't name a
 * file either, since every path is read with `\` as a separator
 * (pathSegments). A pattern the matcher can't read would match nothing, and
 * take every file out of the mount unsaid, so the module refuses it.
 */
export function includePatternReadable(pattern: unknown, platformSep: string = sep): boolean {
  const segment = (s: string): boolean => s.length > 0 && s !== '.' && s !== '..' && !(platformSep === '\\' && s.includes('\\'));
  const name = (s: string): boolean => segment(s) && !s.includes('/') &&
    (!s.includes('*') || (s.startsWith('*.') && s.length > 2 && !s.slice(1).includes('*')));
  return typeof pattern === 'string' &&
    (pattern.endsWith('/**') ? pattern.length > 3 && pattern.slice(0, -3).split('/').every((s) => segment(s) && !s.includes('*')) : name(pattern));
}

/**
 * Whether a mount's include covers a mount-relative path. Its patterns take
 * `ignore`'s forms, read for files: a name or `*.ext` pattern covers a path by
 * its own last segment, at any depth, and `dir/**` covers what lies beneath
 * `dir`, and not a file named `dir`. Unlike `ignore`, a pattern that matches
 * a directory's name covers nothing beneath it: each file is covered by its
 * own name, so `gate.json` covers `x/gate.json` and not `x/gate.json/run.sh`,
 * and a subtree is named with `dir/**`. A directory is no file, so it needs
 * no covering: where one is a scope, refusesAsOutside (index.ts) decides.
 */
function coveredByInclude(relativePath: string, include: readonly string[]): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  for (const pattern of include) {
    if (pattern.endsWith('/**')) {
      if (relativePath.startsWith(pattern.slice(0, -2))) return true;
    } else if (pattern === name || (pattern.startsWith('*.') && name.endsWith(pattern.slice(1)))) {
      return true;
    }
  }
  return false;
}

/**
 * The ignore patterns a walk that names `scope` reads beneath it: a pattern
 * covering the scope itself, or a directory above it, doesn't apply beneath
 * it (#276); one covering only something inside it does.
 */
export function ignoreBeneath(scope: string, patterns: string[]): string[] {
  return patterns.filter((pattern) => !coveredByIgnore(scope, [pattern]));
}

/**
 * Names editors give the files they keep beside the one being edited: vim's
 * swap files (`.name.swp`, and `.name.swx` while it checks it can make one),
 * backups ending in `~`, and Sublime Text's save-in-progress files, ending
 * in `.subl…tmp`. A walk passes over an entry with such a name as it passes
 * over what the ignore list covers, a directory with what lies beneath it,
 * and the watcher ignores it; a sync that names one takes it in. They are
 * the families chokidar's `atomic` option hid from the watcher, but that
 * tested them against the whole path, unanchored, so it also hid
 * `report.v2.swp`, and under a directory with a dot in its name, a plain
 * `notes.swp`. Here each is matched against an entry's name, to its end,
 * and vim's from its start.
 */
const EDITOR_FILE = /^\..+\.sw[px]$|~$|\.subl.*\.tmp$/;

/** The walk's reason for an entry the mount's ignore list covers. */
export const IGNORED = 'ignored by the mount';
/** The walk's reason for an entry `EDITOR_FILE` names. */
const EDITOR_FILE_REASON = "an editor's swap or backup file";

/** Whether a reason the walk gave an entry is one it passes over by design. */
export function passedOverByDesign(why: string | undefined): boolean {
  return why === IGNORED || why === EDITOR_FILE_REASON || why === OTHER_MOUNT || why === OUTSIDE_INCLUDE;
}

/** Why a pass passes over a directory that another mount nested in this one holds, and what lies beneath it. */
export const OTHER_MOUNT = "another mount's directory";

/**
 * Whether a mount-relative path is another mount's directory, or lies
 * beneath one, read as a join reads it: `.` and `..` segments within the
 * path and repeated or trailing separators resolved, links not followed. A
 * stored key such as `a//b/x`, which chronicle accepts, is read as `a/b/x`.
 * A leading `..` that climbs above the mount's root is left as written.
 * Every nested-mount check (a pass's, a walk's, a push's, grep's) asks this.
 */
export function inOtherMount(relativePath: string, others: readonly string[]): boolean {
  const lexical = posix.normalize(relativePath).replace(/\/+$/, '');
  return others.some((dir) => lexical === dir || lexical.startsWith(dir + '/'));
}

/**
 * Why a walk passes over an entry by design, by its mount-relative path and
 * its name: another mount's directory, the ignore list, or an editor's file
 * name. Undefined when none covers it.
 */
function passedOverBecause(relativePath: string, name: string, patterns: string[], others: readonly string[]): string | undefined {
  if (inOtherMount(relativePath, others)) return OTHER_MOUNT;
  if (isIgnored(relativePath, name, patterns)) return IGNORED;
  if (EDITOR_FILE.test(name)) return EDITOR_FILE_REASON;
  return undefined;
}

/**
 * Why a sync without a path, and the watcher, pass over a mount-relative
 * path: the path itself or a directory above it is passed over by design, as
 * the walk reads each entry by its path and name. A path in another mount's
 * directory is that mount's, whatever else covers a directory above it.
 * Undefined when nothing covers it.
 */
export function passedOverAt(relativePath: string, patterns: string[], others: readonly string[]): string | undefined {
  if (inOtherMount(relativePath, others)) return OTHER_MOUNT;
  const segments = relativePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const why = passedOverBecause(segments.slice(0, i + 1).join('/'), segments[i]!, patterns, others);
    if (why !== undefined) return why;
  }
  return undefined;
}

/**
 * Why a walk of `scope` passes over a directory between it and a path beneath
 * it: the first directory strictly beneath the scope and above the path that
 * the mount passes over by design, by its path and name, with the patterns
 * the walk reads there. Undefined when none is.
 */
export function passedOverBetween(scope: string, relativePath: string, patterns: string[], others: readonly string[]): string | undefined {
  const segments = relativePath.split('/').filter(Boolean);
  const from = scope === '' ? 0 : scope.split('/').filter(Boolean).length;
  for (let i = from; i < segments.length - 1; i++) {
    const why = passedOverBecause(segments.slice(0, i + 1).join('/'), segments[i]!, patterns, others);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Simple ignore patterns, as the watcher and the old walk read them. */
export function isIgnored(relativePath: string, name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (relativePath === prefix || relativePath.startsWith(prefix + '/')) return true;
    }
    if (!pattern.includes('/') && relativePath === pattern) return true;
    if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * A subdirectory a checked directory's listing showed, checked in turn: still a
 * real directory beneath that same directory. One that became a symlink or a
 * file since is never followed, and proves nothing.
 */
async function checkChild(view: MountView, rootReal: string, parent: CheckedDir, rel: string): Promise<DirCheck> {
  const real = parent.at(nameOf(rel));
  let info;
  try {
    info = await lstat(real, { bigint: true });
  } catch (err) {
    if (errno(err) !== 'ENOENT') return { kind: 'unobserved', reason: `cannot stat (${errno(err) ?? String(err)})` };
    const proof = await confirmAbsent(view, rootReal, rel, 'beneath');
    return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent', by: proof.by };
  }
  if (!info.isDirectory()) return { kind: 'unobserved', reason: CHANGED_WALK };
  return { kind: 'checked', dir: new CheckedDir(rel, real, lexicalOf(view, rel), info.dev, info.ino) };
}

/**
 * List a directory scope ('' for the mount root), descending when recursive,
 * taking up to `cap` entries in the walk's order (`compareInWalk`): files,
 * and links or other entries that aren't directories. A scope
 * that resolves outside the mount is not listed at all; beneath it, the walk
 * only descends real directories, never symlinks. Each directory's listing
 * counts only if, once listed, it is still the directory at its path: a
 * directory moved or replaced meanwhile is an incomplete region, contributing
 * no names and proving nothing absent.
 *
 * Each listing is read whole and every name in it recorded, so the files the
 * cap leaves are known present (`seen`) and a name the listing lacks is
 * proven absent, whichever files were taken. Once the cap is reached, no
 * further directory is listed.
 *
 * With `resumeAfter` (an entry in the scope, from an earlier walk's
 * `stoppedAfter`), a recursive walk takes the entries after it first, then
 * wraps to the start of the scope, so repeated walks cover a scope larger
 * than the cap.
 */
export async function walkScope(
  view: MountView, rootReal: string, scope: string, recursive: boolean, cap: number,
  opts: { named?: boolean; resumeAfter?: string } = {},
): Promise<Walk> {
  const walk: Walk = {
    files: new Set(), seen: new Set(), othersTaken: new Set(), dirs: new Set(), others: new Map(), otherFiles: new Set(), complete: new Set(), missing: new Set(),
    incomplete: [],
  };
  // A walk that isn't named passes over a scope the mount passes over by
  // design, at it or a directory above it, as its parent's listing would pass
  // over its entry: a name rule (a bare-name ignore entry, an editor's name)
  // doesn't match what lies beneath, as a path rule (`cache/**`) does. So a
  // listing, glob or grep there never starts tracking what the mount leaves
  // out, and a stored copy beneath it is unobserved, as beneath any region
  // passed over by design. Its region says how to take what's there in: a
  // sync that names it, whose scope is walked (#276), below.
  // Another mount's directory is passed over by every walk, named or not,
  // and no sync of this mount takes it in, so its region gives no advice.
  if (scope !== '' && inOtherMount(scope, view.others)) {
    walk.others.set(scope, OTHER_MOUNT);
    walk.incomplete.push({ path: scope, reason: OTHER_MOUNT, kind: 'ignored' });
    return walk;
  }
  if (!opts.named && scope !== '') {
    const why = passedOverAt(scope, view.ignore, view.others);
    if (why !== undefined) {
      walk.others.set(scope, why);
      walk.incomplete.push({ path: scope, reason: `${why}: a sync that names this path takes in what's there, editors' files aside`, kind: 'ignored' });
      return walk;
    }
  }
  const top = await checkDir(view, rootReal, scope);
  if (top.kind === 'absent') {
    walk.missing.add(scope);
    return walk;
  }
  if (top.kind === 'unobserved') {
    walk.incomplete.push({ path: scope, reason: top.outside ? 'the directory resolves outside the mount' : top.reason, kind: 'error' });
    return walk;
  }
  // A scope a path sync names is walked even where the ignore list covers
  // it: a pattern covering the scope itself, or a directory above it, doesn't
  // apply beneath it. So a named directory's contents are synced, as a named
  // file is (agent-framework #276), apart from what a pattern covering only
  // something inside it covers, and editors' files, which are passed over
  // there as anywhere. A listing keeps the ignore: its pass would otherwise
  // start tracking what it lists.
  const ignore = opts.named ? ignoreBeneath(scope, view.ignore) : view.ignore;
  // A position outside the scope, or for a walk that doesn't descend, is no
  // position in this walk's order.
  const after = recursive && opts.resumeAfter !== undefined && (scope === '' || opts.resumeAfter.startsWith(scope + '/'))
    ? opts.resumeAfter
    : undefined;

  /** A listing's entries that aren't directories or ignored, in the walk's order, each a regular file or not. */
  type Listing = { leaves: Array<[string, boolean]>; subdirs: string[]; dev: string; ino: string };
  /**
   * Each directory is listed once: a resumed walk visits the ones holding its
   * position on both sides of it, and the second visit reuses the listing
   * while the directory at its path is still the one it was read from.
   */
  const listings = new Map<string, Listing | null>();
  const visited = new Set<string>();
  /** Paths already reported as errors, so a second visit doesn't report them again. */
  const failed = new Set<string>();
  const fail = (path: string, reason: string): void => {
    if (failed.has(path)) return;
    failed.add(path);
    walk.incomplete.push({ path, reason, kind: 'error' });
  };
  let left = cap;
  let lastTaken: string | undefined;

  /**
   * Take back what the walk read at or beneath `rel`, a directory replaced
   * or gone since it was listed: it describes the directory that was there,
   * so no listing there proves anything absent, the entries and
   * subdirectories they left untaken aren't the cap's to report, and a
   * subdirectory proven missing there proves nothing about what's there
   * now. What was taken stays taken: the pass observes it by path.
   */
  const dropBeneath = (rel: string): void => {
    const beneath = (path: string): boolean => rel === '' || path.startsWith(rel + '/');
    for (const [path, listing] of listings) {
      if (path !== rel && !beneath(path)) continue;
      if (listing) {
        for (const [leaf, isFile] of listing.leaves) if (isFile) walk.seen.delete(leaf);
        for (const sub of listing.subdirs) walk.dirs.delete(sub);
      }
      walk.complete.delete(path);
      listings.set(path, null);
    }
    // The links, ignored names and other entries those listings showed, and
    // the regions they gave rise to, described the directory that was there.
    for (const [path] of walk.others) if (beneath(path) && !walk.othersTaken.has(path)) walk.others.delete(path);
    for (const path of walk.otherFiles) if (!walk.others.has(path)) walk.otherFiles.delete(path);
    for (let i = walk.incomplete.length - 1; i >= 0; i--) {
      const region = walk.incomplete[i]!;
      if ((region.kind === 'symlink' || region.kind === 'ignored') && beneath(region.path)) walk.incomplete.splice(i, 1);
    }
    for (const path of walk.missing) if (beneath(path)) walk.missing.delete(path);
  };

  const list = async (dir: CheckedDir): Promise<Listing | null> => {
    const rel = dir.rel;
    const known = listings.get(rel);
    if (known === null) return null;
    if (known !== undefined) {
      // The scope's own directory comes back as the same CheckedDir, so its
      // identity is checked against the path again, as a subdirectory's is
      // by the fresh check that brought it here.
      const now = dir.identity();
      if (known.dev === now.dev && known.ino === now.ino && await dir.stillHere()) return known;
      dropBeneath(rel);
      fail(rel, CHANGED_WALK);
      return null;
    }
    listings.set(rel, null);
    // Reading a directory is a check of it too, and replaces an earlier proof
    // that it was missing: the scope's own directory, read afresh on the
    // wrap, has no check of its own.
    walk.missing.delete(rel);
    let entries;
    try {
      entries = await readdir(dir.real, { withFileTypes: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Gone since it was checked: absent beneath only if that can be shown.
        const proof = rel === '' ? ROOT_UNAVAILABLE : await confirmAbsent(view, rootReal, rel, 'beneath');
        if (typeof proof === 'string') fail(rel, proof);
        else {
          walk.missing.add(rel);
          // Nothing was listed, so a later check that finds it again, on the
          // wrap, lists it afresh.
          listings.delete(rel);
        }
        return null;
      }
      fail(rel, `cannot list (${code ?? String(err)})`);
      return null;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    const leaves: Array<[string, boolean]> = [];
    const subdirs: string[] = [];
    const others: Array<[string, string]> = [];
    const otherFiles: string[] = [];
    const regions: Walk['incomplete'] = [];
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Another mount's directory is passed over by its real path too, so a
      // walk that reaches one through a link to a directory above it lists
      // none of that mount's names (nestedAtReal).
      const passedOver = passedOverBecause(childRel, entry.name, ignore, view.others)
        ?? (entry.isDirectory() && nestedAtReal(dir.at(entry.name), view.nested) !== undefined ? OTHER_MOUNT : undefined);
      if (passedOver !== undefined) {
        others.push([childRel, passedOver]);
        regions.push({ path: childRel, reason: passedOver, kind: 'ignored' });
        continue;
      }
      // A file or link the mount's include doesn't cover is outside the
      // mount, a named scope's too. A directory is walked, since a name or an
      // extension glob in include can match beneath it. A regular file is
      // noted as one, since nothing covered can lie beneath it.
      if (!entry.isDirectory() && !insideMount(childRel, view.include)) {
        others.push([childRel, OUTSIDE_INCLUDE]);
        if (entry.isFile()) otherFiles.push(childRel);
        regions.push({ path: childRel, reason: OUTSIDE_INCLUDE, kind: 'ignored' });
        continue;
      }
      if (entry.isDirectory()) {
        subdirs.push(childRel);
      } else if (entry.isFile()) {
        leaves.push([childRel, true]);
      } else {
        const symlink = entry.isSymbolicLink();
        leaves.push([childRel, false]);
        others.push([childRel, symlink ? 'a symlink' : 'not a regular file']);
        if (symlink) regions.push({ path: childRel, reason: 'a symlink, not walked', kind: 'symlink' });
      }
    }
    // A listing of a directory that was moved or replaced meanwhile says
    // nothing about this path: neither its names nor its absences count.
    if (!(await dir.stillHere())) {
      fail(rel, CHANGED_WALK);
      return null;
    }
    for (const [p, isFile] of leaves) if (isFile) walk.seen.add(p);
    for (const d of subdirs) walk.dirs.add(d);
    for (const [p, why] of others) walk.others.set(p, why);
    for (const p of otherFiles) walk.otherFiles.add(p);
    walk.incomplete.push(...regions);
    walk.complete.add(rel);
    const listing = { leaves, subdirs, ...dir.identity() };
    listings.set(rel, listing);
    return listing;
  };

  type Stretch = 'all' | 'after' | 'upto';
  const fileIn = (stretch: Stretch, file: string): boolean =>
    stretch === 'all' || (compareInWalk(file, after!) > 0) === (stretch === 'after');
  const dirIn = (stretch: Stretch, dir: string): boolean => {
    if (stretch === 'all') return true;
    const at = subtreeAgainst(dir, after!);
    return at === 'holds' || at === (stretch === 'after' ? 'after' : 'before');
  };

  // Each nested root by which directory it is, read once, when the walk
  // first descends: a directory the walk reaches through a link spelled
  // otherwise than disk spells it, as a disk that folds names lets one, has
  // a real path the check by path doesn't know, and is still another
  // mount's directory.
  let nestedRoots: Array<{ dev: string; ino: string }> | undefined;
  const isNestedRoot = async (dir: CheckedDir): Promise<boolean> => {
    if (!view.nested?.length) return false;
    nestedRoots ??= (await Promise.all([...new Set(view.nested.flatMap((n) => (n.real === undefined ? [] : [n.real])))].map(async (real) => {
      const at = await stat(real, { bigint: true }).catch(() => null);
      return at === null ? [] : [{ dev: String(at.dev), ino: String(at.ino) }];
    }))).flat();
    const { dev, ino } = dir.identity();
    return nestedRoots.some((r) => r.dev === dev && r.ino === ino);
  };

  const visit = async (dir: CheckedDir, stretch: Stretch): Promise<void> => {
    visited.add(dir.rel);
    const listing = await list(dir);
    if (!listing) return;
    // A link or other entry that isn't a directory is taken as a file is,
    // against the cap: the pass observes each one it takes, and following a
    // link can read as much as a file.
    for (const [leaf, isFile] of listing.leaves) {
      if (left === 0) break;
      if (!fileIn(stretch, leaf)) continue;
      left--;
      if (isFile) {
        walk.seen.delete(leaf);
        walk.files.add(leaf);
      } else {
        walk.othersTaken.add(leaf);
      }
      lastTaken = leaf;
    }
    if (!recursive) return;
    for (const sub of listing.subdirs) {
      // Once the cap is reached, no further directory is listed.
      if (left === 0) break;
      if (!dirIn(stretch, sub)) continue;
      const child = await checkChild(view, rootReal, dir, sub);
      // This check replaces what an earlier one proved of `sub` itself, such
      // as missing on the after stretch and found again on the wrap. What was
      // proven beneath a directory that is still the same one stands, and
      // list() drops it from one that isn't.
      walk.missing.delete(sub);
      if (child.kind === 'checked') {
        if (await isNestedRoot(child.dir)) {
          // Passed over as another mount's directory, as the listing passes
          // over one it knows by path.
          walk.dirs.delete(sub);
          if (!walk.others.has(sub)) {
            walk.others.set(sub, OTHER_MOUNT);
            walk.incomplete.push({ path: sub, reason: OTHER_MOUNT, kind: 'ignored' });
          }
          continue;
        }
        await visit(child.dir, stretch);
        continue;
      }
      // On the wrap, a directory listed on the first stretch that isn't the
      // directory there now: what the walk read of it describes another.
      dropBeneath(sub);
      if (child.kind === 'absent') walk.missing.add(sub);
      else fail(sub, child.reason);
    }
  };

  if (after === undefined) {
    await visit(top.dir, 'all');
  } else {
    await visit(top.dir, 'after');
    if (left > 0) await visit(top.dir, 'upto');
  }

  // What the cap left: directories holding entries not taken, and
  // directories a listing showed that weren't listed. A walk that doesn't
  // descend leaves its subdirectories by design.
  const capped = `the walk cap (${cap}) was reached`;
  const holdingUntaken = new Set<string>();
  for (const f of walk.seen) holdingUntaken.add(parentOf(f));
  for (const [p, why] of walk.others) if (!passedOverByDesign(why) && !walk.othersTaken.has(p)) holdingUntaken.add(parentOf(p));
  for (const d of holdingUntaken) {
    walk.incomplete.push({ path: d, reason: `${capped} before everything here was taken`, kind: 'cap' });
  }
  let unlisted = 0;
  if (recursive) {
    for (const d of walk.dirs) {
      if (visited.has(d) || walk.missing.has(d) || failed.has(d)) continue;
      unlisted++;
      walk.incomplete.push({ path: d, reason: `not visited: ${capped}`, kind: 'cap' });
    }
  }
  // The cap stopped the walk only if it left something: a walk whose last
  // file used up the cap covered its scope. A directory the walk didn't list
  // counts as left, even one that holds nothing it would take (empty, or
  // only names it passes over by design): telling them apart would take
  // another read. Such a
  // walk keeps its place and reports the directory as not visited, and the
  // next one lists it on its way to the wrap.
  if (left === 0 && lastTaken !== undefined && (holdingUntaken.size > 0 || unlisted > 0)) walk.stoppedAfter = lastTaken;
  return walk;
}

/**
 * Whether the walk proves nothing exists at `path`: some ancestor directory
 * is missing, a completely listed ancestor holds no entry that could lead
 * to it, or an ancestor is a regular file the mount's include doesn't cover,
 * which the walk passed over and which holds nothing beneath it.
 * Ancestors outside the walked scope are passed through, so a walk of `a/b`
 * decides paths beneath `a/b` and nothing else.
 */
export function provenAbsent(walk: Walk, path: string): boolean {
  const parts = path.split('/');
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    if (walk.missing.has(dir)) return true;
    const child = dir ? `${dir}/${parts[i]}` : parts[i]!;
    if (walk.complete.has(dir)) {
      if (i < parts.length - 1 && walk.otherFiles.has(child)) return true; // a regular file: nothing beneath it exists
      if (walk.others.has(child) || walk.seen.has(child)) return false; // present, but unproven
      if (i === parts.length - 1) return !walk.files.has(child) && !walk.dirs.has(child);
      if (!walk.dirs.has(child)) return true; // no directory there: nothing beneath can exist
    }
    dir = child;
  }
  return false;
}
