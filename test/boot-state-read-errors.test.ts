/**
 * At boot, a stored state that can't be read, or that reads as something this
 * code doesn't read as that state, is a refusal that names it, not an empty
 * state. Taken as empty, each was lost or ignored: a quiesced host booted
 * serving and landed its deferred writes mid-surgery; a deferred-write queue
 * restored nothing and the next deferral replaced it; a deferred write that
 * had landed before its ack landed again when an agent's context couldn't be
 * scanned; usage totals started at zero and the next inference stored zeros
 * over them; an agent's settings booted at its recipe's and the next change
 * stored over the record; coalesced work acknowledged before a crash was never
 * delivered, and the next receipt or flush replaced what was stored. Each
 * refusal leaves the state as it was, so the next boot that can read it
 * restores it. The inline caps' failed read loses nothing, since setting a cap
 * reads them again, so it is logged and boot goes on. Nothing stored still
 * reads as empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fixture, crash } from './helpers/coalescing-fixture.js';
import { rejectsBuild } from './helpers/failed-create.js';
import { isStateExistsError } from '../src/module-registry.js';

/** An I/O error from a store read of `stateId` by the framework's `reader`,
 *  `times` times, as a failing disk would give. */
function failStoreRead(stateId: string, reader: string, times = 1): () => void {
  const proto = JsStore.prototype as unknown as { getStateJson(this: JsStore, id: string): unknown };
  const original = proto.getStateJson;
  let left = times;
  proto.getStateJson = function (this: JsStore, id: string) {
    if (id === stateId && left > 0 && new Error().stack?.includes(reader)) {
      left--;
      throw Object.assign(new Error(`injected EIO reading ${id}`), { code: 'EIO' });
    }
    return original.call(this, id);
  };
  return () => { proto.getStateJson = original; };
}

/** An I/O error from the next read of the recovery file whose path ends in `name`. */
function failRecoveryRead(name: string): () => void {
  const proto = AgentFramework.prototype as unknown as { readRecoveryFile(path: string): unknown };
  const original = proto.readRecoveryFile;
  let left = 1;
  proto.readRecoveryFile = function (this: unknown, path: string) {
    if (path.endsWith(name) && left > 0) {
      left--;
      throw Object.assign(new Error(`injected EIO reading ${name}`), { code: 'EIO' });
    }
    return original.call(this, path);
  };
  return () => { proto.readRecoveryFile = original; };
}

function quietErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

const agents = [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }];
const config = (storePath: string): FrameworkConfig =>
  ({ storePath, membrane: new MockMembrane().asMembrane(), agents, modules: [] }) as unknown as FrameworkConfig;
const texts = (f: AgentFramework): string[] =>
  f.getAgent('agent')!.getContextManager().getAllMessages().map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '');

/** A store directory removed after `body`, which receives its storePath. */
function inStoreDir(prefix: string, body: (storePath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try { await body(join(dir, 'store')); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Write `framework/state` while no framework holds the store. */
function seedFrameworkState(storePath: string, state: Record<string, unknown>): void {
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    try {
      store.registerState({ id: 'framework/state', strategy: 'snapshot' });
    } catch (error) {
      if (!isStateExistsError(error)) throw error;
    }
    store.setStateJson('framework/state', state);
  } finally { store.close(); }
}
function readState(storePath: string, stateId: string): unknown {
  const store = JsStore.openOrCreate({ path: storePath });
  try { return store.getStateJson(stateId); } finally { store.close(); }
}

/** Quiesce with one write deferred, and stop. */
async function quiescedWithAWrite(storePath: string, text = 'said during surgery'): Promise<void> {
  const f = await AgentFramework.create(config(storePath));
  try {
    await f.quiesce({ reason: 'surgery' });
    (f as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text }]);
  } finally { await f.stop(); }
}

// ---------------------------------------------------------------------------
// Host mode
// ---------------------------------------------------------------------------

test("a host-mode file that can't be read fails create(), and the next boot is quiesced with its writes", inStoreDir('boot-read-hostmode-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'host-mode.json');
  const before = readFileSync(file, 'utf8');
  const restore = failRecoveryRead('host-mode.json');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the host mode \\(${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\) could not be read: injected EIO reading host-mode\\.json\\. ` +
      `The framework doesn't start without it, since a host quiesced for maintenance would boot serving\\. ` +
      `The file is unchanged; the framework starts once it can be read, or without it once it's moved aside\\.$`,
    ));
  } finally { restore(); }
  assert.equal(readFileSync(file, 'utf8'), before, 'the file is as it was');
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().quiesced, true);
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
    assert.ok(!texts(f).includes('said during surgery'), 'the deferred write waits for resume');
  } finally { await f.stop(); }
}));

test('a host-mode file that holds no record, or one whose quiesced is not a boolean, fails create(), naming what it holds', inStoreDir('boot-read-hostmode-form-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'host-mode.json');
  for (const [content, holds] of [
    ['["quiesced"]', 'holds an array, not a host-mode record'],
    ['null', 'holds null, not a host-mode record'],
    ['{"version":1,"quiesced":"yes"}', 'is a record whose quiesced is a string, not true or false'],
    ['{"version":1}', 'is a record whose quiesced is missing, not true or false'],
  ] as const) {
    writeFileSync(file, content);
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the host mode \\(.*host-mode\\.json\\) ${holds.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\. The framework doesn't start without it`,
    ), content);
    assert.equal(readFileSync(file, 'utf8'), content, `${content}: the file is as it was`);
  }
}));

test("with no recovery file, a host mode that can't be read from framework/state fails create()", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-read-hostmode-slot-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  // A store passed in, with no recovery paths, keeps host mode in framework/state.
  const slotConfig = () => ({ store, membrane: new MockMembrane().asMembrane(), agents, modules: [] }) as unknown as FrameworkConfig;
  try {
    const first = await AgentFramework.create(slotConfig());
    await first.quiesce({ reason: 'surgery' });
    await first.stop();
    const restore = failStoreRead('framework/state', 'readHostMode');
    try {
      await rejectsBuild(() => AgentFramework.create(slotConfig()), /^the host mode \(framework\/state, hostMode\) could not be read: injected EIO reading framework\/state\. The framework doesn't start without it, since a host quiesced for maintenance would boot serving\. It's unchanged, and the framework starts once it can be read\.$/);
    } finally { restore(); }
    const f = await AgentFramework.create(slotConfig());
    try { assert.equal(f.getHostModeStatus().quiesced, true); } finally { await f.stop(); }
    store.setStateJson('framework/state', { ...(store.getStateJson('framework/state') as object), hostMode: 'quiesced' });
    await rejectsBuild(() => AgentFramework.create(slotConfig()), /^the host mode \(framework\/state, hostMode\) holds a string, not a host-mode record\./);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deferred writes
// ---------------------------------------------------------------------------

test("a deferred-write queue that can't be read fails create(), and the next boot lands its writes at resume", inStoreDir('boot-read-deferred-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'deferred-writes.json');
  const before = readFileSync(file, 'utf8');
  const restore = failRecoveryRead('deferred-writes.json');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the deferred context writes \(.*deferred-writes\.json\) could not be read: injected EIO reading deferred-writes\.json\. The framework doesn't start without them, since the next deferral would replace the stored queue\. The file is unchanged; the framework starts once it can be read, or without those writes once it's moved aside\.$/);
  } finally { restore(); }
  assert.equal(readFileSync(file, 'utf8'), before, 'the queue is as it was');
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
    await f.resume();
    assert.deepEqual(texts(f).filter((t) => t === 'said during surgery').length, 1);
  } finally { await f.stop(); }
}));

test("a deferred-write queue that isn't a queue fails create(), naming what it holds", inStoreDir('boot-read-deferred-form-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'deferred-writes.json');
  for (const [content, holds] of [
    ['"pending"', 'hold a string, not a queue of writes'],
    ['{"version":2,"pending":{"0":{}}}', 'hold an object whose pending is an object, not a list of writes'],
    ['{"version":2}', 'hold an object whose pending is missing, not a list of writes'],
  ] as const) {
    writeFileSync(file, content);
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the deferred context writes \\(.*deferred-writes\\.json\\) ${holds}\\. The framework doesn't start without them`,
    ), content);
    assert.equal(readFileSync(file, 'utf8'), content, `${content}: the file is as it was`);
  }
}));

test("a deferred write whose agent's context can't be scanned fails create(), and the next boot doesn't land it twice", inStoreDir('boot-read-deferred-landed-', async (storePath) => {
  // A write that landed before its ack: in the queue, and in the context with its id.
  await quiescedWithAWrite(storePath);
  const [queued] = JSON.parse(readFileSync(join(storePath, 'recovery', 'deferred-writes.json'), 'utf8')).pending as Array<{ id: string }>;
  const staging = await AgentFramework.create(config(storePath));
  try {
    staging.getAgent('agent')!.getContextManager()
      .addMessage('user', [{ type: 'text', text: 'said during surgery' }], { deferredWriteId: queued!.id } as never);
  } finally { await staging.stop(); }
  const proto = ContextManager.prototype as unknown as { getMessageCount(this: ContextManager): number };
  const original = proto.getMessageCount;
  proto.getMessageCount = function (this: ContextManager) {
    if (new Error().stack?.includes('landedDeferredWriteIds')) throw new Error('injected EIO scanning the context');
    return original.call(this);
  };
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the deferred context writes \(.*deferred-writes\.json\) can't be checked for writes that already landed: agent's context could not be read: injected EIO scanning the context\. The framework doesn't start without that check, since a write that landed before its ack would land a second time\. The queue is unchanged, and the framework starts once that context can be read\.$/);
  } finally { proto.getMessageCount = original; }
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().deferredWrites, 0, 'the landed write is skipped');
    await f.resume();
    assert.equal(texts(f).filter((t) => t === 'said during surgery').length, 1, 'it is in the context once');
  } finally { await f.stop(); }
}));

// ---------------------------------------------------------------------------
// Usage totals
// ---------------------------------------------------------------------------

const storedUsage = {
  totals: { inputTokens: 1000, outputTokens: 500 },
  inferenceCount: 7,
  byAgent: [{ agentName: 'agent', usage: { inputTokens: 1000, outputTokens: 500 }, inferenceCount: 7 }],
};

test("usage totals that can't be read fail create(), and the next boot restores them", inStoreDir('boot-read-usage-', async (storePath) => {
  seedFrameworkState(storePath, { usage: storedUsage });
  const restore = failStoreRead('framework/state', 'restoreUsageState');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the usage totals \(framework\/state, usage\) could not be read: injected EIO reading framework\/state\. The framework doesn't start without them, since the next inference would store fresh totals over them\. They're unchanged, and the framework starts once they can be read\.$/);
  } finally { restore(); }
  assert.deepEqual((readState(storePath, 'framework/state') as { usage: unknown }).usage, storedUsage);
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getSessionUsage().totals.inputTokens, 1000);
    assert.equal(f.getSessionUsage().totals.outputTokens, 500);
  } finally { await f.stop(); }
}));

test("usage totals that aren't token counts fail create(), naming what they are", inStoreDir('boot-read-usage-form-', async (storePath) => {
  for (const [usage, are] of [
    [{ totals: 'lots' }, 'are an object without token counts'],
    [[storedUsage], 'are an array, not token counts'],
  ] as const) {
    seedFrameworkState(storePath, { usage });
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(`^the usage totals \\(framework/state, usage\\) ${are}\\. The framework doesn't start without them`), JSON.stringify(usage));
    assert.deepEqual((readState(storePath, 'framework/state') as { usage: unknown }).usage, usage);
  }
}));

// ---------------------------------------------------------------------------
// Inline caps
// ---------------------------------------------------------------------------

test("inline caps that can't be read are logged, boot goes on, and setting one keeps the others stored", inStoreDir('boot-read-caps-', async (storePath) => {
  seedFrameworkState(storePath, { toolResultInlineCaps: { agent: 5000 } });
  const twoAgents = { ...config(storePath), agents: [...agents, { name: 'other', model: 'test-model', systemPrompt: 'test' }] } as FrameworkConfig;
  const restore = failStoreRead('framework/state', 'readPersistedToolResultInlineCaps');
  const log = quietErrors();
  let f: AgentFramework;
  try {
    f = await AgentFramework.create(twoAgents);
  } finally { restore(); log.restore(); }
  try {
    assert.ok(
      log.lines.some((l) => l.includes(
        "[agent-settings] the persisted tool_result_inline_max_chars caps (framework/state) could not be read: injected EIO reading framework/state; they don't apply until a restart, and setting one keeps the others stored",
      )),
      log.lines.join('\n'),
    );
    const settings = (f as unknown as {
      collectAgentSettingsExtensions(): Map<string, {
        get(agentName: string): Record<string, unknown>;
        update(agentName: string, patch: Record<string, unknown>): unknown;
      }>;
    }).collectAgentSettingsExtensions().get('_framework')!;
    assert.equal(settings.get('agent').tool_result_inline_max_chars, null, "the stored cap doesn't apply");
    settings.update('other', { tool_result_inline_max_chars: 2000 });
  } finally { await f.stop(); }
  assert.deepEqual((readState(storePath, 'framework/state') as { toolResultInlineCaps: unknown }).toolResultInlineCaps, { agent: 5000, other: 2000 });
}));

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test("coalescing receipts that can't be read fail create(), and the next boot delivers the acknowledged work", async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'accepted_before_crash', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f);
  const restore = failStoreRead('mcpl/coalescing-recent', 'initializePushCoalescer');
  try {
    await rejectsBuild(() => f.create(), /^the coalescing receipts since the last snapshot \(mcpl\/coalescing-recent\) could not be read: injected EIO reading mcpl\/coalescing-recent\. MCPL doesn't start without them, since the next coalesced push or message would replace them\. They're unchanged, and MCPL starts once they can be read\.$/);
  } finally { restore(); }
  await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, original.result, 'the receipt survived');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the accepted work was delivered');
  assert.ok(f.lastRequest().includes('accepted_before_crash'));
});

test("a coalescing snapshot that can't be read fails create(), and the next boot renders its batch", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'pending_before_crash', { deferred: true }));
  (f.framework as unknown as { flushCoalescingSnapshot(): void }).flushCoalescingSnapshot();
  await crash(f);
  const restore = failStoreRead('mcpl/coalescing', 'initializePushCoalescer');
  try {
    await rejectsBuild(() => f.create(), /^the coalescing receipts and batches \(mcpl\/coalescing\) could not be read: injected EIO reading mcpl\/coalescing\. MCPL doesn't start without them/);
  } finally { restore(); }
  await f.create();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'the restored batch was rendered');
  assert.ok(f.lastRequest().includes('document_diff'));
});

test("coalescing state this code doesn't read fails create(), naming what it is, and is left as it was", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'pending', { deferred: true }));
  (f.framework as unknown as { flushCoalescingSnapshot(): void }).flushCoalescingSnapshot();
  await crash(f);
  const storePath = join(f.dir, 'store');
  const snapshot = readState(storePath, 'mcpl/coalescing') as Record<string, unknown>;
  const cases: Array<[string, string, unknown, string]> = [
    ['a version 2 snapshot', 'mcpl/coalescing', { ...snapshot, version: 2 }, "receipts and batches \\(mcpl/coalescing\\) are a version 2 snapshot, which this version of agent-framework doesn't read\\. MCPL doesn't start without them, since the next coalesced push or message would replace them\\. They're unchanged, and the version that wrote them reads them\\.$"],
    ['a snapshot with no version', 'mcpl/coalescing', { receipts: [], subjects: [] }, 'receipts and batches \\(mcpl/coalescing\\) are an object with no snapshot version\\.'],
    ['a snapshot that is an array', 'mcpl/coalescing', [snapshot], 'receipts and batches \\(mcpl/coalescing\\) are an array with no snapshot version\\.'],
    ['a snapshot restore throws on', 'mcpl/coalescing', { ...snapshot, subjects: 5 }, 'receipts and batches \\(mcpl/coalescing\\) could not be restored: .*\\. MCPL doesn\'t start'],
    ['receipts that are an object', 'mcpl/coalescing-recent', { 0: 'receipt' }, 'receipts since the last snapshot \\(mcpl/coalescing-recent\\) are an object, not a list of receipts\\.'],
    ['receipts restoreReceipts throws on', 'mcpl/coalescing-recent', [null], 'receipts since the last snapshot \\(mcpl/coalescing-recent\\) could not be restored: .*\\. MCPL doesn\'t start'],
  ];
  for (const [name, stateId, value, says] of cases) {
    const store = JsStore.openOrCreate({ path: storePath });
    const previous = store.getStateJson(stateId);
    store.setStateJson(stateId, value);
    store.close();
    await rejectsBuild(() => f.create(), new RegExp(`^the coalescing ${says}`), name);
    assert.deepEqual(readState(storePath, stateId), value, `${name}: left as it was`);
    const reset = JsStore.openOrCreate({ path: storePath });
    reset.setStateJson(stateId, previous);
    reset.close();
  }
});

test("at a runtime connect, coalescing receipts that can't be read fail the connect, and the next connect restores them", async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'accepted_before_crash', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f);
  // With no MCPL servers configured, the subsystem comes up at the first connect.
  const framework = await AgentFramework.create({
    storePath: join(f.dir, 'store'), membrane: f.membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
  } as unknown as FrameworkConfig);
  try {
    const server = { id: 'editor', url: `ws://127.0.0.1:${f.port}`, enabledFeatureSets: ['doc'] } as McplServerConfig;
    const restore = failStoreRead('mcpl/coalescing-recent', 'initializePushCoalescer');
    try {
      await assert.rejects(framework.connectMcplServer(server), {
        message: /^the coalescing receipts since the last snapshot \(mcpl\/coalescing-recent\) could not be read: injected EIO reading mcpl\/coalescing-recent\. MCPL doesn't start without them/,
      });
    } finally { restore(); }
    await framework.connectMcplServer(server);
    const retry = await f.send('push/event', params);
    assert.deepEqual(retry.result, original.result, 'the receipt survived the refused connect');
  } finally { await framework.stop(); }
});

test('nothing stored reads as empty: a first boot starts serving, with no usage, deferred writes or coalescing history', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.equal(f.framework.getHostModeStatus().quiesced, false);
  assert.equal(f.framework.getHostModeStatus().deferredWrites, 0);
  assert.equal(f.framework.getSessionUsage().totals.inputTokens, 0);
  const first = await f.send('push/event', f.params('1', 'first', { deferred: true }));
  assert.ok(first.result, 'a push is accepted');
});
