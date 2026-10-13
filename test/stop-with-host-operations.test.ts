/**
 * stop() with an operator's operation still running.
 *
 * stop() refuses a host/command that arrives once it has begun. These tests
 * cover the operations admitted before that: a quiesce draining, a resume, a
 * host/command, a store surgery and an awareness sync, whether they came over
 * MCPL or from a direct call. stop() waits for each before it tears down what
 * it uses: the event gate, the modules, the MCPL connections and the store.
 * A quiesce stops waiting for its drain, and a resume that hasn't committed
 * refuses, so the wait stays short and the host boots in the mode it had.
 *
 * Where a test holds an operation open, it lets it go once stop() reaches its
 * modules' teardown, or after a short while if stop() is waiting short of it.
 * The order of the two events is the verdict, so it doesn't depend on timing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** Resolve once `cond` holds; fail, naming `what`, after `ms`. */
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Records when stop() reaches its modules' teardown, which comes after its wait for operations. */
class TeardownProbe implements Module {
  readonly name = 'teardown-probe';
  constructor(private readonly order: string[]) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> { this.order.push('modules stopped'); }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(): Promise<EventResponse> { return {}; }
}

/** The private state these tests set up or hold. */
interface Internals {
  activeTurnTokens: Map<string, number>;
  maintenancePass: Promise<unknown> | null;
  mcplServerRegistry: unknown;
  beginDiscordAwarenessBarrier: () => { requiresBarrier: boolean; promise: Promise<unknown> };
  wireMcplEvents(connection: unknown): void;
}
const internals = (framework: AgentFramework): Internals => framework as unknown as Internals;

describe('stop() with an operator operation in flight', () => {
  let tempDir: string;
  let storePath: string;
  let logged: string[];
  let rejections: unknown[];
  let order: string[];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  const consoleError = console.error;
  const consoleWarn = console.warn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'af-stop-host-ops-'));
    storePath = join(tempDir, 'store');
    logged = [];
    rejections = [];
    order = [];
    process.on('unhandledRejection', onRejection);
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.error = consoleError;
    console.warn = consoleWarn;
    process.off('unhandledRejection', onRejection);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function create(): Promise<AgentFramework> {
    return AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [new TeardownProbe(order)],
    });
  }

  /** Let the held operation go once stop() reaches its modules, or after 300 ms if it waits short of them. */
  async function releaseWhenStopWaits(release: () => void): Promise<void> {
    const deadline = Date.now() + 300;
    while (!order.includes('modules stopped') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    release();
  }

  async function bootsQuiesced(): Promise<boolean> {
    const restarted = await create();
    try {
      return restarted.getHostModeStatus().quiesced;
    } finally {
      await restarted.stop();
    }
  }

  it('a quiesce waiting for its drain stops waiting when stop() begins, and stop() waits for it', { timeout: 20_000 }, async () => {
    const framework = await create();
    framework.start();
    // A turn between dequeue and stream registration holds its token with no
    // stream to cancel, so nothing but stop() can end this drain.
    const tokens = internals(framework).activeTurnTokens;
    tokens.set('agent', -1);
    let settled = false;
    const quiescing = framework.quiesce({ reason: 'surgery', timeoutMs: 600_000 });
    void quiescing.then(() => { settled = true; }, () => { settled = true; });
    try {
      await framework.stop();
      assert.equal(settled, true, 'stop() returned while the quiesce was still waiting');
      const status = await quiescing;
      assert.equal(status.quiesced, true);
      assert.equal(status.drained, false);
      assert.ok(logged.some((line) => line.includes('quiesce stopped waiting for its drain: the framework is stopping')), logged.join('\n'));
    } finally {
      tokens.delete('agent');
      await quiescing.catch(() => {});
    }
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
    assert.deepEqual(rejections, []);
  });

  it("an abandon waiting on a turn it can't cancel stops waiting when stop() begins, and stop() waits for it", { timeout: 20_000 }, async () => {
    const framework = await create();
    framework.start();
    const tokens = internals(framework).activeTurnTokens;
    tokens.set('agent', -1);
    let settled = false;
    const quiescing = framework.quiesce({ timeoutMs: 1_000, abandon: true });
    void quiescing.then(() => { settled = true; }, () => { settled = true; });
    try {
      // After its one-second window, abandon finds no stream to cancel and
      // gives the turn ten seconds to settle on its own.
      await until(() => logged.some((line) => line.includes('cannot abandon turn for agent')), 'abandon to find the held token');
      const began = Date.now();
      await framework.stop();
      const took = Date.now() - began;
      assert.equal(settled, true, 'stop() returned while the abandon was still waiting');
      assert.ok(took < 5_000, `stop() took ${took} ms, waiting out the abandon's ten seconds`);
      assert.deepEqual((await quiescing).unabandonable, ['agent']);
    } finally {
      tokens.delete('agent');
      await quiescing.catch(() => {});
    }
    assert.deepEqual(rejections, []);
  });

  it('a resume waiting when stop() begins refuses, and the host stays quiesced', async () => {
    const framework = await create();
    framework.start();
    await framework.quiesce({ reason: 'surgery' });
    // resume() waits for a running maintenance pass before its feasibility
    // gate, and so does stop(): both go on when the pass ends.
    let endPass!: () => void;
    internals(framework).maintenancePass = new Promise<void>((resolve) => { endPass = resolve; });
    const resuming = framework.resume();
    const stopping = framework.stop();
    endPass();
    await assert.rejects(resuming, /^Error: resume refused: the framework is stopping, so the host stays quiesced$/);
    await stopping;
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
    assert.deepEqual(rejections, []);
  });

  it('a quiesce called after stop() is refused, and persists nothing', async () => {
    const framework = await create();
    await framework.stop();
    await assert.rejects(framework.quiesce({ reason: 'too late' }), /^Error: quiesce refused: the framework is stopping$/);
    assert.equal(await bootsQuiesced(), false, 'the host boots serving');
  });

  it('a resume called after stop() is refused, and the host stays quiesced', async () => {
    const framework = await create();
    await framework.quiesce();
    await framework.stop();
    await assert.rejects(framework.resume(), /^Error: resume refused: the framework is stopping, so the host stays quiesced$/);
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
  });

  it('stop() waits for a resume past its commit point, and a reopen that fails recycles no connection', async () => {
    const framework = await create();
    const connection = {
      id: 'srv',
      recycled: 0,
      pauseDataPlane(): void {},
      readyControlPlane(): void {},
      ready(): void {},
      async reconnectAfterFailure(): Promise<void> { this.recycled++; },
    };
    const fw = internals(framework);
    fw.mcplServerRegistry = { getAllServers: () => [connection], closeAll: async () => {} };
    framework.start();
    await framework.quiesce();
    // The reopen waits on the awareness barrier, which fails while stop() waits.
    let failBarrier: ((error: Error) => void) | undefined;
    fw.beginDiscordAwarenessBarrier = () => ({
      requiresBarrier: true,
      promise: new Promise((_, reject) => { failBarrier = reject; }),
    });
    const resuming = framework.resume().then((status) => { order.push('resume settled'); return status; });
    await until(() => failBarrier !== undefined, 'the resume to reach its reopen');
    const stopping = framework.stop();
    await releaseWhenStopWaits(() => failBarrier!(new Error('the awareness drain failed')));
    await stopping;
    assert.deepEqual(order, ['resume settled', 'modules stopped']);
    assert.equal((await resuming).quiesced, false, 'past its commit point the resume completes');
    assert.equal(connection.recycled, 0, 'a stopping host recycles no connection');
    assert.equal(await bootsQuiesced(), false, 'its durable clear landed');
    assert.deepEqual(rejections, []);
  });

  it("stop() waits for a host/command, so its answer goes out before the connections close", async () => {
    const framework = await create();
    const connection = Object.assign(new EventEmitter(), { id: 'srv' });
    internals(framework).wireMcplEvents(connection);
    const cm = framework.getAgent('agent')!.getContextManager();
    for (const n of [1, 2]) {
      cm.addMessage('user', [{ type: 'text', text: `m${n}` }], { serverId: 'srv', channelId: 'discord:g1:c1', messageId: `d${n}` });
    }
    // hide's answer carries a preview of what the agent sees now; hold it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const preview = framework.previewActivation.bind(framework);
    let previewing = false;
    framework.previewActivation = (async (...args: Parameters<AgentFramework['previewActivation']>) => {
      previewing = true;
      await held;
      return preview(...args);
    }) as AgentFramework['previewActivation'];
    const answers: unknown[] = [];
    connection.emit('host-command', { command: 'hide', agentName: 'agent', fromMessageId: 'd1' }, {
      id: 7,
      respond: (result: unknown) => { answers.push(result); order.push('host/command answered'); },
      respondError: (code: number, message: string) => { answers.push({ code, message }); order.push('host/command answered'); },
    });
    await until(() => previewing, 'hide to reach its preview');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    await stopping;
    assert.deepEqual(order, ['host/command answered', 'modules stopped']);
    assert.equal((answers[0] as { ok?: boolean; hidden?: number }).ok, true, JSON.stringify(answers));
    assert.equal((answers[0] as { hidden?: number }).hidden, 1);
    assert.deepEqual(rejections, []);
  });

  it('stop() waits for a store surgery to release the store', async () => {
    const framework = await create();
    const cm = framework.getAgent('agent')!.getContextManager();
    const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: `m${n}` }]));
    // The rollback syncs awareness markers while it holds the store; hold that.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let syncing = false;
    framework.syncDiscordAwarenessMarkers = async () => {
      syncing = true;
      await held;
      order.push('markers synced');
    };
    const rolling = framework.rollbackToMessage('agent', { messageId: ids[0]! });
    await until(() => syncing, 'the rollback to reach its marker sync');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    await stopping;
    assert.deepEqual(order, ['markers synced', 'modules stopped']);
    assert.equal((await rolling).messagesRemoved, 2);
    assert.deepEqual(rejections, []);
  });

  it("stop() waits for an awareness sync, which an operator's undo or branch switch runs", async () => {
    const framework = await create();
    let deliver!: () => void;
    internals(framework).beginDiscordAwarenessBarrier = () => ({
      requiresBarrier: true,
      promise: new Promise((resolve) => {
        deliver = () => resolve({ status: 'delivered', delivered: 1, failed: 0 });
      }),
    });
    const syncing = framework.syncDiscordAwarenessMarkers().then(() => { order.push('awareness synced'); });
    await until(() => deliver !== undefined, 'the sync to wait on its barrier');
    const stopping = framework.stop();
    await releaseWhenStopWaits(() => deliver());
    await stopping;
    await syncing;
    assert.deepEqual(order, ['awareness synced', 'modules stopped']);
    assert.deepEqual(rejections, []);
  });

  it("an operation that outlasts stop()'s budget fails the stop and keeps the store open for a retry", async () => {
    const framework = await create();
    let deliver: (() => void) | undefined;
    internals(framework).beginDiscordAwarenessBarrier = () => ({
      requiresBarrier: true,
      promise: new Promise((resolve) => {
        deliver = () => resolve({ status: 'delivered', delivered: 1, failed: 0 });
      }),
    });
    const syncing = framework.syncDiscordAwarenessMarkers();
    await until(() => deliver !== undefined, 'the sync to wait on its barrier');
    await assert.rejects(
      framework.stop(100),
      (error: unknown) => error instanceof ShutdownTimeoutError
        && error.pending.includes('awareness:sync')
        && /^Shutdown timed out after 100 ms; pending: awareness:sync$/.test(error.message),
    );
    assert.equal(framework.getStore().isClosed(), false, 'the operation may still write');
    deliver!();
    await syncing;
    await framework.stop();
    assert.equal(framework.getStore().isClosed(), true);
    assert.deepEqual(rejections, []);
  });
});
