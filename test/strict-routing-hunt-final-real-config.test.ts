/**
 * Strict routing — final adversarial review against the deployment's real
 * event flows (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false,
 * ROUTING_NO_SILENCE_ON_SEND=true, default locus prose routing).
 *
 * The places modelled here are the ones a single resident agent actually
 * has: a PRIVATE home channel, a DM, a second private channel, a PUBLIC
 * guild channel, and a visited MCPL world. Channel-less traffic comes from a
 * heartbeat/reminder MCPL server whose tool answers and push events use the
 * exact text shapes of heartbeat-mcpl (reminder ids `rem_<base36>_<4>`,
 * `reminder_list` lines, `[current time: …]` heartbeat ticks,
 * `{source:'reminder', reminderId, recurring}` origins).
 *
 * Every case asserts the privacy requirement — words meant for one place are
 * never published in, or made visible to, another place. A failing case is a
 * demonstrated defect; the passing ones are controls.
 *
 * Harness: the REAL framework turn machinery and the REAL ChannelRegistry over
 * mock MCPL servers (same shape as strict-routing-privacy.test.ts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  GatherContextScope,
  Module,
  ModuleContext,
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
/** The configured home channel — a PRIVATE channel. */
const HOME = 'discord:G1:home';
/** A direct message with the operator. */
const DM = 'discord:dm:42';
/** A second private channel (always-wake policy). */
const SIDE_ROOM = 'discord:G1:side-room';
/** A PUBLIC guild channel. */
const PUBLIC = 'discord:G2:general';
/** A visited MCPL world. */
const COMMONS = 'world:commons';
const OPERATOR = 'U-operator';

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

/** `wait` runs the next queued hook while the tool round is pending — the
 *  window in which mid-turn arrivals happen. Operator input over the IPC lane
 *  is a channel-less external-message, as the host's TUI module adds it. A
 *  module wake ('inference-request' from source 'relay') is raised like the
 *  host's modules raise theirs. */
class ProbeModule implements Module {
  readonly name = 'probe';
  hooks: Array<() => Promise<void>> = [];
  inFlight = new Set<Promise<unknown>>();
  ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
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
    if (e.type === 'external-message' && (e.source === 'headless' || e.source === 'cli')) {
      return {
        addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(e.content) }] }],
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
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
  strictArmings: Array<{ serverId: string; place: string; ids: string[]; texts: string[] }>;
  recordChannelAutoOpenNotice(
    agentName: string | undefined,
    channels: Array<{ channelId: string; label?: string }>,
    cause: string,
  ): void;
  handleMcplPushEvent(event: unknown): unknown;
  handleMcplChannelIncoming(event: unknown): Promise<unknown>;
}

interface Publish { server: string; channelId: string; text: string }
interface Seed { server: string; id: string; label: string; open: boolean }

const DEFAULT_SEEDS: Seed[] = [
  { server: 'discord', id: HOME, label: 'home', open: true },
  { server: 'discord', id: DM, label: 'DM: operator', open: false },
  { server: 'discord', id: SIDE_ROOM, label: 'side room', open: true },
  { server: 'discord', id: PUBLIC, label: 'general', open: true },
  { server: 'world-visit', id: COMMONS, label: 'commons', open: true },
];

/**
 * A faithful fake of heartbeat-mcpl's tool surface: the answers use the
 * server's exact text shapes (that is what the framework's armed-place
 * matching reads).
 */
class FakeHeartbeat {
  reminders: Array<{ id: string; message: string; fireAt: number; everySeconds: number | null }> = [];
  message = 'Automated ambient wake:\n\nThere is time here that doesn’t need to begin with a request.';
  private n = 0;

  call(tool: string, args: Record<string, unknown>): string {
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const fmt = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}-03:00 [Etc/GMT+3]`;
    const describe = (r: FakeHeartbeat['reminders'][number]) =>
      `next ${fmt(r.fireAt)} (~${Math.round((r.fireAt - now) / 1000)}s) | ` +
      `${r.everySeconds !== null ? `repeats every ${r.everySeconds}s` : 'one-shot'} | "${r.message}"`;
    switch (tool) {
      case 'reminder_add': {
        const id = `rem_mgp${(++this.n).toString(36)}k2xy_ab${10 + this.n}`;
        const every = typeof args.everyHours === 'number' ? args.everyHours * 3600 : null;
        const delay = typeof args.inMinutes === 'number' ? args.inMinutes * 60 : typeof args.inHours === 'number' ? args.inHours * 3600 : every ?? 3600;
        const r = { id, message: String(args.message).trim(), fireAt: now + delay * 1000, everySeconds: every };
        this.reminders.push(r);
        return `Reminder ${id} set: ${describe(r)}`;
      }
      case 'reminder_list':
        if (this.reminders.length === 0) return 'No reminders set.';
        return `${this.reminders.length} reminder(s):\n${this.reminders.map((r) => `${r.id} | ${describe(r)}`).join('\n')}`;
      case 'heartbeat_configure':
        if (typeof args.message === 'string' && args.message.trim()) this.message = args.message;
        return `Updated. Heartbeat ACTIVE | interval=21600s (6.00h) | next in ~21600s | reminders=${this.reminders.length} | message="${this.message}"`;
      case 'heartbeat_status':
        return `Heartbeat ACTIVE | interval=21600s (6.00h) | next in ~21600s | reminders=${this.reminders.length} | message="${this.message}"`;
      default:
        return `Unknown tool: ${tool}`;
    }
  }

  /** The push heartbeat-mcpl emits when reminder `id` fires. */
  reminderPush(id: string): ProcessEvent {
    const r = this.reminders.find((x) => x.id === id);
    if (!r) throw new Error(`no reminder ${id}`);
    return {
      type: 'mcpl:push-event',
      serverId: 'heartbeat',
      featureSet: 'heartbeat',
      eventId: nextId('reminder'),
      content: [{ type: 'text', text: r.message }],
      origin: { source: 'reminder', reminderId: r.id, recurring: r.everySeconds !== null },
      timestamp: new Date().toISOString(),
      triggerInference: true,
    } as unknown as ProcessEvent;
  }

  /** The push heartbeat-mcpl emits on a scheduled tick. */
  tickPush(): ProcessEvent {
    return {
      type: 'mcpl:push-event',
      serverId: 'heartbeat',
      featureSet: 'heartbeat',
      eventId: nextId('heartbeat'),
      content: [{ type: 'text', text: `[current time: 2026-10-13T15:00:00-03:00 [Etc/GMT+3]] ${this.message}` }],
      origin: { source: 'heartbeat', reason: 'schedule' },
      timestamp: new Date().toISOString(),
      triggerInference: true,
    } as unknown as ProcessEvent;
  }
}

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  registry: ChannelRegistry;
  heartbeat: FakeHeartbeat;
  published: Publish[];
  sends: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  turnLoci: Array<string | undefined>;
  traces: Array<{ type: string; [k: string]: unknown }>;
  internals: Internals;
}

function attachRegistry(fw: AgentFramework, seeds: Seed[], heartbeat: FakeHeartbeat) {
  const published: Publish[] = [];
  const sends: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
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
    sendChannelsOutgoingChunk: () => {},
    sendChannelsOutgoingComplete: () => {},
    sendToolsCall: async (tool: string, args: Record<string, unknown>) => {
      sends.push({ server: id, tool, args });
      if (id === 'heartbeat') return { content: [{ type: 'text', text: heartbeat.call(tool, args) }] };
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: `${9000 + sends.length}`, channelId: args.channelId }) }],
      };
    },
  });
  const servers: Record<string, ReturnType<typeof mkServer>> = {};
  for (const s of seeds) servers[s.server] ??= mkServer(s.server);
  servers.heartbeat ??= mkServer('heartbeat');
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
  return { registry, published, sends };
}

async function makeHarness(
  dir: string,
  opts: { seeds?: Seed[]; privileged?: boolean; gate?: boolean } = {},
): Promise<Harness> {
  const membrane = new ScriptedMembrane();
  const probe = new ProbeModule();
  const heartbeat = new FakeHeartbeat();
  if (opts.privileged) writeFileSync(join(dir, 'privileged.json'), JSON.stringify([OPERATOR]));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.' }],
    modules: [probe],
    homeChannel: HOME,
    ...(opts.privileged || opts.gate
      ? {
          gate: {
            configPath: join(dir, 'gate.json'),
            config: { policies: [], default: 'always' as const },
            ...(opts.privileged ? { privilegedUsersPath: join(dir, 'privileged.json') } : {}),
          },
        }
      : {}),
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
    heartbeat,
    turnLoci,
    traces,
    internals: fw as unknown as Internals,
    ...attachRegistry(fw, opts.seeds ?? DEFAULT_SEEDS, heartbeat),
  };
}

// ---- events ---------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

/** A Discord DM exactly as discord-mcpl forwards it (push event; DMs are
 *  never open channels). */
function dmEvent(text: string, opts: { authorId?: string; waking?: boolean } = {}): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: nextId('dm'),
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      messageId: nextId('m'),
      guildId: null,
      channelId: '42',
      mcplChannelId: DM,
      authorId: opts.authorId ?? 'U-friend',
      authorName: 'operator',
      isDM: true,
    },
    tags: ['chat:dm', 'chat:private', 'chat:addressed'],
    timestamp: new Date().toISOString(),
    triggerInference: opts.waking ?? true,
  } as unknown as ProcessEvent;
}

/** A message on an open channel (channels/incoming). */
function channelEvent(
  channelId: string,
  text: string,
  opts: { waking?: boolean; serverId?: string; authorId?: string; tags?: string[] } = {},
): ProcessEvent {
  const waking = opts.waking ?? true;
  return {
    type: 'mcpl:channel-incoming',
    serverId: opts.serverId ?? 'discord',
    channelId,
    messageId: nextId('c'),
    author: { id: opts.authorId ?? 'U-someone', name: 'someone' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: opts.tags ?? (waking ? ['chat:mention', 'chat:addressed'] : ['chat:ambient']),
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

/** Arms one reminder from a turn of the HOME place: a heartbeat tick turn,
 *  the most common way this agent sets reminders for itself. */
async function armReminderFromHeartbeatTurn(h: Harness, message: string): Promise<string> {
  h.membrane.turn(
    round(tool(nextId('c'), 'heartbeat--reminder_add', { message, inHours: 24 })),
    final(text('Set myself a reminder.')),
  );
  h.fw.pushEvent(h.heartbeat.tickPush());
  await h.fw.runUntilIdle();
  return h.heartbeat.reminders.at(-1)!.id;
}

// ---------------------------------------------------------------------------

describe('strict routing — final review against the real deployment flows', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-final-'));
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
  // F1 — `reminder_list` in a PUBLIC turn claims every reminder the server
  // lists. strictNoteArming records the ids of ANY answer a non-home turn
  // gets from an MCPL server; heartbeat-mcpl's reminder_list answer names
  // every pending reminder id. A reminder armed in the private home place
  // (a heartbeat turn — never noted, home is the fallback) then matches ONLY
  // the public arming, so it fires into the public channel: its private
  // text becomes the public turn's input and the reply is published there.
  // -------------------------------------------------------------------------

  it('F1: a reminder set in a private heartbeat turn is not answered in the public channel after a public turn listed reminders', async () => {
    const h = await harness();
    const id = await armReminderFromHeartbeatTurn(h, 'Ask the operator how the hospital appointment went.');
    assert.deepEqual(h.turnLoci, [HOME], 'the heartbeat turn ran in the home place');

    // A public conversation asks what the agent has planned; it lists.
    h.membrane.turn(
      round(tool('c-list', 'heartbeat--reminder_list')),
      final(text('I have one thing queued for tomorrow.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident what are you up to tomorrow?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [HOME, PUBLIC]);

    // The next day the reminder fires.
    h.membrane.turn(final(text('Hey — how did the hospital appointment go?')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 3, 'the reminder woke a turn');
    assert.notEqual(h.turnLoci[2], PUBLIC, `LEAK: the private reminder's turn ran in the public channel; loci=${JSON.stringify(h.turnLoci)}`);
    assert.deepEqual(
      publishedTo(h, PUBLIC),
      ['I have one thing queued for tomorrow.'],
      `LEAK: the reminder reply was published in the public channel; published=${JSON.stringify(h.published)}`,
    );
  });

  // -------------------------------------------------------------------------
  // F2 — a reminder that matched no arming (set in the home place, or its
  // arming aged out) is a channel-less push: a "non-channel framework
  // message", released at every boundary of whatever turn is running. Its
  // text is the agent's own note for the home place, yet it is injected into
  // a PUBLIC turn mid-turn (while its wake is answered in the home place).
  // -------------------------------------------------------------------------

  it('F2: an un-armed reminder firing during a public turn is not injected into the public turn', async () => {
    const h = await harness();
    const id = await armReminderFromHeartbeatTurn(h, 'Check whether the operator took the evening medication.');

    h.membrane
      .turn(
        round(text('Let me look.'), tool('c1', 'probe--wait')),
        final(text('Here is the answer for everyone.')),
      )
      .turn(final(text('(reminder turn)')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(h.heartbeat.reminderPush(id));
      await settle();
    });
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident can you check something for us?'));
    await h.fw.runUntilIdle();

    const publicStream = h.membrane.streams[1]!;
    assert.doesNotMatch(
      injectedText(publicStream),
      /evening medication/,
      'LEAK: the private reminder text was injected into the public turn',
    );
    assert.equal(h.turnLoci.at(-1), HOME, 'the reminder itself is answered in the home place');
  });

  it('F2b: an un-armed reminder that fires just after a public wake is not part of the public turn\'s input', async () => {
    const h = await harness();
    const id = await armReminderFromHeartbeatTurn(h, 'Check whether the operator took the evening medication.');

    h.membrane
      .turn(final(text('Answer for the public channel.')))
      .turn(final(text('(reminder turn)')));
    // Both arrive before the scheduler runs: the public wake first.
    await h.internals.handleMcplChannelIncoming(channelEvent(PUBLIC, '@resident quick question'));
    await settle(5);
    h.internals.handleMcplPushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci.slice(1), [PUBLIC, HOME]);
    assert.doesNotMatch(
      requestText(h.membrane.calls[1]!),
      /evening medication/,
      'LEAK: the private reminder text is new input of the public turn',
    );
  });

  // -------------------------------------------------------------------------
  // F3 — free-text matching of the heartbeat tick. heartbeat_configure takes
  // the tick's message; a non-home turn that sets it is noted as an arming
  // whose text every later tick contains, so every scheduled heartbeat turn
  // (the agent's private ambient time) runs in — and publishes into — the
  // place that last edited the message.
  // -------------------------------------------------------------------------

  it('F3: after a public turn edits the heartbeat message, scheduled heartbeat turns do not publish in the public channel', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-cfg', 'heartbeat--heartbeat_configure', {
        message: 'Ambient wake: look at your notes and follow whatever interests you.',
      })),
      final(text('Done, I tweaked my wake prompt.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident you should give yourself a gentler wake prompt'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Private musing: I keep thinking about what the operator told me last night.')));
    h.fw.pushEvent(h.heartbeat.tickPush());
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci.length, 2);
    assert.equal(h.turnLoci[1], HOME, `the heartbeat turn ran in ${h.turnLoci[1]}`);
    assert.deepEqual(
      publishedTo(h, PUBLIC),
      ['Done, I tweaked my wake prompt.'],
      `LEAK: heartbeat prose published publicly; published=${JSON.stringify(h.published)}`,
    );
  });

  // -------------------------------------------------------------------------
  // F4 — armings are capped at 100 and EVERY MCPL call a non-home turn makes
  // (discord history fetches, sends, reactions …) is one. A reminder armed in
  // a DM ages out after 100 further calls and its push falls back to the home
  // place: the DM-written reminder is answered in the home channel (the
  // R2-8 leak, reopened by ordinary tool use between arming and firing).
  // -------------------------------------------------------------------------

  it('F4: a DM-armed reminder is still answered in the DM after the agent made 100 other MCPL calls', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-arm', 'heartbeat--reminder_add', { message: 'Tell the operator: the biopsy came back benign.', inHours: 24 })),
      final(text('I will remind you tomorrow.')),
    );
    h.fw.pushEvent(dmEvent('private: remind me tomorrow about the biopsy result'));
    await h.fw.runUntilIdle();
    const id = h.heartbeat.reminders[0]!.id;

    // A day of ordinary activity in the public channel: history reads.
    const calls = Array.from({ length: 100 }, (_, n) =>
      tool(`c-read-${n}`, 'discord--fetch_messages', { channelId: PUBLIC, limit: 20 }));
    h.membrane.turn(round(...calls), final(text('Caught up on the channel.')));
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident catch up on what we said today'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Reminder: the biopsy came back benign.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM, PUBLIC, DM], `the reminder must come back to the DM; loci=${JSON.stringify(h.turnLoci)}`);
    assert.deepEqual(
      publishedTo(h, HOME),
      [],
      `LEAK: the DM-armed reminder was answered in the home channel; published=${JSON.stringify(h.published)}`,
    );
  });

  // F4b — the two together answer "could a DM reminder's text appear
  // somewhere public?": yes. The DM arming is the oldest, so it ages out
  // first; a public listing made after it survives; the push then matches the
  // public place alone.
  it('F4b: a DM-armed reminder never fires into the public channel (public listing + aged-out DM arming)', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-arm', 'heartbeat--reminder_add', { message: 'Tell the operator: the biopsy came back benign.', inHours: 24 })),
      final(text('I will remind you tomorrow.')),
    );
    h.fw.pushEvent(dmEvent('private: remind me tomorrow about the biopsy result'));
    await h.fw.runUntilIdle();
    const id = h.heartbeat.reminders[0]!.id;

    // A public conversation: the agent checks its list, then reads the
    // channel's history (99 ordinary MCPL calls).
    const reads = Array.from({ length: 99 }, (_, n) =>
      tool(`c-read-${n}`, 'discord--fetch_messages', { channelId: PUBLIC, limit: 20 }));
    h.membrane.turn(
      round(tool('c-list', 'heartbeat--reminder_list')),
      round(...reads),
      final(text('Busy day tomorrow, it seems.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident what is on your plate tomorrow? read back what we said today'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Reminder: the biopsy came back benign.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.deepEqual(
      publishedTo(h, PUBLIC),
      ['Busy day tomorrow, it seems.'],
      `LEAK: the DM reminder was answered in the public channel; loci=${JSON.stringify(h.turnLoci)}`,
    );
    assert.doesNotMatch(
      h.membrane.calls.length >= 3 && h.turnLoci[2] === PUBLIC ? requestText(h.membrane.calls[2]!) : '',
      /biopsy/,
    );
  });

  it('F4 control: with a handful of other MCPL calls the DM-armed reminder comes back to the DM', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-arm', 'heartbeat--reminder_add', { message: 'Tell the operator: the biopsy came back benign.', inHours: 24 })),
      final(text('I will remind you tomorrow.')),
    );
    h.fw.pushEvent(dmEvent('private: remind me tomorrow about the biopsy result'));
    await h.fw.runUntilIdle();
    const id = h.heartbeat.reminders[0]!.id;

    const calls = Array.from({ length: 5 }, (_, n) =>
      tool(`c-read-${n}`, 'discord--fetch_messages', { channelId: PUBLIC, limit: 20 }));
    h.membrane.turn(round(...calls), final(text('Caught up on the channel.')));
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident catch up on what we said today'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Reminder: the biopsy came back benign.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM, PUBLIC, DM]);
    assert.deepEqual(publishedTo(h, HOME), []);
  });

  // -------------------------------------------------------------------------
  // F1b — the same id claim, with the reminder armed in a DM: the DM arming
  // and the public listing both match, the push is "ambiguous" and its turn
  // publishes NOWHERE. Nothing leaks, but the reminder the operator asked
  // for in the DM is never delivered to the DM.
  // -------------------------------------------------------------------------

  it('F1b (loss): a DM-armed reminder is still answered in the DM after a public turn listed reminders', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-arm', 'heartbeat--reminder_add', { message: 'Tell the operator: the biopsy came back benign.', inHours: 24 })),
      final(text('I will remind you tomorrow.')),
    );
    h.fw.pushEvent(dmEvent('private: remind me tomorrow about the biopsy result'));
    await h.fw.runUntilIdle();
    const id = h.heartbeat.reminders[0]!.id;

    h.membrane.turn(
      round(tool('c-list', 'heartbeat--reminder_list')),
      final(text('Just one thing on my list.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident anything on your list for tomorrow?'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Reminder: the biopsy came back benign.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, PUBLIC), ['Just one thing on my list.'], 'no leak into the public channel');
    assert.deepEqual(
      publishedTo(h, DM),
      ['I will remind you tomorrow.', 'Reminder: the biopsy came back benign.'],
      `LOSS: the DM reminder was answered nowhere; loci=${JSON.stringify(h.turnLoci)}`,
    );
  });

  // -------------------------------------------------------------------------
  // W1 — a workspace drop (wakeOnChange on the projects mount) is module
  // content with no channel: a non-channel framework message. Operator input
  // over IPC is held for the home place, but operator input over the
  // filesystem is injected into whatever turn is running — here a PUBLIC
  // turn hears the file name of a private drop mid-turn. (The wake itself
  // is answered in the home place.)
  // -------------------------------------------------------------------------

  it('W1 (minor): a projects-mount drop during a public turn is not injected into the public turn', async () => {
    const { WorkspaceModule } = await import('../src/modules/index.js');
    const ws = new WorkspaceModule({ mounts: [] });
    // The real onProcess, with the deployment's mount flags (start() is not
    // run: it would attach a real watcher and store).
    (ws as unknown as { mounts: Map<string, unknown> }).mounts = new Map([
      ['projects', { config: { name: 'projects', path: dir, mode: 'read-write', watch: 'always', wakeOnChange: true } }],
    ]);
    class WorkspaceRelay implements Module {
      readonly name = 'workspace-relay';
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
      async onProcess(event: ProcessEvent, state: unknown): Promise<EventResponse> {
        return ws.onProcess(event, state as never);
      }
    }
    const h = await harness();
    (h.fw as unknown as { moduleRegistry: { addModule(m: Module): Promise<void> } }).moduleRegistry
      .addModule(new WorkspaceRelay())
      .catch(() => {});
    await settle(5);

    h.membrane
      .turn(
        round(text('Looking.'), tool('c1', 'probe--wait')),
        final(text('Public answer.')),
      )
      .turn(final(text('(workspace turn)')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({ type: 'workspace:created', mount: 'projects', paths: ['projects/operator-therapy-journal.md'] } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident what are you working on?'));
    await h.fw.runUntilIdle();

    assert.ok(h.membrane.calls.length >= 2, 'the drop woke a turn');
    assert.doesNotMatch(
      injectedText(h.membrane.streams[0]!),
      /operator-therapy-journal/,
      'the private drop was injected into the public turn',
    );
  });

  it('O1 control: an operator IPC note during a public turn is held and answered in the home place', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Checking.'), tool('c1', 'probe--wait')),
        final(text('Public answer.')),
      )
      .turn(final(text('Noted, operator.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent({
        type: 'external-message', source: 'headless', content: 'note: the landlord visit is moved to Friday', metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident hello'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [PUBLIC, HOME]);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /landlord/);
    assert.deepEqual(publishedTo(h, PUBLIC), ['Checking.', 'Public answer.']);
    assert.deepEqual(publishedTo(h, HOME), ['Noted, operator.']);
  });

  it('H1 control: a heartbeat tick never moves an earlier DM wake out of the DM, and runs in the home place', async () => {
    const h = await harness();
    h.membrane
      .turn(final(text('DM answer.')))
      .turn(final(text('(heartbeat)')));
    h.internals.handleMcplPushEvent(dmEvent('private: are you there?'));
    await settle(5);
    h.internals.handleMcplPushEvent(h.heartbeat.tickPush());
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, HOME]);
    assert.deepEqual(publishedTo(h, DM), ['DM answer.']);
    assert.deepEqual(publishedTo(h, HOME), ['(heartbeat)']);
  });
});

// ---------------------------------------------------------------------------
// M1 — the host's memory module (system-position memory injection) keys
// retrieval on the newest STORED message with `triggered` and an `author`.
// Push-delivered wakes (a mention in a channel the agent has not opened, a
// bot mention, a DM) carry no `author`, so a turn they start re-uses the
// newest channel message's retrieval — and the module replays its cached
// block when that message is the one it last served. A memory block
// retrieved for the operator's message in the PRIVATE home channel is then
// injected into the system prompt of a PUBLIC turn. The module lives in the
// host checkout, next to this repository's checkout; the case runs only where
// that checkout is present. The fix is two-sided: the framework passes the
// turn's place to gatherContext, and the module picks its gate in that place.
// ---------------------------------------------------------------------------

/** dist/test → repository root → the sibling host checkout. */
const HOST_MEMORY_MODULE = fileURLToPath(
  new URL('../../../forking-knowledge-miner/src/modules/memory-module.ts', import.meta.url),
);

describe('strict routing — host memory injection across places', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-final-mem-'));
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.ROUTING_STRICT = 'true';
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    process.env.ROUTING_NO_SILENCE_ON_SEND = 'true';
  });

  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('M1: memories retrieved for the operator in the private home channel are not injected into a public turn', async (t) => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(HOST_MEMORY_MODULE)) {
      t.skip('host memory module not present');
      return;
    }
    let MemoryModule: new (config: Record<string, unknown>) => Module;
    try {
      ({ MemoryModule } = await import(HOST_MEMORY_MODULE) as { MemoryModule: typeof MemoryModule });
    } catch (err) {
      t.skip(`host memory module not importable here: ${(err as Error).message}`);
      return;
    }
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url === '/retrieve'
          ? { formatted: '<memories>The operator once confided a private diagnosis.</memories>' }
          : {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const membrane = new ScriptedMembrane();
    const probe = new ProbeModule();
    const heartbeat = new FakeHeartbeat();
    const memory = new MemoryModule({ serviceUrl: `http://127.0.0.1:${port}`, bot: 'test', userIds: [OPERATOR] });
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [probe, memory],
      homeChannel: HOME,
    });
    const published: Publish[] = [];
    const seeds = DEFAULT_SEEDS.map((s) => (s.id === PUBLIC ? { ...s, open: false } : s));
    published.push(...attachRegistry(fw, seeds, heartbeat).published);
    try {
      membrane
        .turn(final(text('Home answer.')))
        .turn(final(text('Public answer.')));
      // The operator in the private home channel (an open channel).
      fw.pushEvent(channelEvent(HOME, '@resident how are you holding up?', { authorId: OPERATOR }));
      await fw.runUntilIdle();
      assert.match(JSON.stringify(membrane.calls[0]), /private diagnosis/, 'the home turn got its memories');

      // A stranger mentions the agent in a PUBLIC channel it has not opened
      // (discord-mcpl delivers that as a push event).
      fw.pushEvent({
        type: 'mcpl:push-event',
        serverId: 'discord',
        featureSet: 'discord.messaging',
        eventId: nextId('pub'),
        content: [{ type: 'text', text: 'stranger: @resident hi there' }],
        origin: {
          source: 'discord', messageId: nextId('m'), guildId: 'G2', channelId: 'general', mcplChannelId: PUBLIC,
          channelName: 'general', authorId: 'U-stranger', authorName: 'stranger', isMention: true, isDM: false,
        },
        tags: ['chat:mention', 'chat:addressed', 'chat:from-human'],
        timestamp: new Date().toISOString(),
        triggerInference: true,
      } as unknown as ProcessEvent);
      await fw.runUntilIdle();

      assert.equal(membrane.calls.length, 2);
      assert.doesNotMatch(
        JSON.stringify(membrane.calls[1]),
        /private diagnosis/,
        'LEAK: the operator\'s private memory block was injected into the public turn',
      );
    } finally {
      try { await fw.runUntilIdle(); } catch { /* best effort */ }
      try { await fw.stop(); } catch { /* stopped */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Final repair guards. Each case pins one rule of the repair against the
// mutant that removes it (the hunt cases above already pin per-server
// eviction, id-over-text priority, the arrival order of a parked place, and
// the hold of waking module content):
//  - FR1  a waking channel-less push no turn armed is the home place's input
//  - FR2  a matched arming is refreshed, so a recurring reminder never ages out
//  - FR3  an answer repeating an id the call passed claims nothing
//  - FR4  a call that passes nothing (a listing) arms nothing
//  - FR5  armings restored from the version-1 file are normalized
//  - FR6  an echo under a short label still matches the armed text
//  - FR7  home turns are noted: a home reminder's id outranks another
//         place's text that contains its words
//  - FR8  gatherContext gets the turn's place under the flag, and is called
//         exactly as upstream without it
// ---------------------------------------------------------------------------

describe('strict routing — final repair guards', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-final-repair-'));
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

  /** A reminder the server holds that no turn's call is on record for (set
   *  before the armed places were kept, or by a client the framework did not
   *  see). */
  function legacyReminder(h: Harness, message: string): string {
    const id = 'rem_legacy7q2_zz01';
    h.heartbeat.reminders.push({ id, message, fireAt: Date.UTC(2026, 9, 14), everySeconds: null });
    return id;
  }

  /** Arms one reminder from a DM turn; returns its id ('' when the server
   *  kept none). */
  async function armFromDm(h: Harness, message: string, extra: Record<string, unknown> = {}): Promise<string> {
    h.membrane.turn(
      round(tool(nextId('c'), 'heartbeat--reminder_add', { message, inHours: 24, ...extra })),
      final(text('Reminder set for you.')),
    );
    h.fw.pushEvent(dmEvent('private: please remind me'));
    await h.fw.runUntilIdle();
    return h.heartbeat.reminders.at(-1)?.id ?? '';
  }

  /** `n` reminders set from one heartbeat (home) turn. */
  async function homeArmings(h: Harness, n: number): Promise<void> {
    h.membrane.turn(
      round(...Array.from({ length: n }, (_, k) =>
        tool(nextId('c'), 'heartbeat--reminder_add', { message: `Home chore number ${k} for later on`, inHours: 48 }))),
      final(text('Planned the week.')),
    );
    h.fw.pushEvent(h.heartbeat.tickPush());
    await h.fw.runUntilIdle();
  }

  it('FR1: a reminder no turn armed, firing during a public turn, is held for the home turn it wakes', async () => {
    const h = await harness();
    const id = legacyReminder(h, 'Ask the operator about the therapy session.');
    h.membrane
      .turn(round(text('Looking.'), tool('c1', 'probe--wait')), final(text('Public answer.')))
      .turn(final(text('Home: about the therapy session.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(h.heartbeat.reminderPush(id));
      await settle();
    });
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident hello all'));
    await h.fw.runUntilIdle();

    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /therapy session/, 'LEAK: heard inside the public turn');
    assert.deepEqual(h.turnLoci, [PUBLIC, HOME]);
    assert.match(requestText(h.membrane.calls[1]!), /therapy session/, 'the home turn has it as its input');
    assert.deepEqual(publishedTo(h, PUBLIC), ['Looking.', 'Public answer.']);
  });

  it('FR2: a recurring DM reminder that keeps firing is not aged out by later armings on its server', async () => {
    const h = await harness();
    const id = await armFromDm(h, 'Weekly: ask the operator how the physio exercises go.', { everyHours: 168 });
    await homeArmings(h, 60);
    h.membrane.turn(final(text('Weekly check: how is the physio going?')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();
    assert.equal(h.turnLoci.at(-1), DM, 'first firing: the DM');

    // 60 more armings: 120 since the DM armed it, 60 since it last fired.
    await homeArmings(h, 60);
    h.membrane.turn(final(text('Weekly check again: physio?')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();
    assert.equal(h.turnLoci.at(-1), DM, `LEAK: the recurring DM reminder aged out; loci=${JSON.stringify(h.turnLoci)}`);
    assert.deepEqual(publishedTo(h, HOME).filter((t) => /physio/i.test(t)), []);
  });

  it('FR3: a public turn that names an existing reminder in its call (snooze) does not claim it', async () => {
    const h = await harness();
    const id = legacyReminder(h, 'Check on the operator after the clinic visit.');
    const call = h.heartbeat.call.bind(h.heartbeat);
    h.heartbeat.call = (name, args) => name === 'reminder_snooze'
      ? `Reminder ${String(args.id)} moved: next 2026-10-14T18:00:00-03:00 [Etc/GMT+3] (~3600s) | one-shot`
      : call(name, args);
    h.membrane.turn(
      round(tool('c-snooze', 'heartbeat--reminder_snooze', { id, inMinutes: 60 })),
      final(text('Pushed one of my reminders back an hour.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident can you push your next reminder back an hour?'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Checking on the operator after the clinic.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [PUBLIC, HOME], 'LEAK: the snoozing turn claimed the reminder');
    assert.deepEqual(publishedTo(h, PUBLIC), ['Pushed one of my reminders back an hour.']);
  });

  it('FR4: a public turn that lists reminders the server already held does not claim them', async () => {
    const h = await harness();
    const id = legacyReminder(h, 'Ask the operator whether the new medication helps.');
    h.membrane.turn(
      round(tool('c-list', 'heartbeat--reminder_list')),
      final(text('One thing pending.')),
    );
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident what is pending for you?'));
    await h.fw.runUntilIdle();

    h.membrane.turn(final(text('Asking about the medication.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(id));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [PUBLIC, HOME], 'LEAK: the listing turn claimed a reminder it only listed');
    assert.deepEqual(publishedTo(h, PUBLIC), ['One thing pending.']);
  });

  it('FR5: a version-1 armings file is normalized on restore (a listing claims nothing; an id stays with its first arming)', async () => {
    const first = await harness();
    await first.fw.stop();
    harnesses.splice(harnesses.indexOf(first), 1);
    const home = 'rem_h0me1q2_aa01';
    const dmId = 'rem_dm0q9w8_bb02';
    const recovery = join(dir, 'store', 'recovery');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(recovery, { recursive: true });
    writeFileSync(join(recovery, 'strict-armings.json'), JSON.stringify({
      version: 1,
      armings: [
        { serverId: 'heartbeat', place: JSON.stringify(['ch', 'discord', DM]), callId: 'a1',
          texts: ['tell the operator: the scan was clear.'], ids: [dmId], at: 1 },
        // What version 1 kept for a public `reminder_list`: every id, no text.
        { serverId: 'heartbeat', place: JSON.stringify(['ch', 'discord', PUBLIC]), callId: 'a2',
          texts: [], ids: [home, dmId], at: 2 },
        // A later public call with text whose answer named the DM's id again.
        { serverId: 'heartbeat', place: JSON.stringify(['ch', 'discord', PUBLIC]), callId: 'a3',
          texts: ['the public wording of the heartbeat'], ids: [dmId], at: 3 },
      ],
    }));

    const h = await harness();
    h.heartbeat.reminders.push(
      { id: home, message: 'Water the plants at home.', fireAt: 0, everySeconds: null },
      { id: dmId, message: 'Tell the operator: the scan was clear.', fireAt: 0, everySeconds: null },
    );
    h.membrane.turn(final(text('Watering.'))).turn(final(text('The scan was clear.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(home));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(h.heartbeat.reminderPush(dmId));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [HOME, DM], `loci=${JSON.stringify(h.turnLoci)}`);
    assert.deepEqual(publishedTo(h, PUBLIC), []);
    assert.deepEqual(publishedTo(h, DM), ['The scan was clear.']);
  });

  it('FR6: a server without ids that echoes the armed text under a short label is answered in the arming place', async () => {
    const h = await harness();
    const call = h.heartbeat.call.bind(h.heartbeat);
    h.heartbeat.call = (name, args) => (name === 'reminder_add' ? 'ok' : call(name, args));
    await armFromDm(h, 'Tell the operator the scan was clear.');

    h.membrane.turn(final(text('Reminder: the scan was clear.')));
    h.fw.pushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: nextId('rem'),
      content: [text('Reminder: Tell the operator the scan was clear.')], origin: { source: 'reminder' },
      timestamp: new Date().toISOString(), triggerInference: true,
    } as unknown as ProcessEvent);
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, DM]);
    assert.deepEqual(publishedTo(h, HOME), [], 'LEAK: the DM-armed reminder was answered at home');
  });

  it('FR7: a home reminder whose words another place\'s reminder text contains is answered at home', async () => {
    const h = await harness();
    h.membrane.turn(
      round(tool('c-home', 'heartbeat--reminder_add', { message: 'Stretch after the long call', inMinutes: 90 })),
      final(text('Noted for later.')),
    );
    h.fw.pushEvent(h.heartbeat.tickPush());
    await h.fw.runUntilIdle();
    const homeId = h.heartbeat.reminders.at(-1)!.id;
    await armFromDm(h, 'Remember to stretch after the long call with the surgeon');

    h.membrane.turn(final(text('Stretch break.')));
    h.fw.pushEvent(h.heartbeat.reminderPush(homeId));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [HOME, DM, HOME], `loci=${JSON.stringify(h.turnLoci)}`);
    assert.deepEqual(publishedTo(h, DM), ['Reminder set for you.'], 'LEAK: the home reminder spoke in the DM');
  });

  it('FR8: gatherContext receives the turn\'s place under the flag, and only the agent name without it', async () => {
    class ScopeProbe implements Module {
      readonly name = 'scope-probe';
      calls: Array<{ arity: number; scope?: GatherContextScope }> = [];
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
      async onProcess(): Promise<EventResponse> { return {}; }
      async gatherContext(...args: unknown[]): Promise<[]> {
        this.calls.push({ arity: args.length, scope: args[1] as GatherContextScope | undefined });
        return [];
      }
    }
    const metadataOf = (h: Harness, pattern: RegExp) => h.fw.getAgent(AGENT)!.getContextManager().getAllMessages()
      .find((m) => pattern.test(blockText(m.content)))?.metadata as Record<string, unknown> | undefined;

    const h = await harness();
    const scopes = new ScopeProbe();
    await (h.fw as unknown as { moduleRegistry: { addModule(m: Module): Promise<void> } }).moduleRegistry.addModule(scopes);
    h.membrane.turn(final(text('Home answer.'))).turn(final(text('Public answer.')));
    h.fw.pushEvent(channelEvent(HOME, '@resident HOME-WORDS'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(channelEvent(PUBLIC, '@resident PUBLIC-WORDS'));
    await h.fw.runUntilIdle();

    const [home, pub] = scopes.calls;
    assert.equal(home?.arity, 2);
    assert.equal(home?.scope?.channelId, HOME);
    assert.equal(home?.scope?.includes(metadataOf(h, /HOME-WORDS/)), true);
    assert.equal(home?.scope?.includes(metadataOf(h, /PUBLIC-WORDS/)), false);
    assert.equal(pub?.scope?.channelId, PUBLIC);
    assert.equal(pub?.scope?.includes(metadataOf(h, /HOME-WORDS/)), false);
    assert.equal(pub?.scope?.includes(metadataOf(h, /PUBLIC-WORDS/)), true);
    assert.equal(pub?.scope?.includes(undefined), false, 'a message of no place is in no turn\'s place');

    // Flags unset: modules are called exactly as upstream.
    for (const f of FLAGS) delete process.env[f];
    const plainDir = mkdtempSync(join(tmpdir(), 'strict-final-repair-plain-'));
    try {
      const plain = await makeHarness(plainDir);
      harnesses.push(plain);
      const upstream = new ScopeProbe();
      await (plain.fw as unknown as { moduleRegistry: { addModule(m: Module): Promise<void> } }).moduleRegistry.addModule(upstream);
      plain.membrane.turn(final(text('Answer.')));
      plain.fw.pushEvent(channelEvent(HOME, '@resident hello'));
      await plain.fw.runUntilIdle();
      assert.deepEqual(upstream.calls.map((c) => c.arity), [1]);
    } finally {
      const index = harnesses.findIndex((x) => x.fw !== h.fw);
      if (index >= 0) {
        const [plain] = harnesses.splice(index, 1);
        try { await plain!.fw.stop(); } catch { /* stopped */ }
      }
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
