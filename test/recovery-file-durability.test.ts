/**
 * The recovery files (host mode, deferred writes) are written as a temp file
 * synced and renamed over the record, with the directory synced after the
 * rename. These drive the host-mode record through quiesce(), recording the
 * node:fs calls the write makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

async function withFramework(fn: (framework: AgentFramework, recovery: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-durability-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    framework.start();
    await fn(framework, join(dir, 'store', 'recovery'));
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface FsCall { call: 'open' | 'fsync' | 'close' | 'rename'; path?: string; to?: string; fd?: number }

/** Runs `fn` with node:fs's openSync, fsyncSync, closeSync and renameSync recorded in order, each fd named by
 *  the path it was opened for. `fail` may return an error for an fsync to throw instead of syncing. */
async function recordingFs(
  fn: () => Promise<unknown>,
  fail?: (call: FsCall) => Error | undefined,
): Promise<FsCall[]> {
  const calls: FsCall[] = [];
  const opened = new Map<number, string>();
  const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync };
  fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (original.openSync as (...args: unknown[]) => number)(path, ...rest);
    opened.set(fd, String(path));
    calls.push({ call: 'open', path: String(path), fd });
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => {
    const call: FsCall = { call: 'fsync', path: opened.get(fd), fd };
    calls.push(call);
    const error = fail?.(call);
    if (error) throw error;
    original.fsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.closeSync = ((fd: number) => {
    calls.push({ call: 'close', path: opened.get(fd), fd });
    original.closeSync(fd);
  }) as typeof fs.closeSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    calls.push({ call: 'rename', path: String(from), to: String(to) });
    original.renameSync(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
  return calls;
}

/** The rename that put the host-mode record in place, and the temp file it renamed. */
function recordRename(calls: FsCall[], record: string): { at: number; temporary: string } {
  const at = calls.findIndex((c) => c.call === 'rename' && c.to === record);
  assert.ok(at >= 0, `a rename onto ${record}: ${JSON.stringify(calls)}`);
  const temporary = calls[at].path!;
  assert.match(temporary, /host-mode\.json\.\d+\.[0-9a-f-]+\.tmp$/);
  return { at, temporary };
}

test('quiesce syncs the host-mode record\'s temp file before renaming it over the record, and the directory after', async () => {
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    const calls = await recordingFs(() => framework.quiesce({ reason: 'test' }));
    const rename = recordRename(calls, record);
    const tempSync = calls.findIndex((c) => c.call === 'fsync' && c.path === rename.temporary);
    assert.ok(tempSync >= 0 && tempSync < rename.at, `the temp file synced before the rename: ${JSON.stringify(calls)}`);
    const dirSync = calls.findIndex((c, i) => i > rename.at && c.call === 'fsync' && c.path === recovery);
    assert.ok(dirSync > rename.at, `the directory synced after the rename: ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).quiesced, true);
  });
});

test('a host-mode record that can\'t be replaced leaves no temp file behind', async () => {
  await withFramework(async (framework, recovery) => {
    // A directory where the record goes, so the rename fails.
    mkdirSync(join(recovery, 'host-mode.json'), { recursive: true });
    await assert.rejects(framework.quiesce({ reason: 'test' }));
    assert.deepEqual(readdirSync(recovery).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('on win32 the temp file is still synced, and the directory is not opened to sync it', async () => {
  await withFramework(async (framework, recovery) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let calls: FsCall[];
    try {
      calls = await recordingFs(() => framework.quiesce({ reason: 'test' }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    const rename = recordRename(calls, join(recovery, 'host-mode.json'));
    assert.ok(calls.some((c, i) => i < rename.at && c.call === 'fsync' && c.path === rename.temporary), JSON.stringify(calls));
    assert.ok(!calls.some((c) => c.call === 'open' && c.path === recovery), `the directory not opened: ${JSON.stringify(calls)}`);
  });
});

test('a directory sync that fails after the rename leaves the new record in place and says so', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  await withFramework(async (framework, recovery) => {
    const record = join(recovery, 'host-mode.json');
    const eio = () => Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    await recordingFs(() => framework.quiesce({ reason: 'test' }), (c) => (c.path === recovery ? eio() : undefined));
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).quiesced, true);
    assert.ok(
      logged.some((line) => line.includes(`${record} is in place, but syncing its directory failed, so a crash could still lose this change`)),
      logged.join('\n'),
    );
  });
});
