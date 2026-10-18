/**
 * A mount's `include` is its boundary: a file or link it doesn't cover is
 * outside the mount, for walks, the watcher's pass, materialize (even when the
 * workspace's history holds the file from before the include), sync, and the
 * agent's own reads and writes, which are refused with that reason.
 * connectome-host's `_config` mount versions the host's config files and
 * holds only those: a file saved beside them, such as a kept
 * `gate.json.unreadable-<suffix>` copy, stays out of its history and is never
 * written back (connectome-host #278).
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { insideMount, parsedSpelling, pathSegments } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

const TREE = 'workspace/work/tree';
const OUTSIDE = "outside the mount's include";

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-include-'));
  readonly dir = join(this.root, 'work');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.dir, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }] });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  /** Stop a module, as a restart's process exit would, keeping the store open for the next one. */
  async stop(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
  }

  writeDisk(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  tree(): string[] {
    return this.store.treeList(TREE).map((e: { path: string }) => e.path).sort();
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.data;
}

async function refused(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, false, `${name} ${JSON.stringify(input)} unexpectedly succeeded`);
  return String(res.error);
}

async function listed(m: WorkspaceModule): Promise<string[]> {
  const data = await call(m, 'ls', { path: 'work', recursive: true });
  return (data.entries as Array<{ path: string }>).map((e) => e.path).sort();
}

describe('mount include', () => {
  test('the walk takes only what include covers: names and extension globs at any depth, a directory glob beneath it', async (t) => {
    const env = new Env(t);
    // Beside them, a directory whose name starts with `docs` and a file whose
    // name ends in `md` without the dot: each pattern's boundary holds. An
    // editor's swap file is passed over as one, before the include judges it.
    for (const path of ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'notes.md', 'other.txt', 'sub/gate.json', 'sub/x.md', 'sub/y.txt', 'docs/a/b.txt', 'docsx/c.txt', 'readmemd', '.gate.json.swp']) {
      env.writeDisk(path, `${path}\n`);
    }
    const m = await env.open({ include: ['gate.json', '*.md', 'docs/**'] });
    assert.deepEqual(await listed(m), ['docs/a/b.txt', 'gate.json', 'notes.md', 'sub/gate.json', 'sub/x.md']);
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'notes.md', 'sub/gate.json', 'sub/x.md'], 'nothing else is versioned');
    const data = await call(m, 'sync', {});
    const byReason = (data.passedOver as Array<{ reason: string; count: number }>).map((p) => [p.reason, p.count]).sort();
    assert.deepEqual(byReason, [["an editor's swap or backup file", 1], [OUTSIDE, 6]], 'a sync says what it passed over, and why');
    for (const path of ['work', 'work/sub']) {
      const found = await call(m, 'grep', { path, pattern: 'gate' });
      assert.deepEqual((found.results as Array<{ file: string }>).map((r) => r.file).sort(),
        path === 'work' ? ['work/gate.json', 'work/sub/gate.json'] : ['work/sub/gate.json'], `grep over ${path} searches only what the include covers`);
      const globbed = await call(m, 'glob', { path, pattern: '**' });
      assert.deepEqual((globbed.matches as Array<{ path: string }>).map((x) => x.path).sort(),
        path === 'work' ? ['work/docs/a/b.txt', 'work/gate.json', 'work/notes.md', 'work/sub/gate.json', 'work/sub/x.md'] : ['work/sub/gate.json', 'work/sub/x.md'],
        `glob over ${path} lists only what the include covers`);
    }
  });

  test('a name or extension glob covers a file by its own name, and nothing beneath a directory it matches', async (t) => {
    const env = new Env(t);
    for (const path of ['gate.json', 'sub/gate.json', 'sub/gate.json.d/x.txt', 'x/gate.json/notes.txt', 'notes.md/inner.txt', 'docs/a/b.txt']) {
      env.writeDisk(path, `${path}\n`);
    }
    const m = await env.open({ include: ['gate.json', '*.md', 'docs/**'] });
    assert.deepEqual(await listed(m), ['docs/a/b.txt', 'gate.json', 'sub/gate.json']);
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'sub/gate.json'], 'nothing beneath a directory named like a covered file is versioned');
    assert.match((await call(m, 'read', { path: 'work/sub/gate.json' })).content, /\tsub\/gate\.json$/m, 'a file by its own name, at any depth');
    // A directory named like a covered file holds nothing the include
    // covers, the agent's own writes included.
    for (const [name, input] of [
      ['read', { path: 'work/x/gate.json/notes.txt' }],
      ['read', { path: 'work/notes.md/inner.txt' }],
      ['write', { path: 'work/x/gate.json/run.sh', content: 'echo hi\n' }],
      ['write', { path: 'work/notes.md/new.txt', content: 'x' }],
      ['grep', { path: 'work/x/gate.json/notes.txt', pattern: 'notes' }],
      ['glob', { path: 'work/x/gate.json/notes.txt', pattern: '*' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only gate\.json, \*\.md, docs\/\*\*/, `${name} ${input.path}`);
    }
    assert.equal(m.resolveAbsolutePath('work/x/gate.json/notes.txt'), null);
    // A listing names each directory directly beneath its path, whether or
    // not anything beneath it is covered, and shows only covered files.
    const entries = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string; type: string }>)
      .map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(await entries('work'), ['directory docs', 'directory notes.md', 'directory sub', 'directory x', 'file gate.json']);
    assert.deepEqual(await entries('work/x'), ['directory gate.json']);
    assert.deepEqual(await entries('work/x/gate.json'), []);
    // A directory disk has, with nothing covered beneath it, is still a scope.
    assert.deepEqual((await call(m, 'glob', { path: 'work/x', pattern: '**' })).matches, []);
    // The directory a `dir/**` pattern names needs no covering: it's no file,
    // and it's a scope, as a directory beneath a name pattern is.
    assert.equal(m.resolveAbsolutePath('work/docs'), null);
    assert.deepEqual(await entries('work/docs'), ['directory a']);
    assert.deepEqual(((await call(m, 'glob', { path: 'work/docs', pattern: '**' })).matches as Array<{ path: string }>).map((x) => x.path), ['work/docs/a/b.txt']);
    await call(m, 'materialize', {});
    assert.equal(existsSync(join(env.dir, 'x/gate.json/run.sh')), false, 'nothing was written beneath it');
    assert.deepEqual(env.tree(), ['docs/a/b.txt', 'gate.json', 'sub/gate.json']);
  });

  test('a name outside the include gets the same answer whether or not a file is there, and a directory is still a scope', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('secrets.env', 'on disk\n');
    let m = await env.open();
    await call(m, 'write', { path: 'work/cached.env', content: 'in history only\n' });
    await env.stop(m);
    assert.equal(existsSync(join(env.dir, 'cached.env')), false, 'the mount doesn\'t materialize on write');
    m = await env.open({ include: ['gate.json'] });
    // On disk, in history alone, and nowhere: the five tools that take a
    // directory as their scope answer each the same, as read does.
    for (const name of ['secrets.env', 'cached.env', 'nothing-here.env']) {
      const path = `work/${name}`;
      const said = `"${path}" is outside the mount's include: mount "work" holds only gate.json. `
        + 'The host\'s operator sets the include in the mount\'s configuration, so calling again with this path changes nothing.';
      for (const [tool, input] of [
        ['sync', { path }], ['materialize', { path }], ['grep', { path, pattern: 'x' }], ['glob', { path, pattern: '*' }], ['ls', { path }], ['read', { path }],
      ] as const) {
        // read throws its refusal, so it arrives as an Error's text; the five
        // that take a scope return it.
        const text = await refused(m, tool, input as Record<string, unknown>);
        assert.equal(tool === 'read' ? text.replace(/^Error: /, '') : text, said, `${tool} ${name}`);
      }
    }
    // A directory gone from disk is still a scope while history holds an
    // entry beneath it.
    await call(m, 'write', { path: 'work/old/gate.json', content: '{"old":true}\n' });
    assert.equal(existsSync(join(env.dir, 'old')), false);
    const old = await call(m, 'materialize', { path: 'work/old' });
    assert.deepEqual(old.materialized, [{ mount: 'work', path: 'old/gate.json' }]);
    assert.equal(readFileSync(join(env.dir, 'old/gate.json'), 'utf8'), '{"old":true}\n');
  });

  test('a path outside include is refused, with the reason, by every tool that names a file', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('.gate.json.swp', 'swap\n');
    env.writeDisk('sub/gate.json', '{}\n');
    env.writeDisk('sub/notes.txt', 'notes\n');
    const m = await env.open({ include: ['gate.json'] });
    for (const [name, input] of [
      ['write', { path: 'work/notes.txt', content: 'x' }],
      ['read', { path: 'work/.gate.json.swp' }],
      ['read_image', { path: 'work/.gate.json.swp' }],
      ['edit', { path: 'work/.gate.json.swp', oldString: 'swap', newString: 'swapped' }],
      ['delete', { path: 'work/.gate.json.swp' }],
      ['sync', { path: 'work/.gate.json.swp' }],
      ['materialize', { path: 'work/.gate.json.swp' }],
      ['grep', { path: 'work/.gate.json.swp', pattern: 'swap' }],
      ['glob', { path: 'work/.gate.json.swp', pattern: '*' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only gate\.json/, name);
    }
    // Every tool refuses a path with a `..` segment, whatever it reaches,
    // before anything looks it up, and says that's the reason, since what it
    // reaches may be covered. `gate.json/..`, `sub/..` and
    // `.gate.json.swp/..` each reach the root on disk.
    const climbs = /has a "\.\." segment, which mount "work" refuses since it has an include: give the path from the mount's root, with no "\.\." in it/;
    for (const path of ['work/gate.json/../.gate.json.swp', 'work/sub/../gate.json', 'work/gate.json/..', 'work/sub/..', 'work/.gate.json.swp/..']) {
      for (const name of ['read', 'read_image', 'write', 'edit', 'delete', 'sync', 'materialize', 'grep', 'glob', 'ls']) {
        const input = name === 'grep' || name === 'glob' ? { path, pattern: 'swap' } : name === 'write' ? { path, content: 'x' }
          : name === 'edit' ? { path, oldString: '{}', newString: '[]' } : { path };
        assert.match(await refused(m, name, input), climbs, `${name} ${path}`);
      }
      const binary = await m.readBinary(path);
      assert.ok('error' in binary && climbs.test(binary.error), `readBinary ${path}`);
      const fromDisk = await m.readBinaryFromDisk(path);
      assert.ok('error' in fromDisk && climbs.test(fromDisk.error), `readBinaryFromDisk ${path}`);
      const written = await m.writeBinary(path, Buffer.from([1]), 'image/png');
      assert.match(String(written.error), climbs, `writeBinary ${path}`);
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) =>
        err instanceof WorkspaceReadError && err.code === 'outside_include' && climbs.test(err.message), `readFileFromDisk ${path}`);
      assert.equal(m.resolveAbsolutePath(path), null, `resolveAbsolutePath ${path}`);
    }
    // A path is read in one spelling: a trailing `/`, a `.` segment or an
    // empty one names the file it names without them, refused as that file is.
    for (const path of ['work/.gate.json.swp/', 'work/./.gate.json.swp', 'work/sub/./notes.txt', 'work/sub//notes.txt', 'work/sub/notes.txt/']) {
      for (const name of ['read', 'sync', 'materialize', 'grep']) {
        const input = name === 'grep' ? { path, pattern: 'notes' } : { path };
        assert.match(await refused(m, name, input), /outside the mount's include: mount "work" holds only gate\.json/, `${name} ${path}`);
      }
    }
    assert.deepEqual(env.tree().filter((p) => p !== 'gate.json'), [], 'nothing outside the include was versioned');
    const write = await m.writeBinary('work/image.png', Buffer.from([1, 2, 3]), 'image/png');
    assert.equal(write.success, false);
    assert.match(String(write.error), /outside the mount's include/);
    const read = await m.readBinary('work/.gate.json.swp');
    assert.ok('error' in read && /outside the mount's include/.test(read.error));
    const fromDisk = await m.readBinaryFromDisk('work/.gate.json.swp');
    assert.ok('error' in fromDisk && /outside the mount's include/.test(fromDisk.error));
    // A path that climbs with `..` is outside, whatever it reaches.
    for (const path of ['work/.gate.json.swp', 'work/gate.json/../.gate.json.swp', 'work/sub/../.gate.json.swp', 'work/sub/../gate.json']) {
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) =>
        err instanceof WorkspaceReadError && err.code === 'outside_include', path);
    }
    for (const path of ['work/.gate.json.swp', 'work/sub/..']) {
      assert.equal(m.resolveAbsolutePath(path), null, `${path}: outside the mount, as a path that leaves it is`);
    }
    assert.equal(m.resolveAbsolutePath('work/gate.json'), join(env.dir, 'gate.json'));
    assert.equal(m.resolveAbsolutePath('work/./gate.json'), join(env.dir, 'gate.json'));
    // The mount's root is inside: connectome-host resolves it by the mount's
    // name alone.
    for (const path of ['work', 'work/', 'work/.']) assert.equal(m.resolveAbsolutePath(path), env.dir, path);
    // A sync that names a directory takes what's covered beneath it.
    const sub = await call(m, 'sync', { path: 'work/sub' });
    assert.equal(sub.totalSynced, 1, 'sub/gate.json');
    assert.equal(sub.ignored, undefined);
    // A file tool refuses a directory the include doesn't cover as it
    // refuses a file: one on disk and in history, one on disk alone, and one
    // only the workspace's history has.
    mkdirSync(join(env.dir, 'empty'));
    await call(m, 'write', { path: 'work/drafts/gate.json', content: '{}' });
    assert.equal(existsSync(join(env.dir, 'drafts')), false, 'the mount doesn\'t materialize on write, so disk has no drafts/');
    for (const dir of ['sub', 'empty', 'drafts']) {
      assert.match(await refused(m, 'read', { path: `work/${dir}` }), /outside the mount's include/, dir);
      assert.match(await refused(m, 'write', { path: `work/${dir}`, content: 'x' }), /outside the mount's include/, dir);
      assert.equal(m.resolveAbsolutePath(`work/${dir}`), null, dir);
    }
    assert.equal((await m.writeBinary('work/empty', Buffer.from([1]), 'image/png')).success, false);
    assert.deepEqual(env.tree().filter((p) => p !== 'gate.json'), ['drafts/gate.json', 'sub/gate.json']);
    await assert.rejects(m.readFileFromDisk('work/empty'), (err: unknown) =>
      err instanceof WorkspaceReadError && err.code === 'outside_include');
  });

  test('a name history holds as a file the include doesn\'t cover, where disk now has a directory, is a scope, as a listing names it', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('backup', 'from before the include\n');
    let m = await env.open();
    await listed(m);
    await env.stop(m);
    // Disk replaces the file history holds at backup with a directory holding
    // a covered file, and a whole-mount sync takes that file in beside it, as
    // a host would meet it: history then holds both.
    rmSync(join(env.dir, 'backup'));
    env.writeDisk('backup/gate.json', '{"in":"backup"}\n');
    m = await env.open({ include: ['gate.json'] });
    const backup = env.store.treeGet(TREE, 'backup')!.blobHash;
    await call(m, 'sync', {});
    assert.deepEqual(env.tree(), ['backup', 'backup/gate.json', 'gate.json']);
    const entries = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string; type: string }>)
      .map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(await entries('work'), ['directory backup', 'file gate.json']);
    // Every tool that takes a directory as its scope takes it, as the listing
    // names it, and the ones that name a file refuse it.
    assert.deepEqual(await entries('work/backup'), ['file gate.json']);
    assert.deepEqual(((await call(m, 'glob', { path: 'work/backup', pattern: '*' })).matches as Array<{ path: string }>).map((x) => x.path), ['work/backup/gate.json']);
    assert.equal((await call(m, 'grep', { path: 'work/backup', pattern: 'backup' })).totalMatches, 1);
    // A sync naming it takes in disk's change beneath it, and a materialize
    // naming it writes the workspace's.
    env.writeDisk('backup/gate.json', '{"in":"backup","v":2}\n');
    await call(m, 'sync', { path: 'work/backup' });
    assert.match((await call(m, 'read', { path: 'work/backup/gate.json' })).content, /"v":2/);
    await call(m, 'write', { path: 'work/backup/gate.json', content: '{"in":"backup","v":3}\n' });
    await call(m, 'materialize', { path: 'work/backup' });
    assert.equal(readFileSync(join(env.dir, 'backup/gate.json'), 'utf8'), '{"in":"backup","v":3}\n');
    for (const [name, input] of [
      ['read', { path: 'work/backup' }],
      ['edit', { path: 'work/backup', oldString: 'from', newString: 'changed' }],
      ['delete', { path: 'work/backup' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include/, name);
    }
    await assert.rejects(m.readFileFromDisk('work/backup'), (err: unknown) =>
      err instanceof WorkspaceReadError && err.code === 'outside_include');
    assert.equal(m.resolveAbsolutePath('work/backup'), null);
    // The history file stays as it was, beside what the directory holds.
    assert.equal(env.store.treeGet(TREE, 'backup')?.blobHash, backup);
    assert.deepEqual(env.tree(), ['backup', 'backup/gate.json', 'gate.json']);
  });

  test('a name the include doesn\'t cover, with covered files beneath it in history, gets the same answer whether disk has a file there or nothing', async (t) => {
    const answers = async (onDisk: 'a file' | 'nothing'): Promise<string[]> => {
      const said: string[] = [];
      for (const [tool, input] of [
        ['ls', { path: 'work/x' }], ['sync', { path: 'work/x' }], ['materialize', { path: 'work/x' }],
        ['grep', { path: 'work/x', pattern: 'a' }], ['glob', { path: 'work/x', pattern: '*' }],
      ] as const) {
        const env = new Env(t);
        env.writeDisk('gate.json', '{}\n');
        env.writeDisk('x/gate.json', '{}\n');
        let m = await env.open();
        await listed(m);
        await env.stop(m);
        rmSync(join(env.dir, 'x'), { recursive: true });
        if (onDisk === 'a file') env.writeDisk('x', 'a file outside the include\n');
        m = await env.open({ include: ['gate.json'] });
        const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
        assert.deepEqual(top, ['directory x', 'file gate.json'], `${onDisk}: the listing names x`);
        const res = await m.handleToolCall({ id: 't', name: tool, input: input as Record<string, unknown> });
        said.push(`${tool} ${res.success ? JSON.stringify(res.data) : `refused: ${res.error}`}`);
        if (onDisk === 'a file') assert.equal(readFileSync(join(env.dir, 'x'), 'utf8'), 'a file outside the include\n', `${tool} leaves the file`);
      }
      return said;
    };
    const withFile = await answers('a file');
    assert.deepEqual(withFile, await answers('nothing'));
    for (const line of withFile) assert.doesNotMatch(line, /^\w+ refused/, line);
  });

  test('grep naming a covered file searches that file alone, whether only disk or only history holds it', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    const m = await env.open({ include: ['*.md', 'gate.json'] });
    await call(m, 'write', { path: 'work/notes/a.md', content: 'needle in history\n' });
    assert.equal(existsSync(join(env.dir, 'notes/a.md')), false, 'only history holds it');
    env.writeDisk('b.md', 'needle on disk\n');
    assert.equal(env.store.treeGet(TREE, 'b.md'), null, 'only disk holds it');
    for (const path of ['work/notes/a.md', 'work/b.md']) {
      const found = await call(m, 'grep', { path, pattern: 'needle' });
      assert.deepEqual((found.results as Array<{ file: string }>).map((r) => r.file), [path], path);
    }
  });

  test('a path through a link that no covered history lies beneath is no scope, wherever the link leads, as no listing names it, while a directory ignore covers is one', async (t) => {
    const env = new Env(t);
    const outside = join(env.root, 'outside');
    mkdirSync(join(outside, 'sub'), { recursive: true });
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('real/sub/gate.json', '{}\n');
    env.writeDisk('build/gate.json', '{}\n');
    symlinkSync(outside, join(env.dir, 'out'));
    symlinkSync(join(env.dir, 'real'), join(env.dir, 'in'));
    const m = await env.open({ include: ['gate.json'], ignore: ['build'] });
    const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
    assert.deepEqual(top, ['directory real', 'file gate.json'], 'the listing names neither link, nor the ignored directory');
    // Beyond a link, a directory that's there and a name with nothing there
    // get the same refusal, whether the link leads out of the mount or not.
    const texts = new Set<string>();
    for (const path of ['work/out/sub', 'work/out/nope', 'work/in/sub', 'work/in/nope']) {
      for (const [tool, input] of [
        ['ls', { path }], ['sync', { path }], ['materialize', { path }], ['grep', { path, pattern: 'a' }], ['glob', { path, pattern: '*' }],
      ] as const) {
        texts.add((await refused(m, tool, input as Record<string, unknown>)).replace(path, 'PATH'));
      }
    }
    assert.equal(texts.size, 1, [...texts].join(' | '));
    assert.match([...texts][0]!, /^"PATH" is outside the mount's include/);
    // A directory the ignore list covers isn't listed, and is a scope when
    // it's named, as a sync that names it takes in what's there (#276).
    assert.equal(env.store.treeGet(TREE, 'build/gate.json'), null);
    await call(m, 'sync', { path: 'work/build' });
    assert.notEqual(env.store.treeGet(TREE, 'build/gate.json'), null, 'a sync naming it takes in the covered file there');
    assert.deepEqual(((await call(m, 'ls', { path: 'work/build' })).entries as Array<{ name: string }>).map((e) => e.name), ['gate.json']);
  });

  test('a name covered history lies beneath, where disk has since put a link, is a scope: a mount that follows symlinks answers it through the link, and one that doesn\'t refuses the link', async (t) => {
    for (const followSymlinks of [false, true]) {
      for (const leadsOut of [false, true]) {
        const env = new Env(t);
        const outside = join(env.root, 'outside');
        mkdirSync(join(outside, 'sub'), { recursive: true });
        env.writeDisk('gate.json', '{}\n');
        env.writeDisk('lnk/gate.json', '{"was":"lnk"}\n');
        env.writeDisk('real/sub/gate.json', '{}\n');
        let m = await env.open({ include: ['gate.json'], followSymlinks });
        await call(m, 'sync', {});
        await env.stop(m);
        // Disk replaces the directory history recorded with a link.
        rmSync(join(env.dir, 'lnk'), { recursive: true });
        symlinkSync(leadsOut ? outside : join(env.dir, 'real'), join(env.dir, 'lnk'));
        m = await env.open({ include: ['gate.json'], followSymlinks });
        const label = `followSymlinks ${followSymlinks}, ${leadsOut ? 'out of the mount' : 'in the mount'}`;
        const top = ((await call(m, 'ls', { path: 'work' })).entries as Array<{ name: string; type: string }>).map((e) => `${e.type} ${e.name}`);
        assert.ok(top.includes('directory lnk'), `${label}: covered history implies lnk: ${top.join(', ')}`);
        const beneath = await call(m, 'ls', { path: 'work/lnk' });
        const said = JSON.stringify(beneath);
        const names = (beneath.entries as Array<{ name: string }>).map((e) => e.name);
        if (!followSymlinks) {
          // No link on a path is followed: nothing beyond it is read, and the listing says why.
          assert.ok(!names.includes('sub'), `${label}: ${said}`);
          assert.match(said, leadsOut
            ? /\\"work\/lnk\\" is a symlink leading outside the mount, which this mount does not follow/
            : /\\"work\/lnk\\" is a symlink to \\"work\/real\\", which this mount does not follow/, label);
        } else if (leadsOut) {
          // A link out of the mount: the scope is taken, and nothing beyond it is read.
          assert.match(said, /resolves outside the mount/, label);
        } else {
          // A link to a directory in the mount: the listing names what lies beyond it.
          assert.ok(names.includes('sub'), `${label}: ${said}`);
        }
      }
    }
  });

  test("a link's refusal names an inside target only where a tool could name it: a file the include covers, or a directory", async (t) => {
    const env = new Env(t);
    env.writeDisk('secret.txt', 'not the mount\'s\n');
    env.writeDisk('notes.md', 'covered\n');
    env.writeDisk('real/gate.json', '{}\n');
    // Links among a covered path's directories: to an uncovered file, to a
    // covered file, and to a directory.
    symlinkSync(join(env.dir, 'secret.txt'), join(env.dir, 'gate.json'));
    symlinkSync(join(env.dir, 'notes.md'), join(env.dir, 'x.md'));
    symlinkSync(join(env.dir, 'real'), join(env.dir, 'lnk'));
    const m = await env.open({ include: ['gate.json', '*.md'] });
    const refusal = async (path: string): Promise<string> => {
      let message = '';
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => { message = String((err as Error).message); return err instanceof WorkspaceReadError; });
      return message;
    };
    const uncovered = await refusal('work/gate.json/y.md');
    assert.match(uncovered, /"work\/gate\.json" is a symlink, which this mount does not follow/);
    assert.ok(!uncovered.includes('secret'), uncovered);
    assert.match(await refusal('work/x.md/y.md'), /"work\/x\.md" is a symlink to "work\/notes\.md", which this mount does not follow/);
    assert.match(await refusal('work/lnk/gate.json'), /"work\/lnk" is a symlink to "work\/real", which this mount does not follow; the mount's host can set followSymlinks: true/);
    // Nor does a listing or a sync of the mount name the uncovered target.
    for (const [name, input] of [['ls', { path: 'work' }], ['ls', { path: 'work', recursive: true }], ['sync', {}]] as Array<[string, Record<string, unknown>]>) {
      const said = JSON.stringify(await call(m, name, input));
      assert.ok(!said.includes('secret'), `${name} ${JSON.stringify(input)}: ${said}`);
    }
  });

  test("a link into a nested mount's directory names its target only where that mount's own include covers it", async (t) => {
    const env = new Env(t);
    env.writeDisk('inner/kept.json', '{}\n');
    env.writeDisk('inner/hidden.txt', 'not the inner mount\'s\n');
    env.writeDisk('inner/sub/a.json', '{}\n');
    symlinkSync(join(env.dir, 'inner/hidden.txt'), join(env.dir, 'h.md'));
    symlinkSync(join(env.dir, 'inner/kept.json'), join(env.dir, 'k.md'));
    symlinkSync(join(env.dir, 'inner/sub'), join(env.dir, 'd'));
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['*.md', '*.json'] },
      { name: 'inner', path: join(env.dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      const refusal = async (path: string): Promise<string> => {
        let message = '';
        await assert.rejects(m.readFileFromDisk(path), (err: unknown) => {
          message = `${(err as WorkspaceReadError).code}: ${String((err as Error).message)}`;
          return err instanceof WorkspaceReadError;
        });
        return message;
      };
      // The inner mount's include leaves hidden.txt out, so neither it nor the mount is named, and the code says no
      // more than the message: a link the mount doesn't follow, as for any other target the agent can't name.
      const left = await refusal('work/h.md/y.md');
      assert.match(left, /^parent_symlink: .*"work\/h\.md" is a symlink, which this mount does not follow/);
      assert.ok(!left.includes('hidden') && !left.includes('inner'), left);
      assert.match(await refusal('work/k.md/y.md'), /^other_mount: .*use "inner\/kept\.json"/);
      assert.match(await refusal('work/d/a.json'), /^other_mount: .*use "inner\/sub"/);
    } finally {
      await m.stop();
    }
  });

  test('ignore still applies to what include covers, and a capped walk owes nothing outside the include', async (t) => {
    const env = new Env(t);
    for (const path of ['a.json', 'skip.json', 'note.txt', 'x/1.txt', 'x/2.txt', 'y/1.json', 'z/2.json']) env.writeDisk(path, `${path}\n`);
    const m = await env.open({ include: ['*.json'], ignore: ['skip.json'], walkCap: 2 });
    const data = await call(m, 'sync', {});
    // The walk takes a.json, lists x, takes y/1.json and is at its cap.
    assert.deepEqual(env.tree(), ['a.json', 'y/1.json']);
    const byReason = (data.passedOver as Array<{ reason: string; count: number }>).map(({ reason, count }) => [reason, count]).sort();
    assert.deepEqual(byReason, [['ignored by the mount', 1], [OUTSIDE, 3]]);
    assert.deepEqual((data.incomplete as Array<{ path: string; reason: string }>).map(({ path, reason }) => [path, reason]), [
      ['', 'the walk cap (2) was reached: the next sync of the mount resumes after work/y/1.json'],
      ['z', 'not visited: the walk cap (2) was reached'],
    ], 'z is left by the cap, and x, holding only files outside the include, is no region the cap left');
  });

  test('history from before the include stays as it is, and no materialize writes it back', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{"v":1}\n');
    env.writeDisk('gate.json.bak', 'backup\n');
    env.writeDisk('gate.json.unreadable-1', 'a kept copy\n');
    let m = await env.open();
    await listed(m);
    // And a draft disk never had, in a directory disk doesn't have either,
    // and one beneath a directory named like the file the include will cover.
    await call(m, 'write', { path: 'work/old/notes.txt', content: 'a draft\n' });
    await call(m, 'write', { path: 'work/x/gate.json/run.sh', content: 'echo hi\n' });
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'], 'without include, every file is versioned');
    const main = env.store.currentBranch().name;
    env.store.createBranch('earlier', main);
    rmSync(join(env.dir, 'gate.json.bak'));
    rmSync(join(env.dir, 'gate.json.unreadable-1'));
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    assert.deepEqual(await listed(m), ['gate.json']);
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'],
      'a listing decides nothing outside the include, though disk no longer has those files');
    const top = await call(m, 'ls', { path: 'work' });
    assert.deepEqual((top.entries as Array<{ name: string }>).map((e) => e.name), ['gate.json'], 'no directory shows for history outside the include');
    env.store.switchBranch('earlier');
    const named = await m.handleToolCall({ id: 't', name: 'materialize', input: { path: 'work/old/notes.txt' } });
    assert.match(String(named.error), /outside the mount's include/);
    // A covered change on that branch, which the same call writes: the push ran.
    await call(m, 'write', { path: 'work/gate.json', content: '{"v":2}\n' });
    const written = await m.materializeMount('work');
    assert.deepEqual(written, ['gate.json'], 'the covered change is written, and nothing outside the include');
    assert.equal(readFileSync(join(env.dir, 'gate.json'), 'utf8'), '{"v":2}\n');
    for (const path of ['gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh']) assert.equal(existsSync(join(env.dir, path)), false, path);
    assert.deepEqual(env.tree(), ['gate.json', 'gate.json.bak', 'gate.json.unreadable-1', 'old/notes.txt', 'x/gate.json/run.sh'], 'the earlier branch\'s history outside the include is left as it was');
    const status = await call(m, 'status', {});
    assert.equal(status.work.fileCount, 1, 'only gate.json is the mount\'s');
    assert.equal(status.work.pendingChanges, 0, 'and nothing outside it is owed to disk');
    const all = await call(m, 'materialize', {});
    assert.equal(all.count, 0);
    assert.equal(existsSync(join(env.dir, 'gate.json.bak')), false);
    // A directory that only history outside the include holds is no scope:
    // no listing names it, so it's refused as a name with nothing there is.
    assert.match(await refused(m, 'materialize', { path: 'work/old' }), /outside the mount's include/);
    mkdirSync(join(env.dir, 'old'));
    const old = await call(m, 'materialize', { path: 'work/old' });
    assert.deepEqual(old.materialized, []);
    assert.equal(old.skipped, undefined);
    assert.deepEqual(old.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'a materialize naming a directory counts what it left out, and why, naming none of it');
    assert.equal(existsSync(join(env.dir, 'old/notes.txt')), false);
  });

  test('a dir/** pattern covers what lies beneath its directory, and not a file of that name', async (t) => {
    const env = new Env(t);
    env.writeDisk('docs', 'a file named like the directory\n');
    let m = await env.open();
    await listed(m);
    assert.deepEqual(env.tree(), ['docs'], 'without include, the file is versioned');
    rmSync(join(env.dir, 'docs'));
    await env.stop(m);

    m = await env.open({ include: ['docs/**'] });
    await call(m, 'materialize', {});
    assert.equal(existsSync(join(env.dir, 'docs')), false, 'history from before the include isn\'t written back');
    env.writeDisk('docs', 'on disk again\n');
    assert.deepEqual(await listed(m), []);
    const data = await call(m, 'sync', {});
    assert.deepEqual(data.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'a walk passes over it');
    assert.deepEqual(env.tree(), ['docs'], 'and history keeps the earlier entry as it was');
    for (const [name, input] of [
      ['read', { path: 'work/docs' }],
      ['write', { path: 'work/docs', content: 'x' }],
      ['ls', { path: 'work/docs' }],
    ] as const) {
      assert.match(await refused(m, name, input as Record<string, unknown>), /outside the mount's include: mount "work" holds only docs\/\*\*/, `${name} ${input.path}`);
    }
    assert.equal(m.resolveAbsolutePath('work/docs'), null);
    assert.equal(readFileSync(join(env.dir, 'docs'), 'utf8'), 'on disk again\n');
  });

  test('a deletion the workspace holds outside the include is left alone by a materialize, and counted only by one that names its directory', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('sub/gate.json.bak', 'backup\n');
    let m = await env.open();
    await listed(m);
    // The mount doesn't materialize on write, so the deletion is held, owed to disk.
    await call(m, 'delete', { path: 'work/sub/gate.json.bak' });
    assert.equal((await call(m, 'status', {})).work.pendingWorkspaceDeletions, 1, 'without the include, status counts it');
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    const status = await call(m, 'status', {});
    assert.equal(status.work.pendingWorkspaceDeletions, 0, 'status doesn\'t count it');
    for (const input of [{}, { path: 'work' }]) {
      const all = await call(m, 'materialize', { ...input, applyDeletions: true });
      assert.equal(all.skipped, undefined, `a materialize of the whole mount (${JSON.stringify(input)}) doesn't take it up, so has nothing to report`);
      assert.equal(all.passedOver, undefined, `nor to count (${JSON.stringify(input)})`);
    }
    const named = await call(m, 'materialize', { path: 'work/sub', applyDeletions: true });
    assert.equal(named.skipped, undefined);
    assert.deepEqual(named.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'one that names its directory counts what it left there');
    assert.equal(existsSync(join(env.dir, 'sub/gate.json.bak')), true, 'and disk keeps the file');
  });

  test('a sync naming a directory with a trailing separator records what it takes in under each file\'s one spelling', async (t) => {
    // #351: the separator was kept, so the walk joined each name to the
    // directory with a second one.
    const env = new Env(t);
    env.writeDisk('d/a.txt', 'a\n');
    const m = await env.open();
    const first = await call(m, 'sync', { path: 'work/d/' });
    assert.deepEqual(first.results.flatMap((r: { synced: string[] }) => r.synced), ['d/a.txt']);
    assert.deepEqual(env.tree(), ['d/a.txt']);
    const names = ((await call(m, 'ls', { path: 'work/d' })).entries as Array<{ name: string }>).map((e) => e.name);
    assert.deepEqual(names, ['a.txt'], 'and no entry with an empty name');
    assert.equal((await call(m, 'sync', { path: 'work/d' })).totalSynced, 0, 'the plain spelling finds nothing more to take in');
  });

  test('without an include, a path is read in one spelling too, so history names the file the disk operation reaches', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/./a.txt', content: 'a\n' });
    await call(m, 'write', { path: 'work/b//c.txt', content: 'c\n' });
    await call(m, 'write', { path: 'work/sub/../d.txt', content: 'd\n' });
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt']);
    await call(m, 'write', { path: 'work/a.txt/', content: 'a, again\n' });
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt'], 'a trailing slash names the same file');
    // A `..` that climbs back to the root names the root.
    const names = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string }>).map((e) => e.name);
    assert.deepEqual(await names('work/b/..'), await names('work'));
    // A directory named with a trailing slash is that directory.
    const out = await call(m, 'materialize', { path: 'work/b/' });
    assert.deepEqual(out.materialized, [{ mount: 'work', path: 'b/c.txt' }]);
    assert.equal(readFileSync(join(env.dir, 'b/c.txt'), 'utf8'), 'c\n');
    // A separator straight after the mount's name would make the rest an
    // absolute path, so it's refused, even where that path lies inside the
    // mount (main refused only one outside it). The guard refuses these
    // before anything reads a `..` in them.
    const absolute = /has a separator right after mount "work", which makes it an absolute path/;
    writeFileSync(join(env.root, 'outside.txt'), 'outside\n');
    for (const path of ['work//a.txt', `work/${env.dir}/a.txt`, `work//..${env.dir}/a.txt`, `work//..${env.dir}/../outside.txt`]) {
      for (const name of ['read', 'write', 'sync']) {
        assert.match(await refused(m, name, name === 'write' ? { path, content: 'x' } : { path }), absolute, `${name} ${path}`);
      }
      assert.equal(m.resolveAbsolutePath(path), null, path);
      await assert.rejects(m.readFileFromDisk(path), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'traversal', path);
    }
    // A `..` with nothing before it to take back climbs above the root, and is
    // refused whatever it reaches: here it comes back in by the mount
    // directory's own name, `work`.
    const climbs = /climbs above the root of mount "work"/;
    for (const path of ['work/../work/a.txt', 'work/b/../../work/a.txt', 'work/..', 'work/../outside.txt']) {
      for (const name of ['read', 'write']) {
        assert.match(await refused(m, name, name === 'write' ? { path, content: 'x' } : { path }), climbs, `${name} ${path}`);
      }
      assert.equal(m.resolveAbsolutePath(path), null, path);
    }
    assert.deepEqual(env.tree(), ['a.txt', 'b/c.txt', 'd.txt'], 'nothing those spellings named was stored');
    assert.equal(readFileSync(join(env.root, 'outside.txt'), 'utf8'), 'outside\n');
  });

  test('without an include, glob and grep read their path in one spelling too, and refuse a climb above the root', async (t) => {
    // F208: they took a path with a `.` or `..` segment as written, so the
    // store refused the key each made from it ("Invalid tree path").
    const env = new Env(t);
    env.writeDisk('src/a.ts', 'export const a = 1;\n');
    const m = await env.open();
    await call(m, 'sync', {});
    for (const path of ['work/src/../src', 'work/./src']) {
      const globbed = await call(m, 'glob', { pattern: '*.ts', path });
      assert.deepEqual((globbed.matches as Array<{ path: string }>).map((e) => e.path), ['work/src/a.ts'], `glob ${path}`);
      const grepped = await call(m, 'grep', { pattern: 'export', path });
      assert.deepEqual((grepped.results as Array<{ file: string }>).map((r) => r.file), ['work/src/a.ts'], `grep ${path}`);
    }
    // Out of the root and back in by the mount directory's own name.
    const climbs = /climbs above the root of mount "work"/;
    assert.match(await refused(m, 'glob', { pattern: '*.ts', path: 'work/../work/src' }), climbs, 'glob');
    assert.match(await refused(m, 'grep', { pattern: 'export', path: 'work/../work/src' }), climbs, 'grep');
  });

  test('an entry an earlier version stored under another spelling is outside the mount', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await call(m, 'write', { path: 'work/a/b.txt', content: 'b\n' });
    await call(m, 'materialize', {});
    // What main stored for `work/a//b.txt`, `work/c/` and `work/d//e.txt`:
    // the path as written. main had written the last one to disk, and the
    // file has been edited there since.
    const stale = Buffer.from('stale\n');
    const entry = { blobHash: env.store.storeBlob(stale, 'text/plain'), size: stale.length, mode: 0o644 };
    for (const key of ['a//b.txt', 'c/', 'd//e.txt']) env.store.treeSet(TREE, key, entry);
    env.writeDisk('d/e.txt', 'edited on disk\n');
    const status = (await call(m, 'status', {})).work;
    assert.equal(status.fileCount, 1, 'status counts only a/b.txt');
    assert.equal(status.pendingChanges, 0);
    assert.equal(status.conflicts, 0);
    const names = async (path: string) => ((await call(m, 'ls', { path })).entries as Array<{ name: string }>).map((e) => e.name).sort();
    assert.deepEqual(await names('work/a'), ['b.txt'], 'no directory named "" beside it');
    assert.deepEqual(await names('work'), ['a', 'd'], 'and no entry named "c/"');
    assert.deepEqual(await listed(m), ['a/b.txt', 'd/e.txt']);
    const synced = await call(m, 'sync', {});
    assert.equal(synced.totalConflicts, 0, 'a sync decides nothing about them');
    assert.deepEqual(env.tree(), ['a//b.txt', 'a/b.txt', 'c/', 'd//e.txt', 'd/e.txt'], 'it took in d/e.txt, and history keeps the old keys as they were');
    for (const input of [{}, { path: 'work' }, { path: 'work/a' }, { path: 'work/d' }]) {
      const out = await call(m, 'materialize', input);
      assert.equal(out.skipped, undefined, `materialize ${JSON.stringify(input)} neither takes them up nor reports them`);
      assert.equal(out.passedOver, undefined, `nor counts them (${JSON.stringify(input)})`);
    }
    const read = await call(m, 'read', { path: 'work/a//b.txt' });
    assert.match(read.content, /\tb$/m, 'the spelling names a/b.txt');
    assert.doesNotMatch(read.content, /stale/, 'not the old key');
    assert.equal(readFileSync(join(env.dir, 'a/b.txt'), 'utf8'), 'b\n', 'and no materialize wrote the old key over it');
    assert.equal(readFileSync(join(env.dir, 'd/e.txt'), 'utf8'), 'edited on disk\n', 'nor d//e.txt over d/e.txt');
  });

  test('a conflict the workspace holds outside the include is left alone by a materialize, and counted only by one that names its directory', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('docs/n.md', 'disk\n');
    let m = await env.open();
    // History gets its own copy of a file disk holds, with nothing to say
    // which is newer, so the materialize that names it records a conflict.
    await call(m, 'write', { path: 'work/docs/n.md', content: 'history\n' });
    await call(m, 'materialize', { path: 'work/docs' });
    assert.equal((await call(m, 'status', {})).work.conflicts, 1, 'without the include, status counts it');
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    assert.equal((await call(m, 'status', {})).work.conflicts, 0, 'status doesn\'t count it');
    for (const input of [{}, { path: 'work' }]) {
      const all = await call(m, 'materialize', input);
      assert.equal(all.skipped, undefined, `a materialize of the whole mount (${JSON.stringify(input)}) doesn't take it up, so has nothing to report`);
      assert.equal(all.passedOver, undefined, `nor to count (${JSON.stringify(input)})`);
    }
    const named = await call(m, 'materialize', { path: 'work/docs' });
    assert.equal(named.skipped, undefined);
    assert.deepEqual(named.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'one that names its directory counts what it left there');
    // With no history entry left at the path, the conflict alone is what the
    // named materialize finds there.
    env.store.treeRemove(TREE, 'docs/n.md');
    const again = await call(m, 'materialize', { path: 'work/docs' });
    assert.equal(again.skipped, undefined);
    assert.deepEqual(again.passedOver, [{ mount: 'work', reason: OUTSIDE, count: 1 }], 'the conflict alone is counted');
    assert.equal(readFileSync(join(env.dir, 'docs/n.md'), 'utf8'), 'disk\n', 'and disk keeps its copy');
  });

  test('text the host registers is served under an include, at every spelling that reaches it, and never written', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    const m = await env.open({ include: ['gate.json'] });
    m.registerGeneratedTextFile('work/notes.md', () => 'generated\n', 'resident');
    for (const path of ['work/notes.md', 'work/sub/../notes.md']) {
      const read = await m.handleToolCall({ id: 't', name: 'read', input: { path }, callerAgentName: 'resident' });
      assert.equal(read.success, true, `${path}: ${read.error}`);
      assert.match(JSON.stringify(read.data), /generated/, path);
      const write = await m.handleToolCall({ id: 't', name: 'write', input: { path, content: 'x' }, callerAgentName: 'resident' });
      assert.match(String(write.error), /Generated file is read-only/, path);
    }
    assert.equal(existsSync(join(env.dir, 'notes.md')), false);
    assert.deepEqual(env.tree(), [], 'and history holds none of it');
  });

  test('a path is split at "/", and at "\\" where that is the separator', () => {
    assert.deepEqual(pathSegments('gate.json/..\\gate.json~', '\\'), ['gate.json', '..', 'gate.json~'], 'on Windows a "\\" climb is a climb');
    assert.deepEqual(pathSegments('./a//b/.\\c\\', '\\'), ['a', 'b', 'c']);
    assert.deepEqual(pathSegments('a\\b', '/'), ['a\\b'], 'where the separator is "/", "\\" is part of a name');
    assert.deepEqual(pathSegments('', '/'), []);
    // Only a path spelled as parsing spells one is inside its mount.
    for (const path of ['', 'a', 'a/b.txt', 'a\\b']) assert.equal(parsedSpelling(path, '/'), true, path);
    for (const path of ['a//b', 'c/', '/x', './x', 'a/./b', 'a/../b', '..']) assert.equal(parsedSpelling(path, '/'), false, path);
    assert.equal(parsedSpelling('a\\b', '\\'), false, 'on Windows "\\" is a separator');
    assert.equal(insideMount('gate.json/../secret.txt', ['gate.json']), false, 'a ".." key is outside whatever the include covers');
    assert.equal(insideMount('a//b.txt', undefined), false, 'and a key no spelling names is outside a mount without an include');
    assert.equal(insideMount('sub/gate.json', ['gate.json']), true);
  });

  test('a change outside include, even to a file history holds, is no change to the mount', async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{"v":1}\n');
    env.writeDisk('gate.json.bak', 'backup 1\n');
    let m = await env.open();
    await listed(m);
    const before = env.store.treeGet(TREE, 'gate.json.bak')!.blobHash;
    const gateBefore = env.store.treeGet(TREE, 'gate.json')!.blobHash;
    await env.stop(m);

    m = await env.open({ include: ['gate.json'] });
    env.writeDisk('gate.json.bak', 'backup 2, edited after the include\n');
    env.writeDisk('gate.json', '{"v":2}\n');
    // The watcher's handler, as a debounced batch would call it.
    await (m as unknown as { handleFsChanges(mount: string, changes: Array<{ path: string; op: string }>): Promise<void> })
      .handleFsChanges('work', [{ path: 'gate.json.bak', op: 'modified' }, { path: 'gate.json', op: 'modified' }]);
    await call(m, 'sync', {});
    assert.equal(env.store.treeGet(TREE, 'gate.json.bak')!.blobHash, before, 'the backup\'s history entry is untouched');
    assert.equal(readFileSync(join(env.dir, 'gate.json.bak'), 'utf8'), 'backup 2, edited after the include\n');
    assert.notEqual(env.store.treeGet(TREE, 'gate.json')!.blobHash, gateBefore, 'gate.json\'s edit is taken');
  });

  test("a path in a nested mount's directory is that mount's, whether or not the outer include covers it: every tool names the mount that holds it", async (t) => {
    const env = new Env(t);
    env.writeDisk('gate.json', '{}\n');
    env.writeDisk('x.txt', 'stale words\n');
    env.writeDisk('a/b/x.txt', 'stale words\n');
    env.writeDisk('a/b/gate.json', '{"deep":1}\n');
    const m = new WorkspaceModule({ mounts: [
      { name: 'work', path: env.dir, mode: 'read-write', watch: 'never', include: ['gate.json'] },
      { name: 'deep', path: join(env.dir, 'a/b'), mode: 'read-write', watch: 'never' },
    ] });
    m.initStore(env.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    try {
      const tools: Array<[string, Record<string, unknown>]> = [
        ['read', {}], ['write', { content: 'x' }], ['delete', {}], ['ls', {}], ['glob', { pattern: '*' }],
        ['grep', { pattern: 'stale' }], ['sync', {}], ['materialize', {}],
      ];
      // Uncovered and covered alike: the holder is named, and the include isn't.
      for (const [path, use] of [['work/a/b/x.txt', 'deep/x.txt'], ['work/a/b/gate.json', 'deep/gate.json']]) {
        for (const [name, extra] of tools) {
          const res = await m.handleToolCall({ id: 't', name, input: { path, ...extra } });
          const said = JSON.stringify(res.success ? res.data : String(res.error));
          assert.ok(said.includes(`use \\"${use}\\"`), `${name} ${path}: ${said}`);
          assert.ok(!said.includes(OUTSIDE), `${name} ${path}: ${said}`);
        }
        await assert.rejects(m.readFileFromDisk(path), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
        assert.equal(m.resolveAbsolutePath(path), null);
      }
      // Where no nested mount holds it, the include still refuses it.
      for (const [name, extra] of tools) {
        assert.match(await refused(m, name, { path: 'work/x.txt', ...extra }), /outside the mount's include/, name);
      }
      // A `..` is refused before anything looks the path up, the nested
      // mount's directory included, and the refusal says how to give it.
      assert.match(await refused(m, 'read', { path: 'work/a/b/../b/x.txt' }), /has a "\.\." segment/);
    } finally {
      await m.stop();
    }
  });

  test('the framework keeps its own files only in a writable mount without an include', (t) => {
    const env = new Env(t);
    const config = { name: 'config', path: join(env.root, 'config'), mode: 'read-write' as const, watch: 'never' as const, include: ['gate.json'] };
    const both = new WorkspaceModule({ mounts: [config, { name: 'work', path: env.dir, mode: 'read-write', watch: 'never' }] });
    both.initStore(env.store);
    assert.deepEqual(both.getMounts(), [
      { name: 'config', mode: 'read-write', include: ['gate.json'] },
      { name: 'work', mode: 'read-write' },
    ]);
    // Where tool-results/, refs/ and background-scripts/ go.
    const firstWritable = (ws: WorkspaceModule): string | null =>
      (AgentFramework.prototype as unknown as { firstWritableMountName(w: WorkspaceModule): string | null }).firstWritableMountName.call(null, ws);
    assert.equal(firstWritable(both), 'work');
    const only = new WorkspaceModule({ mounts: [config] });
    only.initStore(env.store);
    assert.equal(firstWritable(only), null, 'as a setup with no writable mount');
  });

  test('include is checked when the module is built, and the refusal names the mount and what it refused', () => {
    const mount = (include: unknown): MountConfig => ({ name: 'work', path: '/tmp/x', mode: 'read-write', include } as MountConfig);
    const refusal = (include: unknown, ending: string): void => {
      assert.throws(() => new WorkspaceModule({ mounts: [mount(include)] }), (err: unknown) => err instanceof Error
        && err.message.startsWith('[workspace] Mount "work": include must be a non-empty list of names') && err.message.endsWith(ending),
      JSON.stringify(include) ?? String(include));
    };
    for (const bad of [[], 42, 'gate.json']) refusal(bad, `, not ${JSON.stringify(bad)}`);
    for (const entry of ['sub/file.txt', 'foo*', '*', '*.', 'a/*/**', '/**', '', '.', '..', './**', '../**', 'a/../**', undefined]) {
      refusal([entry], `; ${JSON.stringify(entry) ?? String(entry)} is none of these`);
    }
    refusal(['gate.json', 'foo*'], '; "foo*" is none of these');
    for (const good of [['gate.json'], ['*.md', 'gate.js'], ['docs/**'], ['a/b/**']]) {
      assert.doesNotThrow(() => new WorkspaceModule({ mounts: [mount(good)] }), JSON.stringify(good));
    }
  });
});
