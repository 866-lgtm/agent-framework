/**
 * A message a tune-out holds from the residents stays out of their windows,
 * and a module's reads mark it (ModuleMessage.heldFromResidents). Such a
 * message is stored with `metadata.tuneOut` and no resident's compiled view
 * shows it. A module's context answered it as an ordinary row, so a module
 * that keeps to what the residents see by leaving out `held` rows still took
 * it in, and a tool boundary of a turn alive when it arrived injected it into
 * that turn. The channel and its traffic come from test/tune-out-e2e.test.ts's
 * MCPL fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { MessageQuery } from '@animalabs/context-manager';
import type { EventResponse, Module, ModuleContext, ModuleMessage, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

class ProbeModule implements Module {
  readonly name = 'probe';
  ctx: ModuleContext | null = null;
  /** What the `wait` tool waits for, and what it calls as it starts. */
  hold: Promise<void> = Promise.resolve();
  onWait: () => void = () => {};
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the test', inputSchema: { type: 'object', properties: {} } }];
  }
  /** Keeps the resident's turn alive, with its round's tool pending, until the test lets it go. */
  async handleToolCall(): Promise<ToolResult> {
    this.onWait();
    await this.hold;
    return { success: true, data: { ok: true } };
  }
  /** A test's external message wakes the resident. */
  async onProcess(event: { type: string; source?: string }): Promise<EventResponse> {
    if (event.type !== 'external-message' || event.source !== 'test') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
  }
}

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: {
    listChannelsRaw(): unknown[];
    getDesiredState(serverId: string, channelId: string): string | undefined;
  } | null;
}

const textOf = (m: { content: ContentBlock[] }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

async function within<T>(what: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Rig {
  framework: AgentFramework;
  ctx: ModuleContext;
  module: ProbeModule;
  membrane: MockMembrane;
  internals: Internals;
  /** An ambient message in the tuned-out channel. */
  emit(id: string, text: string): void;
  close(): Promise<void>;
}

/** A framework with a subconscious, the fixture's channel tuned out, and a
 *  module whose context the test reads through. Each test opens its own, so
 *  no reply one test queues on the mock reaches another's turn. */
async function open(): Promise<Rig> {
  const tempDir = mkdtempSync(join(tmpdir(), 'module-rows-held-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const module = new ProbeModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{
      id: 'disc',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [module],
  });
  const close = async (): Promise<void> => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    await framework.start();
    const internals = framework as unknown as Internals;
    await waitFor('channel registration', () => (internals.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    const entered = internals.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok, 'the channel is tuned out');
    return {
      framework,
      ctx: module.ctx!,
      module,
      membrane,
      internals,
      emit: (id, text) => appendFileSync(commandPath, `ambient ${id} ${text}\n`),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const rowWith = (rows: ModuleMessage[], text: string): ModuleMessage | undefined =>
  rows.find((m) => textOf(m).includes(text));

describe('a message a tune-out holds stays out of the windows, and a module reads it as heldFromResidents', () => {
  it('marks a stored held message in queryMessages and getMessage, during the tune-out and after the cancel, and leaves an ordinary row unmarked', async () => {
    const { framework, ctx, membrane, internals, emit, close } = await open();
    try {
      const ordinaryId = ctx.addMessage('user', [{ type: 'text', text: 'T1-ORDINARY a module write' }]);
      emit('t1', 'T1-HELD chatter in the tuned-out channel');
      await waitFor('the held message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T1-HELD'));

      const rows = ctx.queryMessages({}).messages;
      const heldRow = rowWith(rows, 'T1-HELD')!;
      assert.ok(heldRow.metadata?.tuneOut, 'the stored message carries the tune-out stamp');
      assert.equal(heldRow.heldFromResidents, true, 'queryMessages marks it');
      assert.equal(heldRow.held, undefined, 'a stored row, not a held write');
      assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage marks it');
      const ordinary = rows.find((m) => m.id === ordinaryId)!;
      assert.equal('heldFromResidents' in ordinary, false, 'an ordinary row from queryMessages has no mark');
      assert.equal('heldFromResidents' in ctx.getMessage(ordinaryId)!, false, 'nor from getMessage');

      // With no held write, queryMessages answers the store's own result,
      // its rows marked: a reversed query of one row counts every match and
      // returns the newest, the held message. (The context takes the store's
      // query, which has `limit` and `reverse`, as module-held-writes says.)
      const storeQuery = (filter: MessageQuery) => ctx.queryMessages(filter as never);
      const all = ctx.queryMessages({});
      const newest = storeQuery({ reverse: true, limit: 1 });
      assert.equal(all.totalCount, all.messages.length);
      assert.equal(newest.totalCount, all.totalCount, 'a limited query counts every match');
      assert.deepEqual(newest.messages.map((m) => m.id), [heldRow.id], 'the newest row is the held message');
      assert.equal(newest.messages[0].heldFromResidents, true, 'marked in a limited query too');

      // The mark says what the resident's view does: the held message is out
      // of it and the ordinary row is in it.
      const scout = framework.getAgent('scout')!.getContextManager();
      const view = (await scout.compile()).messages.map(textOf);
      assert.ok(!view.some((t) => t.includes('T1-HELD')), "the held message isn't in the resident's view");
      assert.ok(view.some((t) => t.includes('T1-ORDINARY')), 'the ordinary row is');

      // After the cancel the stamp stays, and so does the mark: the cancel
      // brings the residents a dump, a row of its own.
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
      assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
      await waitFor('the channel open again', () => internals.channelRegistry!.getDesiredState('disc', CHANNEL) === 'open');
      await waitFor('the dump stored', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
      const after = ctx.queryMessages({}).messages;
      assert.equal(rowWith(after, 'T1-HELD')?.heldFromResidents, true, 'still marked after the cancel');
      const dump = rowWith(after, '<tuned-out-backlog')!;
      assert.equal('heldFromResidents' in dump, false, "the dump the residents read isn't marked");
      assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage still marks it');
    } finally {
      await close();
    }
  });

  it("keeps a tuned-out message that arrives during a turn out of that turn, and marks it as well as held, and its stored row once it lands", async () => {
    const { framework, ctx, module, membrane, emit, close } = await open();
    let release: () => void = () => {};
    try {
      emit('t2a', 'T2-STORED chatter before the turn');
      await waitFor('the first message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T2-STORED'));

      // A turn of the resident's, alive with its round's tool pending, so the
      // framework holds what arrives meanwhile, while the run loop goes on
      // taking channel traffic. (A quiesce pauses the MCPL data plane, so
      // nothing arrives while it lasts.)
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Waiting.' },
        { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      const stream = membrane.lastStream!;
      emit('t2b', 'T2-HELD chatter while the turn is alive');
      await waitFor('the held write', () => rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.held === true);
      // Queued behind the tuned-out write, so the boundary has to go on past
      // it to inject this one.
      const plainHandle = ctx.addMessage('user', [{ type: 'text', text: 'T2-PLAIN a module write while the turn is alive' }]);

      // With held writes among them, queryMessages answers the stored rows
      // and then the held ones.
      const rows = ctx.queryMessages({}).messages;
      const heldWrite = rowWith(rows, 'T2-HELD')!;
      assert.ok(heldWrite.metadata?.tuneOut, 'the held write carries the stamp');
      assert.equal(heldWrite.held, true);
      assert.equal(heldWrite.heldFromResidents, true, 'a held write with the stamp is marked');
      assert.equal(rowWith(rows, 'T2-STORED')?.heldFromResidents, true, 'a stored held message beside it is marked');
      assert.equal(ctx.getMessage(heldWrite.id)?.heldFromResidents, true, 'getMessage marks the held write by its handle');
      const plain = rowWith(rows, 'T2-PLAIN')!;
      assert.equal(plain.held, true, "the module's own write is held too");
      assert.equal('heldFromResidents' in plain, false, 'a held write without the stamp has no mark');
      assert.equal('heldFromResidents' in ctx.getMessage(plainHandle)!, false, 'nor by its handle');

      // At the tool boundary both writes are stored. The module's is handed
      // to the live turn; the tuned-out one isn't, as its compiled view
      // leaves it out.
      release();
      await waitFor('the write landed', () => {
        const row = rowWith(ctx.queryMessages({}).messages, 'T2-HELD');
        return !!row && row.held === undefined;
      });
      await waitFor('the tool results handed to the stream', () => stream.receivedToolResultOptions.length > 0);
      const injected = stream.receivedToolResultOptions.flatMap((options) =>
        (options?.injectedMessages ?? []).map((message) => JSON.stringify(message.content)));
      assert.ok(injected.some((t) => t.includes('T2-PLAIN')), "the module's write reaches the live turn");
      assert.ok(!injected.some((t) => t.includes('T2-HELD')), "the tuned-out message doesn't");

      const landed = ctx.getMessage(heldWrite.id);
      assert.ok(landed, 'the handle names the stored row');
      assert.equal(landed.held, undefined);
      assert.equal(landed.heldFromResidents, true, 'the stored row the handle names is marked');
      assert.equal(ctx.getMessage(landed.id)?.heldFromResidents, true, 'and so is it by its stored id');
      assert.equal(rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.heldFromResidents, true, 'and in queryMessages');
    } finally {
      release();
      await close();
    }
  });
});
