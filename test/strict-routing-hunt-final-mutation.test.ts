/**
 * Strict routing — final mutation review (ROUTING_STRICT=true,
 * CHANNEL_OPEN_ON_SEND=false, ROUTING_NO_SILENCE_ON_SEND=true).
 *
 * A mutation pass over the strict-routing implementation (each load-bearing
 * guard reverted or negated in turn, run against the five strict-routing
 * suites) left guards whose removal no existing test notices. Two kinds of
 * case live here:
 *
 *  - KILLERS (titles start with the mutant id: MP5, RL3, RL6, MP1, MP1b, L5,
 *    A4, A5, AR1-AR3, LS2, BR1, BR3). The current code is right; the test
 *    was missing. Each passes today and fails with its mutant applied, in the
 *    shape the production deployment exercises (real discord-mcpl DM tags,
 *    a home channel, heartbeat-mcpl reminders and heartbeats, the privileged
 *    operator brake, auxiliary-call parking, provider cooldowns).
 *
 *  - FAILING CASES (ARMED-1..4, PARK-ORDER). Real defects the mutation pass
 *    led to; each fails on the current code and states the requirement:
 *      ARMED-*: a non-home turn's MCPL calls are noted with EVERY id-like
 *        token of the server's answer and every argument text, so listing
 *        reminders, re-wording the heartbeat, or sharing a reminder's wording
 *        files later channel-less pushes under the wrong place (or none).
 *      PARK-ORDER: a message from the place whose turn is parked behind an
 *        auxiliary call is stored at once, ahead of that place's earlier
 *        held message (the parked branch skips the arrival-order rule).
 *
 * Harness: the REAL framework turn machinery and the REAL ChannelRegistry
 * over mock MCPL servers (same shape as strict-routing-privacy.test.ts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
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
const COMMONS = 'world:commons';
const HOME = 'discord:G1:home';
const CLOSED = 'discord:G1:lounge';
/** A second private channel with an always-wake gate policy. */
const SIDE_ROOM = 'discord:G1:side-room';
const OPERATOR = 'U-operator';

const FLAGS = ['ROUTING_STRICT', 'CHANNEL_OPEN_ON_SEND', 'ROUTING_NO_SILENCE_ON_SEND'] as const;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A stream that fails at once with `error`. */
class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class ScriptedMembrane {
  calls: NormalizedRequest[] = [];
  streams: MockYieldingStream[] = [];
  /** Errors the next streams fail with (one per stream), before any script. */
  failures: Error[] = [];
  private scripts: NormalizedResponse[][] = [];

  turn(...responses: NormalizedResponse[]): this {
    this.scripts.push(responses);
    return this;
  }

  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const failure = this.failures.shift();
    if (failure) return new ErrorStream(failure) as unknown as MockYieldingStream;
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
 *  window in which mid-turn arrivals happen. */
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

  /** Operator input over the CLI/IPC lane: a channel-less message that wakes
   *  unless `triggerInference: false`. */
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
  turnChannelFor(agentName: string): ChannelRef | null | undefined;
  mcplHomeChannel: string | null;
  activeTurnTokens: Map<string, unknown>;
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
  pendingRequests: Array<{ agentName: string; reason: string; channelId?: string; strictPlace?: string; timestamp: number }>;
  recordChannelAutoOpenNotice(agentName: string | undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: string): void;
  handleMcplPushEvent(event: unknown): unknown;
  handleMcplChannelIncoming(event: unknown): Promise<unknown>;
  processNextEvent(): Promise<void>;
  withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>): Promise<T>;
  strictParkedPlaces: Map<string, string>;
  providerAccelerationDefaultCooldownMs: number;
  providerAccelerationJitterMs: number;
  providerAccelerationCooldowns: Map<string, { heldRequests: unknown[] }>;
}

interface Publish { server: string; channelId: string; text: string }
interface Seed { server: string; id: string; label: string; open: boolean }

const DEFAULT_SEEDS: Seed[] = [
  { server: 'discord', id: DM, label: 'DM: operator', open: false },
  { server: 'discord', id: HOME, label: 'home', open: true },
  { server: 'discord', id: CLOSED, label: 'lounge', open: false },
  { server: 'discord', id: SIDE_ROOM, label: 'side room', open: true },
  { server: 'eidoverse', id: WORLD, label: 'plaza', open: true },
];

/** Two world servers serving a default world with the same channel id. */
const TWO_WORLDS: Seed[] = [
  { server: 'discord', id: DM, label: 'DM: operator', open: false },
  { server: 'discord', id: HOME, label: 'home', open: true },
  { server: 'eidoverse', id: COMMONS, label: 'commons', open: true },
  { server: 'eidoverse-visit', id: COMMONS, label: 'commons', open: true },
];

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  registry: ChannelRegistry;
  published: Publish[];
  sends: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  toolReplies: ToolReplies;
  turnLoci: Array<string | undefined>;
  traces: Array<{ type: string; [k: string]: unknown }>;
  internals: Internals;
}

/** Per-tool reply text of the mock MCPL servers (shape of the real server's answer). */
type ToolReplies = Record<string, (args: Record<string, unknown>) => string>;

function attachRegistry(fw: AgentFramework, seeds: Seed[], toolReplies: ToolReplies) {
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
    sendToolsCall: async (tool: string, args: Record<string, unknown>) => {
      sends.push({ server: id, tool, args });
      const reply = toolReplies[tool];
      return {
        content: [{ type: 'text', text: reply ? reply(args) : JSON.stringify({ ok: true, n: sends.length }) }],
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
      activeChannelResolver: (name) => i.turnChannelFor(name),
      homeChannel: i.mcplHomeChannel ?? undefined,
      onRouteFailure: () => {},
      onChannelAutoOpened: ({ conversationId, serverId, source, channels }) =>
        i.recordChannelAutoOpenNotice(conversationId, serverId, channels, source),
    },
  );
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  for (const s of seeds) {
    map.set(destinationKey({ serverId: s.server, channelId: s.id }), { serverId: s.server, descriptor: { id: s.id, type: s.server, label: s.label }, open: s.open });
  }
  i.channelRegistry = registry;
  i.mcplServerRegistry = serverRegistry;
  i.mcplPrefixMap = new Map(Object.keys(servers).map((k) => [k, k]));
  return { registry, published, sends };
}

interface HarnessOpts {
  homeChannel?: string | null;
  privileged?: boolean;
  seeds?: Seed[];
  membrane?: ScriptedMembrane;
  probe?: ProbeModule;
  storePath?: string;
}

async function makeHarness(dir: string, opts: HarnessOpts = {}): Promise<Harness> {
  const membrane = opts.membrane ?? new ScriptedMembrane();
  const probe = opts.probe ?? new ProbeModule();
  if (opts.privileged) writeFileSync(join(dir, 'privileged.json'), JSON.stringify([OPERATOR]));
  const fw = await AgentFramework.create({
    storePath: opts.storePath ?? join(dir, 'store'),
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
    if (e.type === 'inference:started' && e.agentName === AGENT) turnLoci.push(e.channelId as string | undefined);
  });
  const toolReplies: ToolReplies = {};
  return {
    fw, membrane, probe, turnLoci, traces, toolReplies,
    internals: fw as unknown as Internals,
    ...attachRegistry(fw, opts.seeds ?? DEFAULT_SEEDS, toolReplies),
  };
}

// ---- events ---------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

/** A Discord DM exactly as discord-mcpl forwards it from a closed DM channel
 *  (push/event): the RFC-001 tags the server really emits for a DM —
 *  `chat:dm` + `chat:private` + `chat:addressed` — and the composite id in
 *  `mcplChannelId`. */
function realDmPush(text: string, opts: { authorId?: string; waking?: boolean } = {}): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: nextId('discord_msg'),
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      messageId: nextId('m'),
      guildId: null,
      channelId: '42',
      mcplChannelId: DM,
      authorId: opts.authorId ?? 'U-friend',
      authorName: 'friend',
      isMention: false,
      isDM: true,
    },
    tags: ['chat:dm', 'chat:private', 'chat:addressed', 'chat:from-human'],
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: opts.waking ?? true,
  } as unknown as ProcessEvent;
}

/** A Discord DM delivered over channels/incoming (the DM channel is open):
 *  discord-mcpl's metadata carries `isDM: true` and the same DM tags. */
function realDmIncoming(text: string, opts: { authorId?: string } = {}): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId: DM,
    messageId: nextId('m'),
    author: { id: opts.authorId ?? 'U-friend', name: 'friend' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { isDM: true, isMention: false },
    tags: ['chat:dm', 'chat:private', 'chat:addressed', 'chat:from-human'],
    triggerInference: true,
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

/** A message in the second private channel (open; always-wake). */
function sideRoomEvent(text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId: SIDE_ROOM,
    messageId: nextId('m'),
    author: { id: 'U-roommate', name: 'roommate' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { isDM: false, isMention: false },
    tags: ['chat:ambient', 'chat:from-human'],
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** heartbeat-mcpl firing a reminder: a channel-less push whose origin names
 *  the reminder id and whose content is the reminder's message. */
function reminderFired(reminderId: string, message: string): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'heartbeat',
    featureSet: 'heartbeat',
    eventId: nextId('reminder'),
    content: [{ type: 'text', text: message }],
    origin: { source: 'reminder', reminderId, recurring: false },
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** heartbeat-mcpl's scheduled ambient heartbeat (its configured message). */
function scheduledHeartbeat(message: string): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'heartbeat',
    featureSet: 'heartbeat',
    eventId: nextId('heartbeat'),
    content: [{ type: 'text', text: `[current time: Tue 13 Oct 2026, 02:10 (Etc/GMT+3)] ${message}` }],
    origin: { source: 'heartbeat', reason: 'schedule' },
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** heartbeat-mcpl's answers, in the server's own wording. */
function heartbeatServerReplies(h: Harness, reminderIds: string[]): void {
  const reminders: Array<{ id: string; message: string }> = [];
  let message = 'Automated ambient wake.';
  h.toolReplies.reminder_add = (args) => {
    const id = reminderIds[reminders.length] ?? `rem_${reminders.length}zz9`;
    reminders.push({ id, message: String(args.message) });
    return `Reminder ${id} set: in 60m (one-shot) — "${String(args.message)}"`;
  };
  h.toolReplies.reminder_list = () => reminders.length === 0
    ? 'No reminders set.'
    : `${reminders.length} reminder(s):\n${reminders.map((r) => `${r.id} | in 59m (one-shot) — "${r.message}"`).join('\n')}`;
  h.toolReplies.heartbeat_configure = (args) => {
    if (typeof args.message === 'string') message = args.message;
    return `Updated. Heartbeat ACTIVE | interval=21600s (6.00h) | next in ~21600s | reminders=${reminders.length} | message="${message}"`;
  };
}

function heartbeatEvent(): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'heartbeat',
    featureSet: 'heartbeat',
    eventId: nextId('heartbeat'),
    content: [{ type: 'text', text: '[heartbeat] scheduled check-in' }],
    origin: { source: 'heartbeat', reason: 'interval' },
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

function cliInput(content: string, waking = true): ProcessEvent {
  return { type: 'external-message', source: 'cli', content, metadata: {}, triggerInference: waking } as unknown as ProcessEvent;
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
const windowTexts = (fw: AgentFramework): string[] =>
  fw.getAgent(AGENT)!.getContextManager().getAllMessages().map((m) => blockText(m.content));
const publishedTo = (h: { published: Publish[] }, channelId: string, server?: string): string[] =>
  h.published
    .filter((p) => p.channelId === channelId && (server === undefined || p.server === server))
    .map((p) => p.text);
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------

describe('strict routing final mutation review (ROUTING_STRICT=true, CHANNEL_OPEN_ON_SEND=false)', () => {
  let dir: string;
  const saved: Partial<Record<(typeof FLAGS)[number], string | undefined>> = {};
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-final-mut-'));
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

  async function harness(opts: HarnessOpts = {}): Promise<Harness> {
    const h = await makeHarness(dir, opts);
    harnesses.push(h);
    return h;
  }


  // -------------------------------------------------------------------------
  // MP5 (strictMessagePlace: DM-channel detection). discord-mcpl tags every
  // DM `chat:dm` + `chat:private`; those tags also mark an in-world whisper
  // (a one-party place that publishes nowhere). Only the DM-channel check
  // (`isDM`, `guildId: null`, the `discord:dm:` composite) keeps a real DM a
  // place that publishes into the DM. The existing suites build DMs with
  // `chat:addressed` alone, so no test noticed the check removed — and a
  // removed check silently keeps every DM reply private (never delivered).
  // -------------------------------------------------------------------------
  it('MP5: a real Discord DM (chat:dm + chat:private) is answered in the DM, over push/event and channels/incoming', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Reading your DM.'), tool('c1', 'probe--wait')),
        final(text('Here is my answer in the DM.')),
      )
      .turn(final(text('And again, in the DM.')));
    h.probe.hooks.push(async () => {
      // A same-person follow-up in the same DM is heard while acting.
      h.fw.pushEvent(realDmPush('private: one more detail'));
      await settle();
    });
    h.fw.pushEvent(realDmPush('private: how are you?'));
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM, DM], 'the DM turn (and its follow-up wake) are locked to the DM');
    assert.match(injectedText(h.membrane.streams[0]!), /one more detail/, 'same-DM follow-up heard mid-turn');
    assert.deepEqual(publishedTo(h, DM), ['Reading your DM.', 'Here is my answer in the DM.', 'And again, in the DM.'],
      'LOSS: a real DM reply was kept private instead of being delivered to the DM');

    h.membrane.turn(final(text('Open-DM answer.')));
    h.fw.pushEvent(realDmIncoming('private: now the DM channel is open'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, DM, DM]);
    assert.deepEqual(publishedTo(h, DM).at(-1), 'Open-DM answer.');
    assert.equal(h.published.filter((p) => p.channelId !== DM).length, 0, 'nothing published anywhere else');
  });

  // -------------------------------------------------------------------------
  // ARMED PLACE over-attribution (strictNoteArming / strictArmedPlace).
  // Every MCPL call a non-home turn makes is noted with the free text of its
  // arguments AND every id-like token of the server's answer. heartbeat-mcpl
  // answers `reminder_list` with the ids of ALL pending reminders, and
  // delivers `heartbeat_configure`'s message on every scheduled heartbeat. So
  // a DM turn that merely LISTS reminders captures reminders armed at home
  // (and in other places), and a DM turn that re-words the heartbeat files
  // every later heartbeat under the DM — the spec's channel-less wake (home
  // channel, P4/S4) then speaks in the DM.
  // -------------------------------------------------------------------------
  it('ARMED-1 (leak): a reminder armed in a home turn is answered at home, even after a DM turn listed the reminders', async () => {
    const h = await harness();
    heartbeatServerReplies(h, ['rem_mh2k9q1_a7f3']);
    h.membrane
      // Home turn (channel-less operator input): arms the reminder.
      .turn(
        round(text('Setting a reminder.'), tool('c1', 'heartbeat--reminder_add', { message: 'Review the home channel backlog tonight', inMinutes: 60 })),
        final(text('Reminder set for tonight.')),
      )
      // DM turn: someone asks what reminders are pending.
      .turn(
        round(text('Let me look.'), tool('c2', 'heartbeat--reminder_list', {})),
        final(text('I have one reminder pending.')),
      )
      // The reminder fires.
      .turn(final(text('Reviewing the home backlog now: three threads need replies.')));

    h.fw.pushEvent(cliInput('operator: remind yourself to review the backlog tonight'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(realDmPush('private: do you have any reminders set?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [HOME, DM], 'precondition: a home turn armed it, a DM turn listed it');
    assert.deepEqual(h.sends.map((s) => s.tool), ['reminder_add', 'reminder_list']);

    h.fw.pushEvent(reminderFired('rem_mh2k9q1_a7f3', 'Review the home channel backlog tonight'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, DM), ['Let me look.', 'I have one reminder pending.'],
      'LEAK: the home reminder\'s turn spoke in the DM (the DM turn only LISTED the reminders)');
    assert.equal(h.turnLoci[2], HOME, 'the reminder is answered where it was armed (home)');
    assert.deepEqual(publishedTo(h, HOME).at(-1), 'Reviewing the home backlog now: three threads need replies.');
  });

  it('ARMED-2 (leak): after a DM turn re-words the ambient heartbeat, a scheduled heartbeat is still a home turn (P4/S4)', async () => {
    const h = await harness();
    heartbeatServerReplies(h, []);
    h.membrane
      .turn(
        round(text('Changing my heartbeat wording.'), tool('c1', 'heartbeat--heartbeat_configure', {
          message: 'Ambient wake: look around, tend your notes, check on everyone.',
        })),
        final(text('Done, it will read like that from now on.')),
      )
      .turn(final(text('Heartbeat musing: the home channel was busy today; I owe two replies.')));

    h.fw.pushEvent(realDmPush('private: could you make your heartbeat message friendlier?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM]);

    h.fw.pushEvent(scheduledHeartbeat('Ambient wake: look around, tend your notes, check on everyone.'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, DM), ['Changing my heartbeat wording.', 'Done, it will read like that from now on.'],
      'LEAK: a scheduled heartbeat turn published its musing into the DM');
    assert.equal(h.turnLoci[1], HOME, 'a channel-less heartbeat is a home turn');
    assert.deepEqual(publishedTo(h, HOME), ['Heartbeat musing: the home channel was busy today; I owe two replies.']);
  });

  it('ARMED-3 (loss): a reminder armed in the private side-room channel is answered there, even after a DM turn listed it', async () => {
    const h = await harness();
    heartbeatServerReplies(h, ['rem_k2p9x4m_b81c']);
    h.membrane
      .turn(
        round(text('I will remember.'), tool('c1', 'heartbeat--reminder_add', { message: 'Ask how the flat move went', inHours: 2 })),
        final(text('Reminder set.')),
      )
      .turn(
        round(text('Checking.'), tool('c2', 'heartbeat--reminder_list', {})),
        final(text('One reminder pending.')),
      )
      .turn(final(text('Hey, how did the move go?')));

    h.fw.pushEvent(sideRoomEvent('roommate: we move flats on Saturday, ask me later how it went'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(realDmPush('private: any reminders pending?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [SIDE_ROOM, DM], 'precondition');

    h.fw.pushEvent(reminderFired('rem_k2p9x4m_b81c', 'Ask how the flat move went'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, SIDE_ROOM).at(-1), 'Hey, how did the move go?',
      'LOSS: the side-room reminder was answered nowhere (two places matched its id → kept private)');
    assert.deepEqual(publishedTo(h, DM), ['Checking.', 'One reminder pending.']);
  });

  it('ARMED-4 (loss): two places set reminders with the same wording; the one whose id fires is answered in its own place', async () => {
    const h = await harness();
    heartbeatServerReplies(h, ['rem_dm7q2w9_e5d1', 'rem_ap3x8k4_f2a6']);
    h.membrane
      .turn(round(text('Okay.'), tool('c1', 'heartbeat--reminder_add', { message: 'Take the evening medication', inHours: 3 })), final(text('Reminder set.')))
      .turn(round(text('Sure.'), tool('c2', 'heartbeat--reminder_add', { message: 'Take the evening medication', inHours: 5 })), final(text('Set for you too.')))
      .turn(final(text('Time for your evening medication.')));
    h.fw.pushEvent(realDmPush('private: remind me to take my evening medication'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(sideRoomEvent('roommate: remind me about my evening medication as well'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, SIDE_ROOM], 'precondition');

    // The DM's reminder fires: its id names exactly one arming.
    h.fw.pushEvent(reminderFired('rem_dm7q2w9_e5d1', 'Take the evening medication'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, DM).at(-1), 'Time for your evening medication.',
      'LOSS: the reminder whose id the DM turn armed was kept private (the shared wording matched both places)');
    assert.deepEqual(publishedTo(h, SIDE_ROOM), ['Sure.', 'Set for you too.']);
  });

  // -------------------------------------------------------------------------
  // RL6 (strictPendingWakePlaces: provider-cooldown held wakes). An OpenAI
  // organization acceleration 429 parks the agent's wakes in a provider
  // cooldown (agent idle, wakes neither queued nor turn-alive). A DM that
  // arrives meanwhile must be held from the place whose wake the cooldown
  // holds — that turn starts first when the cooldown ends. No existing test
  // drives the cooldown, so the cooldown's wakes could be dropped from the
  // pending-wake set and the DM would land in the world turn's context.
  // -------------------------------------------------------------------------
  it('RL6: a DM arriving during a provider cooldown is not in the context of the cooled-down world turn', async () => {
    const h = await harness();
    const i = h.internals;
    i.providerAccelerationDefaultCooldownMs = 1_000;
    i.providerAccelerationJitterMs = 0;
    h.membrane.failures.push(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 }, rawRequest: {} as NormalizedRequest,
    }));
    h.membrane
      .turn(final(text('World answer after the cooldown.')))
      .turn(final(text('DM answer.')));

    h.fw.pushEvent(worldEvent('@resident are you around?'));
    await h.fw.runUntilIdle();
    assert.equal(i.providerAccelerationCooldowns.size, 1, 'precondition: the world wake is held by a provider cooldown');

    h.fw.pushEvent(realDmPush('private: SECRET-DM-WORDS during the cooldown'));
    await h.fw.runUntilIdle();
    assert.doesNotMatch(windowTexts(h.fw).join('\n'), /SECRET-DM-WORDS/, 'held while the cooled-down world wake waits');

    await settle(1_200);
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [WORLD, WORLD, DM], 'the failed world attempt, its retry after the cooldown, then the DM');
    assert.doesNotMatch(requestText(h.membrane.calls[1]!), /SECRET-DM-WORDS/,
      'LEAK: the DM is in the context of the world turn that ran after the cooldown');
    assert.match(requestText(h.membrane.calls[2]!), /SECRET-DM-WORDS/);
    assert.deepEqual(publishedTo(h, WORLD), ['World answer after the cooldown.']);
    assert.deepEqual(publishedTo(h, DM), ['DM answer.']);
  });

  // -------------------------------------------------------------------------
  // Auxiliary-call parking (compression). A DM held during a world turn waits
  // for the DM's own turn; that turn parks behind a compression call that
  // queued during the world turn, and the DM person writes again meanwhile.
  // -------------------------------------------------------------------------
  async function parkedDmFollowUp(h: Harness): Promise<string> {
    const i = h.internals;
    h.membrane
      .turn(
        round(text('Looking around the plaza.'), tool('c1', 'probe--wait')),
        final(text('The plaza is quiet.')),
      )
      .turn(final(text('Answering both of your DMs.')))
      .turn(final(text('(follow-up DM turn)')));

    // An auxiliary call is in flight before anything happens: the world wake parks.
    let releaseFirst!: () => void;
    const aux1 = i.withAuxiliaryAdmission(AGENT, () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    let releaseSecond!: () => void;
    let aux2: Promise<void> | undefined;
    h.probe.hooks.push(async () => {
      // A compression pass queues during the world turn: it runs between the
      // world turn and the next one, which parks behind it.
      aux2 = i.withAuxiliaryAdmission(AGENT, () => new Promise<void>((resolve) => { releaseSecond = resolve; }));
      await settle(10);
    });

    h.fw.start();
    h.fw.pushEvent(worldEvent('@resident come to the plaza'));
    await waitFor('the world wake to park', () => i.strictParkedPlaces.get(AGENT)?.includes(WORLD) ?? false);
    h.fw.pushEvent(realDmPush('private: DM-FIRST are you free tonight?'));
    await waitFor('the first DM to be held', () =>
      i.deferredMessages.some((m) => /DM-FIRST/.test(blockText((m as { content?: unknown }).content))));

    releaseFirst();
    await aux1;
    await waitFor('the DM wake to park behind the second auxiliary call', () =>
      h.membrane.calls.length === 1 && (i.strictParkedPlaces.get(AGENT)?.includes(DM) ?? false));

    h.fw.pushEvent(realDmPush('private: DM-SECOND (sorry, I meant tomorrow)'));
    await waitFor('the second DM to be processed', () =>
      windowTexts(h.fw).some((t) => /DM-SECOND/.test(t))
      || i.deferredMessages.some((m) => /DM-SECOND/.test(blockText((m as { content?: unknown }).content))));

    releaseSecond();
    await aux2;
    await waitFor('the DM turn', () => h.membrane.calls.length >= 2);
    await h.fw.runUntilIdle();
    assert.equal(h.turnLoci[0], WORLD);
    assert.equal(h.turnLoci[1], DM);
    assert.doesNotMatch(requestText(h.membrane.calls[0]!), /DM-FIRST|DM-SECOND/, 'nothing of the DM reached the world turn');
    return requestText(h.membrane.calls[1]!);
  }

  it('RL3: the DM turn that parked behind a compression call contains the DM held for it, even when the same person wrote again meanwhile', async () => {
    const h = await harness();
    const dmRequest = await parkedDmFollowUp(h);
    assert.match(dmRequest, /DM-FIRST/,
      'the message that woke the DM turn is missing from it (still held at its own turn start)');
    assert.match(dmRequest, /DM-SECOND/);
  });

  it('PARK-ORDER (regression): a DM written while its turn is parked never lands before the earlier DM that was held for that turn', async () => {
    const h = await harness();
    const dmRequest = await parkedDmFollowUp(h);
    const first = dmRequest.indexOf('DM-FIRST');
    const second = dmRequest.indexOf('DM-SECOND');
    assert.ok(first >= 0 && second >= 0, 'both DMs are in the DM turn');
    assert.ok(first < second,
      'REGRESSION: the DM turn reads the person\'s second message BEFORE their first (the parked-branch hold check skips the arrival-order rule)');
  });

  // -------------------------------------------------------------------------
  // MP1 / MP1b (strictMessagePlace: framework system markers). A `system`
  // row with no server is the framework's own note about the agent's own
  // action (the `[discord-send-failed]` marker carries the failed channel's
  // id) — no place, heard at the next boundary of whatever turn runs. A row
  // from an MCPL server always carries its serverId, so a server that sets
  // `system: true` in its metadata cannot pass its channel's traffic off as a
  // framework marker and slip past the hold.
  // -------------------------------------------------------------------------
  it('MP1: the framework\'s own send-failed marker (channelId, no server) is heard mid-turn, not held as that channel\'s traffic', async () => {
    const h = await harness();
    h.membrane.turn(
      round(text('Thinking.'), tool('c1', 'probe--wait')),
      final(text('Done.')),
    );
    h.probe.hooks.push(async () => {
      // Exactly the marker the framework's onRouteFailure writes.
      (h.fw as unknown as { addMessage(p: string, c: ContentBlock[], m: Record<string, unknown>): string }).addMessage(
        'user',
        [text('[discord-send-failed] Your previous reply (12 chars) could not be delivered to #home (discord:G1:home) (delivery not confirmed).')],
        { system: true, kind: 'discord-send-failed', channelId: HOME, reason: 'delivery not confirmed' },
      );
      await settle();
    });
    h.fw.pushEvent(realDmPush('private: quick question'));
    await h.fw.runUntilIdle();
    assert.match(injectedText(h.membrane.streams[0]!), /discord-send-failed/,
      'the marker about the agent\'s own failed delivery is heard at the next boundary');
    assert.deepEqual(h.turnLoci, [DM]);
  });

  it('MP1b: a world server that stamps `system: true` on its message is still held from a DM turn', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Reading your DM.'), tool('c1', 'probe--wait')),
        final(text('DM answer.')),
      )
      .turn(final(text('World answer.')));
    h.probe.hooks.push(async () => {
      const e = worldEvent('@resident SYSTEM-STAMPED world words') as unknown as { metadata: Record<string, unknown> };
      e.metadata = { system: true };
      h.fw.pushEvent(e as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(realDmPush('private: a private question'));
    await h.fw.runUntilIdle();
    assert.doesNotMatch(injectedText(h.membrane.streams[0]!), /SYSTEM-STAMPED/,
      'LEAK: a server\'s system-stamped message was injected into the DM turn');
    assert.deepEqual(h.turnLoci, [DM, WORLD]);
    assert.match(requestText(h.membrane.calls[1]!), /SYSTEM-STAMPED/);
  });

  // -------------------------------------------------------------------------
  // L5 (turn start: the active channel is the turn's PLACE's publish target,
  // not the trigger's channel). The registry hands every MCPL server the
  // turn's channel context before inference (`defaultOutgoing`, and the
  // latest inbound message only when it is in that outgoing place). A
  // whisper turn publishes nowhere — no server may be told the public world
  // channel is where this turn speaks; a channel-less home turn (heartbeat)
  // speaks at home and says so.
  // -------------------------------------------------------------------------
  it('L5: the channel context servers receive names the place\'s publish target (whisper: none; heartbeat: home)', async () => {
    const h = await harness();
    const seen: Array<{ outgoing?: string; incoming?: string }> = [];
    const snapshot = async (): Promise<void> => {
      // Each server is told only its own channels' context.
      const ctxs = ['discord', 'eidoverse'].map((server) => h.registry.buildChannelContext(AGENT, server));
      seen.push({
        outgoing: ctxs.map((c) => c?.defaultOutgoing?.channelId).find((id) => id !== undefined),
        incoming: ctxs.map((c) => c?.incoming?.channelId).find((id) => id !== undefined),
      });
    };
    h.probe.hooks.push(snapshot, snapshot);
    h.membrane
      .turn(round(tool('c1', 'probe--wait')), final(text('(kept between us)')))
      .turn(round(tool('c2', 'probe--wait')), final(text('Home check-in.')));
    // The registry's latest inbound is the whisper on the public world channel.
    const reg = h.registry as unknown as { defaultPublishChannel: ChannelRef | null; defaultPublishMessageId: string | null };
    h.fw.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'eidoverse',
      channelId: WORLD,
      messageId: nextId('w'),
      author: { id: 'mira', name: 'mira' },
      content: [{ type: 'text', text: 'mira: (whispers to you) meet me by the well' }],
      timestamp: new Date().toISOString(),
      metadata: { mentioned: true, isExplicitMention: true },
      tags: ['chat:dm', 'chat:private', 'chat:addressed', 'eidoverse:whisper'],
      triggerInference: true,
    } as unknown as ProcessEvent);
    reg.defaultPublishChannel = { serverId: 'eidoverse', channelId: WORLD };
    reg.defaultPublishMessageId = 'w-latest';
    await h.fw.runUntilIdle();
    h.fw.pushEvent(heartbeatEvent());
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [undefined, HOME]);
    assert.equal(seen[0]?.outgoing, undefined, 'a whisper turn tells no server that it speaks on the public world channel');
    assert.equal(seen[0]?.incoming, undefined, 'nor names the public channel\'s latest message as what it answers');
    assert.equal(seen[1]?.outgoing, HOME, 'a heartbeat turn speaks at home and says so');
    assert.deepEqual(h.published.map((p) => p.channelId), [HOME]);
  });

  // -------------------------------------------------------------------------
  // A4 / A5 (strictArmedPlace). An echo that matches what turns in TWO
  // different places armed is ambiguous and kept private (never guessed); an
  // echo from a DIFFERENT server than the one a turn armed never inherits
  // that turn's place.
  // -------------------------------------------------------------------------
  it('A4: a channel-less push matching what two different places armed is kept private (published nowhere)', async () => {
    const h = await harness();
    // A server that answers without ids: only the armed TEXT can match.
    h.toolReplies.reminder_add = () => 'ok';
    h.membrane
      .turn(round(text('Noted.'), tool('c1', 'heartbeat--reminder_add', { message: 'Water the balcony plants', inHours: 1 })), final(text('Will do.')))
      .turn(round(text('Sure.'), tool('c2', 'heartbeat--reminder_add', { message: 'Water the balcony plants', inHours: 1 })), final(text('Set.')))
      .turn(final(text('Time to water the plants!')));
    h.fw.pushEvent(realDmPush('private: remind me to water the plants'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(sideRoomEvent('roommate: can you remind us about the plants too?'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, SIDE_ROOM]);
    const before = h.published.length;

    h.fw.pushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: nextId('reminder'),
      content: [text('Water the balcony plants')], origin: { source: 'reminder' },
      timestamp: new Date().toISOString(), inferenceId: nextId('inf'), triggerInference: true,
    } as unknown as ProcessEvent);
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci.length, 3);
    assert.equal(h.turnLoci[2], undefined, 'an ambiguous echo is answered nowhere (kept private)');
    assert.equal(h.published.length, before, 'nothing published in either place');
  });

  it('A5: an echo from a different server never inherits the place of a turn that armed something on another server', async () => {
    const h = await harness();
    h.toolReplies.reminder_add = () => 'ok';
    h.membrane
      .turn(round(text('Noted.'), tool('c1', 'heartbeat--reminder_add', { message: 'Bring the blue umbrella tomorrow', inHours: 12 })), final(text('Will remind you.')))
      .turn(final(text('Home: someone mentioned umbrellas in the world.')));
    h.fw.pushEvent(realDmPush('private: remind me about the umbrella'));
    await h.fw.runUntilIdle();

    // A channel-less notice from the world server that happens to carry the text.
    h.fw.pushEvent({
      type: 'mcpl:push-event', serverId: 'eidoverse', featureSet: 'world', eventId: nextId('world'),
      content: [text('World notice: Bring the blue umbrella tomorrow — rain over the plaza')], origin: { source: 'world-notice' },
      timestamp: new Date().toISOString(), inferenceId: nextId('inf'), triggerInference: true,
    } as unknown as ProcessEvent);
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM, HOME], 'the other server\'s channel-less push is a home turn');
    assert.deepEqual(publishedTo(h, DM), ['Noted.', 'Will remind you.']);
  });

  // AR1 / AR2: the minimum text length of a match. A short argument (a
  // one-word reminder) or a short push body is a common word, not an echo:
  // without the floor, a heartbeat that happens to contain the word, or a
  // short home reminder contained in a DM's longer reminder text, would be
  // filed under the DM.
  it('AR1: a one-word reminder set in a DM does not capture a scheduled heartbeat that contains the word', async () => {
    const h = await harness();
    heartbeatServerReplies(h, ['rem_s1t2r3c_h4']);
    h.membrane
      .turn(round(text('Okay.'), tool('c1', 'heartbeat--reminder_add', { message: 'Stretch', inMinutes: 30 })), final(text('I will nudge you.')))
      .turn(final(text('Heartbeat: quiet day at home.')));
    h.fw.pushEvent(realDmPush('private: remind me to stretch in half an hour'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(scheduledHeartbeat('Ambient wake: take a breath, stretch, look around the home channel.'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, HOME], 'the heartbeat is a home turn');
    assert.deepEqual(publishedTo(h, DM), ['Okay.', 'I will nudge you.']);
  });

  it('AR2: a short home reminder firing is not filed under a DM whose longer reminder text contains its words', async () => {
    const h = await harness();
    heartbeatServerReplies(h, ['rem_h0m3r3m_01', 'rem_dmr3m1n_02']);
    h.membrane
      .turn(round(text('Set.'), tool('c1', 'heartbeat--reminder_add', { message: 'Stretch', inMinutes: 20 })), final(text('Home reminder set.')))
      .turn(round(text('Okay.'), tool('c2', 'heartbeat--reminder_add', { message: 'Remember to stretch after the long call', inHours: 2 })), final(text('DM reminder set.')))
      .turn(final(text('Stretch break, everyone at home.')));
    h.fw.pushEvent(cliInput('operator: remind yourself to stretch in 20 minutes'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(realDmPush('private: remind me to stretch after the long call'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [HOME, DM], 'precondition');

    h.fw.pushEvent(reminderFired('rem_h0m3r3m_01', 'Stretch'));
    await h.fw.runUntilIdle();
    assert.equal(h.turnLoci[2], HOME, 'the home reminder is answered at home');
    assert.deepEqual(publishedTo(h, DM), ['Okay.', 'DM reminder set.']);
  });

  // AR3: only id-LIKE tokens (letters AND digits) of a server's answer are
  // kept. heartbeat-mcpl's status line is plain words, and its scheduled
  // heartbeat's origin is `{ source: 'heartbeat', reason: 'schedule' }`: a
  // word-token match would file every later heartbeat under the place that
  // merely asked for the status.
  it('AR3: asking for the heartbeat status in a DM does not capture later scheduled heartbeats', async () => {
    const h = await harness();
    h.toolReplies.heartbeat_status = () =>
      'Heartbeat ACTIVE | interval=21600s (6.00h) | next in ~21000s | reminders=0 | message="Ambient wake: keep to the schedule"';
    h.membrane
      .turn(round(text('Let me check.'), tool('c1', 'heartbeat--heartbeat_status', {})), final(text('Every six hours.')))
      .turn(final(text('Heartbeat: all quiet at home.')));
    h.fw.pushEvent(realDmPush('private: how often does your heartbeat run?'));
    await h.fw.runUntilIdle();
    h.fw.pushEvent(scheduledHeartbeat('Ambient wake: keep to the schedule'));
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, HOME], 'the scheduled heartbeat is a home turn');
    assert.deepEqual(publishedTo(h, DM), ['Let me check.', 'Every six hours.']);
  });

  // -------------------------------------------------------------------------
  // LS2 (the sleep tool's announcement). Two world servers serve a world
  // with the same channel id; a sleep announced in a turn of the VISITED
  // world goes to the visited world's channel, on its server — never to the
  // same-named channel of the server registered first.
  // -------------------------------------------------------------------------
  it('LS2: a sleep announced in a visited-world turn is said in the visited world only', async () => {
    const h = await harness({ seeds: TWO_WORLDS, privileged: true });
    h.membrane.turn(createMockResponse([tool('s1', 'sleep', { seconds: 1, message: 'Resting by the visited fountain for a moment.' })], 'tool_use'));
    h.fw.pushEvent(worldEvent('@resident rest here a while?', { serverId: 'eidoverse-visit', channelId: COMMONS }));
    await h.fw.runUntilIdle();
    await settle(20);
    assert.deepEqual(h.turnLoci, [COMMONS]);
    assert.deepEqual(publishedTo(h, COMMONS, 'eidoverse'), [], 'nothing said in the home world with the same channel id');
    assert.deepEqual(publishedTo(h, COMMONS, 'eidoverse-visit'), ['Resting by the visited fountain for a moment.']);
    await settle(1_200);
    await h.fw.runUntilIdle();
    assert.deepEqual(publishedTo(h, COMMONS, 'eidoverse'), [], 'nor by the turn its expiry wakes');
  });

  // -------------------------------------------------------------------------
  // BR1 (privileged brake over channels/incoming). The operator's message
  // arrives through an OPEN channel (the home channel), not a DM push: the
  // braking message's place still takes the next turn, ahead of a DM that
  // was waiting longer.
  // -------------------------------------------------------------------------
  it('BR1: a privileged stop in the open home channel brakes the world turn and is answered next, before an older waiting DM', async () => {
    const h = await harness({ privileged: true });
    h.membrane
      .turn(round(text('Building a tower.'), tool('c1', 'probe--wait')), final(text('never delivered')))
      .turn(final(text('Stopped. What do you need?')))
      .turn(final(text('Answering your DM now.')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(realDmPush('private: a question for later'));
      await settle(20);
      h.fw.pushEvent({
        type: 'mcpl:channel-incoming',
        serverId: 'discord',
        channelId: HOME,
        messageId: nextId('m'),
        author: { id: OPERATOR, name: 'operator' },
        content: [text('operator: @resident stop building, now')],
        timestamp: new Date().toISOString(),
        metadata: { isDM: false, isMention: true },
        tags: ['chat:mention', 'chat:addressed', 'chat:from-human'],
        triggerInference: true,
      } as unknown as ProcessEvent);
      await settle(60);
    });
    h.fw.pushEvent(worldEvent('@resident build something tall'));
    await h.fw.runUntilIdle();
    assert.ok(h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'), 'the world turn was braked');
    assert.deepEqual(h.turnLoci, [WORLD, HOME, DM], 'the braking message\'s place is answered next');
    assert.deepEqual(publishedTo(h, HOME), ['Stopped. What do you need?']);
    assert.deepEqual(publishedTo(h, DM), ['Answering your DM now.']);
  });

  // -------------------------------------------------------------------------
  // BR3 (privileged brake during an error-retry backoff). The brake ends the
  // turn deliberately: the window gets the honest `[interrupted]` marker,
  // never the `[inference-failed]` "change approach" marker, and the brake is
  // not counted toward the hard-down failure streak.
  // -------------------------------------------------------------------------
  it('BR3: a brake during a retry backoff is recorded as an interruption, not as an inference failure', async () => {
    const h = await harness({ privileged: true });
    h.membrane.failures.push(new Error('provider overloaded (529)'));
    // The braked retry never streams: the next script is the STOP's own turn.
    h.membrane.turn(final(text('Stopped, as you asked.')));
    let sent = false;
    h.fw.onTrace((event) => {
      if ((event as { type: string }).type === 'inference:failed' && !sent) {
        sent = true;
        setTimeout(() => h.fw.pushEvent(realDmPush('private: STOP now', { authorId: OPERATOR })), 100);
      }
    });
    h.fw.pushEvent(worldEvent('@resident build a tall tower'));
    await h.fw.runUntilIdle();
    await settle(50);
    await h.fw.runUntilIdle();
    assert.ok(sent, 'precondition: the first attempt failed and its retry waited out a backoff');
    assert.ok(h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'), 'the retry was braked');
    const window = windowTexts(h.fw).join('\n');
    // Upstream's deliberate-stop marker (abortInference → settleDeliberateCancel).
    assert.match(window, /\[turn-interrupted\][^\n]*a deliberate stop, not a failure/, 'the honest interruption marker is recorded');
    assert.doesNotMatch(window, /\[inference-failed\]/, 'a deliberate brake is not recorded as a model failure');
    assert.deepEqual(publishedTo(h, DM), ['Stopped, as you asked.']);
    assert.deepEqual(h.turnLoci, [WORLD, DM]);
  });
});
