/**
 * Adversarial review of strict routing (ROUTING_STRICT=true,
 * CHANNEL_OPEN_ON_SEND=false), publication-path lens.
 *
 * Each case below is a suspected LEAK / LOSS / REGRESSION in a path that
 * publishes prose (or decides where prose goes) under strict routing. Every
 * case asserts the privacy requirement — words meant for one place are never
 * published in, or made visible to, another place — so a failing case is a
 * demonstrated defect, not a style nit.
 *
 * Harness: the REAL framework turn machinery and the REAL ChannelRegistry over
 * mock MCPL servers (same shape as strict-routing-privacy.test.ts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type {
  AgentConfig,
  EventResponse,
  Module,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const AGENT = 'resident';
const DM = 'discord:dm:42';
const WORLD = 'world:plaza';
const COMMONS = 'world:commons';
const HOME = 'discord:G1:home';

const FLAGS = ['ROUTING_STRICT', 'CHANNEL_OPEN_ON_SEND', 'ROUTING_NO_SILENCE_ON_SEND'] as const;

// ---------------------------------------------------------------------------
// Harness
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

/** `wait` runs the next queued hook while the tool round is pending. CLI
 *  operator input honors `triggerInference` like the host's TUI module. */
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
    const e = event as { type: string; source?: string; content?: unknown; triggerInference?: boolean };
    if (e.type === 'external-message' && e.source === 'cli') {
      return {
        addMessages: [{ participant: 'operator', content: [{ type: 'text', text: String(e.content) }] }],
        ...(e.triggerInference !== false ? { requestInference: true } : {}),
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
  turnLocusPins: Map<string, string>;
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
  recordChannelAutoOpenNotice(
    agentName: string | undefined,
    channels: Array<{ channelId: string; label?: string }>,
    cause: string,
  ): void;
}

interface Publish { server: string; channelId: string; text: string; conversationId: string }

interface Seed { server: string; id: string; label: string; open: boolean }

const DEFAULT_SEEDS: Seed[] = [
  { server: 'discord', id: DM, label: 'DM: operator', open: false },
  { server: 'discord', id: HOME, label: 'home', open: true },
  { server: 'eidoverse', id: WORLD, label: 'plaza', open: true },
];

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  registry: ChannelRegistry;
  published: Publish[];
  sends: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  chunks: Array<{ server: string; channelId: string; delta: string }>;
  turnLoci: Array<string | undefined>;
  traces: Array<{ type: string; [k: string]: unknown }>;
  internals: Internals;
}

function attachRegistry(fw: AgentFramework, seeds: Seed[]) {
  const published: Publish[] = [];
  const sends: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const chunks: Array<{ server: string; channelId: string; delta: string }> = [];
  const mkServer = (id: string) => ({
    id,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId: string; conversationId: string; content: Array<{ type: string; text?: string }> }) => {
      published.push({
        server: id,
        channelId: p.channelId,
        conversationId: p.conversationId,
        text: p.content.map((b) => b.text ?? '').join(''),
      });
      return { delivered: true, messageId: `pub-${published.length}` };
    },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
    sendChannelsTyping: () => {},
    sendChannelsOutgoingChunk: (p: { channelId: string; delta: string }) => {
      chunks.push({ server: id, channelId: p.channelId, delta: p.delta });
    },
    sendChannelsOutgoingComplete: () => {},
    sendToolsCall: async (tool: string, args: Record<string, unknown>) => {
      sends.push({ server: id, tool, args });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  });
  const servers: Record<string, ReturnType<typeof mkServer>> = {};
  for (const s of seeds) servers[s.server] ??= mkServer(s.server);
  const serverRegistry = {
    getServer: (id: string) => servers[id],
    getAllServers: () => [],
    closeAll: async () => {},
  };
  const i = fw as unknown as Internals;
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
      onRouteFailure: () => {},
      onChannelAutoOpened: ({ conversationId, source, channels }) =>
        i.recordChannelAutoOpenNotice(conversationId, channels, source),
    },
  );
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  for (const s of seeds) {
    map.set(`${s.server}:${s.id}`, { serverId: s.server, descriptor: { id: s.id, type: s.server, label: s.label }, open: s.open });
  }
  i.channelRegistry = registry;
  i.mcplServerRegistry = serverRegistry;
  i.mcplPrefixMap = new Map(Object.keys(servers).map((k) => [k, k]));
  return { registry, published, sends, chunks };
}

async function makeHarness(
  dir: string,
  opts: { homeChannel?: string | null; seeds?: Seed[]; agent?: Partial<AgentConfig> } = {},
): Promise<Harness> {
  const membrane = new ScriptedMembrane();
  const probe = new ProbeModule();
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.', ...(opts.agent ?? {}) }],
    modules: [probe],
    ...(opts.homeChannel === null ? {} : { homeChannel: opts.homeChannel ?? HOME }),
  });
  const turnLoci: Array<string | undefined> = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  fw.onTrace((event) => {
    const e = event as { type: string; [k: string]: unknown };
    traces.push(e);
    if (e.type === 'inference:started' && e.agentName === AGENT) turnLoci.push(e.channelId as string | undefined);
  });
  return {
    fw,
    membrane,
    probe,
    turnLoci,
    traces,
    internals: fw as unknown as Internals,
    ...attachRegistry(fw, opts.seeds ?? DEFAULT_SEEDS),
  };
}

// ---- events ---------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

function dmEvent(text: string, opts: { waking?: boolean } = {}): ProcessEvent {
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
      authorId: 'U-friend',
      messageId: nextId('m'),
    },
    tags: ['chat:addressed'],
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: opts.waking ?? true,
  } as unknown as ProcessEvent;
}

function worldEvent(text: string, opts: { waking?: boolean; serverId?: string; channelId?: string } = {}): ProcessEvent {
  const waking = opts.waking ?? true;
  return {
    type: 'mcpl:channel-incoming',
    serverId: opts.serverId ?? 'eidoverse',
    channelId: opts.channelId ?? WORLD,
    messageId: nextId('w'),
    author: { id: 'visitor', name: 'visitor' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: waking ? ['chat:mention', 'chat:addressed'] : ['chat:ambient'],
    triggerInference: waking,
  } as unknown as ProcessEvent;
}

// ---- responses / inspection ----------------------------------------------

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
const injectedText = (stream: MockYieldingStream): string =>
  stream.receivedToolResultOptions
    .flatMap((o) => o?.injectedMessages ?? [])
    .map((m) => blockText(m.content))
    .join('\n');
const publishedTo = (h: Harness, channelId: string, server?: string): string[] =>
  h.published
    .filter((p) => p.channelId === channelId && (server === undefined || p.server === server))
    .map((p) => p.text);
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

describe('strict routing hunt — publication paths (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-hunt-pub-'));
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.ROUTING_STRICT = 'true';
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    process.env.ROUTING_NO_SILENCE_ON_SEND = 'true';
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await Promise.all([...h.probe.inFlight]);
      try { await h.fw.runUntilIdle(); } catch { /* best effort */ }
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

  // -------------------------------------------------------------------------
  // H1 — places are keyed by the BARE channel id, and routeSpeech resolves a
  // bare id with first-match (findChannelEntry). Two world servers that both
  // serve the default world name ("world:commons" — the eidoverse default) are
  // two different places, but strict routing treats them as one.
  // -------------------------------------------------------------------------

  const TWO_WORLDS: Seed[] = [
    { server: 'discord', id: DM, label: 'DM: operator', open: false },
    { server: 'discord', id: HOME, label: 'home', open: true },
    // The agent's home world body …
    { server: 'eidoverse', id: COMMONS, label: 'commons', open: true },
    // … and a second body visiting another eidoverse deployment (mcpl_deploy
    // access:"eidoverse"), whose default world has the same name.
    { server: 'eidoverse-visit', id: COMMONS, label: 'commons', open: true },
  ];

  it('H1a: a turn woken in the VISITED world publishes into the visited world, not the home world with the same channel id', async () => {
    const h = await harness({ seeds: TWO_WORLDS });
    h.membrane.turn(final(text('Hello, visitors of the other commons.')));
    h.fw.pushEvent(worldEvent('@resident welcome to our commons!', { serverId: 'eidoverse-visit', channelId: COMMONS }));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [COMMONS]);
    assert.deepEqual(
      h.published.map((p) => p.server),
      ['eidoverse-visit'],
      `the visited world's reply must reach the visited world only; got ${JSON.stringify(h.published)}`,
    );
  });

  it('H1b: a message from the OTHER world server with the same channel id is held, not heard mid-turn', async () => {
    const h = await harness({ seeds: TWO_WORLDS });
    h.membrane
      .turn(
        round(text('Looking around.'), tool('c1', 'probe--wait')),
        final(text('Nice place.')),
      )
      .turn(final(text('(home world turn)')));
    h.probe.hooks.push(async () => {
      // Speech in the HOME world while the agent is answering the visited one.
      h.fw.pushEvent(worldEvent('@resident home-world secret: the vault is under the fountain', {
        serverId: 'eidoverse', channelId: COMMONS,
      }));
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident hi from the visited commons', { serverId: 'eidoverse-visit', channelId: COMMONS }));
    await h.fw.runUntilIdle();

    assert.doesNotMatch(
      injectedText(h.membrane.streams[0]!),
      /vault is under the fountain/,
      'home-world speech was injected into the visited-world turn (same bare channel id treated as the same place)',
    );
  });

  it('H1c: a self-deployed server that registered a DM\'s channel id first does not receive that DM\'s replies', async () => {
    // DMs register LAZILY (ensureChannelRegistered on their first push
    // event), so any server that already registered the same bare id — e.g.
    // one the agent deployed with mcpl_deploy — owns the id in the registry:
    // ensureChannelRegistered sees "existing" and returns, and routeSpeech's
    // first-match lookup hands every DM reply to that server.
    const h = await harness({
      seeds: [
        { server: 'sketchy', id: DM, label: 'lobby', open: true },
        { server: 'discord', id: HOME, label: 'home', open: true },
        { server: 'eidoverse', id: WORLD, label: 'plaza', open: true },
      ],
    });
    h.membrane.turn(final(text('Only for you: the clinic called back, it is benign.')));
    h.fw.pushEvent(dmEvent('private: any news from the clinic?'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM]);
    assert.deepEqual(
      h.published.map((p) => p.server),
      ['discord'],
      `the DM reply must go to the server the DM came from; got ${JSON.stringify(h.published)}`,
    );
  });

  // -------------------------------------------------------------------------
  // H2 — framework follow-up wakes that re-run or continue a channel turn
  // carry NO channelId (refusal-rewind-retry, unstick-retry,
  // inference-failure-rewind-retry, prose-bounce, prose-continuation). Under
  // strict routing a channel-less wake's place is the HOME channel, so the
  // re-run of a DM conversation publishes its DM reply in the home channel.
  // -------------------------------------------------------------------------

  it('H2a: the refusal auto-rewind retry of a DM turn does not publish the DM reply in the home channel', async () => {
    const h = await harness({ agent: { refusalHandling: { autoRewind: true, maxRewinds: 2 } } });
    h.membrane
      .turn(createMockResponse([], 'refusal'))
      .turn(final(text('Sorry about that — about your private question: yes, I will keep it between us.')));
    h.fw.pushEvent(dmEvent('private: can you keep a secret about my health?'));
    await h.fw.runUntilIdle();

    assert.ok(h.membrane.calls.length >= 2, 'the refused DM turn was retried');
    assert.deepEqual(
      publishedTo(h, HOME),
      [],
      `the retried DM conversation must not be answered in the home channel; turn loci ${JSON.stringify(h.turnLoci)}`,
    );
    assert.deepEqual(publishedTo(h, DM), ['Sorry about that — about your private question: yes, I will keep it between us.']);
  });

  it('H2c: without a home channel, the refusal auto-rewind retry of a DM turn still answers the DM (no silent loss)', async () => {
    const h = await harness({ homeChannel: null, agent: { refusalHandling: { autoRewind: true, maxRewinds: 2 } } });
    h.membrane
      .turn(createMockResponse([], 'refusal'))
      .turn(final(text('Sorry about that — yes, I can help with your question.')));
    h.fw.pushEvent(dmEvent('private: can you help me with something personal?'));
    await h.fw.runUntilIdle();

    assert.ok(h.membrane.calls.length >= 2, 'the refused DM turn was retried');
    assert.deepEqual(
      publishedTo(h, DM),
      ['Sorry about that — yes, I can help with your question.'],
      `the retried DM reply was published nowhere (strict "no locus" keeps it private, with no failure marker); turn loci ${JSON.stringify(h.turnLoci)}`,
    );
  });

  it('H2b: a hybrid prose bounce during a DM turn does not move the follow-up turn\'s bare prose to the home channel', async () => {
    const h = await harness({ agent: { proseRouting: 'hybrid' } });
    h.membrane
      // `>>>@nobody` cannot resolve → bounce → framework wake 'prose-bounce'.
      .turn(final(text('>>>@nobody here is the private address you asked for')))
      .turn(final(text('Sorry, that bounced — here it is again: 12 Elm St.')));
    h.fw.pushEvent(dmEvent('private: what was that address again?'));
    await h.fw.runUntilIdle();

    assert.ok(h.membrane.calls.length >= 2, 'the bounce woke a follow-up turn');
    assert.deepEqual(
      publishedTo(h, HOME),
      [],
      `the DM follow-up's bare prose must not land in the home channel; turn loci ${JSON.stringify(h.turnLoci)}`,
    );
  });

  // -------------------------------------------------------------------------
  // H3 — an ephemeral subagent (spawn/fork) inherits the parent's locus prose
  // mode, and its channel-less wake resolves to the HOME place under strict
  // routing: a subagent working on a DM (its context holds DM words) narrates
  // into the home channel.
  // -------------------------------------------------------------------------

  it('H3: a subagent working on DM material publishes nothing to the home channel', async () => {
    const h = await harness();
    h.membrane.turn(final(text('Summary of the private DM: they asked about their diagnosis.')));
    const created = await h.fw.createEphemeralAgent({
      name: 'spawn-researcher-1',
      model: 'test-model',
      systemPrompt: 'Summarize for the parent.',
      // What the subagent module passes: the parent's prose routing mode.
      proseRouting: h.fw.getAgent(AGENT)!.proseRouting,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Summarize this DM: "about my diagnosis…"' }]);
    const run = h.fw.runEphemeralToCompletion(created.agent, created.contextManager);
    await h.fw.runUntilIdle();
    await run.catch(() => undefined);

    assert.deepEqual(
      h.published.filter((p) => p.conversationId === 'spawn-researcher-1'),
      [],
      'subagent prose must not be published (it is the parent\'s tool result, not speech to any place)',
    );
  });

  // -------------------------------------------------------------------------
  // H4 — an in-world WHISPER arrives on the PUBLIC world channel (the
  // eidoverse door delivers speech and whispers alike as channels/incoming on
  // `world:<name>`, whispers tagged chat:dm + chat:private), and
  // channels/publish on that channel IS saying it aloud. Strict routing keys
  // the place by channel only, so a whisper-woken turn's plain reply is
  // spoken aloud to everyone in the world.
  // -------------------------------------------------------------------------

  it('H4: the plain-prose reply to an in-world whisper is not said aloud on the public world channel', async () => {
    const h = await harness();
    h.membrane.turn(final(text('Understood — I will keep "swordfish" between us.')));
    h.fw.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'eidoverse',
      channelId: WORLD,
      messageId: nextId('w'),
      author: { id: 'mira', name: 'mira' },
      // Exactly what the eidoverse door sends for a whisper.
      content: [{ type: 'text', text: 'mira: (whispers to you) the vault password is swordfish' }],
      timestamp: new Date().toISOString(),
      metadata: { mentioned: true, isExplicitMention: true },
      tags: ['chat:dm', 'chat:private', 'chat:addressed', 'eidoverse:whisper'],
      triggerInference: true,
    } as unknown as ProcessEvent);
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 1);
    assert.deepEqual(
      publishedTo(h, WORLD),
      [],
      'the reply to a private whisper was published on the public world channel (said aloud to everyone)',
    );
  });

  it('H4b: a whisper arriving during a PUBLIC world turn is not heard inside that public turn', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Hello everyone, welcome to the plaza!'), tool('c1', 'probe--wait')),
        final(text('Enjoy the fountain, all.')),
      )
      .turn(final(text('(whisper turn)')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({
        type: 'mcpl:channel-incoming',
        serverId: 'eidoverse',
        channelId: WORLD,
        messageId: nextId('w'),
        author: { id: 'mira', name: 'mira' },
        content: [{ type: 'text', text: 'mira: (whispers to you) I am leaving my partner, please keep it quiet' }],
        timestamp: new Date().toISOString(),
        metadata: { mentioned: true, isExplicitMention: true },
        tags: ['chat:dm', 'chat:private', 'chat:addressed', 'eidoverse:whisper'],
        triggerInference: true,
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident say hi to everyone'));
    await h.fw.runUntilIdle();

    assert.doesNotMatch(
      injectedText(h.membrane.streams[0]!),
      /leaving my partner/,
      'a private whisper was injected into the public world turn, whose next prose is said aloud',
    );
  });

  // -------------------------------------------------------------------------
  // H5 — channel-less operator input is stamped with a place only when it
  // requests a wake. Non-waking operator input (CLI/IPC note with
  // triggerInference:false) has no place, so the boundary filter treats it as
  // a framework message and injects it into whatever turn is running — a
  // world turn hears a private operator note.
  // -------------------------------------------------------------------------

  it('H5: a non-waking private operator note is not injected into a running world turn', async () => {
    const h = await harness();
    h.membrane.turn(
      round(text('Stacking blocks.'), tool('c1', 'probe--wait')),
      final(text('Tower done.')),
    );
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({
        type: 'external-message',
        source: 'cli',
        content: 'operator: FYI the deploy key rotates tonight, keep it quiet',
        triggerInference: false,
        metadata: {},
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident build a tower'));
    await h.fw.runUntilIdle();

    assert.doesNotMatch(
      injectedText(h.membrane.streams[0]!),
      /deploy key rotates/,
      'a private operator note was heard inside the world turn',
    );
  });

  // -------------------------------------------------------------------------
  // H6 — the refusal reaction targets the registry's process-global "most
  // recent inbound" message whenever it is in the home channel. A DM turn's
  // refusal is then signalled in the HOME channel, on a message the agent has
  // not even seen yet (it is held for its own turn).
  // -------------------------------------------------------------------------

  it('H6: a DM turn\'s refusal is not signalled (reaction) in the home channel', async () => {
    const h = await harness();
    h.membrane.turn(
      round(text('Let me think.'), tool('c1', 'probe--wait')),
      createMockResponse([], 'refusal'),
    );
    h.probe.hooks.push(async () => {
      // A home-channel message accepted via channels/incoming mid-turn makes
      // it the registry's most recent inbound (handleIncoming's markAccepted).
      const reg = h.registry as unknown as { defaultPublishChannel: string; defaultPublishMessageId: string };
      reg.defaultPublishChannel = HOME;
      reg.defaultPublishMessageId = 'home-msg-77';
      await settle();
    });
    h.fw.pushEvent(dmEvent('private: something borderline'));
    await h.fw.runUntilIdle();
    await settle(20);

    assert.deepEqual(
      h.sends.filter((s) => s.tool === 'add_reaction'),
      [],
      'the DM turn\'s refusal was marked with a reaction on a home-channel message',
    );
  });

  it('H6b (regression): a refusal in a non-home channel turn still marks that channel\'s message', async () => {
    const GUILD = 'discord:G1:general';
    const h = await harness({
      seeds: [...DEFAULT_SEEDS, { server: 'discord', id: GUILD, label: 'general', open: true }],
    });
    h.membrane.turn(createMockResponse([], 'refusal'));
    // The waking message, accepted via channels/incoming (handleIncoming's
    // markAccepted makes it the most recent inbound).
    const reg = h.registry as unknown as { defaultPublishChannel: string; defaultPublishMessageId: string };
    reg.defaultPublishChannel = GUILD;
    reg.defaultPublishMessageId = 'general-msg-5';
    h.fw.pushEvent(worldEvent('@resident something borderline', { serverId: 'discord', channelId: GUILD }));
    await h.fw.runUntilIdle();
    await settle(20);

    assert.deepEqual(h.turnLoci, [GUILD]);
    assert.deepEqual(
      h.sends.filter((s) => s.tool === 'add_reaction').map((s) => s.args.messageId),
      ['general-msg-5'],
      'upstream marks the refused turn\'s own message; under ROUTING_STRICT the reaction is silently dropped for every non-home channel',
    );
  });

  // -------------------------------------------------------------------------
  // H7 — explicit prose mode: unprefixed prose is PRIVATE by design (delivery
  // bounces it and keeps it in context), but the RFC streaming router is
  // seeded with the trigger channel as its initial target (typingChannel),
  // so the same private text streams live to that channel's server as
  // channels/outgoing/chunk — e.g. voiced in-world by a speech sidecar —
  // before delivery refuses it. (The router's own contract says explicit mode
  // starts suppressed.)
  // -------------------------------------------------------------------------

  it('H7: explicit-mode private (unprefixed) prose is not streamed to the trigger channel', async () => {
    const h = await harness({ agent: { proseRouting: 'explicit' } });
    h.membrane
      .turn(final(text('Note to self: the operator told me privately that the vault code is 0451.')))
      // The bounce wakes a follow-up turn; keep it quiet.
      .turn(final(text('>>skip_reply nothing to send')));
    h.fw.pushEvent(worldEvent('@resident what are you thinking about?'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.published, [], 'delivery refused the unprefixed prose (explicit mode)');
    const streamed = h.chunks.map((c) => `${c.server}:${c.channelId}:${c.delta}`).join('|');
    assert.doesNotMatch(
      streamed,
      /vault code is 0451/,
      'private explicit-mode prose was streamed live to the world channel',
    );
  });
});
