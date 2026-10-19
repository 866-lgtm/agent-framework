/**
 * A read-only direct mount (MountConfig.backend 'direct'): its tools read
 * disk as it is when they run, record nothing in the store, and give the
 * answers a 'chronicle' mount's tools give where the two should agree. And
 * the switch between the kinds, both ways.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
// A namespace, so this file loads where the module lacks inOrder, and only
// the tests that call it fail there.
import * as workspaceModule from '../src/modules/workspace/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';
import { changedAfterFstat, countingLoads, withFileHandle } from './helpers/file-handle.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');

type Alert = { kind: string; agent: string; message: string; data?: Record<string, unknown> };

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-direct-'));
  readonly ref = join(this.root, 'ref');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  events: ProcessEvent[] = [];
  alerts: Alert[] = [];
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.ref, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  file(rel: string, content: string | Buffer): void {
    mkdirSync(dirname(join(this.ref, rel)), { recursive: true });
    writeFileSync(join(this.ref, rel), content);
  }

  /** A module whose `ref` mount is direct and read-only unless `mount` says otherwise, with `more` mounts beside it. */
  async open(mount: Partial<MountConfig> = {}, more: MountConfig[] = []): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: [{ name: 'ref', path: this.ref, mode: 'read-only', backend: 'direct', ...mount }, ...more],
    });
    m.initStore(this.store);
    await m.start({
      isRestart: false,
      getState: () => null,
      setState: () => {},
      pushEvent: (e: ProcessEvent) => this.events.push(e),
      notifyOps: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => this.alerts.push({ kind, agent, message, data }),
    } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  /** The same mount as a 'chronicle' one, read-write and unwatched. */
  openChronicle(): Promise<WorkspaceModule> {
    return this.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' });
  }

  async close(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
  }

  stateIds(): string[] {
    return this.store.listStates().map((s) => s.id).sort();
  }
}

/** The mounts a module watches. */
function watched(m: WorkspaceModule): string[] {
  return [...(m as unknown as { watchers: Map<string, unknown> }).watchers.keys()];
}

/** Run `fn` with `node:fs/promises`'s `lstat`, as the module's imports see it, replaced by what `make` makes of it. */
async function withLstat<T>(make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
  const original = fsp.lstat!;
  fsp.lstat = make(original);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fsp.lstat = original;
    syncBuiltinESMExports();
  }
}

function call(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  return m.handleToolCall({ id: name, name, input });
}

async function data<T = Record<string, unknown>>(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)}: ${result.error}`);
  return result.data as T;
}

async function failure(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const result = await call(m, name, input);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} succeeded: ${JSON.stringify(result.data)}`);
  return result.error!;
}

test('a direct mount reads disk as it is now, and its tools record nothing in the store', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'one\n');
  env.file('img/dot.png', PNG);
  const m = await env.open();
  const states = env.stateIds();
  const sequence = env.store.currentSequence();

  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/src/a.ts' })).content, '     1\tone');
  appendFileSync(join(env.ref, 'src/a.ts'), 'two\n');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/src/a.ts' })).content, '     1\tone\n     2\ttwo');
  await data(m, 'ls', { path: 'ref', recursive: true });
  await data(m, 'ls', { path: 'ref/src' });
  await data(m, 'glob', { pattern: '**/*.ts' });
  await data(m, 'grep', { pattern: 'two' });
  await data(m, 'read_image', { path: 'ref/img/dot.png' });
  await data(m, 'status');
  await data(m, 'sync');
  assert.deepEqual('data' in (await m.readBinary('ref/src/a.ts')), true);

  assert.deepEqual(env.stateIds(), states, 'no state was made');
  assert.ok(!states.some((id) => id.startsWith('workspace/ref/')), `the mount's states: ${states}`);
  assert.equal(env.store.currentSequence(), sequence, 'nothing was recorded');
  assert.deepEqual(env.events.filter((e) => e.type !== 'workspace:mounted').map((e) => e.type), [], 'no change was evented');
  assert.deepEqual(watched(m), [], 'no watcher runs, though watch is left out');
});

test("read on a direct mount refuses what a 'chronicle' mount never stores: a binary file, and one over the size limit", async (t) => {
  const env = new Env(t);
  env.file('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
  env.file('dot.png', PNG);
  env.file('big.txt', 'x'.repeat(9));
  env.file('fits.txt', 'x'.repeat(8));
  const m = await env.open({ maxFileSize: 8 });
  assert.equal(await failure(m, 'read', { path: 'ref/bin.dat' }), "ref/bin.dat is binary, so read doesn't show it as text.");
  assert.equal(await failure(m, 'read', { path: 'ref/dot.png' }), "ref/dot.png is over the size limit (8 bytes), so read doesn't show it.");
  assert.equal(await failure(m, 'read', { path: 'ref/big.txt' }), "ref/big.txt is over the size limit (8 bytes), so read doesn't show it.");
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/fits.txt' })).content, '     1\txxxxxxxx');

  const roomy = await env.open({ maxFileSize: 1024 });
  assert.equal(await failure(roomy, 'read', { path: 'ref/dot.png' }), "ref/dot.png is binary, so read doesn't show it as text; read it with read_image.");
});

test("read on a direct mount answers with the disk reader's refusals", async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  symlinkSync(join(env.ref, 'src/a.ts'), join(env.ref, 'link.ts'));
  symlinkSync(join(env.ref, 'src'), join(env.ref, 'srclink'));
  const m = await env.open();
  assert.equal(await failure(m, 'read', { path: 'ref/missing.ts' }), 'File not found: ref/missing.ts');
  assert.equal(await failure(m, 'read', { path: 'ref/src' }), 'Path is a directory: ref/src');
  assert.equal(await failure(m, 'read', { path: 'ref/link.ts' }), 'Symlinks are not allowed: ref/link.ts');
  assert.equal(
    await failure(m, 'read', { path: 'ref/srclink/a.ts' }),
    'ref/srclink/a.ts: "ref/srclink" is a symlink to "ref/src", which this mount does not follow; the mount\'s host can set followSymlinks: true',
  );
  assert.match(await failure(m, 'read', { path: 'ref/../escape.txt' }), /^Path traversal detected/);
});

test("read_image on a direct mount never shows the copy a 'chronicle' run stored", async (t) => {
  const env = new Env(t);
  const chronicle = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', autoMaterialize: true });
  assert.equal((await chronicle.writeBinary('ref/dot.img', PNG, 'image/png')).success, true);
  await env.close(chronicle);
  env.file('dot.img', GIF);
  const direct = await env.open();
  assert.deepEqual(env.alerts, [], 'it starts direct');
  const image = await data<Array<{ mimeType?: string; data?: string }>>(direct, 'read_image', { path: 'ref/dot.img' });
  assert.deepEqual([image[1]!.mimeType, image[1]!.data], ['image/gif', GIF.toString('base64')]);
});

test("read_image on a direct mount reads disk's image as it is now", async (t) => {
  const env = new Env(t);
  env.file('dot.img', PNG);
  const m = await env.open();
  const first = await data<Array<{ type: string; text?: string; data?: string; mimeType?: string }>>(m, 'read_image', { path: 'ref/dot.img' });
  assert.equal(first[0]!.text, `Path: ref/dot.img\nMIME: image/png\nBytes: ${PNG.byteLength}`);
  assert.equal(first[1]!.data, PNG.toString('base64'));
  env.file('dot.img', GIF);
  const second = await data<Array<{ mimeType?: string; data?: string }>>(m, 'read_image', { path: 'ref/dot.img' });
  assert.equal(second[1]!.mimeType, 'image/gif');
  assert.equal(second[1]!.data, GIF.toString('base64'));
});

test('ls on a direct mount lists disk\'s entries with their sizes and no state, and a link with why it isn\'t taken', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'abc');
  env.file('src/b.ts', 'bb');
  symlinkSync(join(env.ref, 'a.txt'), join(env.ref, 'link.txt'));
  const m = await env.open();
  assert.deepEqual((await data(m, 'ls', { path: 'ref' })).entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.txt', type: 'file', size: 3 },
    { name: 'link.txt', type: 'file', note: 'a symlink, which this mount does not follow' },
  ]);
  assert.deepEqual(await data(m, 'ls', { path: 'ref', recursive: true }), {
    path: 'ref',
    entries: [
      { path: 'a.txt', size: 3 },
      { path: 'link.txt', note: 'a symlink, which this mount does not follow' },
      { path: 'src/b.ts', size: 2 },
    ],
    count: 3,
  });

  const following = await env.open({ followSymlinks: true });
  assert.deepEqual((await data(following, 'ls', { path: 'ref' })).entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.txt', type: 'file', size: 3 },
    { name: 'link.txt', type: 'file', size: 3 },
  ]);
});

test('the default ignore list keeps whole walks out of what it covers, and a path a tool names is walked', async (t) => {
  const env = new Env(t);
  env.file('src/a.js', 'needle\n');
  env.file('node_modules/pkg/index.js', 'needle\n');
  env.file('node_modules/pkg/dist/built.js', 'needle\n');
  env.file('dist/out.js', 'needle\n');
  const m = await env.open();
  assert.deepEqual((await data(m, 'ls', { path: 'ref' })).entries, [{ name: 'src', type: 'directory' }]);
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: '**/*.js' })).matches, [{ path: 'ref/src/a.js', size: 7 }]);
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle' })).results.map((r) => r.file),
    ['ref/src/a.js'],
  );
  // Named, by a path or a pattern's directory: walked, the rest of the list
  // applying beneath it.
  assert.deepEqual((await data(m, 'ls', { path: 'ref/node_modules/pkg' })).entries, [{ name: 'index.js', type: 'file', size: 7 }]);
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'node_modules/pkg/*.js' })).matches, [{ path: 'ref/node_modules/pkg/index.js', size: 7 }]);
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle', path: 'ref/node_modules' })).results.map((r) => r.file),
    ['ref/node_modules/pkg/index.js'],
  );
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle', glob: 'node_modules/**' })).results.map((r) => r.file),
    ['ref/node_modules/pkg/index.js'],
  );
  // A list the config names replaces it.
  const own = await env.open({ ignore: ['dist'] });
  assert.deepEqual(
    (await data<{ matches: Array<{ path: string }> }>(own, 'glob', { pattern: '**/*.js' })).matches.map((x) => x.path),
    ['ref/node_modules/pkg/index.js', 'ref/src/a.js'],
  );
});

test('glob and grep on a direct mount find a file the moment disk has it, as disk has it', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'alpha\n');
  env.file('src/notes.md', 'notes\n');
  const m = await env.open();
  assert.equal((await data<{ count: number }>(m, 'glob', { pattern: 'src/*.ts' })).count, 1);
  env.file('src/b.ts', 'beta\nalpha again\n');
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'src/*.ts' })).matches, [
    { path: 'ref/src/a.ts', size: 6 },
    { path: 'ref/src/b.ts', size: 17 },
  ]);
  assert.deepEqual(await data(m, 'grep', { pattern: 'alpha', path: 'ref/src', contextAfter: 1 }), {
    pattern: 'alpha',
    results: [
      { file: 'ref/src/a.ts', version: 'disk', matches: [{ line: 1, text: 'alpha', context: ['alpha'] }] },
      { file: 'ref/src/b.ts', version: 'disk', matches: [{ line: 2, text: 'alpha again', context: ['alpha again'] }] },
    ],
    totalMatches: 2,
  });
  assert.deepEqual((await data<{ results: unknown[] }>(m, 'grep', { pattern: 'beta', path: 'ref/src/b.ts' })).results, [
    { file: 'ref/src/b.ts', version: 'disk', matches: [{ line: 1, text: 'beta' }] },
  ]);
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'alpha', glob: 'src/b.*' })).results.map((r) => r.file),
    ['ref/src/b.ts'],
  );
});

test("a direct mount's walks keep the cap, start where their pattern names, and say what they couldn't reach", async (t) => {
  const env = new Env(t);
  for (const name of ['1', '2', '3']) env.file(`node_modules/aaa/${name}.js`, 'x\n');
  env.file('node_modules/pkg/index.js', 'x\n');
  const m = await env.open({ walkCap: 2 });
  // The start descends into the directory the pattern names, past what the
  // cap would leave of a walk from above it.
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'node_modules/pkg/*.js' })).matches, [{ path: 'ref/node_modules/pkg/index.js', size: 2 }]);
  const capped = [
    { path: 'node_modules/aaa', reason: 'the walk cap (2) was reached before everything here was taken' },
    { path: 'node_modules/pkg', reason: 'not visited: the walk cap (2) was reached' },
  ];
  assert.deepEqual(await data(m, 'ls', { path: 'ref/node_modules', recursive: true }), {
    path: 'ref/node_modules',
    entries: [{ path: 'node_modules/aaa/1.js', size: 2 }, { path: 'node_modules/aaa/2.js', size: 2 }],
    count: 2,
    incomplete: capped,
  });
  assert.deepEqual(
    (await data<{ incomplete: unknown[] }>(m, 'grep', { pattern: 'x', path: 'ref/node_modules' })).incomplete,
    capped.map((region) => ({ ...region, path: `ref/${region.path}` })),
  );
});

test("a direct listing names a directory it couldn't list", { skip: IS_ROOT ? 'root lists every directory' : false }, async (t) => {
  const env = new Env(t);
  env.file('open/a.ts', 'a\n');
  env.file('shut/b.ts', 'b\n');
  const m = await env.open();
  chmodSync(join(env.ref, 'shut'), 0o000);
  try {
    assert.deepEqual(await data(m, 'ls', { path: 'ref', recursive: true }), {
      path: 'ref',
      entries: [{ path: 'open/a.ts', size: 2 }],
      count: 1,
      incomplete: [{ path: 'shut', reason: 'cannot list (EACCES)' }],
    });
  } finally {
    chmodSync(join(env.ref, 'shut'), 0o755);
  }
});

test("a direct mount's read and grep load no more than the size limit, and refuse a file that grows past it as it's read", async (t) => {
  const env = new Env(t);
  env.file('grows.txt', 'x'.repeat(8));
  env.file('huge.txt', 'y'.repeat(100_000));
  const m = await env.open({ maxFileSize: 10 });
  const over = (path: string) => `${path} is over the size limit (10 bytes), so read doesn't show it.`;
  // Over the limit at its open: read loads none of it, and grep its head.
  const read = await countingLoads(() => call(m, 'read', { path: 'ref/huge.txt' }));
  assert.deepEqual([read.result.error, read.loaded], [over('ref/huge.txt'), 0]);
  const grep = await countingLoads(() => call(m, 'grep', { pattern: 'y', path: 'ref/huge.txt' }));
  assert.deepEqual((grep.result.data as { skipped: unknown[] }).skipped, [{ file: 'ref/huge.txt', reason: 'over the size limit (10 bytes)', size: 100_000 }]);
  assert.equal(grep.loaded, 8192);
  // Grown past it after its open's fstat: no more than the limit and a byte.
  const grows = join(env.ref, 'grows.txt');
  const grown = await changedAfterFstat(grows, () => appendFileSync(grows, 'x'.repeat(1000)),
    () => countingLoads(() => call(m, 'read', { path: 'ref/grows.txt' })));
  assert.equal(grown.result.error, over('ref/grows.txt'));
  assert.ok(grown.loaded <= 11, `loaded ${grown.loaded}`);
  writeFileSync(grows, 'x'.repeat(8));
  const grownGrep = await changedAfterFstat(grows, () => appendFileSync(grows, 'x'.repeat(1000)),
    () => countingLoads(() => call(m, 'grep', { pattern: 'x', path: 'ref/grows.txt' })));
  assert.deepEqual((grownGrep.result.data as { skipped: unknown[] }).skipped, [{ file: 'ref/grows.txt', reason: 'over the size limit (10 bytes)', size: 1008 }]);
  assert.ok(grownGrep.loaded <= 11, `loaded ${grownGrep.loaded}`);
});

test("a direct mount's read and grep say so where reading a file fails", async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'needle\n');
  const m = await env.open();
  const failing = { read: () => async function () { throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }); } };
  assert.equal((await withFileHandle(failing, () => call(m, 'read', { path: 'ref/a.txt' }))).error, 'Unable to read file: ref/a.txt (EIO)');
  assert.deepEqual((await withFileHandle(failing, () => call(m, 'grep', { pattern: 'needle' }))).data, {
    pattern: 'needle',
    results: [],
    totalMatches: 0,
    skipped: [{ file: 'ref/a.txt', reason: 'cannot read (EIO)' }],
  });
});

test('a file gone between the walk that listed it and its read is neither listed nor searched', async (t) => {
  const env = new Env(t);
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const name of names) env.file(name, 'needle\n');
  const m = await env.open();
  const gone = join(env.ref, 'f30.txt');
  const left = names.filter((name) => name !== 'f30.txt');
  // grep reads 16 at a time, in order: the 31st file is opened only once the
  // 15th is done, so after the 2nd file's open, when it's removed.
  const grep = await changedAfterFstat(join(env.ref, 'f01.txt'), () => unlinkSync(gone),
    () => data<{ results: Array<{ file: string }>; skipped?: unknown }>(m, 'grep', { pattern: 'needle' }));
  assert.deepEqual(grep.results.map((r) => r.file), left.map((name) => `ref/${name}`));
  assert.equal(grep.skipped, undefined);
  // A listing looks at each file by its path, where this one is removed first.
  env.file('f30.txt', 'needle\n');
  const listed = await withLstat((lstat) => async (...args: any[]) => {
    if (args[0] === gone) rmSync(gone, { force: true });
    return lstat(...args);
  }, () => data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true }));
  assert.deepEqual(listed.entries.map((e) => e.path), left);
});

test('grep on a direct mount lists what it doesn\'t search, with why', async (t) => {
  const env = new Env(t);
  env.file('text.txt', 'needle\n');
  env.file('bin.dat', Buffer.concat([Buffer.from('needle'), Buffer.from([0])]));
  env.file('dot.png', PNG);
  env.file('big.txt', 'needle '.repeat(40));
  symlinkSync(join(env.ref, 'text.txt'), join(env.ref, 'link.txt'));
  const m = await env.open({ maxFileSize: 100 });
  assert.deepEqual(await data(m, 'grep', { pattern: 'needle' }), {
    pattern: 'needle',
    results: [{ file: 'ref/text.txt', version: 'disk', matches: [{ line: 1, text: 'needle' }] }],
    totalMatches: 1,
    skipped: [
      { file: 'ref/big.txt', reason: 'over the size limit (100 bytes)', size: 280 },
      { file: 'ref/bin.dat', reason: 'binary: a NUL in its first 8 KB', size: 7 },
      { file: 'ref/dot.png', reason: 'binary: a NUL in its first 8 KB', size: PNG.byteLength, mimeType: 'image/png' },
      { file: 'ref/link.txt', reason: 'a symlink, which this mount does not follow' },
    ],
  });
});

test("grep's results come in path order, however its reads finish", async (t) => {
  const env = new Env(t);
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const name of [...names].reverse()) env.file(`many/${name}`, `${name} needle\n`.repeat(1 + (names.indexOf(name) % 7) * 500));
  const m = await env.open();
  const files = (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle' })).results.map((r) => r.file);
  assert.deepEqual(files, names.map((name) => `ref/many/${name}`));
});

test("ls without a path and status give a direct mount's kind and ignore list, and a 'chronicle' mount's as before", async (t) => {
  const env = new Env(t);
  const work = join(env.root, 'work');
  mkdirSync(work);
  const m = await env.open({}, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]);
  const ignore = ['node_modules', 'dist', '.git', 'build', 'coverage', 'target', '__pycache__', '.venv'];
  assert.deepEqual((await data(m, 'ls')).mounts, [
    { name: 'ref', path: env.ref, mode: 'read-only', backend: 'direct', ignore },
    { name: 'work', path: work, mode: 'read-write' },
  ]);
  const status = await data<Record<string, Record<string, unknown>>>(m, 'status');
  assert.deepEqual(status.ref, { path: env.ref, mode: 'read-only', backend: 'direct', ignore });
  assert.deepEqual(Object.keys(status.work!).sort(), [
    'canMaterialize', 'conflicts', 'currentBranch', 'currentSeq', 'fileCount', 'initialSyncDone', 'lastMaterializedBranch',
    'lastMaterializedSeq', 'mode', 'path', 'pendingChanges', 'pendingWorkspaceDeletions', 'watch',
  ]);
  const named = await env.open({ ignore: ['vendor'] });
  assert.deepEqual((await data<Record<string, Record<string, unknown>>>(named, 'status')).ref!.ignore, ['vendor']);
});

test('sync passes over a direct mount, and says so rather than that nothing changed', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  const m = await env.open();
  const reason = "a direct mount: its tools read disk as it is, so there's nothing to take in";
  assert.deepEqual(await data(m, 'sync'), { results: [], totalSynced: 0, totalConflicts: 0, skipped: [{ mount: 'ref', path: '', reason }] });
  assert.deepEqual((await data(m, 'sync', { mount: 'ref', acceptRoot: true })).skipped, [{ mount: 'ref', path: '', reason }]);
  assert.deepEqual((await data(m, 'sync', { path: 'ref/src' })).skipped, [{ mount: 'ref', path: 'src', reason }]);
  assert.deepEqual((await data(m, 'materialize', { mount: 'ref' })).skipped, [{ mount: 'ref', reason: 'a read-only mount: materialize writes nothing to it' }]);
});

test("readBinary reads a direct mount's disk, a binary file included, up to the mount's size limit", async (t) => {
  const env = new Env(t);
  env.file('bin.dat', Buffer.from([1, 0, 2]));
  env.file('big.dat', Buffer.alloc(9));
  const m = await env.open({ maxFileSize: 8 });
  assert.deepEqual(await m.readBinary('ref/bin.dat'), { data: Buffer.from([1, 0, 2]) });
  assert.deepEqual(await m.readBinary('ref/big.dat'), { error: 'File too large: 9 > 8 bytes' });
  assert.deepEqual(await m.readBinary('ref/none.dat'), { error: 'File not found on disk: ref/none.dat' });
});

test('a direct mount reads beneath whatever directory is at its root now', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'old\n');
  // A 'chronicle' run records the root it agreed with.
  const chronicle = await env.openChronicle();
  assert.equal((await data<{ content: string }>(chronicle, 'read', { path: 'ref/a.txt' })).content, '     1\told');
  await env.close(chronicle);
  // The checkout is cloned again: another directory at the same path.
  renameSync(env.ref, join(env.root, 'ref-before'));
  env.file('a.txt', 'new\n');
  env.file('sub/x.txt', 'x\n');
  // A cap of one entry, so a search's start that the old root's identity
  // stopped short would leave its directory unvisited.
  const direct = await env.open({ walkCap: 1 });
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/a.txt' })).content, '     1\tnew');
  assert.deepEqual((await data<{ matches: unknown[] }>(direct, 'glob', { pattern: '*.txt' })).matches, [{ path: 'ref/a.txt', size: 4 }]);
  assert.deepEqual((await data<{ matches: unknown[] }>(direct, 'glob', { pattern: 'sub/*.txt' })).matches, [{ path: 'ref/sub/x.txt', size: 2 }]);
  await env.close(direct);
  // A 'chronicle' run checks the root against the one it agreed with.
  const again = await env.openChronicle();
  assert.match(JSON.stringify((await data(again, 'ls', { path: 'ref' })).incomplete), /not the directory disk last agreed with/);
});

test('a direct mount whose config sets what would never act there is refused, naming the mount and each setting', () => {
  const base: MountConfig = { name: 'ref', path: '/tmp/af-ws-direct-none', mode: 'read-only', backend: 'direct' };
  const refused = (mount: Partial<MountConfig>): string => {
    try {
      new WorkspaceModule({ mounts: [{ ...base, ...mount }] });
    } catch (err) {
      return (err as Error).message;
    }
    assert.fail(`accepted ${JSON.stringify(mount)}`);
  };
  const lead = '[workspace] Mount "ref" is direct, which reads disk as it is with no store, watcher or push: ';
  assert.equal(refused({ mode: 'read-write' }), `${lead}mode must be 'read-only', not "read-write"`);
  assert.equal(refused({ watch: 'always' }), `${lead}watch "always" would watch nothing (leave it out, or set 'never')`);
  assert.equal(refused({ watch: 'on-agent-action' }), `${lead}watch "on-agent-action" would watch nothing (leave it out, or set 'never')`);
  assert.equal(refused({ watchDebounceMs: 100 }), `${lead}watchDebounceMs would tune no watcher (leave it out)`);
  assert.equal(refused({ watchRootPollMs: 100 }), `${lead}watchRootPollMs would tune no watcher (leave it out)`);
  assert.equal(refused({ wakeOnChange: true }), `${lead}wakeOnChange would never wake (leave it out)`);
  assert.equal(refused({ wakeOnChange: ['created'] }), `${lead}wakeOnChange would never wake (leave it out)`);
  assert.equal(refused({ autoMaterialize: true }), `${lead}autoMaterialize would never push (leave it out)`);
  assert.equal(
    refused({ mode: 'read-write', autoMaterialize: true }),
    `${lead}mode must be 'read-only', not "read-write"; autoMaterialize would never push (leave it out)`,
  );
  for (const accepted of [{}, { watch: 'never' as const }, { wakeOnChange: false }, { wakeOnChange: [] }, { autoMaterialize: false }]) {
    new WorkspaceModule({ mounts: [{ ...base, ...accepted }] });
  }
  assert.throws(
    () => new WorkspaceModule({ mounts: [{ ...base, backend: 'disk' as MountConfig['backend'] }] }),
    { message: `[workspace] Mount "ref": backend must be 'chronicle' or 'direct', not "disk"` },
  );
});

test('tool descriptions mention the direct kind only on a host with a direct mount', async (t) => {
  const env = new Env(t);
  const descriptions = (m: WorkspaceModule) => Object.fromEntries(m.getTools().map((tool) => [tool.name, tool.description]));
  const chronicle = descriptions(await env.openChronicle());
  for (const [name, description] of Object.entries(chronicle)) assert.doesNotMatch(description, /\bdirect\b/, name);
  const direct = descriptions(await env.open());
  for (const name of Object.keys(chronicle)) {
    if (name === 'ls' || name === 'grep' || name === 'sync') {
      assert.ok(direct[name]!.startsWith(chronicle[name]!) && direct[name]!.length > chronicle[name]!.length, name);
      assert.match(direct[name]!, /direct mount/, name);
    } else {
      assert.equal(direct[name], chronicle[name], name);
    }
  }
});

test("a mount the store holds changes on that disk lacks runs as 'chronicle', says so, and starts direct once they're given up", async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  env.file('deleted.ts', 'kept on disk\n');
  env.file('both.ts', 'v1\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'ls', { path: 'ref' });
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await data(chronicle, 'delete', { path: 'ref/deleted.ts' });
  await data(chronicle, 'write', { path: 'ref/both.ts', content: 'v2\n' });
  env.file('both.ts', 'v3\n');
  assert.equal((await data<{ entries: Array<{ name: string; state: string }> }>(chronicle, 'ls', { path: 'ref' })).entries.find((e) => e.name === 'both.ts')!.state, 'conflict');
  await env.close(chronicle);

  const held = await env.open({ walkCap: 1 });
  assert.deepEqual(env.alerts, [{
    kind: 'workspace-mount-not-direct',
    agent: 'framework',
    message: 'Mount "ref" runs as \'chronicle\' this session, though its config makes it direct: the workspace holds changes '
      + 'there that disk lacks, which a direct mount wouldn\'t show: "ref/both.ts" (in conflict), "ref/deleted.ts" (deleted in '
      + 'the workspace), "ref/drafted.ts" (changed in the workspace). To start it direct, finish them (with the mount configured '
      + '\'chronicle\' and read-write, materialize them) or give them up (sync each path, which takes disk\'s copy); the first '
      + 'start that finds none starts it direct.',
    data: { mount: 'ref', held: 3 },
  }]);
  // As a 'chronicle' mount, unwatched, with no catch-up scan to take turns
  // with its syncs, its changes in view.
  const status = await data<Record<string, Record<string, unknown>>>(held, 'status');
  assert.equal(status.ref!.backend, undefined);
  assert.equal(status.ref!.watch, 'never');
  assert.deepEqual(watched(held), []);
  assert.equal(status.ref!.pendingChanges, 3);
  const capped = (await data<{ incomplete: Array<{ path: string; reason: string }> }>(held, 'sync')).incomplete.map((region) => region.reason);
  assert.ok(capped.some((reason) => /^the walk cap \(1\) was reached: the next sync of the mount resumes after ref\//.test(reason)), JSON.stringify(capped));
  assert.equal((await data<{ content: string }>(held, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
  assert.ok(held.getTools().every((tool) => !/\bdirect\b/.test(tool.description)));

  for (const path of ['ref/drafted.ts', 'ref/deleted.ts', 'ref/both.ts']) await data(held, 'sync', { path });
  await env.close(held);
  env.alerts = [];
  const direct = await env.open();
  assert.deepEqual(env.alerts, []);
  assert.equal((await data<Record<string, Record<string, unknown>>>(direct, 'status')).ref!.backend, 'direct');
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdisk');
});

test("the changes that keep a mount from starting direct are named ten at a time, an intent that can't be read among them", async (t) => {
  const env = new Env(t);
  const chronicle = await env.openChronicle();
  for (let i = 0; i < 11; i++) await data(chronicle, 'write', { path: `ref/d${String(i).padStart(2, '0')}.ts`, content: `${i}\n` });
  await env.close(chronicle);
  // A recorded intent whose blob the store doesn't hold.
  env.store.treeSet('workspace/ref/intent', 'aa.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });

  await env.open();
  assert.equal(env.alerts.length, 1);
  const shown = Array.from({ length: 9 }, (_, i) => `"ref/d0${i}.ts" (changed in the workspace)`).join(', ');
  assert.match(env.alerts[0]!.message, new RegExp(`disk lacks, which a direct mount wouldn't show: "ref/aa\\.ts" \\(its workspace intent can't be read\\), ${shown.replace(/[.()]/g, '\\$&')}, and 2 more\\. To start it direct`));
  assert.deepEqual(env.alerts[0]!.data, { mount: 'ref', held: 12 });
});

test("a mount that ran direct takes in what disk changed meanwhile when it runs as 'chronicle' again", async (t) => {
  const env = new Env(t);
  env.file('changed.ts', 'before\n');
  env.file('removed.ts', 'gone soon\n');
  const first = await env.openChronicle();
  assert.equal((await data<{ count: number }>(first, 'ls', { path: 'ref', recursive: true })).count, 2);
  await env.close(first);

  const direct = await env.open();
  env.file('changed.ts', 'after\n');
  unlinkSync(join(env.ref, 'removed.ts'));
  env.file('added.ts', 'new\n');
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/changed.ts' })).content, '     1\tafter');
  await env.close(direct);

  const again = await env.openChronicle();
  assert.deepEqual((await data(again, 'ls', { path: 'ref', recursive: true })).entries, [
    { path: 'added.ts', state: 'synced', size: 4 },
    { path: 'changed.ts', state: 'synced', size: 6 },
  ]);
  assert.equal((await data<{ content: string }>(again, 'read', { path: 'ref/changed.ts' })).content, '     1\tafter');
  const status = (await data<Record<string, Record<string, unknown>>>(again, 'status')).ref!;
  assert.deepEqual([status.pendingChanges, status.conflicts], [0, 0]);
});

test("a direct mount's listings pass over another mount's directory, naming the mount to use", async (t) => {
  const env = new Env(t);
  env.file('inner/x.ts', 'x\n');
  env.file('top.ts', 't\n');
  const m = await env.open({}, [{ name: 'inner', path: join(env.ref, 'inner'), mode: 'read-only', watch: 'never' }]);
  assert.deepEqual((await data(m, 'ls', { path: 'ref' })).entries, [{ name: 'top.ts', type: 'file', size: 2 }]);
  assert.deepEqual(await data(m, 'ls', { path: 'ref/inner' }), {
    path: 'ref/inner',
    entries: [],
    count: 0,
    incomplete: [{ path: 'inner', reason: 'it lies in mount "inner", nested in this one: use "inner"' }],
  });
  assert.match(await failure(m, 'read', { path: 'ref/inner/x.ts' }), /lies in mount "inner", nested in mount "ref"/);
});

test('inOrder hands each result on in order, at most `width` at once', async () => {
  const running = { now: 0, most: 0 };
  const order: number[] = [];
  const delays = [30, 5, 20, 1, 10, 2, 25, 3];
  await workspaceModule.inOrder(delays.map((_, i) => i), 3, async (i) => {
    running.now++;
    running.most = Math.max(running.most, running.now);
    await new Promise((resolve) => setTimeout(resolve, delays[i]));
    running.now--;
    return i * 10;
  }, (result, i) => {
    assert.equal(result, i * 10);
    order.push(i);
  });
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(running.most, 3);
});

test('inOrder rejects in turn for a work that rejects before its turn, leaving no rejection unhandled', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    let second!: () => void;
    const secondRejected = new Promise<void>((resolve) => { second = resolve; });
    const seen: number[] = [];
    await assert.rejects(workspaceModule.inOrder([0, 1, 2], 3, async (i) => {
      if (i === 1) {
        queueMicrotask(second);
        throw new Error('the second');
      }
      // The first finishes only after the second has rejected and a turn of
      // the event loop has passed, when Node reports a rejection unhandled.
      if (i === 0) {
        await secondRejected;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return i;
    }, (_, i) => { seen.push(i); }), { message: 'the second' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [0]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});
