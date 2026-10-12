/**
 * Adversarial hunt: strict routing at turn START and turn END.
 *
 * Each case is a scenario that SHOULD hold under ROUTING_STRICT=true (+
 * CHANNEL_OPEN_ON_SEND=false) per the strict-routing spec — words meant for
 * one place are never published in (or shown to) another, and nothing held
 * is lost, duplicated or reordered — written so that it FAILS against the
 * implementation when a leak / loss / regression exists. Nothing here
 * changes the implementation.
 *
 * The harness mirrors test/strict-routing-privacy.test.ts: the REAL turn
 * machinery and the REAL ChannelRegistry over two mock MCPL servers
 * (`discord`: a DM, a home channel, a closed lounge, a private channel;
 * `eidoverse`: a world channel). H1 uses the RFC-006 wire fixture instead.
 */

import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type {
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
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, TS } from './helpers/coalescing-fixture.js';

const AGENT = 'resident';
const DM = 'discord:dm:42';
const WORLD = 'world:plaza';
const HOME = 'discord:G1:home';
const CLOSED = 'discord:G1:lounge';
const PRIVATE = 'discord:G1:private';
const OPERATOR = 'U-operator';

const FLAGS = ['ROUTING_STRICT', 'CHANNEL_OPEN_ON_SEND', 'ROUTING_NO_SILENCE_ON_SEND'] as const;

function setStrict(on: boolean): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const f of FLAGS) saved[f] = process.env[f];
  if (on) {
    process.env.ROUTING_STRICT = 'true';
    process.env.CHANNEL_OPEN_ON_SEND = 'false';
    process.env.ROUTING_NO_SILENCE_ON_SEND = 'true';
  } else {
    for (const f of FLAGS) delete process.env[f];
  }
  return () => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  };
}

// ---------------------------------------------------------------------------
// Harness (same shape as the strict privacy suite's)
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
  ctx: { addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>): string; pushEvent(e: ProcessEvent): void } | null = null;

  async start(ctx: unknown): Promise<void> { this.ctx = ctx as never; }
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

  /** As SubagentModule.onProcess: an async subagent's completion event
   *  becomes a wake for its parent. */
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    const e = event as { type: string; source?: string; agentName?: string };
    if (e.type === 'inference-request' && e.source === 'subagent' && e.agentName) {
      return { requestInference: [e.agentName] };
    }
    return {};
  }
}

interface Internals {
  channelRegistry: unknown;
  mcplServerRegistry: unknown;
  mcplPrefixMap: Map<string, string>;
  activeTriggerChannels: Map<string, string>;
  activeTurnTokens: Map<string, number>;
  mcplHomeChannel: string | null;
  deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
  pendingRequests: Array<{ agentName: string; reason: string; channelId?: string }>;
  eventGate: { asShouldTriggerCallback(): (content: string, metadata: Record<string, unknown>) => boolean } | null;
  tuneOutCoordinator: unknown;
  recordChannelAutoOpenNotice(
    agentName: string | undefined,
    channels: Array<{ channelId: string; label?: string }>,
    cause: string,
  ): void;
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  processNextEvent(): Promise<void>;
  withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>): Promise<T>;
  providerGates: Map<string, { primaryDepth: number }>;
}

interface Publish { server: string; channelId: string; text: string }

interface Harness {
  fw: AgentFramework;
  membrane: ScriptedMembrane;
  probe: ProbeModule;
  registry: ChannelRegistry;
  serverRegistry: unknown;
  published: Publish[];
  turnLoci: Array<string | undefined>;
  traces: Array<{ type: string; [k: string]: unknown }>;
  internals: Internals;
}

const internalsOf = (fw: AgentFramework): Internals => fw as unknown as Internals;

function attachRegistry(fw: AgentFramework) {
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
    sendChannelsAcknowledge: async () => ({}),
    sendToolsCall: async (_tool: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, channelId: args.channelId }) }],
    }),
  });
  const servers: Record<string, ReturnType<typeof mkServer>> = {
    discord: mkServer('discord'),
    eidoverse: mkServer('eidoverse'),
    // A second world host (another eidoverse deployment). Eidoverse names its
    // channel `world:<worldName>` with no server prefix, so two hosts running
    // a same-named world (the default is "commons") register the same id.
    eidoverse2: mkServer('eidoverse2'),
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
      onRouteFailure: () => {},
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
  seed('discord', PRIVATE, 'private', true);
  seed('eidoverse', WORLD, 'plaza', true);
  seed('eidoverse2', WORLD, 'plaza (second host)', true);

  i.channelRegistry = registry;
  i.mcplServerRegistry = serverRegistry;
  i.mcplPrefixMap = new Map([['discord', 'discord'], ['eidoverse', 'eidoverse'], ['eidoverse2', 'eidoverse2']]);
  return { registry, serverRegistry, published };
}

interface HarnessOpts {
  homeChannel?: string | null;
  privileged?: boolean;
  gatePolicies?: unknown[];
  agentExtra?: Record<string, unknown>;
}

async function makeHarness(dir: string, opts: HarnessOpts = {}): Promise<Harness> {
  const membrane = new ScriptedMembrane();
  const probe = new ProbeModule();
  if (opts.privileged) writeFileSync(join(dir, 'privileged.json'), JSON.stringify([OPERATOR]));
  const wantGate = opts.privileged || opts.gatePolicies;
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a resident.', ...(opts.agentExtra ?? {}) }],
    modules: [probe],
    ...(opts.homeChannel === null ? {} : { homeChannel: opts.homeChannel ?? HOME }),
    ...(wantGate
      ? {
          gate: {
            configPath: join(dir, 'gate.json'),
            config: { policies: (opts.gatePolicies ?? []) as never[], default: 'always' as const },
            ...(opts.privileged ? { privilegedUsersPath: join(dir, 'privileged.json') } : {}),
          },
        }
      : {}),
  } as never);
  const turnLoci: Array<string | undefined> = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  fw.onTrace((event) => {
    const e = event as { type: string; [k: string]: unknown };
    traces.push(e);
    if (e.type === 'inference:started' && e.agentName === AGENT) turnLoci.push(e.channelId as string | undefined);
  });
  return { fw, membrane, probe, turnLoci, traces, internals: internalsOf(fw), ...attachRegistry(fw) };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

function dmEvent(text: string, opts: { authorId?: string; waking?: boolean } = {}): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: nextId('dm'),
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord', channelId: '42', guildId: null, isDM: true,
      authorName: 'operator', authorId: opts.authorId ?? 'U-friend', messageId: nextId('m'),
    },
    tags: ['chat:addressed'],
    timestamp: new Date().toISOString(),
    inferenceId: nextId('inf'),
    triggerInference: opts.waking ?? true,
  } as unknown as ProcessEvent;
}

function channelEvent(serverId: string, channelId: string, text: string, opts: { waking?: boolean; addressed?: boolean } = {}): ProcessEvent {
  const waking = opts.waking ?? true;
  const addressed = opts.addressed ?? waking;
  return {
    type: 'mcpl:channel-incoming',
    serverId,
    channelId,
    messageId: nextId('c'),
    author: { id: 'visitor', name: 'visitor' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: addressed ? ['chat:mention', 'chat:addressed'] : ['chat:ambient'],
    triggerInference: waking,
  } as unknown as ProcessEvent;
}

const worldEvent = (text: string, opts: { waking?: boolean } = {}) => channelEvent('eidoverse', WORLD, text, opts);

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
const requestText = (req: NormalizedRequest | undefined): string =>
  (req?.messages ?? []).map((m) => blockText((m as { content: unknown }).content)).join('\n');
const injectedText = (stream: MockYieldingStream | undefined): string =>
  (stream?.receivedToolResultOptions ?? [])
    .flatMap((o) => o?.injectedMessages ?? [])
    .map((m) => blockText(m.content))
    .join('\n');
const publishedTo = (h: Harness, channelId: string): string[] =>
  h.published.filter((p) => p.channelId === channelId).map((p) => p.text);
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function refusalResponse(): NormalizedResponse {
  return {
    ...createMockResponse([], 'refusal'),
    content: [],
    stopReason: 'refusal',
    toolCalls: [],
    rawAssistantText: '',
    usage: { inputTokens: 40, outputTokens: 0 },
    details: { stop: { reason: 'refusal', wasTruncated: false }, usage: { inputTokens: 40, outputTokens: 0 } },
    raw: { request: {}, response: { stop_details: { category: 'cyber' } } },
  } as unknown as NormalizedResponse;
}

// ---------------------------------------------------------------------------

describe('strict routing hunt: turn start / turn end (ROUTING_STRICT=true)', () => {
  let dir: string;
  let restore: () => void;
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-hunt-'));
    restore = setStrict(true);
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await Promise.all([...h.probe.inFlight]);
      try { await h.fw.runUntilIdle(); } catch { /* best effort */ }
      try { await h.fw.stop(); } catch { /* already stopped */ }
    }
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function harness(opts: HarnessOpts = {}): Promise<Harness> {
    const h = await makeHarness(dir, opts);
    harnesses.push(h);
    return h;
  }

  // -------------------------------------------------------------------------
  // H2: tune-out cancel dump. The coordinator writes the tuned-out channel's
  // verbatim backlog as `{ system: true, kind: 'tune-out-cancel', channelId }`
  // with no serverId — strictMessagePlace() classifies that as a non-channel
  // framework marker, so the boundary drain injects another place's raw
  // conversation into the running turn.
  // -------------------------------------------------------------------------
  it('H2: a tune-out cancel firing mid-world-turn must not inject the private lounge backlog into the world turn', async () => {
    const h = await harness();
    const i = h.internals;
    let tunedOut = true;
    const params = { epochId: 'epoch-1', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 0 };
    const fakeRegistry = {
      getTuneOutState: (_s: string, c: string) => (tunedOut && c === CLOSED ? { params } : null),
      cancelTuneOut: (_s: string, c: string) => {
        if (!tunedOut || c !== CLOSED) return null;
        tunedOut = false;
        return { params, wakeCount: 0 };
      },
      recordTuneOutWake: () => null,
      listChannelsRaw: () => [],
    };
    // Wired exactly as AgentFramework.create wires the coordinator's hooks.
    const coordinator = new TuneOutCoordinator(fakeRegistry as never, h.serverRegistry as never, {
      addMessage: (participant, content, metadata, forAgent) =>
        i.addMessage(participant, content, metadata, forAgent ? { forAgent } : undefined),
      requestInference: (agentName, reason, source) => {
        (i.pendingRequests as unknown[]).push({ agentName, reason, source, timestamp: Date.now() });
      },
      subconsciousName: () => null,
      primaryName: () => AGENT,
      getStoredMessages: () => h.fw.getAgent(AGENT)!.getContextManager().getAllMessages(),
      currentSequence: () => 0,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    });
    i.tuneOutCoordinator = coordinator;

    // Private lounge chatter diverted while idle (stamped, hidden from the resident).
    h.fw.pushEvent(channelEvent('discord', CLOSED, 'lounge member: the merger closes friday, keep it quiet', { waking: false }));
    await h.fw.runUntilIdle();

    h.membrane
      .turn(
        round(text('Heading to the fountain.'), tool('c1', 'probe--wait')),
        final(text('What a nice plaza.')),
      )
      .turn(final(text('(tune-out cancel turn)')));
    h.probe.hooks.push(async () => {
      // The tune-out's duration elapses mid-world-turn.
      coordinator.cancel('discord', CLOSED, 'duration', 'duration elapsed');
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident come to the fountain'));
    await h.fw.runUntilIdle();
    coordinator.stop();

    assert.equal(h.turnLoci[0], WORLD);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]), /merger closes friday/,
      'LEAK: the private lounge backlog was injected into the running world turn');
  });

  // -------------------------------------------------------------------------
  // H3: framework retry wakes carry no channelId. A refusal auto-rewind (and
  // the poison-history breaker's inference-failure-rewind-retry, and the
  // unstick retry) re-run the DM's conversation in a fresh turn whose strict
  // place is strictWakePlace(undefined) = the home channel.
  // -------------------------------------------------------------------------
  it('H3: a refusal auto-rewind retry of a DM turn must answer in the DM, never the home channel', async () => {
    const h = await harness({ agentExtra: { refusalHandling: { autoRewind: true, maxRewinds: 2 } } });
    h.membrane
      .turn(
        round(text('Let me look that up.'), tool('c1', 'probe--wait')),
        refusalResponse(),
      )
      .turn(final(text('Here is your private answer: the code is 1234.')));
    h.fw.pushEvent(dmEvent('private: what is the door code?'));
    await h.fw.runUntilIdle();
    await settle(20);
    await h.fw.runUntilIdle();

    assert.ok(h.membrane.calls.length >= 2, 'the refusal was rewound and retried');
    assert.deepEqual(publishedTo(h, HOME), [],
      'LEAK: the retried DM turn published its private answer in the home channel');
    assert.ok(publishedTo(h, DM).includes('Here is your private answer: the code is 1234.'));
  });

  // -------------------------------------------------------------------------
  // H12 (same mechanism as H3, the commonest trigger): skip_reply's
  // wake_in_seconds self-wake. Armed inside a DM turn ("back in a moment"),
  // it fires as a channel-less gate wake, so the follow-up turn's strict
  // place is the home channel — the DM conversation continues in public.
  // -------------------------------------------------------------------------
  it('H12: a self-wake armed from a DM turn must not continue the DM conversation in the home channel', async () => {
    const h = await harness({ gatePolicies: [] });
    h.membrane
      .turn(round(tool('s1', 'skip_reply', { wake_in_seconds: 1 })))
      .turn(final(text('Following up on your DM: the test results are fine.')));
    h.fw.pushEvent(dmEvent('private: can you check my test results and get back to me?'));
    await h.fw.runUntilIdle();
    await settle(1200); // the self-wake fires
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 2, 'the self-wake started a turn');
    assert.deepEqual(publishedTo(h, HOME), [],
      'LEAK: the self-wake follow-up to a DM was published in the home channel');
  });

  // -------------------------------------------------------------------------
  // H4: a dequeued wake parked behind an in-flight auxiliary call
  // (startAgentStream → waitForAuxiliaryIdle). The trigger lives in a
  // closure: it is neither in pendingRequests (strictPendingWakePlaces) nor
  // turn-alive (activeTurnTokens), so a waking message from another place
  // that arrives during the park is stored at once and is in the context of
  // the parked turn when it starts — the P3 invariant without the batch.
  // -------------------------------------------------------------------------
  it('H4: a world mention arriving while the DM turn waits for auxiliary admission must not be visible to the DM turn', async () => {
    const h = await harness();
    const i = h.internals;
    h.membrane.turn(final(text('dm answer'))).turn(final(text('world answer')));

    // An auxiliary call (compression, a summarizer) holds the provider gate.
    let release!: () => void;
    const aux = i.withAuxiliaryAdmission(AGENT, () => new Promise<void>((resolve) => { release = resolve; }));
    await settle(5);

    h.fw.pushEvent(dmEvent('private: the DM words'));
    await i.processNextEvent(); // the DM's wake is dequeued and parks on the auxiliary call
    assert.equal(i.pendingRequests.length, 0, 'the DM wake left the queue');
    assert.equal(i.activeTurnTokens.has(AGENT), false, 'not yet turn-alive (parked)');

    h.fw.pushEvent(worldEvent('@resident the world words'));
    await i.processNextEvent();

    release();
    await aux;
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 2);
    assert.deepEqual(h.turnLoci, [DM, WORLD]);
    assert.doesNotMatch(requestText(h.membrane.calls[0]), /the world words/,
      'LEAK: the world mention (its own wake pending) is in the DM turn\'s context');
  });

  // -------------------------------------------------------------------------
  // H5: gate debounce. A debounced message is stored at arrival with
  // triggered=false; its wake exists only in the gate's debounce timer /
  // inference buffer, which strictPendingWakePlaces never consults. A waking
  // message from another place then starts its turn with the debounced
  // place's words in context (and a crash before the debounce fires would
  // demote it to ambient: rearmStrictHeldWakes keys on triggered===true).
  // -------------------------------------------------------------------------
  it('H5: a debounced (waking) private-channel message must not be visible to a world turn that starts first', async () => {
    const h = await harness({
      gatePolicies: [{ name: 'private-debounce', match: { channel: PRIVATE }, behavior: { debounce: 150 } }],
    });
    const i = h.internals;
    const shouldTrigger = i.eventGate!.asShouldTriggerCallback();
    // Emulate the ChannelRegistry ingress: the gate decides triggerInference.
    const ingress = (serverId: string, channelId: string, body: string) => {
      const decision = shouldTrigger(body, {
        eventType: 'mcpl:channel-incoming', serverId, channelId, messageId: nextId('g'),
        author: { id: 'visitor', name: 'visitor' }, tags: ['chat:mention', 'chat:addressed'],
      });
      h.fw.pushEvent(channelEvent(serverId, channelId, body, { waking: decision, addressed: true }));
      return decision;
    };
    h.membrane
      .turn(final(text('world answer')))
      .turn(final(text('private answer')));

    assert.equal(ingress('discord', PRIVATE, '@resident private: payroll numbers attached'), false, 'debounced');
    assert.equal(ingress('eidoverse', WORLD, '@resident hello from the plaza'), true, 'immediate');
    await h.fw.runUntilIdle();
    await settle(250); // the debounce fires; its wake is delivered after the world turn
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci[0], WORLD);
    assert.doesNotMatch(requestText(h.membrane.calls[0]), /payroll numbers/,
      'LEAK: a private-channel message whose wake is pending (debounced) is in the world turn\'s context');
    assert.deepEqual(publishedTo(h, PRIVATE), ['private answer'], 'the private message is answered in its own turn');
  });

  // -------------------------------------------------------------------------
  // H6: sub-agents. An ephemeral subagent spawned from inside a DM turn (the
  // SubagentModule passes the parent's proseRouting, default 'locus') runs
  // its own turn whose strict place is strictWakePlace(diver, undefined) =
  // the home channel, so its prose about the DM's task is published there.
  // -------------------------------------------------------------------------
  it('H6: a subagent spawned by a DM turn must not publish its prose into the home channel', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Sending a diver.'), tool('c1', 'probe--wait')),
        final(text('The diver reported back.')),
      )
      .turn(final(text('Diver notes: the private medical file says stage two.')));
    h.probe.hooks.push(async () => {
      // As SubagentModule.spawn does (proseRouting inherited from the parent).
      const { agent, contextManager } = await h.fw.createEphemeralAgent({
        name: 'spawn-diver-1', model: 'test-model', systemPrompt: 'diver', proseRouting: 'locus',
      } as never);
      contextManager.addMessage('user', [text('Summarize the private medical file for the DM.')]);
      await h.fw.runEphemeralToCompletion(agent, contextManager);
    });
    h.fw.pushEvent(dmEvent('private: can you look at my medical file?'));
    await h.fw.runUntilIdle();

    assert.deepEqual(publishedTo(h, HOME), [],
      'LEAK: the subagent\'s prose about the DM\'s task was published in the home channel');
  });

  // -------------------------------------------------------------------------
  // H7: brake pedal priority. The privileged interrupt aborts the running
  // world turn, but the strict one-place split then starts the turn for the
  // EARLIEST pending wake — a same-place world follow-up queued during the
  // aborted turn — so the agent resumes exactly the conversation the
  // operator braked, and the operator's DM waits behind it. Upstream (see the
  // control below) answers the privileged DM in the very next turn.
  // -------------------------------------------------------------------------
  it('H7: after a privileged interrupt the next turn answers the privileged message, not the braked place', async () => {
    const h = await harness({ privileged: true });
    h.membrane
      .turn(
        round(text('Building a tower.'), tool('c1', 'probe--wait')),
        final(text('never delivered')),
      )
      .turn(final(text('next turn')))
      .turn(final(text('turn after that')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(worldEvent('@resident make it taller!'));
      await settle(30);
      h.fw.pushEvent(dmEvent('private: STOP building now', { authorId: OPERATOR }));
      await settle(60);
    });
    h.fw.pushEvent(worldEvent('@resident build something'));
    await h.fw.runUntilIdle();

    assert.ok(h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'));
    assert.equal(h.turnLoci[1], DM,
      'REGRESSION: the turn after the brake went back to the braked world conversation instead of the privileged DM');
  });

  // -------------------------------------------------------------------------
  // H9: async subagent returns. A subagent spawned by a DM turn returns
  // later via ctx.addMessage + an `inference-request` wake. Spec S2/S4 treat
  // channel-less module content as a non-channel framework message (heard
  // mid-turn) and a module's wake as channel-less (home channel) — see the
  // round-2 R2-SPEC-S2 / R2-SPEC-S4 cases. A module that RELAYS material
  // belonging to a place names that place (channelId + serverId) on both
  // the content and the wake: then, if a world turn is running when it
  // returns, the DM task's result is held from the world turn, and the wake
  // it raises is answered in the DM — never in the world or at home.
  // -------------------------------------------------------------------------
  it('H9: an async subagent spawned for a DM must not return its result into a world turn or a home-channel turn', async () => {
    const h = await harness();
    h.membrane
      .turn(final(text('I sent a diver to read your file; results soon.')))
      .turn(
        round(text('Admiring the fountain.'), tool('c1', 'probe--wait')),
        final(text('Lovely plaza.')),
      )
      .turn(final(text('Your diver says: the biopsy came back positive.')));
    h.fw.pushEvent(dmEvent('private: please have a diver read my biopsy report'));
    await h.fw.runUntilIdle();

    h.probe.hooks.push(async () => {
      // The diver (spawned in the DM turn) finishes while the world turn runs.
      // The relaying module names the DM the subagent was spawned for.
      h.probe.ctx!.addMessage('user', [text("[Subagent 'diver' returned]\n\nThe biopsy report says: positive.")],
        { channelId: DM, serverId: 'discord' } as never);
      h.probe.ctx!.pushEvent({
        type: 'inference-request', agentName: AGENT, reason: 'subagent-completed:diver', source: 'subagent',
        channelId: DM, serverId: 'discord',
      } as unknown as ProcessEvent);
      await settle();
    });
    h.fw.pushEvent(worldEvent('@resident look at the fountain'));
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci[1], WORLD);
    assert.doesNotMatch(injectedText(h.membrane.streams[1]), /biopsy/,
      'LEAK: the DM-spawned subagent\'s result was injected into the running world turn');
    assert.deepEqual(publishedTo(h, HOME), [],
      'LEAK: the subagent-completion turn published the DM\'s private result in the home channel');
    assert.deepEqual(publishedTo(h, WORLD), ['Admiring the fountain.', 'Lovely plaza.']);
    assert.deepEqual(h.turnLoci, [DM, WORLD, DM], 'the relayed return is answered in the DM it belongs to');
    assert.deepEqual(publishedTo(h, DM).slice(-1), ['Your diver says: the biopsy came back positive.']);
  });

  // -------------------------------------------------------------------------
  // H10: quiesce parking keeps the NEWEST wake per (reason, addressed,
  // subject, channel) key. A place that woke the agent first AND again later
  // during the maintenance window is re-queued with its later timestamp, so
  // at resume the one-place-per-turn split ("earliest-arrived wake first")
  // runs another place's turn first — places are answered out of arrival
  // order.
  // -------------------------------------------------------------------------
  it('H10: after a quiesce, places are answered in arrival order (earliest wake first)', async () => {
    const h = await harness();
    h.membrane.turn(final(text('first answer'))).turn(final(text('second answer')));
    await h.fw.quiesce({ reason: 'maintenance' });
    h.fw.pushEvent(dmEvent('private: first message of the window'));
    await settle(5);
    h.fw.pushEvent(worldEvent('@resident hello during maintenance'));
    await settle(5);
    h.fw.pushEvent(dmEvent('private: a later follow-up'));
    await h.fw.runUntilIdle();
    await h.fw.resume();
    await h.fw.runUntilIdle();
    assert.deepEqual(h.turnLoci, [DM, WORLD],
      'REORDER: the DM arrived first but the world turn ran first (the parked DM wake kept only its newest timestamp)');
  });

  // -------------------------------------------------------------------------
  // H11: place identity is the bare channelId. strictMessagePlace /
  // strictWakePlace key a place by channelId alone, and routeSpeech resolves
  // a locus with findChannelEntry (first registry entry whose descriptor id
  // matches, any server). Two MCPL servers exposing the same channel id —
  // two eidoverse hosts both running the default world ("world:commons") —
  // are therefore ONE place: the second host's turn publishes into the first
  // host's world, and each host's chatter is heard inside the other's turn.
  // -------------------------------------------------------------------------
  it('H11: two world hosts with the same channel id are different places', async () => {
    const h = await harness();
    h.membrane
      .turn(
        round(text('Hi second-host friends.'), tool('c1', 'probe--wait')),
        final(text('See you around.')),
      )
      .turn(final(text('(first host turn)')));
    h.probe.hooks.push(async () => {
      h.fw.pushEvent(channelEvent('eidoverse', WORLD, '@resident first-host secret: the vault is open'));
      await settle();
    });
    h.fw.pushEvent(channelEvent('eidoverse2', WORLD, '@resident hello from the second host'));
    await h.fw.runUntilIdle();

    const toSecond = h.published.filter((p) => p.server === 'eidoverse2').map((p) => p.text);
    const toFirst = h.published.filter((p) => p.server === 'eidoverse').map((p) => p.text);
    assert.doesNotMatch(injectedText(h.membrane.streams[0]), /vault is open/,
      'LEAK: the first host\'s message was heard inside the second host\'s turn');
    assert.deepEqual(toSecond, ['Hi second-host friends.', 'See you around.'],
      'LEAK: the second host\'s turn did not publish to the second host');
    assert.ok(!toFirst.includes('Hi second-host friends.'),
      'LEAK: prose for the second host was published in the first host\'s world');
  });

  // -------------------------------------------------------------------------
  // H8: tune-out divert under hold. A diverted (tuned-out) message is stored
  // stamped and hidden from the resident (viewFilter); only the subconscious
  // reads it, through the shared slot, and the coordinator schedules the
  // subconscious's coalesced wake (~2s) at arrival. Upstream lands it at the
  // running turn's next round boundary; strict holds it (it carries a
  // channelId + serverId) until the resident's turn elsewhere ENDS, so the
  // subconscious wake it triggered reads a backlog without it (and the wake
  // is spent against maxWakes).
  // -------------------------------------------------------------------------
  it('H8: a diverted (tuned-out) message reaches the shared slot by the next round boundary, as upstream', async () => {
    const h = await harness();
    await runH8(h);
  });
});

async function runH8(h: Harness): Promise<void> {
  const i = h.internals;
  i.tuneOutCoordinator = { onIncoming: () => ({ epochId: 'epoch-x' }), stop: () => {} };
  let storedAfterBoundary = false;
  h.membrane.turn(
    round(text('One moment.'), tool('c1', 'probe--wait')),
    round(text('Still working.'), tool('c2', 'probe--wait')),
    final(text('Done.')),
  );
  h.probe.hooks.push(async () => {
    h.fw.pushEvent(channelEvent('discord', CLOSED, '@resident are you ignoring us?', { waking: true }));
    await settle();
  });
  h.probe.hooks.push(async () => {
    // One round boundary later, still mid-turn.
    storedAfterBoundary = h.fw.getAgent(AGENT)!.getContextManager().getAllMessages()
      .some((m) => /ignoring us/.test(blockText(m.content)));
  });
  h.fw.pushEvent(dmEvent('private: quick question'));
  await h.fw.runUntilIdle();
  assert.equal(storedAfterBoundary, true,
    'REGRESSION: the tuned-out message is held out of the shared slot until the turn elsewhere ends — invisible to the subconscious wake it triggered');
}


// ---------------------------------------------------------------------------
// H7 control: flags unset — the privileged DM is answered in the next turn.
// ---------------------------------------------------------------------------

describe('strict routing hunt controls (flags unset)', () => {
  it('H8 control: upstream lands a diverted message in the shared slot at the next round boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strict-hunt-ctl8-'));
    const restore = setStrict(false);
    const h = await makeHarness(dir);
    try {
      await runH8(h);
    } finally {
      await Promise.all([...h.probe.inFlight]);
      await h.fw.runUntilIdle();
      await h.fw.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H7 control: upstream answers the privileged DM in the turn right after the brake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strict-hunt-ctl-'));
    const restore = setStrict(false);
    const h = await makeHarness(dir, { privileged: true });
    try {
      h.membrane
        .turn(
          round(text('Building a tower.'), tool('c1', 'probe--wait')),
          final(text('never delivered')),
        )
        .turn(final(text('next turn')))
        .turn(final(text('turn after that')));
      h.probe.hooks.push(async () => {
        h.fw.pushEvent(worldEvent('@resident make it taller!'));
        await settle(30);
        h.fw.pushEvent(dmEvent('private: STOP building now', { authorId: OPERATOR }));
        await settle(60);
      });
      h.fw.pushEvent(worldEvent('@resident build something'));
      await h.fw.runUntilIdle();
      assert.equal(h.turnLoci[1], DM, 'upstream: the brake\'s message is answered next');
    } finally {
      await Promise.all([...h.probe.inFlight]);
      await h.fw.runUntilIdle();
      await h.fw.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// H1: RFC-006 deferred-batch assembly at another place's turn start.
// beginAgentTurn → pushCoalescer.assemble(agent) freezes EVERY pending batch
// whose audience includes the agent; freeze() withdraws the batch's wake
// (host.cancelWake) and delivers it with assemblingFor (triggerInference
// false → metadata.triggered=false). Strict holds the content (good), but
// its wake is gone, so after the turn it is stored as ambient: the waking
// batch never gets its own turn.
// ---------------------------------------------------------------------------

test('H1: a turn for place A must not swallow the wake of place B\'s deferred batch', { timeout: 30_000 }, async () => {
  const restore = setStrict(true);
  const f = await fixture({ server: { shouldTriggerInference: () => true } });
  try {
    await f.register('chat');
    await f.register('other');

    // Place "other": a plain addressed message — the EARLIEST wake. (Straight
    // to the ingest handler, as the strict suite's P3 does, so its wake is
    // queued before the batch's.)
    await (f.framework as unknown as { handleMcplChannelIncoming(e: unknown): Promise<unknown> }).handleMcplChannelIncoming({
      type: 'mcpl:channel-incoming', serverId: 'editor', channelId: 'other', messageId: 'o1',
      author: { id: 'u2', name: 'Other' }, content: [{ type: 'text', text: 'other_place_question' }],
      timestamp: TS, metadata: {}, tags: ['chat:mention'], triggerInference: true,
    });
    // Place "chat": a deferred, channel-scoped, waking batch — a LATER wake.
    f.renderer(async () => ({ content: [{ type: 'text', text: 'chat_place_secret_render' }] }));
    await f.send('push/event', {
      ...f.params('1', 'fallback', { deferred: true, channelId: 'chat', key: 'activity' }),
      origin: { authorId: 'u', authorName: 'User' },
    });
    const internals = f.framework as unknown as { pendingRequests: Array<{ channelId?: string }> };
    assert.deepEqual(internals.pendingRequests.map((r) => r.channelId), ['other', 'chat'], 'two places, two wakes');

    const calls: string[] = [];
    (f.membrane as unknown as { streamYielding: unknown }).streamYielding = (request: { messages?: unknown }) => {
      calls.push(JSON.stringify(request.messages));
      return new MockYieldingStream([createMockResponse([{ type: 'text', text: `reply_${calls.length}` }])]);
    };
    await f.framework.runUntilIdle();

    assert.ok(calls.length >= 1);
    assert.ok(!calls[0]!.includes('chat_place_secret_render'),
      'LEAK: place "chat"\'s deferred batch was rendered into the turn for place "other"');
    assert.equal(calls.length, 2,
      'LOSS: place "chat"\'s waking batch was withdrawn by the other place\'s assembly and never got its own turn');
    assert.ok(calls[1]!.includes('chat_place_secret_render'));
    assert.deepEqual(f.published.map((p) => p.channelId), ['other', 'chat']);
  } finally {
    restore();
    void f.close();
  }
});

// ===========================================================================
// Round 2: turn start / turn end, after the round-1 fixes.
// ===========================================================================

/** Emulates the ChannelRegistry ingress: the gate decides triggerInference
 *  (debounce → false now, a gate wake later), as in H5. */
function gateIngress(h: Harness) {
  const shouldTrigger = h.internals.eventGate!.asShouldTriggerCallback();
  return (serverId: string, channelId: string, body: string): boolean => {
    const decision = shouldTrigger(body, {
      eventType: 'mcpl:channel-incoming', serverId, channelId, messageId: nextId('g'),
      author: { id: 'visitor', name: 'visitor' }, tags: ['chat:mention', 'chat:addressed'],
    });
    h.fw.pushEvent(channelEvent(serverId, channelId, body, { waking: decision, addressed: true }));
    return decision;
  };
}

/** Index of the first turn whose locus is `channelId` (-1 when none ran). */
const turnIndexOf = (h: Harness, channelId: string): number => h.turnLoci.indexOf(channelId);

/** Every turn that ran BEFORE `place`'s own turn must not contain `secret`;
 *  then `place` must have had a turn of its own. */
function assertHeldUntilOwnTurn(h: Harness, place: string, secret: RegExp, what: string): void {
  const own = turnIndexOf(h, place);
  const before = own === -1 ? h.membrane.calls.length : own;
  for (let k = 0; k < before; k++) {
    assert.doesNotMatch(requestText(h.membrane.calls[k]), secret,
      `LEAK: ${what} is in the context of turn #${k} (locus ${h.turnLoci[k]}) before its own turn ` +
      `(turns: ${JSON.stringify(h.turnLoci)})`);
  }
  assert.notEqual(own, -1,
    `LOSS: ${what} (a waking message) never got a turn of its own — turns ran for ${JSON.stringify(h.turnLoci)}`);
}

describe('strict routing hunt round 2: turn start / turn end (ROUTING_STRICT=true)', () => {
  let dir: string;
  let restore: () => void;
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-hunt-r2-'));
    restore = setStrict(true);
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await Promise.all([...h.probe.inFlight]);
      try { await h.fw.runUntilIdle(); } catch { /* best effort */ }
      try { await h.fw.stop(); } catch { /* already stopped */ }
    }
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function harness(opts: HarnessOpts = {}): Promise<Harness> {
    const h = await makeHarness(dir, opts);
    harnesses.push(h);
    return h;
  }

  // -------------------------------------------------------------------------
  // R2-1: one debounce policy covering several channels (a glob such as
  // `discord:G1:*`, or `source: discord`). Two addressed messages from two
  // places land in ONE debounce batch; the gate delivers ONE wake whose
  // route is the batch's newest addressed event (wakeProvenance), and
  // pendingWakeRoutes() reports only that route. The earlier place's message
  // (held as a gate wake at its arrival) loses its pending wake the moment
  // the later one joins the batch: the routed turn's start releases it into
  // that turn's context, and nothing ever re-arms its own turn.
  // -------------------------------------------------------------------------
  it('R2-1: a debounce batch spanning two places gives each place its own turn; neither sees the other first', async () => {
    const h = await harness({
      gatePolicies: [{ name: 'guild-debounce', match: { channel: 'discord:G1:*' }, behavior: { debounce: 120 } }],
    });
    const ingress = gateIngress(h);
    h.membrane
      .turn(final(text('first answer')))
      .turn(final(text('second answer')));

    assert.equal(ingress('discord', PRIVATE, '@resident private: the salary list is attached'), false, 'debounced');
    await settle(10);
    assert.equal(ingress('discord', HOME, '@resident hello at home'), false, 'debounced (same batch)');
    await settle(260); // the batch fires once
    await h.fw.runUntilIdle();
    await settle(20);
    await h.fw.runUntilIdle();

    assertHeldUntilOwnTurn(h, PRIVATE, /salary list/, 'the private-channel message');
    assert.ok(!publishedTo(h, HOME).some((t) => /salary/.test(t)));
    assert.deepEqual(h.turnLoci, [PRIVATE, HOME], 'one turn per place, earliest first');
  });

  // -------------------------------------------------------------------------
  // R2-2: per-channel debounce policies whose timers fire while a turn runs.
  // fireDebounce() puts every batch into ONE gate inference buffer
  // (inferring.size > 0); at the turn's end the buffer is delivered as one
  // batch → one wake → one place. The other buffered place's addressed
  // message was held mid-turn as a plain 'hold' (no strictWake), has no
  // pending wake once the buffer's single route is computed, and is released
  // as ambient at the DM turn's teardown — into the context of the routed
  // place's turn — and never answered in a turn of its own.
  // -------------------------------------------------------------------------
  it('R2-2: two places debounced during a turn each get their own turn after it (the gate buffer is one batch)', async () => {
    const h = await harness({
      gatePolicies: [
        { name: 'private-debounce', match: { channel: PRIVATE }, behavior: { debounce: 20 } },
        { name: 'world-debounce', match: { channel: WORLD }, behavior: { debounce: 20 } },
      ],
    });
    const ingress = gateIngress(h);
    h.membrane
      .turn(
        round(text('Let me check.'), tool('c1', 'probe--wait')),
        final(text('dm done')),
      )
      .turn(final(text('second answer')))
      .turn(final(text('third answer')));
    h.probe.hooks.push(async () => {
      assert.equal(ingress('discord', PRIVATE, '@resident private: payroll numbers attached'), false);
      await settle(5);
      assert.equal(ingress('eidoverse', WORLD, '@resident hello from the plaza'), false);
      await settle(80); // both debounce timers fire while the DM turn is inferring
    });
    h.fw.pushEvent(dmEvent('private: quick question'));
    await h.fw.runUntilIdle();
    await settle(30);
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci[0], DM);
    assertHeldUntilOwnTurn(h, PRIVATE, /payroll numbers/, 'the private-channel message');
    assert.deepEqual(h.turnLoci, [DM, PRIVATE, WORLD], 'each held place answered in its own turn, in arrival order');
  });

  // -------------------------------------------------------------------------
  // R2-3: resume() clears the gate's quiesce (setQuiesced(false) splices the
  // inference buffer and schedules deliverEvents as a MICROTASK) and then
  // runs flushDeferredWrites('resume') synchronously up to its partition. In
  // that gap the buffered (debounced) place's wake is neither in the gate
  // nor in pendingRequests, so strictReleasable('idle') releases its held
  // message as if ambient. The DM's parked wake (earlier arrival) then runs
  // first with the private channel's waking message in its context.
  // -------------------------------------------------------------------------
  it('R2-3: a debounced place parked by a quiesce is not visible to an earlier place\'s turn after resume', async () => {
    const h = await harness({
      gatePolicies: [{ name: 'private-debounce', match: { channel: PRIVATE }, behavior: { debounce: 20 } }],
    });
    const ingress = gateIngress(h);
    h.membrane.turn(final(text('dm answer'))).turn(final(text('private answer')));

    await h.fw.quiesce({ reason: 'maintenance' });
    h.fw.pushEvent(dmEvent('private: first, during maintenance'));
    await h.fw.runUntilIdle();
    await settle(5);
    assert.equal(ingress('discord', PRIVATE, '@resident private: payroll numbers attached'), false);
    await settle(80); // the debounce fires into the quiesced gate's buffer
    await h.fw.runUntilIdle();

    await h.fw.resume();
    await h.fw.runUntilIdle();
    await settle(20);
    await h.fw.runUntilIdle();

    assert.equal(h.turnLoci[0], DM, 'the DM arrived first');
    assertHeldUntilOwnTurn(h, PRIVATE, /payroll numbers/, 'the debounced private-channel message');
    assert.deepEqual(publishedTo(h, PRIVATE), ['private answer']);
  });

  // -------------------------------------------------------------------------
  // R2-4: module notes. The spec's hold boundary keeps "non-channel framework
  // messages: module notes, ..." flowing mid-turn. stampModulePlace() files
  // EVERY ModuleContext.addMessage without a channel under the private
  // NOWHERE place, so a module's note about the running turn itself — the
  // TTS relay's "[voice] your reply was interrupted after: …", the time
  // module's notes — is held from the turn it is about and only stored after
  // it ends (no wake: it is not answered either). (Round-1 H9 holds async
  // subagent returns the same way on purpose; a fix has to tell a module's
  // own note from content it relays.)
  // -------------------------------------------------------------------------
  it('R2-4: a module note added mid-turn (no channel) is still heard at the next round boundary', async () => {
    const h = await harness();
    await runR24(h);
  });

  // -------------------------------------------------------------------------
  // R2-5: brake pedal during an inference-error retry. A retryable stream
  // error resets the agent to 'idle' and the error policy retries the SAME
  // turn after a backoff (1 s, 2 s, 4 s) from inside driveStream — the turn
  // stays alive (token held) while the event loop keeps processing events.
  // interruptForPrivileged() only aborts inferring/streaming/waiting agents,
  // so a privileged STOP during the backoff (or the retry's compile) brakes
  // nothing. Upstream still delivers it: deferred, then injected at the
  // retried turn's first round boundary. Strict holds it as another place's
  // message, so the runaway turn neither stops nor hears the operator.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // R2-6: a DEBOUNCED in-world whisper. The eidoverse door delivers a
  // whisper on the PUBLIC world channel tagged chat:dm + chat:private; strict
  // files it under a one-party place whose turn publishes nowhere (round-1
  // publication H4). But a gate wake knows only routeChannelId/routeServerId:
  // the debounced batch's wake (and pendingWakeRoutes) name the PUBLIC world
  // place. The whisper is held at arrival (its party place has no pending
  // wake), the gate's wake starts a public world turn, that turn's start
  // releases the whisper (no wake for its party place) as the turn's input,
  // and the reply to the private whisper is said aloud to the whole world.
  // -------------------------------------------------------------------------
  it('R2-6: a debounced whisper is never answered aloud on the public world channel', async () => {
    const h = await harness({
      gatePolicies: [{ name: 'world-debounce', match: { channel: WORLD }, behavior: { debounce: 40 } }],
    });
    const shouldTrigger = h.internals.eventGate!.asShouldTriggerCallback();
    const whisperTags = ['chat:dm', 'chat:private', 'chat:addressed', 'eidoverse:whisper'];
    const body = 'mira: (whispers to you) my locker code is 4471, keep it between us';
    const decision = shouldTrigger(body, {
      eventType: 'mcpl:channel-incoming', serverId: 'eidoverse', channelId: WORLD, messageId: nextId('g'),
      author: { id: 'mira', name: 'mira' }, tags: whisperTags,
    });
    assert.equal(decision, false, 'debounced');
    h.membrane.turn(final(text('Got it, 4471 stays between us.')));
    h.fw.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'eidoverse',
      channelId: WORLD,
      messageId: nextId('w'),
      author: { id: 'mira', name: 'mira' },
      content: [{ type: 'text', text: body }],
      timestamp: new Date().toISOString(),
      metadata: { mentioned: true, isExplicitMention: true },
      tags: whisperTags,
      triggerInference: decision,
    } as unknown as ProcessEvent);
    await h.fw.runUntilIdle();
    await settle(120); // the debounce fires
    await h.fw.runUntilIdle();

    assert.equal(h.membrane.calls.length, 1, 'the debounced whisper woke a turn');
    assert.deepEqual(publishedTo(h, WORLD), [],
      'LEAK: the reply to a private (debounced) whisper was said aloud on the public world channel');
  });

  // -------------------------------------------------------------------------
  // R2-7: durability of a DEBOUNCED waking message held mid-turn. Round 1
  // made a gate-owed wake survive a crash by stamping `strictWake` — but only
  // when the message is held while the agent is idle (strictHoldOnArrival
  // returns plain 'hold' as soon as a turn is alive, before it ever looks at
  // the gate). The debounce timer / inference buffer is in memory; a stop
  // (or kill -9) mid-turn takes it, and at the next boot the restored
  // message has neither `triggered` nor `strictWake`: rearmStrictHeldWakes
  // skips it and it is stored as ambient — its place never gets the turn
  // the gate had promised (a direct wake in the same spot is re-armed: FH1).
  // -------------------------------------------------------------------------
  it('R2-7: a debounced message held mid-turn keeps its own turn across a stop/restart', async () => {
    const policies = [{ name: 'private-debounce', match: { channel: PRIVATE }, behavior: { debounce: 400 } }];
    const a = await makeHarness(dir, { gatePolicies: policies });
    const ingress = gateIngress(a);
    a.membrane.turn(
      round(text('Long task.'), tool('c1', 'probe--wait')),
      final(text('never delivered')),
    );
    a.probe.hooks.push(async () => {
      assert.equal(ingress('discord', PRIVATE, '@resident private: payroll numbers attached'), false, 'debounced');
      // The tool never returns: the process goes down mid-turn.
      await new Promise<void>(() => {});
    });
    a.fw.start();
    a.fw.pushEvent(dmEvent('private: begin'));
    await waitFor('the private-channel message to be held', () =>
      a.internals.deferredMessages.some((m) => m.metadata?.channelId === PRIVATE));
    await a.fw.stop();

    const b = await harness({ gatePolicies: policies });
    b.membrane.turn(final(text('Sorry for the wait — got the payroll file.')));
    await b.fw.runUntilIdle();
    await settle(20);
    await b.fw.runUntilIdle();

    assert.deepEqual(b.turnLoci, [PRIVATE],
      'LOSS: the debounced (waking) private-channel message held mid-turn was demoted to ambient by the restart');
    assert.deepEqual(publishedTo(b, PRIVATE), ['Sorry for the wait — got the payroll file.']);
  });

  // -------------------------------------------------------------------------
  // R2-8 (minor): the gate's batched-wake notice. deliverEvents() writes
  // "[Gate: N events matched] — 1 message in #<channel> … already shown above
  // at arrival" with no channelId, so strictMessagePlace() treats it as a
  // framework marker: never held, stored into whichever turn comes next.
  // When another place's turn is about to start (here: dequeued and parked
  // behind an auxiliary call), that turn reads a notice naming the private
  // channel and claiming its message was already shown — while the message
  // itself is (correctly) held for its own turn.
  // -------------------------------------------------------------------------
  it('R2-8: a gate notice about a held place is not shown to another place\'s turn', async () => {
    const h = await harness({
      gatePolicies: [{ name: 'private-debounce', match: { channel: PRIVATE }, behavior: { debounce: 30 } }],
    });
    const i = h.internals;
    const ingress = gateIngress(h);
    h.membrane.turn(final(text('dm answer'))).turn(final(text('private answer')));
    let release!: () => void;
    const aux = i.withAuxiliaryAdmission(AGENT, () => new Promise<void>((resolve) => { release = resolve; }));
    await settle(5);

    assert.equal(ingress('discord', PRIVATE, '@resident private: payroll numbers attached'), false, 'debounced');
    h.fw.pushEvent(dmEvent('private: quick DM question'));
    await i.processNextEvent(); // the private-channel message (held: its wake is owed by the gate)
    await i.processNextEvent(); // the DM: its wake is dequeued and parks on the auxiliary call
    await settle(90);           // the debounce fires while nothing is inferring
    release();
    await aux;
    await h.fw.runUntilIdle();
    await settle(20);
    await h.fw.runUntilIdle();

    assert.deepEqual(h.turnLoci, [DM, PRIVATE]);
    assert.doesNotMatch(requestText(h.membrane.calls[0]), /payroll/, 'the message itself is held');
    assert.doesNotMatch(requestText(h.membrane.calls[0]), /discord:G1:private/,
      'LEAK (metadata): the DM turn reads a gate notice naming the private channel\'s held message as "already shown"');
  });

  it('R2-5: a privileged STOP sent during an error-retry backoff still brakes (or reaches) the running turn', async () => {
    const h = await harness({ privileged: true });
    const { aborted, heard } = await runR25(h);
    assert.ok(aborted || heard,
      'REGRESSION: the brake pedal did nothing — the retried world turn was neither aborted nor told about the privileged STOP');
  });

  // -------------------------------------------------------------------------
  // R2-5b: the same brake gap while the world turn is dequeued but PARKED
  // behind an in-flight auxiliary call (H4's window). Nothing is streaming,
  // so interruptForPrivileged() aborts nothing and the STOP carries no
  // strictBrake; strict holds it from the parked turn (its own place is the
  // DM). Upstream stores it before the world turn compiles, so that turn
  // reads the STOP. Strict starts the world turn as if the operator had said
  // nothing, and only answers the STOP after the world turn has run.
  // -------------------------------------------------------------------------
  it('R2-5b: a privileged STOP that lands while the world turn waits for auxiliary admission is not ignored by that turn', async () => {
    const h = await harness({ privileged: true });
    const r = await runR25b(h);
    assert.ok(r.dmFirst || r.heard || r.aborted,
      `REGRESSION: the world turn ran first without the privileged STOP (turns: ${JSON.stringify(h.turnLoci)})`);
  });
});

async function runR25b(h: Harness): Promise<{ dmFirst: boolean; heard: boolean; aborted: boolean }> {
  const i = h.internals;
  h.membrane
    .turn(final(text('Tower built, three floors!')))
    .turn(final(text('Stopped, as you asked.')));
  let release!: () => void;
  const aux = i.withAuxiliaryAdmission(AGENT, () => new Promise<void>((resolve) => { release = resolve; }));
  await settle(5);
  h.fw.pushEvent(worldEvent('@resident build a tall tower'));
  await i.processNextEvent(); // the world wake is dequeued and parks on the auxiliary call
  h.fw.pushEvent(dmEvent('private: STOP, do not build anything', { authorId: OPERATOR }));
  await i.processNextEvent();
  release();
  await aux;
  await h.fw.runUntilIdle();
  await settle(20);
  await h.fw.runUntilIdle();
  return {
    dmFirst: h.turnLoci[0] === DM,
    heard: /STOP, do not build/.test(requestText(h.membrane.calls[0])),
    aborted: h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt'),
  };
}

/** A stream that fails at once with a retryable (non-Membrane) error. */
class FailingStream extends MockYieldingStream {
  constructor() {
    super([]);
    (this as unknown as { events: unknown[] }).events = [{ type: 'error', error: new Error('provider overloaded (529)') }];
  }
}

async function runR25(h: Harness): Promise<{ aborted: boolean; heard: boolean }> {
  const scripted = h.membrane.streamYielding.bind(h.membrane);
  let failNext = true;
  h.membrane.streamYielding = (request: NormalizedRequest) => {
    if (!failNext) return scripted(request);
    failNext = false;
    h.membrane.calls.push(request);
    const failing = new FailingStream();
    h.membrane.streams.push(failing);
    return failing;
  };
  h.membrane
    .turn(
      round(text('Building floor two.'), tool('c1', 'probe--wait')),
      final(text('Third floor done.')),
    )
    .turn(final(text('Stopped, as you asked.')));
  let sent = false;
  h.fw.onTrace((event) => {
    const e = event as { type: string };
    if (e.type === 'inference:failed' && !sent) {
      sent = true;
      // The operator hits the brake while the turn waits out its retry backoff.
      setTimeout(() => h.fw.pushEvent(dmEvent('private: STOP building now', { authorId: OPERATOR })), 100);
    }
  });
  h.fw.pushEvent(worldEvent('@resident build a tall tower'));
  await h.fw.runUntilIdle();
  await settle(50);
  await h.fw.runUntilIdle();
  assert.equal(h.turnLoci[0], WORLD);
  assert.ok(sent, 'the first attempt failed and was retried');
  const aborted = h.traces.some((t) => t.type === 'inference:aborted' && t.reason === 'privileged-interrupt');
  const heard = h.membrane.streams.some((s) => /STOP building now/.test(injectedText(s)));
  return { aborted, heard };
}

async function runR24(h: Harness): Promise<void> {
  h.membrane.turn(
    round(text('Reading it aloud now.'), tool('c1', 'probe--wait')),
    final(text('And that is the end of the story.')),
  );
  h.probe.hooks.push(async () => {
    h.probe.ctx!.addMessage('user', [text('[voice] Your reply was interrupted by user speech after: "Reading it"')]);
    await settle();
  });
  h.fw.pushEvent(dmEvent('please read me the story'));
  await h.fw.runUntilIdle();
  assert.match(injectedText(h.membrane.streams[0]), /Your reply was interrupted/,
    'REGRESSION: a module note about the running turn was held from that turn (not heard at the next boundary)');
}

describe('strict routing hunt round 2 controls (flags unset)', () => {
  async function withUpstream(opts: HarnessOpts, run: (h: Harness) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'strict-hunt-r2-ctl-'));
    const restore = setStrict(false);
    const h = await makeHarness(dir, opts);
    try {
      await run(h);
    } finally {
      await Promise.all([...h.probe.inFlight]);
      await h.fw.runUntilIdle();
      await h.fw.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('R2-4 control: upstream injects a mid-turn module note at the next round boundary', async () => {
    await withUpstream({}, runR24);
  });

  it('R2-5b control: upstream lets the parked world turn read the privileged STOP', async () => {
    await withUpstream({ privileged: true }, async (h) => {
      const r = await runR25b(h);
      assert.equal(r.heard, true, 'upstream: the STOP is stored before the parked turn compiles');
    });
  });

  it('R2-5 control: upstream cannot abort an idle retry either, but the retried turn hears the STOP', async () => {
    await withUpstream({ privileged: true }, async (h) => {
      const { aborted, heard } = await runR25(h);
      assert.equal(aborted, false, 'upstream: nothing streaming to abort during the backoff');
      assert.equal(heard, true, 'upstream: the STOP is injected at the retried turn\'s first boundary');
    });
  });
});
