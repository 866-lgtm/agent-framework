import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs, { existsSync, mkdtempSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { MountWatcher, type FsChange, type WatcherLifecycle } from '../src/modules/workspace/watcher.js';
import type { MountConfig } from '../src/modules/workspace/types.js';

// Much shorter than the watcher's defaults (a 300 ms debounce, a 2 s root
// poll), so a test isn't waiting on production timing.
const DEBOUNCE_MS = 50;
const WATCH_ROOT_POLL_MS = 50;
// After an end-to-end test's batch, how long it watches for a second entry
// for the same path: chokidar's awaitWriteFinish (stabilityThreshold 100)
// plus our debounce, with room to spare.
const SETTLE_MS = 350;
// How long a test waits for something it needs to happen (the watcher ready,
// a reattach, a change's batch) before it fails: far past what any of it
// takes here.
const EVENT_MS = 10_000;

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mw-test-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(): MountConfig {
  return {
    name: 'test',
    path: tmp,
    mode: 'read-write',
    watch: 'always',
    watchDebounceMs: DEBOUNCE_MS,
    watchRootPollMs: WATCH_ROOT_POLL_MS,
  };
}

function collect(
  lifecycle?: WatcherLifecycle,
  config: MountConfig = makeConfig(),
  others: readonly string[] = [],
): { watcher: MountWatcher; batches: FsChange[][] } {
  const batches: FsChange[][] = [];
  const watcher = new MountWatcher(config, (changes) => {
    batches.push(changes);
  }, lifecycle, others);
  watcher.start();
  return { watcher, batches };
}

function withChokidarBackend<T>(usePolling: boolean, start: () => T): T {
  const previousUsePolling = process.env.CHOKIDAR_USEPOLLING;
  const previousInterval = process.env.CHOKIDAR_INTERVAL;
  process.env.CHOKIDAR_USEPOLLING = String(usePolling);
  if (usePolling) process.env.CHOKIDAR_INTERVAL = '25';
  try {
    return start();
  } finally {
    if (previousUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = previousUsePolling;
    if (previousInterval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = previousInterval;
  }
}

function withPollingBackend<T>(start: () => T): T {
  return withChokidarBackend(true, start);
}

function withNativeBackend<T>(start: () => T): T {
  return withChokidarBackend(false, start);
}

function collectWithPolling(lifecycle?: WatcherLifecycle): {
  watcher: MountWatcher;
  batches: FsChange[][];
} {
  return withPollingBackend(() => collect(lifecycle));
}

function collectWithNative(
  lifecycle?: WatcherLifecycle,
  config?: MountConfig,
  others?: readonly string[],
): { watcher: MountWatcher; batches: FsChange[][] } {
  return withNativeBackend(() => collect(lifecycle, config, others));
}

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = EVENT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  assert.fail(message);
}

/**
 * A polling watcher, once chokidar's first scan is done. A change made before
 * then can be part of the files chokidar starts from (ignoreInitial), and is
 * then never reported. If the watcher has reported an error and isn't ready
 * when the wait checks, the wait fails with that error, and a watcher that
 * doesn't get ready is stopped.
 */
async function readyWithPolling(): Promise<{ watcher: MountWatcher; batches: FsChange[][] }> {
  let ready = false;
  let failed: Error | undefined;
  const collected = collectWithPolling({ onReady: () => { ready = true; }, onError: (err) => { failed ??= err; } });
  try {
    await waitFor(() => ready || failed !== undefined, 'expected the watcher to be ready');
    if (!ready) throw failed;
  } catch (error) {
    await collected.watcher.stop();
    throw error;
  }
  return collected;
}

/**
 * Waits until a batch names `path`, with `op` when one is given: the batch is
 * what a test's assertions read.
 */
async function changeFor(batches: FsChange[][], path: string, op?: FsChange['op']): Promise<void> {
  await waitFor(
    () => batches.flat().some(c => c.path === path && (op === undefined || c.op === op)),
    `expected ${op ? `a ${op} entry` : 'a change'} for ${path}`,
  );
}

// The probe files changesFlow writes, which a test's results leave out by name.
const PROBE_PREFIX = 'probe-';
const isProbe = (path: string): boolean => basename(path).startsWith(PROBE_PREFIX);

/**
 * Waits until the watcher reports a change in each of `dirs`, relative to the
 * mount's root `root` (the root itself when `dirs` names none), so what a test
 * writes there next is written while changes are delivered. `onReady` says
 * chokidar's first scan is done, not that the platform delivers events yet. By
 * our reading of libuv, on macOS `fs.watch` of a directory returns before
 * libuv's own thread has made the FSEventStream that reports it, a stream that
 * starts "since now" and is made again for every watched directory each time
 * one is added. So a file written in between isn't reported until a later
 * change in its directory, when chokidar reads the directory again, and a probe
 * reported in one directory can come from a stream made before another
 * directory's watch. Each attempt writes a new probe in each directory still
 * unreported and waits up to a second, since the next probe is that later
 * change. The probes stay in the batches, and a test's results leave them out
 * (isProbe).
 */
async function changesFlow(root: string, batches: FsChange[][], dirs: readonly string[]): Promise<void> {
  const where = dirs.length ? dirs : [''];
  const start = Date.now();
  const left = () => Date.now() - start < EVENT_MS;
  const reportedIn = (dir: string) => batches.flat().some((c) => isProbe(c.path) && dirname(c.path) === (dir || '.'));
  for (let n = 0; left(); n++) {
    for (const dir of where) if (!reportedIn(dir)) writeFileSync(join(root, dir, `${PROBE_PREFIX}${n}.txt`), String(n));
    for (const attempt = Date.now(); Date.now() - attempt < 1_000 && left(); await wait(25)) {
      if (where.every(reportedIn)) return;
    }
  }
  const seen = [...new Set(batches.flat().map((c) => c.path))];
  assert.fail(`expected the watcher to report a probe in each of ${where.map((d) => d || '.').join(', ')}; it reported ${seen.join(', ') || 'nothing'}`);
}

/**
 * Hands the watcher chokidar's events for paths under the mount, as chokidar
 * reports them: chokidar's FSWatcher is an EventEmitter, and its own
 * emitWithAll calls emit. So a test can show how events merge with no file
 * system timing in it.
 */
function emitChokidar(watcher: MountWatcher, events: Array<['add' | 'change' | 'unlink', string]>): void {
  const chokidar = chokidarOf(watcher);
  for (const [event, path] of events) chokidar.emit(event, join(tmp, path));
}

/** The watcher's chokidar instance, an EventEmitter, so a test can hand it an event as chokidar emits one. */
function chokidarOf(watcher: MountWatcher): { emit(event: string, ...args: unknown[]): boolean } {
  return (watcher as unknown as { watcher: { emit(event: string, ...args: unknown[]): boolean } }).watcher;
}

/**
 * The process's open descriptors of `path`, a real path, as Linux's /proc names
 * them: the path, or the path and " (deleted)" once it has been removed.
 */
function descriptorsOf(path: string): string[] {
  return readdirSync('/proc/self/fd').flatMap((fd) => {
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return []; // closed since the listing, as the listing's own is
    }
    return target === path || target === `${path} (deleted)` ? [target] : [];
  });
}

/**
 * Runs `fn` with node:fs's `openSync` refusing `path` as at the process's file
 * limit. The watcher imports it by name, so the binding is synced both ways.
 */
async function withOpenRefused<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const original = fs.openSync;
  fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
    if (String(file) === path) {
      throw Object.assign(new Error(`EMFILE: too many open files, open '${path}'`), { code: 'EMFILE', syscall: 'open', path });
    }
    return (original as (...args: unknown[]) => number)(file, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
  }
}

describe('MountWatcher mergeOp', () => {
  // Each merge rule, from chokidar's events handed in within one debounce
  // window: what the batch says once the window closes. Nothing else changes
  // the directory, so that batch is the only one, and no window is needed
  // after it. They use the polling backend, since they need no real events.
  for (const [name, events, op] of [
    ['an unlink then an add → modified (atomic save)', [['unlink', 'a.md'], ['add', 'a.md']], 'modified'],
    ['an add then a change → created (still new)', [['add', 'a.md'], ['change', 'a.md']], 'created'],
    ['an add then an unlink → deleted (a trailing delete wins)', [['add', 'a.md'], ['unlink', 'a.md']], 'deleted'],
  ] as Array<[string, Array<['add' | 'change' | 'unlink', string]>, FsChange['op']]>) {
    it(name, async () => {
      const { watcher, batches } = collectWithPolling();
      try {
        emitChokidar(watcher, events);
        await changeFor(batches, 'a.md');
      } finally {
        await watcher.stop();
      }
      assert.deepStrictEqual(batches, [[{ path: 'a.md', op }]]);
    });
  }

  // End to end, under polling: what a real save comes out as, one entry with
  // the right op. Both steps run in one synchronous stretch, so a poll sees
  // the state between them only if its stat lands there, and these pass with
  // any merge rule removed: the rule tests above pin the merges. Each then
  // watches SETTLE_MS more for a second entry for the file.
  it('an atomic save (unlink, then write) comes out as one modified entry', async () => {
    const file = join(tmp, 'ticket.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = await readyWithPolling();

    try {
      unlinkSync(file);
      writeFileSync(file, 'v2');

      // Its batch, then SETTLE_MS more to see any second entry.
      await changeFor(batches, 'ticket.md');
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }

    const flat = batches.flat();
    const forFile = flat.filter(c => c.path === 'ticket.md');
    assert.strictEqual(forFile.length, 1, `expected 1 change, got ${JSON.stringify(flat)}`);
    assert.strictEqual(forFile[0].op, 'modified');
  });

  it('a new file written twice comes out as one created entry', async () => {
    const { watcher, batches } = await readyWithPolling();

    try {
      const file = join(tmp, 'new.md');
      writeFileSync(file, 'hello');
      writeFileSync(file, 'hello updated');

      await changeFor(batches, 'new.md');
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }

    const forFile = batches.flat().filter(c => c.path === 'new.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'created');
  });
});

describe('MountWatcher lifecycle', () => {
  it('mkdir -p covers missing parent dir at attach time (case C repro)', async () => {
    const nested = join(tmp, 'parent-also-missing', 'tickets');
    assert.ok(!existsSync(nested), 'precondition: nested path should not exist');

    const batches: FsChange[][] = [];
    let ready = false;
    const watcher = withPollingBackend(() => {
      const mounted = new MountWatcher(
        { name: 'tickets', path: nested, mode: 'read-write', watch: 'always', watchDebounceMs: DEBOUNCE_MS },
        (changes) => { batches.push(changes); },
        { onReady: () => { ready = true; } },
      );
      mounted.start();
      return mounted;
    });

    try {
      assert.ok(existsSync(nested), 'start() should have created the watched path');
      // A file written before chokidar's first scan is done can be part of
      // what it starts from (ignoreInitial), and then is never reported.
      await waitFor(() => ready, 'onReady should have fired');
      writeFileSync(join(nested, 'ticket.md'), 'hi');
      await changeFor(batches, 'ticket.md');
    } finally {
      await watcher.stop();
    }

    const created = batches.flat().find(c => c.path === 'ticket.md');
    assert.ok(created, `expected created event for ticket.md, got ${JSON.stringify(batches.flat())}`);
    assert.strictEqual(created.op, 'created');
  });

  it('read-only mount does not create the watched path', async () => {
    const roPath = join(tmp, 'read-only-missing');
    const watcher = new MountWatcher(
      { name: 'ro', path: roPath, mode: 'read-only', watch: 'always', watchDebounceMs: DEBOUNCE_MS },
      () => {},
    );
    watcher.start();
    try {
      await wait(50);
      assert.ok(!existsSync(roPath), 'read-only mount must not mkdir -p behind the user\'s back');
    } finally {
      await watcher.stop();
    }
  });

  // Root-liveness re-attach cases are authoritative on Linux (written around
  // inode-reuse semantics there). Under Node 24 on macOS the native watcher
  // delivers a different event stream — root not recreated, duplicate
  // reattach, read-only root re-attached — tracked in #130.
  it('read-write mount recreates a deleted root and re-attaches', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      rmSync(tmp, { recursive: true, force: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to recreate and reattach');
      await waitFor(() => readyCount > 1, 'expected recreated watcher ready');
      assert.ok(existsSync(tmp), 'read-write mount should recreate its deleted root');
    } finally {
      await watcher.stop();
    }
  });

  // Sandboxed macOS rejects native fs.watch handles with EMFILE. Keep this
  // production-backend integration assertion authoritative on Linux.
  it('re-attaches after the root is removed and recreated', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      // The watcher holds its root open, so the root's removal sends no rename
      // until the hold ends, and the root poll finds the root made again.
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');

      writeFileSync(join(tmp, 'after-recreate.md'), 'hello');
      await changeFor(batches, 'after-recreate.md');

      const created = batches.flat().find(c => c.path === 'after-recreate.md');
      assert.ok(created, `expected created event after reattach, got ${JSON.stringify(batches.flat())}`);
      assert.strictEqual(created.op, 'created');
    } finally {
      await watcher.stop();
    }
  });

  // Linux-only for the same reason as above (#130).
  it('fires onReattach exactly once for one remove and recreate cycle', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');
      await wait(WATCH_ROOT_POLL_MS * 4);

      assert.strictEqual(reattachCount, 1);
    } finally {
      await watcher.stop();
    }
  });

  it('does not re-attach for normal create and modify traffic', async () => {
    let ready = false;
    let reattachCount = 0;
    const { watcher, batches } = collectWithPolling({
      onReady: () => { ready = true; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => ready, 'expected initial watcher ready');

      const file = join(tmp, 'normal.md');
      writeFileSync(file, 'v1');
      await changeFor(batches, 'normal.md', 'created');
      writeFileSync(file, 'v2');
      await changeFor(batches, 'normal.md', 'modified');
      // Root polls run through the traffic and after it, and none re-attaches.
      await wait(WATCH_ROOT_POLL_MS * 4);

      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });

  // Linux-only for the same reason as above (#130).
  it('keeps a deleted read-only root detached and stops cleanly', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const watcher = new MountWatcher(
      { ...makeConfig(), mode: 'read-only' },
      () => {},
      {
        onReady: () => { readyCount++; },
        onReattach: () => { reattachCount++; },
      },
    );
    watcher.start();

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      rmSync(tmp, { recursive: true, force: true });
      // Root polls run through this window and find the root gone. A mount
      // that watched the missing root again would fire onReady again, which
      // is what this test counts: the root stays absent either way, and
      // onReattach needs it back.
      await wait(WATCH_ROOT_POLL_MS * 4);
      assert.ok(!existsSync(tmp), 'read-only mount must not recreate its deleted root');
      assert.strictEqual(readyCount, 1, 'a read-only mount must not watch its missing root again');
      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });

  // libuv reports a rename of an entry named like the root under that name,
  // as it reports the root's own removal or move. On Linux the watcher holds
  // its root, whose identity tells them apart.
  it("doesn't re-attach for an entry named like its held root, made, saved over or removed anywhere beneath it", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(tmp, 'work');
    mkdirSync(join(root, 'sub'), { recursive: true });
    let ready = false;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      { onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } },
      // The root poll is past the test's deadline, so within it only a rename
      // could re-attach.
      { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
    );
    // Each step waits for the batch its change comes in, which comes after
    // the change's rename and the check that rename runs, or for a re-attach,
    // which loses the change's events.
    const step = async (what: string, change: () => void, path: string, op?: FsChange['op']) => {
      batches.length = 0;
      change();
      const reported = () => batches.flat().some((c) => c.path === path && (op === undefined || c.op === op));
      await waitFor(() => reported() || reattachCount > 0, `expected ${op ? `a ${op} entry` : 'a change'} for ${path}`);
      assert.strictEqual(reattachCount, 0, `${what} re-attached the watcher`);
    };

    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      await step('a file named like the root, made', () => writeFileSync(join(root, 'work'), 'v1'), 'work', 'created');
      await step('a file named like the root, made in a subdirectory', () => writeFileSync(join(root, 'sub', 'work'), 'v1'), 'sub/work', 'created');
      await step('a file named like the root, saved over by a rename', () => {
        writeFileSync(join(root, '.work.tmp'), 'v2');
        renameSync(join(root, '.work.tmp'), join(root, 'work'));
      }, 'work');
      await step('a file named like the root, removed', () => unlinkSync(join(root, 'work')), 'work', 'deleted');
      await step('a file named like the root, removed from a subdirectory', () => unlinkSync(join(root, 'sub', 'work')), 'sub/work', 'deleted');
      // A directory's own making isn't reported, so this step waits for a
      // file made in it after it.
      await step('a directory named like the root, made', () => {
        mkdirSync(join(root, 'work'));
        writeFileSync(join(root, 'work', 'x.md'), 'x');
      }, 'work/x.md', 'created');
    } finally {
      await watcher.stop();
    }
  });

  // On Linux a removed directory's inode number can go to the next directory
  // made, as ext4 gives it, so a root made again could look unchanged. The
  // watcher holds its root open, and a number held isn't given out.
  it('holds its root open while it watches, so a root made again takes another inode number', {
    skip: process.platform !== 'linux',
  }, async (t) => {
    // Whether this disk gives a removed directory's number to the next one
    // made. tmpfs doesn't, and there the test has nothing to show.
    const scratch = join(tmp, 'scratch');
    mkdirSync(scratch);
    const scratchIno = statSync(scratch).ino;
    rmdirSync(scratch);
    mkdirSync(scratch);
    if (statSync(scratch).ino !== scratchIno) {
      t.skip("this disk didn't give the removed directory's inode number to the next one made");
      return;
    }
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative(
      { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: root },
    );

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      const held = statSync(root).ino;
      rmdirSync(root);
      mkdirSync(root);
      assert.notStrictEqual(statSync(root).ino, held, "the root made again took the held root's inode number");
      await waitFor(() => reattachCount > 0 && readyCount > 1, 'expected the watcher to re-attach to the root made again');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds the root made again, having let the removed one go');
    } finally {
      await watcher.stop();
    }
    assert.deepStrictEqual(descriptorsOf(root), [], 'a stopped watcher holds nothing of its root');
  });

  it('lets go of its root at a stop whose close of chokidar fails', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    const { watcher } = collectWithNative({ onReady: () => { ready = true; } }, { ...makeConfig(), path: root });
    await waitFor(() => ready, 'expected initial watcher ready');
    const chokidar = chokidarOf(watcher) as unknown as { close(): Promise<void> };
    const close = chokidar.close.bind(chokidar);
    chokidar.close = async () => {
      await close();
      throw new Error('close failed');
    };
    await assert.rejects(watcher.stop(), /close failed/);
    assert.deepStrictEqual(descriptorsOf(root), [], 'the stopped watcher still holds its root');
  });

  // A root the watcher doesn't hold has its identity read from its path,
  // which a root made again can share with the removed one, so a rename named
  // like it forces a re-attach, as it always did. On Linux that's a root it
  // can't open, as without read permission or at the process's file limit;
  // elsewhere it holds no root.
  it("reads a root it doesn't hold from its path, and re-attaches at a rename named like it", async () => {
    const root = join(tmp, 'work');
    mkdirSync(root);
    const unheld = <T>(fn: () => Promise<T>): Promise<T> => (process.platform === 'linux' ? withOpenRefused(root, fn) : fn());
    await unheld(async () => {
      let readyCount = 0;
      let reattachCount = 0;
      const { watcher } = withPollingBackend(() => collect(
        { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
        { ...makeConfig(), path: root },
      ));
      try {
        await waitFor(() => readyCount > 0, 'expected initial watcher ready');
        // Root polls run through this wait, and none finds the root changed.
        // A rename named otherwise comes meanwhile, and leaves it be.
        chokidarOf(watcher).emit('raw', 'rename', 'other.md', { watchedPath: root });
        await wait(WATCH_ROOT_POLL_MS * 4);
        assert.strictEqual(readyCount, 1, 'the watcher attached to its unchanged root again');
        // The rename libuv reports for the root's own removal, as chokidar emits it.
        chokidarOf(watcher).emit('raw', 'rename', 'work', { watchedPath: root });
        await waitFor(() => reattachCount > 0 && readyCount > 1, 'expected the rename to re-attach the watcher');
      } finally {
        await watcher.stop();
      }
    });
  });

  // libuv gives a rename without a name for a file whose path it can't read
  // (its kqueue backend, macOS's for files).
  it('passes over a rename that comes without a name', async () => {
    let ready = false;
    let reattachCount = 0;
    const { watcher } = withPollingBackend(() => collect({ onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } }));
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      chokidarOf(watcher).emit('raw', 'rename', null, { watchedPath: join(tmp, 'a.md') });
      await wait(WATCH_ROOT_POLL_MS * 2);
      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });

  // A root moved away is found at its rename, which comes for a move even
  // while the root is held: the check finds nothing at the root's path.
  it('re-attaches at the rename when its root is moved away', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(tmp, 'work');
    mkdirSync(root);
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
      // The root poll is past the test's deadline, so within it only the
      // rename re-attaches.
      { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
    );

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      renameSync(root, `${root}.away`);
      await waitFor(() => reattachCount > 0 && readyCount > 1, 'expected the watcher to re-attach at the rename');
      // A read-write mount makes its root again, and the watcher reports what's
      // written there.
      writeFileSync(join(root, 'after.md'), 'x');
      await changeFor(batches, 'after.md', 'created');
    } finally {
      await watcher.stop();
    }
  });
});

describe('MountWatcher ignores what a walk passes over by design (connectome-host #278)', () => {
  // The mount sits under a directory with a dot in its name, as one under
  // ~/.local does: chokidar's own filter for editors' files tested the whole
  // path, so there it hid every `*.swp` beneath the root.
  async function reported(
    collectOn: (lifecycle?: WatcherLifecycle, config?: MountConfig, others?: readonly string[]) => { watcher: MountWatcher; batches: FsChange[][] },
    ignore: string[],
    files: string[],
    expected: string[],
    others: readonly string[] = [],
  ): Promise<string[]> {
    const root = join(tmp, '.local', 'work');
    mkdirSync(join(root, 'cache'), { recursive: true });
    mkdirSync(join(root, 'drafts~'), { recursive: true });
    for (const other of others) mkdirSync(join(root, other), { recursive: true });
    let ready = false;
    const { watcher, batches } = collectOn({ onReady: () => { ready = true; } }, { ...makeConfig(), path: root, ignore }, others);
    try {
      await waitFor(() => ready, 'expected the watcher to be ready', 10_000);
      // Probes in each directory a file must be reported from.
      await changesFlow(root, batches, [...new Set(expected.map((f) => (dirname(f) === '.' ? '' : dirname(f))))]);
      for (const f of files) writeFileSync(join(root, f), 'x');
      // What must be reported, then time for anything that mustn't be.
      const seen = (p: string) => batches.flat().some((c) => c.path === p);
      await waitFor(() => expected.every(seen), `expected ${expected.join(', ')} to be reported`, 10_000);
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }
    return [...new Set(batches.flat().map((c) => c.path))].filter((p) => !isProbe(p)).sort();
  }

  const EDITORS = ['.gate.json.swp', '.gate.json.swx', 'gate.json~', '.x.subl3f9.tmp', 'drafts~/x.txt'];
  const PLAIN = ['notes.swp', 'report.v2.swp', 'notes.sublime.tmpl', 'backup.txt.bak', 'kept.txt'];

  for (const [backend, collectOn] of [
    ['native', collectWithNative],
    ['polling', (l?: WatcherLifecycle, c?: MountConfig, o?: readonly string[]) => withPollingBackend(() => collect(l, c, o))],
  ] as const) {
    it(`reports a plain name and passes over editors' files, by their own name (${backend})`, async () => {
      assert.deepEqual(await reported(collectOn, [], [...EDITORS, ...PLAIN], PLAIN), [...PLAIN].sort());
    });

    it(`passes over another mount's directory nested in this one, and reports what lies beside it (${backend})`, async () => {
      const files = ['inner/mount/x.txt', 'inner/kept.txt', 'kept.txt'];
      assert.deepEqual(await reported(collectOn, [], files, ['inner/kept.txt', 'kept.txt'], ['inner/mount']), ['inner/kept.txt', 'kept.txt']);
    });
  }

  it("passes over what the mount's ignore list covers, by the path relative to the mount", async () => {
    assert.deepEqual(await reported(collectWithNative, ['*.log', 'cache/**'], ['new.log', 'cache/blob.txt', 'kept.txt'], ['kept.txt']), ['kept.txt']);
  });
});
