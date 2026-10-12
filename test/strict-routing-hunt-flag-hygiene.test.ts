/**
 * Strict routing hunt — flag hygiene and durability of held messages.
 *
 * Adversarial review of ROUTING_STRICT / CHANNEL_OPEN_ON_SEND=false. Each
 * case drives the REAL framework turn machinery and the REAL ChannelRegistry
 * (same harness as strict-routing-privacy.test.ts) and asserts one property
 * of a held message: it survives a crash (kill -9 = on-disk snapshot of the
 * store taken mid-turn, no teardown), a graceful stop and an abort; it is
 * stored exactly once; it wakes a turn only when the original arrival would
 * have; and it is published only in its own place.
 *
 * Cases that FAIL against the implementation under review are the findings;
 * the passing ones are the checked-and-safe controls.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const AGENT = 'resident';
const DM = 'discord:dm:42';
const WORLD = 'world:plaza';
const HOME = 'discord:G1:home';
const CLOSED = 'discord:G1:lounge';
const OPERATOR = 'U-operator';

const FLAGS = ['ROUTING_STRICT', 'CHANNEL_OPEN_ON_SEND', 'ROUTING_NO_SILENCE_ON_SEND'] as const;

// ---------------------------------------------------------------------------
// Harness (mirrors strict-routing-privacy.test.ts)
// ---------------------------------------------------------------------------

class ScriptedMembrane {
  calls: NormalizedRequest[] = [];
  streams: MockYieldingStream[] = [];
  private scripts: NormalizedResponse[][] = [];

  turn(...responses: NormalizedResponse[]): this {
    this.scripts.push(responses);
    return this;
  }

  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const script = this.scripts.shift() ?? [createMockResponse([{ type: 'text', text: '(unscripted turn)' }])];
    const stream = new MockYieldingStream(script);
    this.streams.push(stream);
    return stream;
  }

  async complete(): Promise<NormalizedResponse> {
    return createMockResponse([{ type: 'text', text: '(complete)' }]);
  }

  asMembrane(): Membrane {
    return this as unknown as Membrane;
  }
}

class ProbeModule implements Module {
  readonly name = 'probe';
  hooks: Array<() => Promise<void>> = [];
  inFlight = new Set<Promise<unknown>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait a moment', inputSchema: { type: 'object', properties: {} } }];
  }

  handleToolCall(call: ToolCall): Promise<ToolResult> {
    const run = (async (): Promise<ToolResult> => {
      if (call.name === 'wait') {
        const hook = this.hooks.shift();
        if (hook) await hook();
      }
      return { success: true, data: { ok: true, tool: call.name } };
    })();
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
    return run;
  }

  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    const e = event as { type: string; source?: string; content?: unknown };
    if (e.type === 'external-message' && e.source === 'cli') {
      return {
        addMessages: [{ participant: 'operator', content: [{ type: 'text', text: String(e.content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

interface Internals {
  channelRegistry: unknown;
  mcplServerRegistry: unknown;
  mcplPrefixMap: Map<string, string>;
  activeTriggerChannels: Map<string, string>;
  mcplHomeChannel: string | null;
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown>; content: unknown[] }>;
  pendingRequests: Array<{ agentName: string; reason: string; channelId?: string }>;
  recordChannelAutoOpenNotice(agentName: string | undefined, channels: Array<{ channelId: string; label?: string }>, cause: string): void;
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>): string;
}

interface Publish { server: string; channelId: string; text: string }

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  published: Publish[];
  turnLoci: Array<string | undefined>;
  internals: Internals;
}

function internalsOf(fw: AgentFramework): Internals {
  return fw as unknown as Internals;
}

function attachRegistry(fw: AgentFramework): { published: Publish[] } {
  const published: Publish[] = [];
  const mkServer = (id: string) => ({
    id,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId: string; content: Array<{ type: string; text?: string }> }) => {
      published.push({ server: id, channelId: p.channelId, text: p.content.map((b) => b.text ?? '').join('') });
      return { delivered: true, messageId: `pub-${published.length}` };
    },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
    sendChannelsTyping: () => {},
    sendToolsCall: async (_tool: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: JSON.stringify({ messageId: 'sent', channelId: args.channelId }) }],
    }),
  });
  const servers: Record<string, ReturnType<typeof mkServer>> = {
    discord: mkServer('discord'),
    eidoverse: mkServer('eidoverse'),
  };
  const serverRegistry = {
    getServer: (id: string) => servers[id],
    getAllServers: () => [],
    closeAll: async () => {},
  };
  const i = internalsOf(fw);
  const registry = new ChannelRegistry(
    serverRegistry as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    (event) => fw.pushEvent(event),
    () => {},
    {
      sendTypingFn: () => {},
      homeChannelResolver: () => undefined,
      activeChannelResolver: (name) => i.activeTriggerChannels.get(name),
      homeChannel: i.mcplHomeChannel ?? undefined,
      onChannelAutoOpened: ({ conversationId, source, channels }) =>
        i.recordChannelAutoOpenNotice(conversationId, channels, source),
    },
  );
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  const seed = (serverId: string, id: string, label: string, open: boolean) =>
    map.set(`${serverId}:${id}`, { serverId, descriptor: { id, type: serverId, label }, open });
  seed('discord', DM, 'DM: operator', false);
  seed('discord', HOME, 'home', true);
  seed('discord', CLOSED, 'lounge', false);
  seed('eidoverse', WORLD, 'plaza', true);
  i.channelRegistry = registry;
  i.mcplServerRegistry = serverRegistry;
  i.mcplPrefixMap = new Map([['discord', 'discord'], ['eidoverse', 'eidoverse']]);
  return { published };
}

async function makeHarness(
  storeDir: string,
  opts: { membrane?: ScriptedMembrane; probe?: ProbeModule; privilegedDir?: string } = {},
): Promise<Harness> {
  const membrane = opts.membrane ?? new ScriptedMembrane();
  const probe = opts.probe ?? new ProbeModule();
  if (opts.privilegedDir) writeFileSync(join(opts.privilegedDir, 'privileged.json'), JSON.stringify([OPERATOR]));
  const fw = await AgentFramework.create({
    storePath: storeDir,
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.' }],
    modules: [probe],
    homeChannel: HOME,
    ...(opts.privilegedDir
      ? {
          gate: {
            configPath: join(opts.privilegedDir, 'gate.json'),
            config: { policies: [], default: 'always' as const },
            privilegedUsersPath: join(opts.privilegedDir, 'privileged.json'),
          },
        }
      : {}),
  });
  const turnLoci: Array<string | undefined> = [];
  fw.onTrace((event) => {
    const e = event as { type: string; [k: string]: unknown };
    if (e.type === 'inference:started') turnLoci.push(e.channelId as string | undefined);
  });
  return { fw, membrane, probe, turnLoci, internals: internalsOf(fw), ...attachRegistry(fw) };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

function dmEvent(text: string, authorId = 'U-friend'): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: nextId('dm'),
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord', channelId: '42', guildId: null, isDM: true,
      authorName: 'operator', authorId, messageId: nextId('m'),
    },
    tags: ['chat:addressed'],
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

function worldEvent(text: string, opts: { waking?: boolean; content?: ContentBlock[] } = {}): ProcessEvent {
  const waking = opts.waking ?? true;
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'eidoverse',
    channelId: WORLD,
    messageId: nextId('w'),
    author: { id: 'visitor', name: 'visitor' },
    content: opts.content ?? [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: waking ? ['chat:mention', 'chat:addressed'] : ['chat:ambient'],
    triggerInference: waking,
  } as unknown as ProcessEvent;
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const tool = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const round = (...blocks: ContentBlock[]) => createMockResponse(blocks, 'tool_use');
const final = (...blocks: ContentBlock[]) => createMockResponse(blocks);

const blockText = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .map((b: { type?: string; text?: string; content?: unknown }) =>
      b?.type === 'text' ? b.text ?? '' : b?.content ? blockText(b.content) : '')
    .join('\n');

const requestText = (req: NormalizedRequest): string =>
  (req.messages ?? []).map((m) => blockText((m as { content: unknown }).content)).join('\n');

const windowTexts = (fw: AgentFramework): string[] =>
  fw.getAgent(AGENT)!.getContextManager().getAllMessages().map((m) => blockText(m.content));

const publishedTo = (h: { published: Publish[] }, channelId: string): string[] =>
  h.published.filter((p) => p.channelId === channelId).map((p) => p.text);

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const never = () => new Promise<void>(() => {});

// ---------------------------------------------------------------------------

describe('strict routing hunt — flag hygiene & durability (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const live: AgentFramework[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-hunt-hyg-'));
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.ROUTING_STRICT = 'true';
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    process.env.ROUTING_NO_SILENCE_ON_SEND = 'true';
  });

  afterEach(async () => {
    for (const fw of live.splice(0)) {
      try { await fw.stop(); } catch { /* already stopped */ }
    }
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Run a DM turn whose tool round hangs forever; inside it, `during` runs
   * (the mid-turn arrival). Returns the running harness once `heldWhen`
   * holds. A kill -9 at that instant leaves exactly the on-disk state, which
   * `crashSnapshot` copies for the next boot.
   */
  async function dmTurnHanging(storeDir: string, during: (h: Harness) => void | Promise<void>): Promise<Harness> {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const h = await makeHarness(storeDir, { membrane, probe });
    live.push(h.fw);
    membrane.turn(round(text('Thinking about your DM.'), tool('c1', 'probe--wait')), final(text('never delivered')));
    let arrived = false;
    probe.hooks.push(async () => {
      await during(h);
      await settle();
      arrived = true;
      await never();
    });
    h.fw.start();
    h.fw.pushEvent(dmEvent('private: a long question'));
    await waitFor('the mid-turn arrival', () => arrived);
    return h;
  }

  /** On-disk state of a store at this instant (what a kill -9 leaves). */
  function crashSnapshot(from: string): string {
    const to = join(dir, `crash-${++counter}`);
    cpSync(from, to, { recursive: true });
    return to;
  }

  async function bootFrom(storeDir: string, membrane: ScriptedMembrane): Promise<Harness> {
    const h = await makeHarness(storeDir, { membrane });
    live.push(h.fw);
    return h;
  }

  // ---- crash (kill -9) mid-turn ---------------------------------------------

  it('FH1 (control): a WAKING world mention held mid-DM-turn survives a kill -9 and is answered once, in the world only', async () => {
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent(worldEvent('@resident hello from the plaza'));
    });
    assert.ok(a.internals.deferredMessages.some((m) => m.metadata?.channelId === WORLD), 'held');
    assert.doesNotMatch(windowTexts(a.fw).join('\n'), /hello from the plaza/, 'not stored while held');
    const snap = crashSnapshot(join(dir, 'store'));

    const membrane2 = new ScriptedMembrane().turn(final(text('Hi plaza!')));
    const b = await bootFrom(snap, membrane2);
    await b.fw.runUntilIdle();

    assert.deepEqual(b.turnLoci, [WORLD]);
    assert.deepEqual(b.published, [{ server: 'eidoverse', channelId: WORLD, text: 'Hi plaza!' }]);
    assert.equal(windowTexts(b.fw).filter((t) => /hello from the plaza/.test(t)).length, 1, 'stored exactly once');
    assert.match(requestText(membrane2.calls[0]!), /hello from the plaza/, 'the re-armed turn carries its message');
  });

  it('FH2 (control): an AMBIENT world message held mid-DM-turn survives a kill -9, is stored once and wakes nothing', async () => {
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent(worldEvent('visitor: nice fountain', { waking: false }));
    });
    assert.ok(a.internals.deferredMessages.some((m) => m.metadata?.channelId === WORLD), 'held');
    const snap = crashSnapshot(join(dir, 'store'));

    const membrane2 = new ScriptedMembrane();
    const b = await bootFrom(snap, membrane2);
    await b.fw.runUntilIdle();

    assert.equal(membrane2.calls.length, 0, 'an ambient message wakes no turn');
    assert.deepEqual(b.published, []);
    assert.equal(windowTexts(b.fw).filter((t) => /nice fountain/.test(t)).length, 1, 'stored exactly once');
  });

  it('FH3 (control): channel-less operator input held mid-turn survives a kill -9 and is answered in a home turn', async () => {
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent({ type: 'external-message', source: 'cli', content: 'operator: private deploy note', metadata: {} } as unknown as ProcessEvent);
    });
    await waitFor('the operator note to be held', () =>
      a.internals.deferredMessages.some((m) => /private deploy note/.test(blockText(m.content))));
    const snap = crashSnapshot(join(dir, 'store'));

    const membrane2 = new ScriptedMembrane().turn(final(text('Noted.')));
    const b = await bootFrom(snap, membrane2);
    await b.fw.runUntilIdle();

    assert.deepEqual(b.turnLoci, [HOME]);
    assert.deepEqual(b.published, [{ server: 'discord', channelId: HOME, text: 'Noted.' }]);
    assert.equal(windowTexts(b.fw).filter((t) => /private deploy note/.test(t)).length, 1);
  });

  it('FH4 (control): a kill -9 AFTER the held place\'s own turn stored it neither replays nor re-answers it', async () => {
    // DM turn completes; the world turn then starts (its turn-start drain
    // stores and acks the held mention) and hangs in a tool round.
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const a = await makeHarness(join(dir, 'store'), { membrane, probe });
    live.push(a.fw);
    membrane
      .turn(round(text('On it.'), tool('c1', 'probe--wait')), final(text('DM answer.')))
      .turn(round(text('Hello plaza.'), tool('c2', 'probe--wait')), final(text('never delivered')));
    let worldTurnHanging = false;
    probe.hooks.push(async () => {
      a.fw.pushEvent(worldEvent('@resident ping from the plaza'));
      await settle();
    });
    probe.hooks.push(async () => { worldTurnHanging = true; await never(); });
    a.fw.start();
    a.fw.pushEvent(dmEvent('private: quick one'));
    await waitFor('the world turn to hang', () => worldTurnHanging);
    assert.deepEqual(a.turnLoci, [DM, WORLD]);
    const snap = crashSnapshot(join(dir, 'store'));

    const membrane2 = new ScriptedMembrane();
    const b = await bootFrom(snap, membrane2);
    await b.fw.runUntilIdle();
    assert.equal(membrane2.calls.length, 0, 'no replayed wake');
    assert.equal(windowTexts(b.fw).filter((t) => /ping from the plaza/.test(t)).length, 1, 'stored exactly once');
  });

  it('FH5: a tuned-out (diverted) message held mid-turn must not wake a resident turn after a kill -9', async () => {
    // The tune-out divert path stores the message stamped `tuneOut` and
    // queues NO resident wake (handleMcplChannelIncoming: `triggerInference
    // && !divert`), while `metadata.triggered` keeps the gate verdict (true).
    // Without a crash the hold ends at the turn end as an ambient store. The
    // boot re-arm keys on `metadata.triggered` alone, so after a crash it
    // invents a resident wake whose locus is the tuned-out channel.
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.internals.addMessage('user', [text('visitor: chatter in a tuned-out plaza')], {
        channelId: WORLD,
        serverId: 'eidoverse',
        messageId: nextId('w'),
        author: { id: 'visitor', name: 'visitor' },
        triggered: true,
        tags: ['chat:mention', 'chat:addressed'],
        tuneOut: { epochId: 'epoch-1' },
      });
    });
    assert.ok(a.internals.deferredMessages.some((m) => m.metadata?.tuneOut), 'the diverted message is held');
    const snap = crashSnapshot(join(dir, 'store'));

    const membrane2 = new ScriptedMembrane();
    const b = await bootFrom(snap, membrane2);
    await b.fw.runUntilIdle();

    assert.equal(membrane2.calls.length, 0, 'a diverted message never wakes the resident');
    assert.deepEqual(publishedTo(b, WORLD), [], 'nothing is said into the tuned-out channel');
  });

  // ---- graceful stop ----------------------------------------------------------

  it('FH6: a large held message (over the 4 MiB recovery cap) must not be lost by a graceful stop mid-turn', async () => {
    // Upstream stores a mid-turn message at the turn teardown that stop()
    // forces (control below). Under ROUTING_STRICT a waking message from
    // another place stays held through that teardown and relies on the
    // durable recovery mirror alone — which silently refuses payloads over
    // DEFERRED_WRITES_PERSIST_CAP_BYTES. A world message carrying a large
    // attachment (inline image data) is then neither stored nor recoverable.
    const big = 'x'.repeat(4 * 1024 * 1024 + 1024);
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent(worldEvent('', { content: [text('@resident look at this BIG-ATTACHMENT'), text(big)] }));
    });
    assert.ok(a.internals.deferredMessages.some((m) => m.metadata?.channelId === WORLD), 'held');
    await a.fw.stop();
    live.splice(live.indexOf(a.fw), 1);

    const membrane2 = new ScriptedMembrane().turn(final(text('Lovely picture.')));
    const b = await bootFrom(join(dir, 'store'), membrane2);
    await b.fw.runUntilIdle();

    const stored = windowTexts(b.fw).filter((t) => /BIG-ATTACHMENT/.test(t)).length;
    assert.equal(stored, 1, 'the held world message is stored exactly once after the restart (it was lost)');
  });

  it('FH6b: one oversized held message makes EVERY other held message non-durable (a small operator note is lost by a graceful stop)', async () => {
    // The recovery mirror is one JSON document for the whole queue; once it
    // exceeds the cap nothing is written, so small held messages from other
    // places that arrive alongside an attachment lose durability too.
    const big = 'x'.repeat(4 * 1024 * 1024 + 1024);
    const a = await dmTurnHanging(join(dir, 'store'), async (h) => {
      h.fw.pushEvent(worldEvent('', { content: [text('@resident BIG-ATTACHMENT'), text(big)] }));
      await settle();
      h.fw.pushEvent({ type: 'external-message', source: 'cli', content: 'operator: SMALL-NOTE please check the logs', metadata: {} } as unknown as ProcessEvent);
    });
    await waitFor('both to be held', () =>
      a.internals.deferredMessages.some((m) => /SMALL-NOTE/.test(blockText(m.content))));
    await a.fw.stop();
    live.splice(live.indexOf(a.fw), 1);

    const b = await bootFrom(join(dir, 'store'), new ScriptedMembrane());
    await b.fw.runUntilIdle();
    assert.equal(windowTexts(b.fw).filter((t) => /SMALL-NOTE/.test(t)).length, 1, 'the small held operator note survives the restart');
  });

  it('FH7 (control): an abort followed at once by a stop, before the held place\'s turn starts, loses nothing', async () => {
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent(worldEvent('@resident are you there, from the plaza?'));
    });
    a.fw.abortInference(AGENT, 'operator-stop');
    await a.fw.stop();
    live.splice(live.indexOf(a.fw), 1);
    const startedWorld = a.turnLoci.includes(WORLD);

    const membrane2 = new ScriptedMembrane().turn(final(text('Here now.')));
    const b = await bootFrom(join(dir, 'store'), membrane2);
    await b.fw.runUntilIdle();
    assert.equal(windowTexts(b.fw).filter((t) => /are you there, from the plaza/.test(t)).length, 1, 'stored exactly once');
    if (!startedWorld) assert.deepEqual(publishedTo(b, WORLD), ['Here now.'], 'answered after the restart');
    assert.deepEqual(publishedTo(b, DM), []);
  });

  it('FH8 (control): a quiesce while a place is held keeps its own turn at resume and stores it once', async () => {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const a = await makeHarness(join(dir, 'store'), { membrane, probe });
    live.push(a.fw);
    membrane
      .turn(round(text('Working.'), tool('c1', 'probe--wait')), final(text('DM done.')))
      .turn(final(text('Plaza, hello.')));
    let quiescing: Promise<unknown> | undefined;
    probe.hooks.push(async () => {
      a.fw.pushEvent(worldEvent('@resident during the DM turn'));
      await settle();
      // Quiesce mid-turn (not awaited here: it drains THIS turn).
      quiescing = a.fw.quiesce({ reason: 'surgery' });
    });
    a.fw.pushEvent(dmEvent('private: something'));
    await a.fw.runUntilIdle();
    await waitFor('the quiesce', () => quiescing !== undefined);
    await quiescing;
    assert.deepEqual(a.turnLoci, [DM]);
    assert.doesNotMatch(windowTexts(a.fw).join('\n'), /during the DM turn/, 'still held while quiesced');
    await a.fw.resume();
    await a.fw.runUntilIdle();
    assert.deepEqual(a.turnLoci, [DM, WORLD]);
    assert.deepEqual(publishedTo(a, WORLD), ['Plaza, hello.']);
    assert.equal(windowTexts(a.fw).filter((t) => /during the DM turn/.test(t)).length, 1);
  });

  // ---- mutation guards: each passes on the implementation and fails when the
  // ---- named guard line is reverted (the privacy suite misses all of them).

  it('MG-channel_open: opening a channel mid-DM-turn does not move the DM turn\'s prose (guards the channel_open re-pin gate)', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane.turn(
      round(text('Let me open the lounge first.'), tool('c1', 'channel_open', { channelId: CLOSED })),
      final(text('Private answer, still for you.')),
    );
    h.fw.pushEvent(dmEvent('private: what do you think?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(publishedTo(h, DM), ['Let me open the lounge first.', 'Private answer, still for you.']);
    assert.deepEqual(publishedTo(h, CLOSED), [], 'nothing of the DM turn lands in the opened channel');
  });

  it('MG-teardown-durability: a same-place follow-up held at an aborted turn\'s teardown survives an immediate stop', async () => {
    const a = await dmTurnHanging(join(dir, 'store'), (h) => {
      h.fw.pushEvent(dmEvent('private: FOLLOWUP-ONE'));
    });
    // Same place: deferred (memory-only), not strict-held at arrival.
    assert.ok(a.internals.deferredMessages.some((m) => /FOLLOWUP-ONE/.test(blockText(m.content))));
    a.fw.abortInference(AGENT, 'operator-stop');
    await a.fw.stop();
    live.splice(live.indexOf(a.fw), 1);
    assert.deepEqual(a.turnLoci, [DM], 'precondition: the follow-up turn did not start before the stop');

    const membrane2 = new ScriptedMembrane().turn(final(text('About your follow-up.')));
    const b = await bootFrom(join(dir, 'store'), membrane2);
    await b.fw.runUntilIdle();
    assert.equal(windowTexts(b.fw).filter((t) => /FOLLOWUP-ONE/.test(t)).length, 1, 'not lost, stored once');
    assert.deepEqual(publishedTo(b, DM), ['About your follow-up.']);
  });

  it('MG-auto-open-notice: with ROUTING_STRICT alone, a delivery that opens the closed DM writes no [channels] notice', async () => {
    delete process.env.CHANNEL_OPEN_ON_SEND; // upstream open-on-delivery
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane.turn(final(text('Hi, privately.')));
    h.fw.pushEvent(dmEvent('private: hello'));
    await h.fw.runUntilIdle();
    assert.deepEqual(publishedTo(h, DM), ['Hi, privately.']);
    assert.equal(
      (h.internals.channelRegistry as ChannelRegistry).isChannelOpen(DM), true,
      'precondition: delivery opened the DM',
    );
    assert.doesNotMatch(windowTexts(h.fw).join('\n'), /\[channels\] Now open/);
  });

  it('MG-quiesce-coalescing: two DMs from different people parked by a quiesce each get their own turn', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane.turn(final(text('answer one'))).turn(final(text('answer two')));
    const dm2 = (t: string): ProcessEvent => {
      const e = dmEvent(t) as unknown as { origin: Record<string, unknown> };
      e.origin = { ...e.origin, channelId: '43', authorName: 'friend', authorId: 'U-two' };
      return e as unknown as ProcessEvent;
    };
    await h.fw.quiesce({ reason: 'test' });
    h.fw.pushEvent(dmEvent('private: first person'));
    await settle(5);
    h.fw.pushEvent(dm2('private: second person'));
    await h.fw.runUntilIdle();
    await h.fw.resume();
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, 'discord:dm:43'], 'one turn per DM, in arrival order');
    assert.deepEqual(publishedTo(h, DM), ['answer one']);
    assert.deepEqual(publishedTo(h, 'discord:dm:43'), ['answer two']);
  });

  it('MG-order: a message arriving between a turn\'s teardown and its place\'s own turn keeps arrival order', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane
      .turn(round(text('One sec.'), tool('c1', 'probe--wait')), final(text('DM done.')))
      .turn(final(text('Plaza, hi.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('@resident ORDER-FIRST'));
      await settle();
    });
    const fw = h.fw as unknown as { ackDeferredWrites(): void; activeTurnTokens: Map<string, number>; handleMcplChannelIncoming(e: unknown): unknown };
    const realAck = fw.ackDeferredWrites.bind(h.fw);
    let injected = false;
    fw.ackDeferredWrites = () => {
      realAck();
      if (!injected && !fw.activeTurnTokens.has(AGENT)
        && h.internals.deferredMessages.some((m) => /ORDER-FIRST/.test(blockText(m.content)))) {
        injected = true;
        void fw.handleMcplChannelIncoming(worldEvent('visitor: ORDER-SECOND', { waking: false }));
      }
    };
    h.fw.pushEvent(dmEvent('private: quick'));
    await h.fw.runUntilIdle();
    assert.ok(injected, 'precondition: the second message arrived in the gap');
    const w = windowTexts(h.fw);
    const first = w.findIndex((t) => /ORDER-FIRST/.test(t));
    const second = w.findIndex((t) => /ORDER-SECOND/.test(t));
    assert.ok(first >= 0 && second > first, `within a place, arrival order is kept (first=${first}, second=${second})`);
  });

  it('MG-budget-restart: a context-budget restart of a DM turn does not consume a held world mention\'s wake', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    const overBudget = round(text('Working on it.'), tool('c1', 'probe--wait'));
    (overBudget as unknown as { usage: { inputTokens: number; outputTokens: number } }).usage = { inputTokens: 999_999, outputTokens: 5 };
    h.membrane
      .turn(overBudget, final(text('(cancelled by the restart)')))
      .turn(final(text('DM, continued after the restart.')))
      .turn(final(text('Plaza, here I am.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('@resident BUDGET-WORLD ping'));
      await settle();
    });
    h.fw.pushEvent(dmEvent('private: long task'));
    await h.fw.runUntilIdle();
    assert.equal(h.turnLoci.filter((l) => l === WORLD).length, 1, `the world mention gets its own turn (loci=${JSON.stringify(h.turnLoci)})`);
    assert.deepEqual(publishedTo(h, WORLD), ['Plaza, here I am.']);
    assert.ok(!publishedTo(h, DM).includes('Plaza, here I am.'));
  });

  it('brake (control): a privileged follow-up in the SAME place still interrupts, and is answered next in that place', async () => {
    const h = await makeHarness(join(dir, 'store'), { privilegedDir: dir });
    live.push(h.fw);
    const traces: Array<{ type: string; reason?: unknown }> = [];
    h.fw.onTrace((e) => traces.push(e as { type: string; reason?: unknown }));
    h.membrane
      .turn(round(text('Starting a long thing.'), tool('c1', 'probe--wait')), final(text('never delivered')))
      .turn(final(text('Stopped, what is up?')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(dmEvent('private: BRAKE stop that', OPERATOR));
      await settle(60);
    });
    h.fw.pushEvent(dmEvent('private: do the long thing'));
    await h.fw.runUntilIdle();
    await Promise.all([...h.probe.inFlight]);
    assert.ok(traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'));
    assert.deepEqual(h.turnLoci, [DM, DM]);
    assert.deepEqual(publishedTo(h, DM), ['Starting a long thing.', 'Stopped, what is up?']);
    assert.equal(windowTexts(h.fw).filter((t) => /BRAKE stop that/.test(t)).length, 1);
  });

  it('heartbeat (control): a channel-less heartbeat mid-DM-turn is heard, and its own turn speaks only at home', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane
      .turn(round(text('Looking.'), tool('c1', 'probe--wait')), final(text('DM reply.')))
      .turn(final(text('Home check-in.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({
        type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: nextId('hb'),
        content: [text('[heartbeat] HB-TICK')], origin: { source: 'heartbeat' },
        timestamp: new Date().toISOString(), inferenceId: nextId('inf'), triggerInference: true,
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(dmEvent('private: hi'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, HOME]);
    assert.deepEqual(publishedTo(h, DM), ['Looking.', 'DM reply.']);
    assert.deepEqual(publishedTo(h, HOME), ['Home check-in.']);
  });

  it('MG-rollback-dedupe: a rollback while a place is held leaves ONE durable copy of each released message (no duplicate after a crash)', async () => {
    const h = await makeHarness(join(dir, 'store'));
    live.push(h.fw);
    h.membrane.turn(final(text('DM reply one.')));
    h.fw.pushEvent(dmEvent('private: before the surgery'));
    await h.fw.runUntilIdle();
    const ids = h.fw.getAgent(AGENT)!.getContextManager().getAllMessages().map((m) => m.id);
    assert.ok(ids.length >= 2, 'precondition: history to roll back');

    await h.fw.quiesce({ reason: 'surgery' });
    // A waking world mention (wake parked by the quiesce) and an ambient home
    // message arrive during the maintenance window.
    h.fw.pushEvent(worldEvent('@resident WORLD-DURING-SURGERY'));
    await h.fw.runUntilIdle();
    const home = worldEvent('visitor: HOME-AMBIENT-DURING-SURGERY', { waking: false }) as unknown as Record<string, unknown>;
    home.serverId = 'discord';
    home.channelId = HOME;
    h.fw.pushEvent(home as unknown as ProcessEvent);
    await h.fw.runUntilIdle();
    assert.equal(h.internals.deferredMessages.length, 2, 'precondition: both deferred during the window');
    await h.fw.rollbackToMessage(AGENT, { messageId: ids[ids.length - 2]! });

    const recovery = join(dir, 'store', 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(recovery, 'utf8')) as { pending: Array<{ content: unknown }> };
    const copies = doc.pending.filter((m) => /HOME-AMBIENT-DURING-SURGERY/.test(blockText(m.content))).length;
    assert.equal(copies, 1, 'the durable queue lists the released message once');

    // kill -9 now, then boot and resume: stored exactly once.
    const snap = crashSnapshot(join(dir, 'store'));
    const b = await bootFrom(snap, new ScriptedMembrane().turn(final(text('Plaza, hi.'))));
    if (b.fw.getHostModeStatus().quiesced) await b.fw.resume();
    await b.fw.runUntilIdle();
    assert.equal(windowTexts(b.fw).filter((t) => /HOME-AMBIENT-DURING-SURGERY/.test(t)).length, 1, 'stored exactly once');
  });

  it('MG-orphan: a held message whose wake the policy drops is stored (ambient), not held forever', async () => {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [probe],
      homeChannel: HOME,
      inferencePolicy: {
        shouldInfer: (_agent, requests) => !requests.some((r) => r.channelId === WORLD),
      },
    });
    live.push(fw);
    const h = { fw, published: attachRegistry(fw).published };
    membrane.turn(round(text('Busy.'), tool('c1', 'probe--wait')), final(text('Done.')));
    probe.hooks.push(async () => {
      fw.pushEvent(worldEvent('@resident ORPHAN-WAKE'));
      await settle();
    });
    fw.start();
    fw.pushEvent(dmEvent('private: go'));
    await waitFor('the dropped wake\'s message to be stored', () =>
      windowTexts(fw).some((t) => /ORPHAN-WAKE/.test(t)), 3000);
    assert.deepEqual(publishedTo(h, WORLD), []);
  });
});

// ---------------------------------------------------------------------------
// Controls with the flags unset (upstream behavior the strict cases regress).
// ---------------------------------------------------------------------------

describe('strict routing hunt — flag hygiene controls (flags unset)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const live: AgentFramework[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-hunt-hyg-off-'));
    for (const f of FLAGS) { saved[f] = process.env[f]; delete process.env[f]; }
  });

  afterEach(async () => {
    for (const fw of live.splice(0)) {
      try { await fw.stop(); } catch { /* already stopped */ }
    }
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('hygiene: flags unset, a mid-turn message from another place is NOT mirrored to the recovery file (upstream: memory-only)', async () => {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const a = await makeHarness(join(dir, 'store'), { membrane, probe });
    live.push(a.fw);
    membrane
      .turn(round(text('Thinking.'), tool('c1', 'probe--wait')), final(text('Done.')))
      .turn(final(text('(follow-up turn)')));
    let sawFile: boolean | undefined;
    probe.hooks.push(async () => {
      a.fw.pushEvent(worldEvent('@resident mid-turn from the plaza'));
      await settle();
      sawFile = existsSync(join(dir, 'store', 'recovery', 'deferred-writes.json'));
    });
    a.fw.pushEvent(dmEvent('private: hello'));
    await a.fw.runUntilIdle();
    assert.equal(sawFile, false, 'no durable mirror outside a quiesce window when the flags are unset');
  });

  it('FH6 control: upstream stores a large mid-turn message at the stop teardown (nothing lost)', async () => {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const a = await makeHarness(join(dir, 'store'), { membrane, probe });
    membrane.turn(round(text('Thinking.'), tool('c1', 'probe--wait')), final(text('never delivered')));
    const big = 'x'.repeat(4 * 1024 * 1024 + 1024);
    let arrived = false;
    probe.hooks.push(async () => {
      a.fw.pushEvent(worldEvent('', { content: [text('@resident look at this BIG-ATTACHMENT'), text(big)] }));
      await settle();
      arrived = true;
      await never();
    });
    a.fw.start();
    a.fw.pushEvent(dmEvent('private: a long question'));
    await waitFor('the mid-turn arrival', () => arrived);
    await a.fw.stop();

    const b = await makeHarness(join(dir, 'store'), { membrane: new ScriptedMembrane() });
    live.push(b.fw);
    assert.equal(windowTexts(b.fw).filter((t) => /BIG-ATTACHMENT/.test(t)).length, 1);
    assert.equal(existsSync(join(dir, 'store', 'recovery', 'deferred-writes.json'))
      ? /BIG-ATTACHMENT/.test(readFileSync(join(dir, 'store', 'recovery', 'deferred-writes.json'), 'utf8'))
      : false, false);
  });
});
