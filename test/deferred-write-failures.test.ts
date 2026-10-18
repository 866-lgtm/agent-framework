/**
 * The queue of context writes deferred while quiesced, when its record can't
 * be written or the queue is over the cap: quiesce() writes the queue before
 * it changes anything and rejects when it can't, and elsewhere a write that
 * fails keeps the queue in memory with one ops alert a run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A stream that ends only when cancelled: a turn that stays alive. */
class HangingStream implements YieldingStream {
  private pendingResolve: (() => void) | null = null;
  private aborted = false;
  cancel(): void { this.aborted = true; this.pendingResolve?.(); }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.aborted) await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
  }
}
class HangingMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new HangingStream();
  }
}

interface Alert { kind: string; agentName: string; message: string; data?: Record<string, unknown> }

/** A host on a recovery file or a store only, with what it alerts and logs. */
async function withHost(
  where: 'recovery file' | 'store only',
  fn: (h: {
    framework: AgentFramework;
    membrane: HangingMembrane;
    store: JsStore | undefined;
    queuePath: string;
    hostModePath: string;
    alerts: Alert[];
    errors: string[];
    add(text: string): void;
    liveTurn(): Promise<void>;
    queued(): unknown;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deferred-write-failures-'));
  const storePath = join(dir, 'store');
  const store = where === 'store only' ? JsStore.openOrCreate({ path: storePath }) : undefined;
  const membrane = new HangingMembrane();
  const framework = await AgentFramework.create({
    ...(store ? { store } : { storePath }),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const alerts: Alert[] = [];
  (framework as unknown as { opsAlert: unknown }).opsAlert = (kind: string, agentName: string, message: string, opts?: { data?: Record<string, unknown> }) => {
    alerts.push({ kind, agentName, message, data: opts?.data });
  };
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const queuePath = join(storePath, 'recovery', 'deferred-writes.json');
  const textsOf = (pending: unknown): unknown => (Array.isArray(pending)
    ? pending.map((m: { content?: Array<{ text?: string }> }) => m.content?.[0]?.text)
    : pending);
  try {
    await fn({
      framework, membrane, store, queuePath, alerts, errors,
      hostModePath: join(storePath, 'recovery', 'host-mode.json'),
      add: (text) => {
        (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text }]);
      },
      liveTurn: async () => {
        framework.start();
        framework.nudgeAgent('agent', 'operator');
        const deadline = Date.now() + 5_000;
        while (membrane.calls.length < 1) {
          if (Date.now() > deadline) throw new Error('the turn never started');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      // The texts the record lists, or undefined when there's no record.
      queued: () => {
        if (store) {
          const raw = store.getStateJson('framework/deferred-writes') as { pending?: unknown } | unknown[] | null;
          return raw == null ? undefined : textsOf(Array.isArray(raw) ? raw : raw.pending);
        }
        return existsSync(queuePath) ? textsOf((JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: unknown }).pending) : undefined;
      },
    });
  } finally {
    console.error = consoleError;
    rmSync(queuePath, { recursive: true, force: true });
    await framework.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `body` while the store's sync fails when it follows a write of the deferred-write slot. */
async function withFailingSlotSync(body: () => Promise<void> | void): Promise<void> {
  const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
  const sync = proto.sync;
  proto.sync = function (this: JsStore) {
    if (new Error().stack?.includes('writeDeferredWritesSlot')) throw new Error('injected EIO syncing the store');
    return sync.call(this);
  };
  try {
    await body();
  } finally {
    proto.sync = sync;
  }
}

/** A text that alone puts the queue's JSON past the cap, 4 MiB counted as the string's length. */
const OVER_CAP = `big ${'x'.repeat(4 * 1024 * 1024)}`;

test('quiesce() writes a context write deferred behind a turn still alive, though its drain times out', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add('held for the turn');
    assert.equal(h.queued(), undefined, 'memory only while the host serves');
    const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(status.drained, false, 'the turn is still alive');
    assert.deepEqual(h.queued(), ['held for the turn']);
  });
});

for (const where of ['recovery file', 'store only'] as const) {
  test(`${where}: a quiesce() whose write of the queue fails rejects before it changes anything, and the next quiesce() writes the queue`, async () => {
    await withHost(where, async (h) => {
      await h.liveTurn();
      h.add('held for the turn');
      const quiesce = () => h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
      if (where === 'recovery file') {
        mkdirSync(h.queuePath, { recursive: true });
        await assert.rejects(quiesce(), { code: 'EISDIR' });
        rmSync(h.queuePath, { recursive: true });
      } else {
        await withFailingSlotSync(() => assert.rejects(quiesce(), { message: 'injected EIO syncing the store' }));
      }
      const status = h.framework.getHostModeStatus();
      assert.equal(status.quiesced, false, 'the host is still serving');
      assert.equal(status.reason, undefined);
      assert.equal(status.since, undefined);
      assert.equal(status.deferredWrites, 1, 'the write is still queued');
      if (where === 'recovery file') {
        assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
      } else {
        assert.equal((h.store!.getStateJson('framework/state') as { hostMode?: unknown } | null)?.hostMode, undefined, 'no host-mode record was written');
      }
      assert.deepEqual(h.alerts, [], 'the caller hears it, so no alert');

      await quiesce();
      assert.equal(h.framework.getHostModeStatus().quiesced, true);
      assert.deepEqual(h.queued(), ['held for the turn']);
    });
  });
}

test("a quiesce() whose record write fails after the queue's leaves the host serving with the queue written, and the next quiesce() quiesces", async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add('held for the turn');
    const proto = AgentFramework.prototype as unknown as { writeRecoveryFile(this: unknown, path: string, document: unknown): void };
    const write = proto.writeRecoveryFile;
    proto.writeRecoveryFile = function (this: unknown, path: string, document: unknown) {
      if (path.endsWith('host-mode.json')) throw Object.assign(new Error('injected EACCES writing host-mode.json'), { code: 'EACCES' });
      return write.call(this, path, document);
    };
    try {
      await assert.rejects(h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 }), { code: 'EACCES' });
    } finally {
      proto.writeRecoveryFile = write;
    }
    assert.equal(h.framework.getHostModeStatus().quiesced, false, 'the host is still serving');
    assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
    assert.deepEqual(h.queued(), ['held for the turn'], 'the queue was written first');
    await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(h.framework.getHostModeStatus().quiesced, true);
  });
});

test('a quiesce() on a quiesced host writes the queue first: one whose write fails rejects before its abandon runs, and one whose write succeeds says the record has caught up', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    mkdirSync(h.queuePath, { recursive: true });
    h.add('during surgery');
    assert.equal(h.alerts.length, 1, 'the deferral\'s failed write raised the alert');

    await assert.rejects(h.framework.quiesce({ abandon: true }), { code: 'EISDIR' });
    const status = h.framework.getHostModeStatus();
    assert.equal(status.quiesced, true);
    assert.equal(status.activeTurns, 1, 'the abandon didn\'t run');

    rmSync(h.queuePath, { recursive: true });
    // No abandon, so nothing but quiesce()'s own write can bring the record up to date.
    const after = await h.framework.quiesce();
    assert.equal(after.activeTurns, 1, 'the turn is still alive');
    assert.deepEqual(h.queued(), ['during surgery']);
    assert.ok(
      h.errors.includes(`[host-mode] ${h.queuePath} written again: it holds the queue's 1 deferred context write(s)`),
      h.errors.join('\n'),
    );
    assert.equal(h.alerts.length, 1, 'a quiesce() raises no alert of its own');
  });
});

test('a queue over the cap is refused by quiesce() before it changes anything, naming the cap and the way out', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add(OVER_CAP);
    await assert.rejects(h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 }), {
      message: `quiesce refused: the queue's 1 deferred context write(s) come to more than 4194304 characters of JSON, ` +
        `the cap, so ${h.queuePath} can't hold them, and a restart would lose them. Quiesce again once they have landed.`,
    });
    assert.equal(h.framework.getHostModeStatus().quiesced, false, 'the host is still serving');
    assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
    assert.equal(h.queued(), undefined, 'and no queue');
  });
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    h.add('small');
    h.add(OVER_CAP);
    await assert.rejects(h.framework.quiesce({ reason: 'surgery' }), {
      message: `quiesce refused: the queue's 2 deferred context write(s) come to more than 4194304 characters of JSON, ` +
        `the cap, so ${h.queuePath} can't hold them, and a restart would lose them. Resume so they land, then quiesce again.`,
    });
    assert.equal(h.framework.getHostModeStatus().quiesced, true, 'still quiesced');
    assert.deepEqual(h.queued(), ['small'], 'the record keeps what it last held');
  });
});

test('a deferral whose write fails while quiesced keeps the write in memory, raises one ops alert a run, and logs a line once a write succeeds', async () => {
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    mkdirSync(h.queuePath, { recursive: true });
    h.add('one');
    h.add('two');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 2, 'both are held');
    assert.equal(h.errors.filter((l) => l.startsWith('[host-mode] failed to persist deferred context writes:')).length, 2, 'each failure has its line');
    assert.equal(h.alerts.length, 1, 'one alert for the run');
    const [alert] = h.alerts;
    assert.equal(alert!.kind, 'deferred-writes');
    assert.equal(alert!.agentName, 'framework');
    assert.match(alert!.message, new RegExp(
      `^writing ${h.queuePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed, so a crash before a write of it succeeds ` +
      `restores what it last held, not the queue's 1 deferred context write\\(s\\): .*EISDIR`,
    ));
    assert.deepEqual(alert!.data, { record: h.queuePath, queued: 1, code: 'EISDIR' });

    rmSync(h.queuePath, { recursive: true });
    h.add('three');
    assert.deepEqual(h.queued(), ['one', 'two', 'three'], 'the next write carries the writes held in memory');
    assert.ok(
      h.errors.includes(`[host-mode] ${h.queuePath} written again: it holds the queue's 3 deferred context write(s)`),
      h.errors.join('\n'),
    );

    rmSync(h.queuePath);
    mkdirSync(h.queuePath);
    h.add('four');
    assert.equal(h.alerts.length, 2, 'a new run raises a new alert');
  });
});

test('over the cap while quiesced, the record keeps what it last held, with one ops alert and line a run', async () => {
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    h.add('small');
    h.add(OVER_CAP);
    h.add('after');
    assert.deepEqual(h.queued(), ['small'], 'nothing of the queue over the cap is written');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 3);
    const message = `the queue's 2 deferred context write(s) come to more than 4194304 characters of JSON, the cap, ` +
      `so ${h.queuePath} isn't written, and a crash before the queue is under the cap and written restores what it last held`;
    assert.deepEqual(h.alerts, [{
      kind: 'deferred-writes',
      agentName: 'framework',
      message,
      data: { record: h.queuePath, queued: 2, cap: 4 * 1024 * 1024 },
    }]);
    assert.deepEqual(h.errors.filter((l) => l.includes('the cap')), [`[host-mode] ${message}`], 'its line, once');
  });
});

for (const cause of ['a failed write', 'the cap'] as const) {
  test(`when the first write of a quiesce is lost to ${cause}, the queue stays mirrored, and resume's writes bring the record up to date`, async () => {
    await withHost('recovery file', async (h) => {
      await h.framework.quiesce({ reason: 'surgery' });
      if (cause === 'a failed write') {
        mkdirSync(h.queuePath, { recursive: true });
        h.add('held');
        rmSync(h.queuePath, { recursive: true });
      } else {
        h.add(OVER_CAP);
      }
      assert.equal(h.alerts.length, 1);
      assert.equal(h.queued(), undefined, 'no record yet');
      await h.framework.resume();
      assert.deepEqual(h.queued(), [], 'the record is cleared once the queue lands');
      assert.ok(h.errors.some((l) => l.startsWith(`[host-mode] ${h.queuePath} written again:`)), h.errors.join('\n'));
    });
  });
}

test('store only, a deferral while quiesced syncs the store after the slot\'s write, and a sync that fails is a failed write', async () => {
  await withHost('store only', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
    const sync = proto.sync;
    let syncs = 0;
    proto.sync = function (this: JsStore) { syncs++; return sync.call(this); };
    try {
      h.add('one');
    } finally {
      proto.sync = sync;
    }
    assert.equal(syncs, 1, 'the slot\'s write is synced');
    assert.deepEqual(h.queued(), ['one']);

    await withFailingSlotSync(() => h.add('two'));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]!.message,
      "writing the store's framework/deferred-writes slot failed, so a crash before a write of it succeeds restores " +
      "what it last held, not the queue's 2 deferred context write(s): injected EIO syncing the store");
    assert.deepEqual(h.alerts[0]!.data, { record: "the store's framework/deferred-writes slot", queued: 2 });
  });
});
