/**
 * A mount that doesn't follow symlinks follows none among a path's parent
 * directories either. A link there, wherever it leads, makes the path
 * unobserved: no push writes, creates or unlinks a file through it, no sync
 * reads through it, and no read from disk returns its bytes. Before, an
 * inside link among the parents was followed, so the workspace acted on a
 * file under another path than the one it named: a deletion's push unlinked
 * the file behind the link, a write created or overwrote one there, and a
 * sync took its bytes in. A link among the parents that leads out of the
 * mount was refused before as well, and now gets the same answer. A mount
 * that follows links keeps following an inside one, and a root that is
 * itself a link is still the root.
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { checkDir, confirmAbsent, observePath, readPath, type MountView } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

const TREE = 'workspace/work/tree';
const LINKED = /goes through a symlink at "l", which this mount does not follow: use the path it leads to, or set followSymlinks: true on the mount/;

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-parent-link-'));
  readonly dir = join(this.root, 'work');
  store: JsStore;

  constructor(t: TestContext) {
    mkdirSync(this.dir, { recursive: true });
    this.store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
    t.after(async () => {
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(t: TestContext, mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', autoMaterialize: false, ...mount }] });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
    t.after(() => m.stop().catch(() => {}));
    return m;
  }

  writeDisk(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  /**
   * Replace the directory `l` with a link to a directory holding `x.txt`:
   * `elsewhere/` inside the mount, or `outside/` beside it. Returns the
   * directory the link leads to.
   */
  swapLForLink(target: 'inside' | 'outside', bytes = 'behind the link\n'): string {
    rmSync(join(this.dir, 'l'), { recursive: true, force: true });
    const away = target === 'inside' ? join(this.dir, 'elsewhere') : join(this.root, 'outside');
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, 'x.txt'), bytes);
    symlinkSync(away, join(this.dir, 'l'));
    return away;
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const res = await m.handleToolCall({ id: 't', name, input });
  assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
  return res.data;
}

/** The skipped reason for a path in a materialize's or a sync's result. */
function skippedReason(data: any, path: string): string {
  const entry = ((data.skipped ?? []) as Array<{ path?: string; reason: string }>)
    .find((s) => s.path === path || s.reason.startsWith(`${path}: `));
  assert.ok(entry, `nothing skipped for ${path}: ${JSON.stringify(data)}`);
  return entry.reason;
}

describe('a symlinked parent on a mount that does not follow symlinks', () => {
  for (const target of ['inside', 'outside'] as const) {
    test(`a workspace deletion is not applied through it, forced or not (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'behind the link\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      await call(m, 'delete', { path: 'work/l/x.txt' });
      const away = env.swapLForLink(target);
      for (const force of [false, true]) {
        const data = await call(m, 'materialize', { path: 'work/l/x.txt', applyDeletions: true, force });
        assert.deepEqual(data.deleted ?? [], [], `force ${force}: nothing was deleted`);
        assert.match(skippedReason(data, 'l/x.txt'), LINKED, `force ${force}`);
        assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'behind the link\n', `force ${force}: the file behind the link stays`);
      }
    });

    test(`no file is created through it, forced or not (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'write', { path: 'work/l/new.txt', content: 'created\n' });
      const away = env.swapLForLink(target);
      for (const force of [false, true]) {
        const data = await call(m, 'materialize', { path: 'work/l/new.txt', force });
        assert.deepEqual(data.materialized, [], `force ${force}: nothing was written`);
        assert.match(skippedReason(data, 'l/new.txt'), LINKED, `force ${force}`);
        assert.equal(existsSync(join(away, 'new.txt')), false, `force ${force}: nothing appeared behind the link`);
      }
    });

    test(`an edit is not written through it, forced or not, and the unforced refusal doesn't offer force (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      await call(m, 'write', { path: 'work/l/x.txt', content: 'v2\n' });
      const away = env.swapLForLink(target, 'v1\n');
      const unforced = skippedReason(await call(m, 'materialize', { path: 'work/l/x.txt' }), 'l/x.txt');
      assert.match(unforced, LINKED);
      assert.doesNotMatch(unforced, /pass force/, 'force never takes a path through a link this mount does not follow');
      const forced = await call(m, 'materialize', { path: 'work/l/x.txt', force: true });
      assert.deepEqual(forced.materialized, []);
      assert.match(skippedReason(forced, 'l/x.txt'), LINKED);
      assert.equal(readFileSync(join(away, 'x.txt'), 'utf8'), 'v1\n', 'the file behind the link is as it was');
    });

    test(`an explicit sync doesn't read through it, and history keeps its copy (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      await call(m, 'read', { path: 'work/l/x.txt' });
      const before = env.store.treeGet(TREE, 'l/x.txt')!.blobHash;
      env.swapLForLink(target, 'other bytes\n');
      const data = await call(m, 'sync', { path: 'work/l/x.txt' });
      assert.match(skippedReason(data, 'l/x.txt'), LINKED);
      assert.equal(env.store.treeGet(TREE, 'l/x.txt')?.blobHash, before, 'history holds what it held');
    });

    test(`readFileFromDisk refuses a path through it as a symlink, naming the way out (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      env.swapLForLink(target);
      await assert.rejects(m.readFileFromDisk('work/l/x.txt'), (err: unknown) => {
        assert.ok(err instanceof WorkspaceReadError, String(err));
        assert.equal(err.code, 'symlink');
        assert.match(err.message, /goes through a symlink at "work\/l", which this mount does not follow: use the path it leads to, or set followSymlinks: true on the mount/);
        assert.ok(!err.message.includes(env.root), 'the refusal names no absolute path');
        return true;
      });
    });

    test(`a listing of the directory the link stands at says so instead of walking it (${target})`, async (t) => {
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      const m = await env.open(t);
      env.swapLForLink(target);
      const data = await call(m, 'ls', { path: 'work/l', recursive: true });
      assert.deepEqual(data.entries, []);
      assert.equal(data.incomplete.length, 1);
      assert.equal(data.incomplete[0].path, 'l');
      assert.match(data.incomplete[0].reason, LINKED);
    });
  }

  for (const target of ['inside', 'outside'] as const) {
    test(`each primitive that finds a parent refuses it with the one reason: a directory check, an observation, a read and an absence proof (${target})`, async (t) => {
      // Each check sits at the point of use, so each is asked here directly:
      // through the tools, an earlier one usually answers first.
      const env = new Env(t);
      env.writeDisk('l/x.txt', 'v1\n');
      env.swapLForLink(target);
      const view: MountView = { root: env.dir, followSymlinks: false, maxFileSize: 1 << 20, ignore: [] };
      const rootReal = realpathSync(env.dir);
      const exactly = /^the path goes through a symlink at "l", which this mount does not follow: use the path it leads to, or set followSymlinks: true on the mount$/;
      const dir = await checkDir(view, rootReal, 'l');
      assert.ok(dir.kind === 'unobserved' && exactly.test(dir.reason), `checkDir: ${JSON.stringify(dir)}`);
      const seen = await observePath(view, rootReal, 'l/x.txt');
      assert.ok(seen.kind === 'unobserved' && exactly.test(seen.reason), `observePath: ${JSON.stringify(seen)}`);
      const read = await readPath(view, rootReal, 'l/x.txt', 1 << 20);
      assert.ok(read.kind === 'unobserved' && exactly.test(read.reason), `readPath: ${JSON.stringify({ ...read, bytes: undefined })}`);
      const absent = await confirmAbsent(view, rootReal, 'l/nothing.txt');
      assert.ok(typeof absent === 'string' && exactly.test(absent), `confirmAbsent: ${JSON.stringify(absent)}`);
    });
  }

  test('readBinaryFromDisk reads nothing through a link: the file itself leading out, a parent leading out, or a parent inside', async (t) => {
    const env = new Env(t);
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL');
    env.writeDisk('elsewhere/x.txt', 'INSIDE_TARGET');
    symlinkSync(join(outside, 'secret.txt'), join(env.dir, 'file-link.txt'));
    symlinkSync(outside, join(env.dir, 'out'));
    symlinkSync(join(env.dir, 'elsewhere'), join(env.dir, 'in'));
    const m = await env.open(t);
    for (const path of ['work/file-link.txt', 'work/out/secret.txt', 'work/in/x.txt']) {
      const res = await m.readBinaryFromDisk(path);
      assert.ok('error' in res, `${path} returned bytes: ${'data' in res ? res.data.toString() : ''}`);
      assert.match(res.error, /symlink/i, path);
      assert.ok(!res.error.includes(env.root), `${path}: the error names no absolute path`);
    }
  });

  test('a regular parent directory is still read and written as before', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t);
    await call(m, 'read', { path: 'work/l/x.txt' });
    await call(m, 'write', { path: 'work/l/x.txt', content: 'v2\n' });
    assert.deepEqual((await call(m, 'materialize', { path: 'work/l/x.txt' })).materialized.map((e: { path: string }) => e.path), ['l/x.txt']);
    assert.equal(readFileSync(join(env.dir, 'l/x.txt'), 'utf8'), 'v2\n');
    assert.equal((await m.readFileFromDisk('work/l/x.txt')).bytes.toString(), 'v2\n');
  });
});

describe('a mount that follows symlinks', () => {
  test('still follows an inside link among a path\'s parents, and refuses one leading out', async (t) => {
    const env = new Env(t);
    env.writeDisk('l/x.txt', 'v1\n');
    const m = await env.open(t, { followSymlinks: true });
    await call(m, 'write', { path: 'work/l/new.txt', content: 'created\n' });
    const away = env.swapLForLink('inside');
    assert.deepEqual((await call(m, 'materialize', { path: 'work/l/new.txt' })).materialized.map((e: { path: string }) => e.path), ['l/new.txt']);
    assert.equal(readFileSync(join(away, 'new.txt'), 'utf8'), 'created\n', 'written behind the link, which this mount follows');
    assert.equal((await m.readFileFromDisk('work/l/x.txt')).bytes.toString(), 'behind the link\n');

    const env2 = new Env(t);
    env2.writeDisk('l/x.txt', 'v1\n');
    const m2 = await env2.open(t, { followSymlinks: true });
    env2.swapLForLink('outside');
    await assert.rejects(m2.readFileFromDisk('work/l/x.txt'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'escape');
  });
});
