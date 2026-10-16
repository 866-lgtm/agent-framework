/**
 * A create() that fails releases what it had acquired before its error reaches
 * the caller, so the caller can retry it in the same process (#389).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function recordingModule(name: string, stop: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  const module: Module = {
    name,
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); await stop(); },
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { throw new Error('No tool calls expected'); },
  };
  return { module, calls };
}

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'failed-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseConfig(storePath: string) {
  return { storePath, membrane: new MockMembrane().asMembrane(), agents: [], modules: [] as Module[],
    syncIntervalMs: 0, maintenanceIntervalMs: 0 };
}

// Two servers on one prefix: refused after the modules have started, before
// any MCPL server is spawned (the reproduction in #389).
const COLLIDING_SERVERS = [
  { id: 'first', command: process.execPath, args: ['-e', ''], toolPrefix: 'shared' },
  { id: 'second', command: process.execPath, args: ['-e', ''], toolPrefix: 'shared' },
];

test('a create() refused after its modules started stops them and frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module, calls } = recordingModule('started');
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    /toolPrefix "shared" collides with server "first"/,
  );
  assert.deepEqual(calls, ['start', 'stop']);
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a create() refused before the framework is built frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), timeZone: 'Not/AZone' }),
    /Invalid IANA time zone/,
  );
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() leaves a store the caller owns open, and stops what it started', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-create-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  t.after(() => { try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const { module, calls } = recordingModule('started');
  const { storePath: _unused, ...config } = baseConfig('');
  await assert.rejects(
    AgentFramework.create({ ...config, store, modules: [module], mcplServers: COLLIDING_SERVERS }),
    /collides with server "first"/,
  );
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(store.isClosed(), false);
  await assert.rejects(
    AgentFramework.create({ ...config, store, timeZone: 'Not/AZone' }),
    /Invalid IANA time zone/,
  );
  assert.equal(store.isClosed(), false);
  const retried = await AgentFramework.create({ ...config, store });
  await retried.stop();
});

test('a failed create() whose teardown also fails reports both, and still frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module } = recordingModule('stuck', async () => { throw new Error('the socket would not close'); });
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
      assert.match(error.message, /^AgentFramework\.create\(\) failed: MCPL server "second" toolPrefix "shared" collides with server "first"/);
      assert.match(error.message, /the socket would not close/);
      assert.match(String((error.errors[0] as Error).message), /collides with server "first"/);
      return true;
    },
  );
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() waits at most 30 s for its release, then says the release did not finish', async t => {
  const storePath = join(tempDir(t), 'store');
  let release!: () => void;
  const stopping = new Promise<void>(done => { release = done; });
  t.after(() => release());
  const { module, calls } = recordingModule('hung', () => stopping);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const rejection = AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS })
    .then(() => assert.fail('create() should fail'), (error: unknown) => error)
    .finally(() => { settled = true; });
  // The module's stop() is called once the release's deadline is armed.
  for (let turns = 0; !calls.includes('stop'); turns++) {
    assert.ok(turns < 1000, 'the release never reached the module');
    await new Promise(done => setImmediate(done));
  }
  t.mock.timers.tick(29_999);
  await new Promise(done => setImmediate(done));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  for (let turns = 0; !settled; turns++) {
    assert.ok(turns < 1000, 'create() still waits on its release after 30 s');
    await new Promise(done => setImmediate(done));
  }
  const error = await rejection;
  assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
  assert.match(error.message, /^AgentFramework\.create\(\) failed: MCPL server "second" toolPrefix "shared" collides with server "first"\. Releasing what it had started didn't finish cleanly, so part of it may still be running: Shutdown timed out after 30000 ms; pending: module:hung$/);
  t.mock.timers.reset();
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

// The watchdog's worker kills the whole process once the main thread stops
// beating for its threshold. One a failed create() left running would kill a
// process that carried on after the failure.
test('a failed create() leaves no liveness watchdog to kill the process later', async t => {
  const dir = tempDir(t);
  const script = join(dir, 'child.mjs');
  const index = pathToFileURL(join(import.meta.dirname, '../src/index.js')).href;
  const membrane = pathToFileURL(join(import.meta.dirname, 'helpers/mock-membrane.js')).href;
  writeFileSync(script, `
    import { AgentFramework } from ${JSON.stringify(index)};
    import { MockMembrane } from ${JSON.stringify(membrane)};
    const failed = await AgentFramework.create({
      storePath: ${JSON.stringify(join(dir, 'store'))}, membrane: new MockMembrane().asMembrane(),
      agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      watchdog: { enabled: true, thresholdMs: 2000, action: 'exit' },
      toolResultInlineMaxChars: 1,
    }).then(() => false, () => true);
    if (!failed) process.exit(3);
    await new Promise(done => setTimeout(done, 200));
    const end = Date.now() + 5000;
    while (Date.now() < end) {}
    process.exit(0);
  `);
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const safety = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('exit', (code, signal) => { clearTimeout(safety); resolve({ code, signal }); });
  });
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});
