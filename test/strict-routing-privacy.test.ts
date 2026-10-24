/**
 * Strict routing privacy suite (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false).
 *
 * The requirement under test: words meant for one place are never published
 * in another. A conversation in progress in one place (a private DM, a world
 * channel served by a second MCPL server) is never poached by a message from
 * somewhere else, and every place is answered in its own turn.
 *
 * The harness drives the REAL framework turn machinery and the REAL
 * ChannelRegistry (routing, open-on-delivery, auto-open notices) against two
 * mock MCPL servers — `discord` (a DM, a home channel, a closed guild
 * channel) and `eidoverse` (a world channel) — so every assertion about
 * "where prose went" is read off the servers' channels/publish calls.
 *
 * Each case names the scenario it covers (P1..P10).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
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
// Harness
// ---------------------------------------------------------------------------

/** One scripted response list per turn (each stream consumes one script). */
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

/** `wait` runs the next queued hook while the tool round is pending — the
 *  window in which mid-turn arrivals happen. `say` is a world publication
 *  verb (bare name), handled locally. */
class ProbeModule implements Module {
  readonly name = 'probe';
  hooks: Array<() => Promise<void>> = [];
  /** Tool calls still running (a call can outlive an aborted turn). */
  inFlight = new Set<Promise<unknown>>();
  ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      { name: 'wait', description: 'Wait a moment', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'say',
        description: 'Say something aloud in the world',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ];
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

  /** Operator input over the CLI/IPC lane: a channel-less waking message. */
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    const e = event as { type: string; source?: string; content?: unknown; agentName?: string };
    if (e.type === 'external-message' && e.source === 'cli') {
      return {
        addMessages: [{ participant: 'operator', content: [{ type: 'text', text: String(e.content) }] }],
        requestInference: true,
      };
    }
    // A module's own wake request (as the host's subagent module raises it).
    if (e.type === 'inference-request' && e.source === 'relay' && e.agentName) {
      return { requestInference: [e.agentName] };
    }
    return {};
  }
}

interface Internals {
  channelRegistry: unknown;
  mcplServerRegistry: unknown;
  mcplPrefixMap: Map<string, string>;
  turnChannelFor(agentName: string): ChannelRef | null | undefined;
  mcplHomeChannel: string | null;
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
  pendingRequests: Array<{ agentName: string; reason: string; channelId?: string }>;
  recordChannelAutoOpenNotice(agentName: string | undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: string): void;
  handleMcplPushEvent(event: unknown): unknown;
  handleMcplChannelIncoming(event: unknown): Promise<unknown>;
}

interface Publish { server: string; channelId: string; text: string }

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  registry: ChannelRegistry;
  published: Publish[];
  opens: Array<{ server: string; channelId: string }>;
  sends: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  routeFailures: Array<{ channelId: string | null; reason: string }>;
  /** channelId of every inference:started trace — one per (re)started stream. */
  turnLoci: Array<string | undefined>;
  traces: Array<{ type: string; [k: string]: unknown }>;
  internals: Internals;
}

function internalsOf(fw: AgentFramework): Internals {
  return fw as unknown as Internals;
}

/** Real ChannelRegistry over two mock MCPL servers, wired to the framework
 *  the way initializeMcpl wires the production one. */
function attachRegistry(fw: AgentFramework): Omit<Harness, 'fw' | 'membrane' | 'probe' | 'turnLoci' | 'traces' | 'internals'> {
  const published: Publish[] = [];
  const opens: Array<{ server: string; channelId: string }> = [];
  const sends: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const routeFailures: Array<{ channelId: string | null; reason: string }> = [];
  const mkServer = (id: string) => ({
    id,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId: string; content: Array<{ type: string; text?: string }> }) => {
      published.push({ server: id, channelId: p.channelId, text: p.content.map((b) => b.text ?? '').join('') });
      return { delivered: true, messageId: `pub-${published.length}` };
    },
    sendChannelsOpen: async (p: { channelId: string }) => {
      opens.push({ server: id, channelId: p.channelId });
      return {};
    },
    sendChannelsClose: async () => ({}),
    sendChannelsTyping: () => {},
    sendToolsCall: async (tool: string, args: Record<string, unknown>) => {
      sends.push({ server: id, tool, args });
      return {
        content: [{ type: 'text', text: JSON.stringify({ messageId: `sent-${sends.length}`, channelId: args.channelId }) }],
      };
    },
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
      activeChannelResolver: (name) => i.turnChannelFor(name),
      homeChannel: i.mcplHomeChannel ?? undefined,
      onRouteFailure: ({ channelId, reason }) => { routeFailures.push({ channelId, reason }); },
      onChannelAutoOpened: ({ conversationId, serverId, source, channels }) =>
        i.recordChannelAutoOpenNotice(conversationId, serverId, channels, source),
    },
  );
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  const seed = (serverId: string, id: string, label: string, open: boolean) =>
    map.set(destinationKey({ serverId, channelId: id }), { serverId, descriptor: { id, type: serverId, label }, open });
  seed('discord', DM, 'DM: operator', false); // DMs register closed
  seed('discord', HOME, 'home', true);
  seed('discord', CLOSED, 'lounge', false);
  seed('eidoverse', WORLD, 'plaza', true);

  i.channelRegistry = registry;
  i.mcplServerRegistry = serverRegistry;
  i.mcplPrefixMap = new Map([['discord', 'discord'], ['eidoverse', 'eidoverse']]);
  return { registry, published, opens, sends, routeFailures };
}

async function makeHarness(
  dir: string,
  opts: { homeChannel?: string | null; privileged?: boolean; membrane?: ScriptedMembrane; probe?: ProbeModule } = {},
): Promise<Harness> {
  const membrane = opts.membrane ?? new ScriptedMembrane();
  const probe = opts.probe ?? new ProbeModule();
  if (opts.privileged) writeFileSync(join(dir, 'privileged.json'), JSON.stringify([OPERATOR]));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.' }],
    modules: [probe],
    ...(opts.homeChannel === null ? {} : { homeChannel: opts.homeChannel ?? HOME }),
    ...(opts.privileged
      ? {
          gate: {
            configPath: join(dir, 'gate.json'),
            config: { policies: [], default: 'always' as const },
            privilegedUsersPath: join(dir, 'privileged.json'),
          },
        }
      : {}),
  });
  const turnLoci: Array<string | undefined> = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  fw.onTrace((event) => {
    const e = event as { type: string; [k: string]: unknown };
    traces.push(e);
    if (e.type === 'inference:started') turnLoci.push(e.channelId as string | undefined);
  });
  return { fw, membrane, probe, turnLoci, traces, internals: internalsOf(fw), ...attachRegistry(fw) };
}

// ---- events ---------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

/** A Discord DM as discord-mcpl forwards it (push event, closed channel). */
function dmEvent(text: string, opts: { authorId?: string; waking?: boolean } = {}): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: nextId('dm'),
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      channelId: '42',
      guildId: null,
      isDM: true,
      authorName: 'operator',
      authorId: opts.authorId ?? 'U-friend',
      messageId: nextId('m'),
    },
    tags: ['chat:addressed'],
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: opts.waking ?? true,
  } as unknown as ProcessEvent;
}

/** A world-channel message from the second MCPL server (channels/incoming). */
function worldEvent(text: string, opts: { waking?: boolean } = {}): ProcessEvent {
  const waking = opts.waking ?? true;
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'eidoverse',
    channelId: WORLD,
    messageId: nextId('w'),
    author: { id: 'visitor', name: 'visitor' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: waking ? ['chat:mention', 'chat:addressed'] : ['chat:ambient'],
    triggerInference: waking,
  } as unknown as ProcessEvent;
}

/** A channel-less scheduled wake (heartbeat server push). */
function heartbeatEvent(): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'heartbeat',
    featureSet: 'heartbeat',
    eventId: nextId('hb'),
    content: [{ type: 'text', text: '[heartbeat] scheduled check-in' }],
    origin: { source: 'heartbeat' },
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

// ---- responses ------------------------------------------------------------

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const tool = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const round = (...blocks: ContentBlock[]) => createMockResponse(blocks, 'tool_use');
const final = (...blocks: ContentBlock[]) => createMockResponse(blocks);

// ---- inspection -----------------------------------------------------------

const blockText = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .map((b: { type?: string; text?: string; content?: unknown }) =>
      b?.type === 'text' ? b.text ?? '' : b?.content ? blockText(b.content) : '')
    .join('\n');

/** Everything the model was shown in one request. */
const requestText = (req: NormalizedRequest): string =>
  (req.messages ?? []).map((m) => blockText((m as { content: unknown }).content)).join('\n');

/** Everything injected into one stream at its tool boundaries. */
const injectedText = (stream: MockYieldingStream): string =>
  stream.receivedToolResultOptions
    .flatMap((o) => o?.injectedMessages ?? [])
    .map((m) => blockText(m.content))
    .join('\n');

const windowTexts = (fw: AgentFramework): string[] =>
  fw.getAgent(AGENT)!.getContextManager().getAllMessages().map((m) => blockText(m.content));

const publishedTo = (h: Harness, channelId: string): string[] =>
  h.published.filter((p) => p.channelId === channelId).map((p) => p.text);

/** Let the run loop process a pushed event while a tool round is pending. */
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------

describe('strict routing privacy (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-routing-'));
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.ROUTING_STRICT = 'true';
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    process.env.ROUTING_NO_SILENCE_ON_SEND = 'true';
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      // A tool call that outlived an aborted turn returns into the running
      // framework, never into a stopped one.
      await Promise.all([...h.probe.inFlight]);
      await h.fw.runUntilIdle();
      try { await h.fw.stop(); } catch { /* already stopped */ }
    }
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function harness(opts: Parameters<typeof makeHarness>[1] = {}): Promise<Harness> {
    const h = await makeHarness(dir, opts);
    harnesses.push(h);
    return h;
  }

  it('P1: a world mention mid-DM-turn is held, never injected, and answered in its own world turn', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Looking into it.'), tool('c1', 'probe--wait')),
        final(text('Here is my private answer.')),
      )
      .turn(final(text('Hello, world!')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('@resident come see the fountain'));
      await settle();
    });

    h.fw.pushEvent(dmEvent('private: how was your day?'));
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 2, 'two turns: the DM, then the world');
    assert.deepEqual(h.turnLoci, [DM, WORLD], 'each turn is locked to its own place');
    // Nothing of the DM turn reached the world; the world turn reached only the world.
    assert.deepEqual(publishedTo(h, DM), ['Looking into it.', 'Here is my private answer.']);
    assert.deepEqual(publishedTo(h, WORLD), ['Hello, world!']);
    assert.equal(h.published.length, 3, 'no publication anywhere else');
    // The mention was never injected into the DM turn.
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /fountain/);
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /fountain/);
    // The world turn's NEW input is the world message alone: it directly
    // follows the DM turn's last assistant message.
    const worldReq = h.membrane.calls[1]!;
    const msgs = worldReq.messages ?? [];
    assert.match(blockText((msgs.at(-1) as { content: unknown }).content), /come see the fountain/);
    assert.match(blockText((msgs.at(-2) as { content: unknown }).content), /Here is my private answer\./);
    // Delivering into the closed DM did not open it (CHANNEL_OPEN_ON_SEND=false),
    // and no notices of any kind were written.
    assert.deepEqual(h.opens, []);
    assert.equal(h.registry.isChannelOpen({ serverId: 'discord', channelId: DM }), false);
    const window = windowTexts(h.fw).join('\n');
    assert.doesNotMatch(window, /\[routing\]|\[delivered\]|\[channels\] Now open/);
  });

  it('P2: a DM arriving mid-world-turn never reaches the world turn and is answered in the DM', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Walking to the fountain.'), tool('c1', 'probe--wait')),
        final(text('The fountain is lovely today.')),
      )
      .turn(final(text('Only for you: it is 1234.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(dmEvent('private: what is the door code?'));
      await settle();
    });

    h.fw.pushEvent(worldEvent('@resident join us'));
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 2);
    assert.deepEqual(h.turnLoci, [WORLD, DM]);
    assert.deepEqual(publishedTo(h, WORLD), ['Walking to the fountain.', 'The fountain is lovely today.']);
    assert.deepEqual(publishedTo(h, DM), ['Only for you: it is 1234.']);
    assert.equal(h.published.length, 3);
    // The DM's words never entered the world turn's context.
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /door code/);
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /door code/);
    assert.match(requestText(h.membrane.calls[1]!), /door code/);
  });

  for (const order of ['dm-first', 'world-first'] as const) {
    it(`P3 (${order}): simultaneous DM + world mention while idle → two turns, earliest first, neither sees the other`, async () => {
      const h = await harness();
      const first = order === 'dm-first' ? DM : WORLD;
      const second = order === 'dm-first' ? WORLD : DM;
      h.membrane
        .turn(final(text(`answer for ${first}`)))
        .turn(final(text(`answer for ${second}`)));
      // Both arrive before any turn can start (delivered straight to the
      // ingest handlers, as one scheduler batch).
      const i = h.internals;
      const dm = async () => { i.handleMcplPushEvent(dmEvent('private: the DM words')); };
      const world = async () => { await i.handleMcplChannelIncoming(worldEvent('@resident the world words')); };
      if (order === 'dm-first') { await dm(); await settle(5); await world(); }
      else { await world(); await settle(5); await dm(); }

      // The later arrival is held, not stored, while the earlier place's wake waits.
      const laterText = order === 'dm-first' ? /the world words/ : /the DM words/;
      assert.doesNotMatch(windowTexts(h.fw).join('\n'), laterText, 'held until its own turn');

      await h.fw.runUntilIdle();

      assert.equal(h.membrane.calls.length, 2);
      assert.deepEqual(h.turnLoci, [first, second], 'earliest-arrived place first');
      assert.deepEqual(publishedTo(h, first), [`answer for ${first}`]);
      assert.deepEqual(publishedTo(h, second), [`answer for ${second}`]);
      assert.equal(h.published.length, 2);
      const firstReq = requestText(h.membrane.calls[0]!);
      const secondReq = requestText(h.membrane.calls[1]!);
      const earlyText = order === 'dm-first' ? /the DM words/ : /the world words/;
      assert.match(firstReq, earlyText);
      assert.doesNotMatch(firstReq, laterText, 'the second place is invisible to the first turn');
      assert.match(secondReq, laterText);
    });
  }

  it('P4: a no-trigger heartbeat turn publishes to the home channel only', async () => {
    const h = await harness();
    // A most-recent-inbound default that must NOT be used.
    (h.registry as unknown as { defaultPublishChannel: ChannelRef }).defaultPublishChannel = { serverId: 'eidoverse', channelId: WORLD };
    h.membrane.turn(final(text('Quiet afternoon check-in.')));
    h.fw.pushEvent(heartbeatEvent());
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [HOME]);
    assert.deepEqual(h.published, [{ server: 'discord', channelId: HOME, text: 'Quiet afternoon check-in.' }]);
  });

  it('P4: with no home channel configured, a no-trigger turn publishes nowhere (kept private, no failure marker)', async () => {
    const h = await harness({ homeChannel: null });
    (h.registry as unknown as { defaultPublishChannel: ChannelRef }).defaultPublishChannel = { serverId: 'eidoverse', channelId: WORLD };
    h.membrane.turn(
      round(text('Thinking out loud.'), tool('c1', 'probe--wait')),
      final(text('Private musing.')),
    );
    h.fw.pushEvent(heartbeatEvent());
    await h.fw.runUntilIdle();
    assert.equal(h.membrane.calls.length, 1);
    assert.deepEqual(h.turnLoci, [undefined], 'the turn has no locus');
    assert.deepEqual(h.published, [], 'nothing published anywhere — not the most-recent-inbound channel');
    assert.deepEqual(h.routeFailures, [], 'a locus-less turn is not a delivery failure');
    assert.doesNotMatch(windowTexts(h.fw).join('\n'), /send-failed/);
  });

  it('P5: a same-place follow-up mid-turn is still injected (hear-while-acting) and the locus does not move', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Checking.'), tool('c1', 'probe--wait')),
        final(text('Yes, and about your follow-up: sure.')),
      )
      // The follow-up's own wake runs a second DM turn afterwards (as upstream).
      .turn(final(text('Anything else?')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(dmEvent('private: and one more thing'));
      await settle();
    });
    h.fw.pushEvent(dmEvent('private: can you check?'));
    await h.fw.runUntilIdle();

    assert.match(injectedText(h.membrane.streams[0]!), /one more thing/, 'injected into the live turn');
    assert.deepEqual(h.turnLoci, [DM, DM]);
    assert.deepEqual(publishedTo(h, DM), ['Checking.', 'Yes, and about your follow-up: sure.', 'Anything else?']);
    assert.equal(h.published.length, 3);
  });

  it('P6: an explicit send_message elsewhere works, keeps the locus, does not silence prose, does not reopen the target', async () => {
    const h = await harness();
    h.membrane.turn(
      round(
        text('Passing that along.'),
        tool('c1', 'discord--send_message', { channelId: CLOSED, text: 'note for the lounge' }),
      ),
      final(text('Done — back to you.')),
    );
    h.fw.pushEvent(dmEvent('private: tell the lounge I am late'));
    await h.fw.runUntilIdle();
    await settle(10); // the open-on-send decision is fire-and-forget

    assert.deepEqual(h.sends, [{ server: 'discord', tool: 'send_message', args: { channelId: CLOSED, text: 'note for the lounge' } }]);
    assert.deepEqual(h.turnLoci, [DM]);
    assert.equal(h.internals.turnChannelFor(AGENT)?.channelId, DM, 'the locus never moved');
    assert.deepEqual(publishedTo(h, DM), ['Passing that along.', 'Done — back to you.'], 'prose not silenced');
    assert.deepEqual(publishedTo(h, CLOSED), [], 'the explicit send is the only thing that reached the lounge');
    assert.deepEqual(h.opens, [], 'no channel was opened');
    assert.equal(h.registry.isChannelOpen({ serverId: 'discord', channelId: CLOSED }), false);
    assert.equal(h.registry.getDesiredState('discord', CLOSED), undefined, 'no lifecycle change recorded');
  });

  it('P6/S6: a world `say` mid-turn neither moves the locus nor silences prose', async () => {
    const h = await harness();
    h.membrane.turn(
      round(text('One moment.'), tool('c1', 'probe--say', { text: 'brb' })),
      final(text('Back in the DM.')),
    );
    h.fw.pushEvent(dmEvent('private: are you there?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM]);
    assert.equal(h.internals.turnChannelFor(AGENT)?.channelId, DM);
    assert.deepEqual(publishedTo(h, DM), ['One moment.', 'Back in the DM.']);
    assert.deepEqual(publishedTo(h, WORLD), []);
  });

  it('P7: an ambient message from another place mid-turn is held, stored after the turn, and starts no turn', async () => {
    const h = await harness();
    h.membrane.turn(
      round(text('Let me look.'), tool('c1', 'probe--wait')),
      final(text('Found it.')),
    );
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('visitor: lovely weather in the plaza', { waking: false }));
      await settle();
      // Held: not in the window while the turn runs.
      assert.doesNotMatch(windowTexts(h.fw).join('\n'), /lovely weather/);
    });
    h.fw.pushEvent(dmEvent('private: find my notes?'));
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 1, 'no turn for an ambient message');
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /lovely weather/);
    assert.deepEqual(publishedTo(h, WORLD), []);
    const window = windowTexts(h.fw);
    const found = window.findIndex((t) => /Found it\./.test(t));
    const ambient = window.findIndex((t) => /lovely weather/.test(t));
    assert.ok(found >= 0 && ambient > found, 'stored after the turn, as if it arrived while idle');
    assert.equal(h.internals.deferredMessages.length, 0, 'nothing left held');
  });

  it('P8: an abort mid-turn does not lose held messages — their place is answered next', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Starting.'), tool('c1', 'probe--wait')),
        final(text('never delivered')),
      )
      .turn(final(text('World, I am here.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('@resident are you coming?'));
      await settle();
      h.fw.abortInference(AGENT, 'operator-stop');
      await settle();
    });
    h.fw.pushEvent(dmEvent('private: start something long'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, DM), ['Starting.']);
    assert.deepEqual(publishedTo(h, WORLD), ['World, I am here.']);
    assert.deepEqual(h.turnLoci, [DM, WORLD]);
    assert.match(requestText(h.membrane.calls[1]!), /are you coming\?/);
  });

  it('P8: a stop mid-turn does not lose held messages — they survive the restart and wake their own turn', async () => {
    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const a = await makeHarness(dir, { membrane, probe });
    membrane.turn(
      round(text('Long task.'), tool('c1', 'probe--wait')),
      final(text('never delivered')),
    );
    probe.hooks.push(async () => {
      a.fw.pushEvent(worldEvent('@resident hello from the plaza'));
      // The tool never returns: the process goes down mid-turn.
      await new Promise<void>(() => {});
    });
    a.fw.start();
    a.fw.pushEvent(dmEvent('private: begin'));
    await waitFor('the world mention to be held', () =>
      a.internals.deferredMessages.some((m) => m.metadata?.channelId === WORLD));
    const recovery = join(dir, 'store', 'recovery', 'deferred-writes.json');
    assert.ok(existsSync(recovery), 'the hold is mirrored durably');
    assert.match(readFileSync(recovery, 'utf8'), /hello from the plaza/);
    await a.fw.stop();

    assert.deepEqual(publishedTo(a, WORLD), [], 'nothing reached the world before the stop');

    const membrane2 = new ScriptedMembrane().turn(final(text('Sorry for the wait, plaza!')));
    const b = await makeHarness(dir, { membrane: membrane2 });
    harnesses.push(b);
    await b.fw.runUntilIdle();

    assert.equal(membrane2.calls.length, 1, 'the restored hold woke its own turn');
    assert.deepEqual(b.turnLoci, [WORLD]);
    assert.deepEqual(b.published, [{ server: 'eidoverse', channelId: WORLD, text: 'Sorry for the wait, plaza!' }]);
    const window = windowTexts(b.fw);
    assert.equal(window.filter((t) => /hello from the plaza/.test(t)).length, 1, 'stored exactly once');
  });

  it('P9: the privileged-human brake pedal still interrupts, and its message is answered in its own place', async () => {
    const h = await harness({ privileged: true });
    h.membrane
      .turn(
        round(text('Building a tower.'), tool('c1', 'probe--wait')),
        final(text('never delivered')),
      )
      .turn(final(text('Stopped. What is up?')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(dmEvent('private: stop please', { authorId: OPERATOR }));
      await settle(60);
    });
    h.fw.pushEvent(worldEvent('@resident build something'));
    await h.fw.runUntilIdle();

    assert.ok(
      h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'),
      'the in-flight turn was aborted',
    );
    assert.deepEqual(publishedTo(h, WORLD), ['Building a tower.'], 'the interrupted turn said nothing more');
    assert.deepEqual(publishedTo(h, DM), ['Stopped. What is up?']);
    assert.deepEqual(h.turnLoci, [WORLD, DM]);
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /stop please/);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /stop please/);
  });

  it('S2/S4: channel-less operator input (CLI) mid-world-turn is held and answered in a home-channel turn', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Stacking blocks.'), tool('c1', 'probe--wait')),
        final(text('Tower done.')),
      )
      .turn(final(text('Got your note.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({ type: 'external-message', source: 'cli', content: 'operator: private note about the deploy', metadata: {} } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident build a tower'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [WORLD, HOME]);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /private note/, 'not heard inside the world turn');
    assert.deepEqual(publishedTo(h, WORLD), ['Stacking blocks.', 'Tower done.']);
    assert.deepEqual(publishedTo(h, HOME), ['Got your note.']);
    assert.match(requestText(h.membrane.calls[1]!), /private note about the deploy/);
  });

  it('S3: wakes of different places parked by a quiesce keep their own turns at resume', async () => {
    const h = await harness();
    h.membrane.turn(final(text('dm answer'))).turn(final(text('world answer')));
    await h.fw.quiesce({ reason: 'test' });
    h.fw.pushEvent(dmEvent('private: during maintenance'));
    h.fw.pushEvent(worldEvent('@resident during maintenance too'));
    await h.fw.runUntilIdle();
    assert.equal(h.membrane.calls.length, 0);
    await h.fw.resume();
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, WORLD]);
    assert.deepEqual(publishedTo(h, DM), ['dm answer']);
    assert.deepEqual(publishedTo(h, WORLD), ['world answer']);
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /during maintenance too/);
  });

  it('S4 (armed place): a reminder a DM turn armed on a server is answered in the DM, also after a restart', async () => {
    const membrane = new ScriptedMembrane();
    const a = await makeHarness(dir, { membrane });
    membrane.turn(
      round(
        text('Noted.'),
        tool('c1', 'discord--reminder_add', { inMinutes: 60, message: 'Tell the operator the lab results are fine.' }),
      ),
      final(text('I will remind you.')),
    );
    a.fw.pushEvent(dmEvent('private: remind me about the lab results in an hour'));
    await a.fw.runUntilIdle();
    assert.deepEqual(a.sends.map((s) => s.tool), ['reminder_add'], 'the DM turn armed the reminder');
    assert.deepEqual(publishedTo(a, DM), ['Noted.', 'I will remind you.']);
    await a.fw.stop();

    // After a restart the server fires the reminder: a channel-less push that
    // names the id the server answered the arming call with (`sent-1`).
    const membrane2 = new ScriptedMembrane().turn(final(text('Reminder: the lab results are fine.')));
    const b = await makeHarness(dir, { membrane: membrane2 });
    harnesses.push(b);
    b.fw.pushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'reminders',
      eventId: nextId('rem'),
      content: [text('A reminder is due.')],
      origin: { source: 'reminder', reminderId: 'sent-1' },
      timestamp: new Date().toISOString(),
      inferenceId: nextId('inf'),
      triggerInference: true,
    } as unknown as ProcessEvent);
    await b.fw.runUntilIdle();

    assert.deepEqual(b.turnLoci, [DM], 'the reminder is answered in the place that armed it');
    assert.deepEqual(publishedTo(b, HOME), [], 'never in the home channel');
    assert.deepEqual(publishedTo(b, DM), ['Reminder: the lab results are fine.']);
  });

  it('S2 (module place): content a module relays for a DM is held from a world turn and answered in the DM', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Admiring the plaza.'), tool('c1', 'probe--wait')),
        final(text('Lovely plaza.')),
      )
      .turn(final(text('Your file is summarized.')));
    h.probe.hooks.push(async () => {
      // A module relaying a result produced for the DM names the DM.
      h.probe.ctx!.addMessage('user', [text('[relay] RELAYED-DM-RESULT: summary of the private file')],
        { channelId: DM, serverId: 'discord' } as never);
      h.probe.ctx!.pushEvent({
        type: 'inference-request', agentName: AGENT, reason: 'relay-done', source: 'relay',
        channelId: DM, serverId: 'discord',
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident look around'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [WORLD, DM]);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /RELAYED-DM-RESULT/, 'not heard inside the world turn');
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /RELAYED-DM-RESULT/);
    assert.deepEqual(publishedTo(h, WORLD), ['Admiring the plaza.', 'Lovely plaza.']);
    assert.deepEqual(publishedTo(h, DM), ['Your file is summarized.']);
    assert.deepEqual(publishedTo(h, HOME), []);
  });

  it('closed-channel invitation: plain wording, no delivery-opens claim, other places need a send tool', async () => {
    const h = await harness();
    h.internals.handleMcplPushEvent(dmEvent('private: hi', { waking: false }));
    const invitation = windowTexts(h.fw).find((t) => /Channel invitation/.test(t)) ?? '';
    assert.match(invitation, /1\. Reply — if this turn's replies go to #DM: operator, write your reply as plain text and it lands there; from anywhere else, use an explicit send tool with channelId "discord:dm:42"\. Replying does not join the channel\./);
    assert.doesNotMatch(invitation, /opens the channel|did not start a turn|moves the pin/);
  });
});

// ---------------------------------------------------------------------------
// P10: flags unset → upstream behavior (the same P1 scenario re-pins).
// ---------------------------------------------------------------------------

describe('strict routing flags unset (P10: upstream behavior unchanged)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-routing-off-'));
    for (const f of FLAGS) { saved[f] = process.env[f]; delete process.env[f]; }
  });

  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a world mention mid-DM-turn is injected and re-pins the trailing prose (upstream), and delivery opens the DM', async () => {
    const h = await makeHarness(dir);
    try {
      h.membrane
        .turn(
          round(text('Looking into it.'), tool('c1', 'probe--wait')),
          final(text('Answering the mention.')),
        )
        .turn(final(text('(follow-up turn)')));
      h.probe.hooks.push(async () => {
        h.fw.pushEvent(worldEvent('@resident come see the fountain'));
        await settle();
      });
      h.fw.pushEvent(dmEvent('private: how was your day?'));
      await h.fw.runUntilIdle();

      assert.match(injectedText(h.membrane.streams[0]!), /come see the fountain/, 'heard mid-turn');
      assert.deepEqual(publishedTo(h, DM), ['Looking into it.']);
      assert.ok(publishedTo(h, WORLD).includes('Answering the mention.'), 'the addressed re-pin moved the trailing prose');
      assert.deepEqual(h.opens, [{ server: 'discord', channelId: DM }], 'delivery opened the closed DM');
      assert.match(windowTexts(h.fw).join('\n'), /\[routing\]/, 'routing notices are written');
    } finally {
      await h.fw.stop();
    }
  });

  it('a no-trigger turn with no home channel falls back to the most-recent-inbound channel (upstream)', async () => {
    const h = await makeHarness(dir, { homeChannel: null });
    try {
      (h.registry as unknown as { defaultPublishChannel: ChannelRef }).defaultPublishChannel = { serverId: 'eidoverse', channelId: WORLD };
      h.membrane.turn(final(text('musing')));
      h.fw.pushEvent(heartbeatEvent());
      await h.fw.runUntilIdle();
      assert.deepEqual(h.published, [{ server: 'eidoverse', channelId: WORLD, text: 'musing' }]);
    } finally {
      await h.fw.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// ChannelRegistry under the flags (no framework).
// ---------------------------------------------------------------------------

describe('ChannelRegistry under ROUTING_STRICT / CHANNEL_OPEN_ON_SEND=false', () => {
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  beforeEach(() => { for (const f of FLAGS) { saved[f] = process.env[f]; delete process.env[f]; } });
  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  });

  function bareRegistry(opts: { homeChannel?: string; active?: string } = {}) {
    const published: Publish[] = [];
    const opens: string[] = [];
    const failures: string[] = [];
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsPublish: async (p: { channelId: string; content: Array<{ text?: string }> }) => {
        published.push({ server: 'discord', channelId: p.channelId, text: p.content.map((b) => b.text ?? '').join('') });
        return { delivered: true };
      },
      sendChannelsOpen: async (p: { channelId: string }) => { opens.push(p.channelId); return {}; },
    };
    const registry = new ChannelRegistry(
      { getServer: () => server } as unknown as McplServerRegistry,
      {} as FeatureSetManager,
      () => {},
      () => {},
      {
        activeChannelResolver: () => (opts.active ? { serverId: 'discord', channelId: opts.active } : undefined),
        homeChannel: opts.homeChannel,
        onRouteFailure: ({ reason }) => { failures.push(reason); },
      },
    );
    const r = registry as unknown as {
      channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
      defaultPublishChannel: ChannelRef | null;
      defaultPublishMessageId: string | null;
    };
    r.channels.set(destinationKey({ serverId: 'discord', channelId: DM }), { serverId: 'discord', descriptor: { id: DM, type: 'discord', label: 'DM: operator' }, open: false });
    r.channels.set(destinationKey({ serverId: 'discord', channelId: HOME }), { serverId: 'discord', descriptor: { id: HOME, type: 'discord', label: 'home' }, open: true });
    r.defaultPublishChannel = { serverId: 'discord', channelId: DM }; // the most recent inbound
    r.defaultPublishMessageId = 'm-last';
    return { registry, published, opens, failures };
  }

  it('resolveLocus / buildChannelContext never fall back to the most recent inbound under ROUTING_STRICT', () => {
    const { registry } = bareRegistry();
    assert.equal(registry.resolveLocus(AGENT)?.channelId, DM, 'upstream falls back to the most recent inbound');
    assert.equal(registry.buildChannelContext(AGENT, 'discord')?.defaultOutgoing?.channelId, DM);
    process.env.ROUTING_STRICT = 'true';
    assert.equal(registry.resolveLocus(AGENT), null);
    const ctx = registry.buildChannelContext(AGENT, 'discord');
    assert.equal(ctx?.defaultOutgoing, undefined);
    assert.equal(ctx?.incoming, undefined, 'another place\'s latest message is not advertised');
    const homed = bareRegistry({ homeChannel: HOME }).registry;
    assert.equal(homed.resolveLocus(AGENT)?.channelId, HOME);
    assert.equal(bareRegistry({ homeChannel: HOME, active: DM }).registry.buildChannelContext(AGENT, 'discord')?.incoming?.channelId, DM,
      'the incoming message is named when it is the outgoing place');
  });

  it('channel_publish without a channelId is refused under ROUTING_STRICT (no default channel)', async () => {
    const { registry, published } = bareRegistry();
    process.env.ROUTING_STRICT = 'true';
    const refused = await registry.handleChannelToolCall('channel_publish', { content: 'hello' });
    assert.equal(refused.success, false);
    assert.match(String(refused.error), /needs a `channelId`, and there's no channel to default to/);
    assert.deepEqual(published, []);
    const ok = await registry.handleChannelToolCall('channel_publish', { channelId: HOME, content: 'hello' });
    assert.equal(ok.success, true);
    assert.deepEqual(published, [{ server: 'discord', channelId: HOME, text: 'hello' }]);
  });

  it('a locus-less routeSpeech is kept private under ROUTING_STRICT (no failure callback)', async () => {
    const { registry, failures } = bareRegistry();
    assert.equal(await registry.routeSpeech(AGENT, 'x', null), null);
    assert.equal(failures.length, 1, 'upstream reports a routing failure');
    process.env.ROUTING_STRICT = 'true';
    assert.equal(await registry.routeSpeech(AGENT, 'x', null), null);
    assert.equal(failures.length, 1, 'strict: no failure marker for a designed no-locus turn');
  });

  it('CHANNEL_OPEN_ON_SEND=false: routed prose and explicit sends deliver into a closed channel without opening it', async () => {
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    const { registry, published, opens } = bareRegistry();
    const outcome = await registry.routeSpeech(AGENT, 'quiet reply', { serverId: 'discord', channelId: DM });
    assert.deepEqual(outcome, { delivered: true, serverId: 'discord', channelId: DM });
    assert.deepEqual(published.map((p) => p.channelId), [DM]);
    assert.deepEqual(opens, []);
    assert.equal(registry.isChannelOpen({ serverId: 'discord', channelId: DM }), false);
    assert.equal(registry.getDesiredState('discord', DM), undefined, 'no lifecycle entry');
    const sent = await registry.openIfClosedForSend(DM, 'discord');
    assert.equal(sent.status, 'left-closed');
    assert.deepEqual(opens, []);
    delete process.env.CHANNEL_OPEN_ON_SEND;
    const reopened = await registry.openIfClosedForSend(DM, 'discord');
    assert.equal(reopened.status, 'opened', 'flag unset: upstream send-opens-channel');
  });
});
