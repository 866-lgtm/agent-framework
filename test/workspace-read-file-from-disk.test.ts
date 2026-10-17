/**
 * WorkspaceModule.readFileFromDisk — filesystem-enforced mount containment
 * for peer modules (issue #129).
 *
 * `resolveAbsolutePath()` is lexical: an in-mount symlink targeting an outside
 * file passes it, and a peer that then `fs.readFile`s the returned path reads
 * the outside content (connectome-host #101 pulled such a file into a
 * system-position injection). `readFileFromDisk()` is the workspace-owned read
 * that enforces the mount's `followSymlinks` policy and canonical containment,
 * so peers stop reimplementing the boundary.
 *
 * Symlink cases create real symlinks; on Windows that needs a privilege the
 * test runner may not have (EPERM), in which case those cases are skipped —
 * the non-symlink cases still run everywhere.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants as fsConstants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';

function setup(t: TestContext, options?: { followSymlinks?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'af-read-from-disk-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never', followSymlinks: options?.followSymlinks }],
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, mountDir, workspace };
}

/** Create a symlink, or skip the test when the platform refuses (Windows without the privilege). */
function symlinkOrSkip(t: TestContext, target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`symlink creation not permitted on this platform (${code})`);
      return false;
    }
    throw err;
  }
}

async function expectRefusal(promise: Promise<unknown>, code: WorkspaceReadError['code']): Promise<WorkspaceReadError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkspaceReadError, `expected WorkspaceReadError, got ${String(err)}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`expected a WorkspaceReadError(${code}) but the read succeeded`);
}

test('a regular in-mount file can be read, with size and mtime reported', async (t) => {
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'AGENTS.md'), '# instructions\n');

  const result = await workspace.readFileFromDisk('work/AGENTS.md');
  assert.equal(result.bytes.toString('utf8'), '# instructions\n');
  assert.equal(result.size, Buffer.byteLength('# instructions\n'));
  assert.equal(result.truncated, false);
  assert.equal(result.mount, 'work');
  assert.ok(result.mtimeMs > 0);
  assert.ok(result.realPath.endsWith('AGENTS.md'));
});

test('nested paths read and reject lexical traversal / unknown mounts by code', async (t) => {
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'sub'), { recursive: true });
  writeFileSync(join(mountDir, 'sub', 'deep.txt'), 'deep');

  assert.equal((await workspace.readFileFromDisk('work/sub/deep.txt')).bytes.toString(), 'deep');

  const traversal = await expectRefusal(workspace.readFileFromDisk('work/../outside.txt'), 'traversal');
  assert.match(traversal.message, /traversal/i);
  await expectRefusal(workspace.readFileFromDisk('nope/file.txt'), 'unknown_mount');
});

test('missing files and directories are distinguished', async (t) => {
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'dir'));

  await expectRefusal(workspace.readFileFromDisk('work/missing.txt'), 'not_found');
  await expectRefusal(workspace.readFileFromDisk('work/dir'), 'directory');
  await expectRefusal(workspace.readFileFromDisk('work'), 'directory');
});

test('readBinaryFromDisk answers a file, a missing file, a directory and a file over maxBytes in its own words', async (t) => {
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'a.bin'), Buffer.from([0, 1, 2, 3]));
  mkdirSync(join(mountDir, 'dir'));
  const read = await workspace.readBinaryFromDisk('work/a.bin');
  assert.ok('data' in read, JSON.stringify(read));
  assert.deepEqual([...read.data], [0, 1, 2, 3]);
  assert.equal(read.absolutePath, join(mountDir, 'a.bin'));
  assert.deepEqual(await workspace.readBinaryFromDisk('work/missing.bin'), { error: 'File not found on disk: work/missing.bin' });
  // A path through a file is missing too, not the system's message with the
  // absolute path.
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.bin/x'), { error: 'File not found on disk: work/a.bin/x' });
  assert.deepEqual(await workspace.readBinaryFromDisk('work/dir'), { error: 'Not a file: work/dir' });
  assert.deepEqual(await workspace.readBinaryFromDisk('work/a.bin', { maxBytes: 3 }), { error: 'File too large: 4 > 3 bytes' });
  assert.ok('data' in (await workspace.readBinaryFromDisk('work/a.bin', { maxBytes: 4 })), 'a file of exactly maxBytes is read');
});

test("readBinaryFromDisk says a file it can't read is unreadable, whatever its size", async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('file modes don\'t keep this user out');
    return;
  }
  const { mountDir, workspace } = setup(t);
  writeFileSync(join(mountDir, 'locked.bin'), Buffer.alloc(8));
  chmodSync(join(mountDir, 'locked.bin'), 0o000);
  try {
    for (const opts of [{}, { maxBytes: 4 }]) {
      assert.deepEqual(await workspace.readBinaryFromDisk('work/locked.bin', opts), { error: 'Unable to read file: work/locked.bin' }, JSON.stringify(opts));
    }
  } finally {
    chmodSync(join(mountDir, 'locked.bin'), 0o600);
  }
});

test('a FIFO is refused at once by each disk reader, without waiting for a writer', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no FIFOs on Windows');
    return;
  }
  const { mountDir, workspace } = setup(t);
  const fifo = join(mountDir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  // The bound only tells an answer from a wait for a writer that never
  // comes, so it's generous: a slow runner answers well inside it.
  const within = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} still waits on the FIFO after 10 s`)), 10_000).unref()),
  ]);
  try {
    const err = await expectRefusal(within(workspace.readFileFromDisk('work/pipe'), 'readFileFromDisk'), 'not_found');
    assert.equal(err.message, 'Not a regular file: work/pipe');
    const image = await within(workspace.handleToolCall({ id: 'f', name: 'read_image', input: { path: 'work/pipe' } }), 'read_image');
    assert.equal(image.error, 'Unable to read image file: work/pipe');
    assert.deepEqual(await within(workspace.readBinaryFromDisk('work/pipe'), 'readBinaryFromDisk'), { error: 'Not a file: work/pipe' });
  } finally {
    // Release any open still waiting for a writer, so a failure ends the
    // test rather than holding the process.
    try {
      closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    } catch {
      // No reader waits (ENXIO): nothing to release.
    }
  }
});

test('a final-component symlink to an outside file is rejected under the default no-follow policy', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, join(outside, 'secret.txt'), join(mountDir, 'AGENTS.md'), 'file')) return;

  // The lexical resolver is happy — that is exactly the gap.
  assert.ok(workspace.resolveAbsolutePath('work/AGENTS.md'));

  const err = await expectRefusal(workspace.readFileFromDisk('work/AGENTS.md'), 'symlink');
  assert.ok(!err.message.includes(root), 'refusal must not leak absolute paths');
});

test('an intermediate symlinked directory escaping the mount is rejected under no-follow', async (t) => {
  const { root, mountDir, workspace } = setup(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, outside, join(mountDir, 'linkdir'), 'dir')) return;

  // Final component is a regular file; only the directory hop is a symlink,
  // which a mount that doesn't follow symlinks refuses as one, before it
  // looks where the link leads.
  const err = await expectRefusal(workspace.readFileFromDisk('work/linkdir/secret.txt'), 'symlink');
  assert.ok(!err.message.includes(root));
});

test('with followSymlinks, an in-mount target is followed but an outside target is still an escape', async (t) => {
  const { root, mountDir, workspace } = setup(t, { followSymlinks: true });
  writeFileSync(join(mountDir, 'real.txt'), 'inside');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  if (!symlinkOrSkip(t, join(mountDir, 'real.txt'), join(mountDir, 'alias.txt'), 'file')) return;
  if (!symlinkOrSkip(t, join(outside, 'secret.txt'), join(mountDir, 'leak.txt'), 'file')) return;

  const followed = await workspace.readFileFromDisk('work/alias.txt');
  assert.equal(followed.bytes.toString(), 'inside');
  assert.ok(followed.realPath.endsWith('real.txt'), 'realPath reports the canonical target');

  await expectRefusal(workspace.readFileFromDisk('work/leak.txt'), 'escape');
});

test('with followSymlinks, an in-mount symlink is followed only because policy allows it', async (t) => {
  const strict = setup(t);
  writeFileSync(join(strict.mountDir, 'real.txt'), 'inside');
  if (!symlinkOrSkip(t, join(strict.mountDir, 'real.txt'), join(strict.mountDir, 'alias.txt'), 'file')) return;
  // Same layout, default policy: the in-mount symlink is refused as a symlink,
  // not followed — containment would have passed, policy says no.
  await expectRefusal(strict.workspace.readFileFromDisk('work/alias.txt'), 'symlink');
});

test('a sibling-prefix directory is not beneath the mount', async (t) => {
  const { root, mountDir, workspace } = setup(t, { followSymlinks: true });
  const sibling = join(root, 'mount-other');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'x.txt'), 'sibling');
  if (!symlinkOrSkip(t, join(sibling, 'x.txt'), join(mountDir, 'x.txt'), 'file')) return;

  // `/mount-other/x.txt` starts with `/mount` as a string prefix — a naive
  // startsWith(root) check would accept it.
  await expectRefusal(workspace.readFileFromDisk('work/x.txt'), 'escape');
});

test('maxBytes performs a bounded prefix read and reports truncation', async (t) => {
  const { mountDir, workspace } = setup(t);
  const content = 'x'.repeat(10_000);
  writeFileSync(join(mountDir, 'big.txt'), content);

  const capped = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 1024 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.bytes.length, 1024);
  assert.equal(capped.size, 10_000, 'size reports the full on-disk length');
  assert.equal(capped.bytes.toString(), 'x'.repeat(1024));

  const whole = await workspace.readFileFromDisk('work/big.txt', { maxBytes: 20_000 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.bytes.length, 10_000);

  await assert.rejects(workspace.readFileFromDisk('work/big.txt', { maxBytes: -1 }), RangeError);
});

test('read_image keeps its historical error wording after sharing the containment core', async (t) => {
  // The image reader was the original owner of this algorithm; its messages
  // are pinned by workspace-read-image.test.ts. Spot-check the two codes the
  // shared core maps most delicately (not_found variants and directory).
  const { mountDir, workspace } = setup(t);
  mkdirSync(join(mountDir, 'folder'));
  const dir = await workspace.handleToolCall({ id: 'c1', name: 'read_image', input: { path: 'work/folder' } });
  assert.equal(dir.error, 'Path is a directory: work/folder');
  const missing = await workspace.handleToolCall({ id: 'c2', name: 'read_image', input: { path: 'work/nope.png' } });
  assert.equal(missing.error, 'File not found: work/nope.png');
});
