/**
 * A module's reads mark a message a tune-out holds from the residents
 * (ModuleMessage.heldFromResidents). Such a message is stored with
 * `metadata.tuneOut` and no resident's compiled view shows it, but a
 * module's context answered it as an ordinary row, so a module that keeps to
 * what the residents see by leaving out `held` rows still took it in. The
 * channel and its traffic come from test/tune-out-e2e.test.ts's MCPL fixture.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
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
  agents: Map<string, { getContextManager(): {
    compile(): Promise<{ messages: Array<{ content: ContentBlock[] }> }>;
  } }>;
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

describe('a module reads a message a tune-out holds as heldFromResidents', () => {
  let tempDir: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let ctx: ModuleContext;
  let module: ProbeModule;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'module-rows-held-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    module = new ProbeModule();
    framework = await AgentFramework.create({
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
    await framework.start();
    ctx = module.ctx!;
    const i = framework as unknown as Internals;
    await waitFor('channel registration', () => (i.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    const entered = i.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok, 'the channel is tuned out');
  });

  after(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const emit = (id: string, text: string): void => appendFileSync(commandPath, `ambient ${id} ${text}\n`);
  const rowWith = (rows: ModuleMessage[], text: string): ModuleMessage | undefined =>
    rows.find((m) => textOf(m).includes(text));

  it('marks a stored held message in queryMessages and getMessage, during the tune-out and after it, and leaves an ordinary row unmarked', async () => {
    const i = framework as unknown as Internals;
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

    // The mark says what the resident's view does: the held message is out
    // of it and the ordinary row is in it.
    const scout = i.agents.get('scout')!.getContextManager();
    const view = (await scout.compile()).messages.map(textOf);
    assert.ok(!view.some((t) => t.includes('T1-HELD')), "the held message isn't in the resident's view");
    assert.ok(view.some((t) => t.includes('T1-ORDINARY')), 'the ordinary row is');

    // After the tune-out the stamp stays, and so does the mark: the release
    // brings the resident a dump, a row of its own.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
    assert.ok(i.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
    await waitFor('the channel open again', () => i.channelRegistry!.getDesiredState('disc', CHANNEL) === 'open');
    await waitFor('the dump stored', () => !!rowWith(ctx.queryMessages({}).messages, '<tuned-out-backlog'));
    const after = ctx.queryMessages({}).messages;
    assert.equal(rowWith(after, 'T1-HELD')?.heldFromResidents, true, 'still marked after the tune-out');
    const dump = after.find((m) => textOf(m).includes('<tuned-out-backlog'))!;
    assert.equal('heldFromResidents' in dump, false, "the dump the resident reads isn't marked");
    assert.equal(ctx.getMessage(heldRow.id)?.heldFromResidents, true, 'getMessage still marks it');

    // Back in for the next test.
    assert.ok(i.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok);
  });

  it('marks a held write that carries the stamp as well as held, beside a marked stored row, and its stored row once it lands', async () => {
    emit('t2a', 'T2-STORED chatter before the turn');
    await waitFor('the first message stored', () => !!rowWith(ctx.queryMessages({}).messages, 'T2-STORED'));

    // A turn of the resident's, alive with its round's tool pending, so the
    // framework holds what arrives meanwhile, while the run loop goes on
    // taking channel traffic. (A quiesce pauses the MCPL data plane, so
    // nothing arrives while it lasts.)
    let waiting!: () => void;
    const inTool = new Promise<void>((resolve) => { waiting = resolve; });
    let release!: () => void;
    module.hold = new Promise<void>((resolve) => { release = resolve; });
    module.onWait = waiting;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Waiting.' },
      { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as never);
      await within("the resident's tool", inTool);
      emit('t2b', 'T2-HELD chatter while the turn is alive');
      await waitFor('the held write', () => rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.held === true);

      // With a held write among them, queryMessages answers the stored rows
      // and then the held ones.
      const rows = ctx.queryMessages({}).messages;
      const heldWrite = rowWith(rows, 'T2-HELD')!;
      assert.ok(heldWrite.metadata?.tuneOut, 'the held write carries the stamp');
      assert.equal(heldWrite.held, true);
      assert.equal(heldWrite.heldFromResidents, true, 'a held write with the stamp is marked');
      assert.equal(rowWith(rows, 'T2-STORED')?.heldFromResidents, true, 'a stored held message beside it is marked');
      assert.equal(ctx.getMessage(heldWrite.id)?.heldFromResidents, true, "getMessage marks the held write by its handle");

      release();
      await waitFor('the write landed', () => rowWith(ctx.queryMessages({}).messages, 'T2-HELD')?.held === undefined);
      const landed = ctx.getMessage(heldWrite.id);
      assert.ok(landed, 'the handle names the stored row');
      assert.equal(landed.held, undefined);
      assert.equal(landed.heldFromResidents, true, 'the stored row the handle names is marked');
    } finally {
      release();
      module.hold = Promise.resolve();
      module.onWait = () => {};
    }
  });
});
