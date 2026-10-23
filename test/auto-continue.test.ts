/**
 * autoContinue (docs/auto-continue.md): a turn the model ends itself, with
 * prose or with nothing, is followed by another turn, unless it ended on a
 * skip (the skip_reply tool, or a `>>skip_reply` / `>>>skip_reply`
 * envelope). The next turn reads a `[continue]` notice; a run is capped.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentConfig,
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  InferenceRequest,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { resolveAutoContinue } from '../src/agent.js';
import { autoContinueNotice } from '../src/auto-continue.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedResponse } from '@animalabs/membrane';

class TriggerModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }], requestInference: true };
    }
    return {};
  }
}

/** Registry stub, as main's prose-routing tests build it: a locus of
 *  world:commons on the stub server, two named channels, and a log of what
 *  was routed where (by channel id). */
function stubRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const known: Record<string, { channelId: string; label: string }> = {
    '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
    'world:commons': { channelId: 'world:commons', label: 'world:commons' },
  };
  const deliverSpeech = async (_agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
    routed.push({ text, locus: locus?.channelId ?? null });
    return {
      status: 'delivered' as const,
      destination: { serverId: locus?.serverId ?? 'stub', channelId: locus?.channelId ?? '' },
      at: Date.now(),
    };
  };
  const registry: Record<string, unknown> = {
    resolveProseTarget: (spec: string) =>
      known[spec] ? { serverId: 'stub', ...known[spec] } : { error: 'no channel matches "' + spec + '"' },
    deliverSpeech,
    routeSpeech: async (agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
      const outcome = await deliverSpeech(agent, text, locus);
      return { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId };
    },
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }),
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    channelsNamed: (name: string) => [{ serverId: 'stub', channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
    // skip_reply ends the turn, as the registry's own handler does.
    handleChannelToolCall: async () => ({ success: true, endTurn: true, data: { skipped: true } }),
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const prose = (t: string): NormalizedResponse => createMockResponse([text(t)]);
const empty = (): NormalizedResponse => createMockResponse([]);
const skipReply = (id = 'sr'): NormalizedResponse =>
  createMockResponse([{ type: 'tool_use', id, name: 'skip_reply', input: {} } as ContentBlock], 'tool_use');

async function within<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('autoContinue', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: TriggerModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'auto-continue-test-'));
    membrane = new MockMembrane();
    module = new TriggerModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(
    autoContinue: AgentConfig['autoContinue'],
    proseRouting: AgentConfig['proseRouting'] = 'locus',
    allowedTools?: AgentConfig['allowedTools'],
  ): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting, autoContinue,
        ...(allowedTools ? { allowedTools } : {}),
      }],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  /**
   * Answer the Nth turn with responses[N-1] the moment it starts (the mock
   * hands every queued response to the first stream otherwise). A turn past
   * the script calls skip_reply, so a stray continuation ends instead of
   * hanging and the test fails on its count. Returns each turn's trigger.
   */
  function script(framework: AgentFramework, responses: NormalizedResponse[]): InferenceRequest[] {
    const triggers: InferenceRequest[] = [];
    const internals = framework as unknown as { activeTurnTriggers: Map<string, InferenceRequest> };
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      const turn = triggers.length;
      const trigger = internals.activeTurnTriggers?.get('assistant');
      triggers.push(trigger ?? ({ reason: 'unknown' } as InferenceRequest));
      membrane.pushResponse(responses[turn] ?? skipReply(`stray-${turn}`));
    });
    return triggers;
  }

  function trigger(framework: AgentFramework, content = 'hello'): void {
    framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
  }

  /** The window's rows: text and kind. */
  function rows(framework: AgentFramework): Array<{ text: string; kind?: string }> {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { kind?: string };
    }>;
    return messages.map((m) => ({
      text: m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      kind: m.metadata?.kind,
    }));
  }

  const notices = (framework: AgentFramework) => rows(framework).filter((r) => r.kind === 'auto-continue').map((r) => r.text);

  it('continues a turn that ends in prose, after its receipt, in the same channel, until skip_reply', async () => {
    const framework = await createFramework(true);
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('First thought.'), prose('Second thought.'), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');

      assert.equal(triggers.length, 3, 'two continuations, then skip_reply ends the run');
      assert.deepEqual(triggers.slice(1).map((t) => t.reason), ['auto-continue', 'auto-continue']);
      assert.ok(triggers.slice(1).every((t) => t.channelId === 'world:commons' && t.channelServerId === 'stub'), 'each continuation keeps the locus, server and id');
      assert.deepEqual(routed, [
        { text: 'First thought.', locus: 'world:commons' },
        { text: 'Second thought.', locus: 'world:commons' },
      ]);
      const all = rows(framework);
      const firstNotice = all.findIndex((r) => r.kind === 'auto-continue');
      assert.equal(all[firstNotice - 1]?.kind, 'delivery-receipt', 'the notice follows the turn\'s receipt');
      assert.deepEqual(notices(framework), [
        autoContinueNotice(1, 3, 'call skip_reply'),
        autoContinueNotice(2, 3, 'call skip_reply'),
      ]);
      assert.match(notices(framework)[0]!, /To stop and wait for the next event, call skip_reply\.$/);
      assert.match(notices(framework)[1]!, /Continuation 2 of 3 in a row: one more is left\.$/);
    } finally {
      await framework.stop();
    }
  });

  it('continues a turn that ends with no text', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [empty(), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'auto-continue');
      assert.equal(notices(framework).length, 1);
    } finally {
      await framework.stop();
    }
  });

  it('stops at maxConsecutive, and says so on the last continuation', async () => {
    const framework = await createFramework({ maxConsecutive: 2 });
    stubRegistry(framework);
    // The model never skips: the cap ends the run.
    const triggers = script(framework, [prose('one'), prose('two'), prose('three'), prose('four')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 3, 'the turn and two continuations');
      assert.deepEqual(notices(framework), [
        autoContinueNotice(1, 2, 'call skip_reply'),
        autoContinueNotice(2, 2, 'call skip_reply'),
      ]);
      assert.match(notices(framework)[0]!, /Continuation 1 of 2 in a row: one more is left\.$/);
      assert.match(notices(framework)[1]!, /This is the last continuation in a row \(2 of 2\): after this turn you wait for the next event either way\.$/);
    } finally {
      await framework.stop();
    }
  });

  it('starts a fresh run when a message wakes the agent after the cap', async () => {
    const framework = await createFramework({ maxConsecutive: 1 });
    stubRegistry(framework);
    const triggers = script(framework, [prose('a'), prose('b'), prose('c'), prose('d')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the first run');
      assert.equal(triggers.length, 2, 'one continuation, then the cap');
      trigger(framework, 'again');
      await within(framework.runUntilIdle(), 'the second run');
      assert.equal(triggers.length, 4, 'the message starts a turn, and its run continues once more');
      assert.equal(triggers[3]!.reason, 'auto-continue');
    } finally {
      await framework.stop();
    }
  });

  it('does nothing when autoContinue is off', async () => {
    const framework = await createFramework(undefined);
    stubRegistry(framework);
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the turn');
      assert.equal(triggers.length, 1);
      assert.equal(notices(framework).length, 0);
    } finally {
      await framework.stop();
    }
  });

  it('continues a turn that ends on a stop sequence', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [createMockResponse([text('stopped at the sequence')], 'stop_sequence'), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'auto-continue');
    } finally {
      await framework.stop();
    }
  });

  for (const stop of ['max_tokens', 'refusal', 'no_progress', 'round_limit'] as const) {
    it(`does not continue a turn that ended with ${stop}`, async () => {
      const framework = await createFramework(true);
      stubRegistry(framework);
      const triggers = script(framework, [createMockResponse([text('cut off')], stop)]);
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the turn');
        assert.equal(triggers.length, 1);
        assert.equal(notices(framework).length, 0);
      } finally {
        await framework.stop();
      }
    });
  }

  it('does not continue a silent heartbeat tick', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [prose('private check')]);
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    try {
      // As a real tick arrives: from its MCPL server, not the framework.
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true } as InferenceRequest);
      await within(framework.runUntilIdle(), 'the silent turn');
      assert.equal(triggers.length, 1);
      assert.equal(notices(framework).length, 0);
    } finally {
      await framework.stop();
    }
  });

  it('a tool-ended turn clears the run, so the next run counts from one', async () => {
    const framework = await createFramework({ maxConsecutive: 2 });
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number>; pendingRequests: InferenceRequest[] };
    const triggers = script(framework, [skipReply(), prose('after'), skipReply('sr2')]);
    try {
      // A run already at its cap, then a framework wake (not a cause of its
      // own) whose turn ends with skip_reply.
      internals.autoContinueStreaks.set('assistant', 2);
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'prose-bounce', source: 'framework', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the skip');
      assert.equal(triggers.length, 1);
      assert.equal(internals.autoContinueStreaks.has('assistant'), false, 'skip_reply cleared the run');
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'prose-bounce', source: 'framework', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the next run');
      assert.equal(triggers.length, 3, 'a prose end continues again');
      assert.deepEqual(notices(framework), [autoContinueNotice(1, 2, 'call skip_reply')]);
    } finally {
      await framework.stop();
    }
  });

  it("a message that arrives during the turn takes the next turn: its channel, no notice, a fresh run", async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as { pendingRequests: InferenceRequest[]; autoContinueStreaks: Map<string, number> };
    const triggers = script(framework, [prose('Working in the commons.'), skipReply()]);
    // An ambient message in another channel, queued while the first turn
    // runs: it waits for that turn, then batches with the continuation.
    let injected = false;
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started' || injected) return;
      injected = true;
      internals.pendingRequests.push({
        agentName: 'assistant', reason: 'channel-message', source: 'stub', timestamp: Date.now(),
        channelId: 'chan-b', channelServerId: 'stub',
      });
    });
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2, 'one more turn, not two');
      assert.equal(triggers[1]!.reason, 'channel-message', 'the message, queued first, is the turn\'s trigger');
      assert.equal(triggers[1]!.channelId, 'chan-b', "the message's channel outranks the continuation's, though queued first");
      assert.deepEqual(notices(framework), [], 'the message is the turn\'s cause: no [continue] row');
      assert.equal(internals.autoContinueStreaks.has('assistant'), false, 'and the run starts again');
    } finally {
      await framework.stop();
    }
  });

  it('a continuation the inference policy drops writes no notice and gives back its count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      inferencePolicy: { shouldInfer(agent: string, requests: InferenceRequest[]): boolean };
      autoContinueStreaks: Map<string, number>;
      autoContinuePending: Map<string, unknown>;
    };
    internals.inferencePolicy = { shouldInfer: (_agent, requests) => !requests.some((r) => r.reason === 'auto-continue') };
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 1);
      assert.deepEqual(notices(framework), [], 'no notice claims a turn that never ran');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0, 'the count is given back');
      assert.equal(internals.autoContinuePending.size, 0);
    } finally {
      await framework.stop();
    }
  });

  it('a notice that cannot be stored starts no continuation and gives back its count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number> };
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage(role: string, content: unknown, metadata?: { kind?: string }): unknown;
    };
    const original = cm.addMessage.bind(cm);
    cm.addMessage = (role, content, metadata) => {
      if (metadata?.kind === 'auto-continue') throw new Error('synthetic store failure');
      return original(role, content, metadata);
    };
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 1, 'no turn wakes without its notice');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0);
    } finally {
      await framework.stop();
    }
  });

  for (const [mode, first, stop] of [
    ['explicit', '>>#alpha hello', 'end with a >>skip_reply envelope'],
    ['hybrid', 'hello', 'end with a >>>skip_reply envelope'],
    ['locus', 'hello', undefined],
  ] as const) {
    it(`${mode}: an agent that can't call skip_reply is told ${stop ? 'its envelope' : 'no way to stop'}`, async () => {
      const framework = await createFramework({ maxConsecutive: 1 }, mode, ['robot--move']);
      stubRegistry(framework);
      // Without skip_reply, the cap ends the run.
      const triggers = script(framework, [prose(first), prose(first), prose(first)]);
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the run to settle');
        assert.equal(triggers.length, 2);
        assert.deepEqual(notices(framework), [autoContinueNotice(1, 1, stop)]);
      } finally {
        await framework.stop();
      }
    });
  }

  it('queues nothing for an ephemeral run, a stopping framework or an agent no longer registered', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      pendingRequests: InferenceRequest[];
      ephemeralRuns: Map<string, unknown>;
      providerAdmissionClosed: boolean;
      autoContinuePending: Map<string, unknown>;
      autoContinueStreaks: Map<string, number>;
    };
    const agent = framework.getAgent('assistant')!;
    const queued = () => internals.pendingRequests.filter((r) => r.reason === 'auto-continue').length;
    try {
      internals.ephemeralRuns.set('assistant', {});
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      internals.ephemeralRuns.delete('assistant');
      assert.equal(queued(), 0, 'an ephemeral run ends with its result');

      internals.providerAdmissionClosed = true;
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      internals.providerAdmissionClosed = false;
      assert.equal(queued(), 0, 'a stopping framework starts nothing');

      internals.autoContinueAfterTurn(Object.create(agent), {}, undefined, 'end_turn');
      assert.equal(queued(), 0, 'an agent object no longer the registered one starts nothing');

      // The same call for the registered agent does queue one.
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      assert.equal(queued(), 1);
      assert.equal(internals.autoContinuePending.size, 1);
    } finally {
      internals.pendingRequests.length = 0;
      internals.autoContinuePending.clear();
      internals.autoContinueStreaks.clear();
      await framework.stop();
    }
  });

  it('explicit: a turn whose last envelope is >>skip_reply waits; one that ends on a delivery continues', async () => {
    const framework = await createFramework(true, 'explicit');
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('>>#alpha posted'), prose('>>#alpha more\n>>skip_reply thinking it over')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2, 'the delivery continues; the >>skip_reply ending waits');
      assert.deepEqual(routed.map((r) => r.text), ['posted', 'more']);
      assert.deepEqual(notices(framework), [autoContinueNotice(1, 3, 'call skip_reply')]);
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a turn left private by >>>skip_reply waits', async () => {
    const framework = await createFramework(true, 'hybrid');
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('Out loud.'), prose('>>>skip_reply\nkeeping this to myself')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.channelId, 'world:commons', 'the continuation keeps the hybrid locus');
      assert.equal(triggers[1]!.channelServerId, 'stub');
      assert.deepEqual(routed.map((r) => r.text), ['Out loud.']);
      assert.equal(notices(framework).length, 1);
    } finally {
      await framework.stop();
    }
  });

  it("a turn's ' !' continuation runs instead, with no notice and no count", async () => {
    const framework = await createFramework(true, 'explicit');
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number> };
    const triggers = script(framework, [prose('>>#alpha ! step one'), prose('>>skip_reply done')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'prose-continuation');
      assert.equal(notices(framework).length, 0);
      assert.equal(internals.autoContinueStreaks.has('assistant'), false);
    } finally {
      await framework.stop();
    }
  });
});

describe('autoContinue config', () => {
  const at = (autoContinue: unknown) => ({ name: 'a', model: 'm', systemPrompt: '', autoContinue } as AgentConfig);

  it('reads off, true, and a cap', () => {
    assert.equal(resolveAutoContinue(at(undefined)), undefined);
    assert.equal(resolveAutoContinue(at(false)), undefined);
    assert.equal(resolveAutoContinue(at(null)), undefined);
    assert.deepEqual(resolveAutoContinue(at(true)), { maxConsecutive: 3 });
    assert.deepEqual(resolveAutoContinue(at({})), { maxConsecutive: 3 });
    assert.deepEqual(resolveAutoContinue(at({ maxConsecutive: 7 })), { maxConsecutive: 7 });
  });

  it('tells a string or number it can be true, false or an object', () => {
    assert.throws(() => resolveAutoContinue(at('true')), /must be true, false or an object such as \{ maxConsecutive: 3 \}, not a string \(true and false go unquoted\)/);
    assert.throws(() => resolveAutoContinue(at(1)), /must be true, false or an object/);
  });

  it('refuses anything else', () => {
    for (const bad of ['yes', 1, [], { maxConsecutive: 0 }, { maxConsecutive: 21 }, { maxConsecutive: 2.5 }, { maxConsecutive: '3' }]) {
      assert.throws(() => resolveAutoContinue(at(bad)), /Agent "a" autoContinue/, JSON.stringify(bad));
    }
  });

  it('names the value\'s kind, never the value, which could be a secret', () => {
    const secret = 'sk-ant-not-a-real-key';
    const message = (bad: unknown): string => {
      try { resolveAutoContinue(at(bad)); } catch (err) { return (err as Error).message; }
      return '';
    };
    assert.match(message({ maxConsecutive: secret }), /not a string:/);
    assert.ok(!message({ maxConsecutive: secret }).includes(secret));
    assert.ok(!message(secret).includes(secret));
    assert.match(message({ maxConsecutive: 0 }), /not a number below 1:/);
    assert.match(message({ maxConsecutive: 21 }), /not a number above 20:/);
    assert.match(message({ maxConsecutive: 2.5 }), /not a number that isn't whole:/);
  });
});

describe('autoContinueNotice', () => {
  it('names the way to stop, and the count only near the cap', () => {
    assert.equal(
      autoContinueNotice(1, 3, 'call skip_reply'),
      '[continue] Your last turn ended without skip_reply, so another one starts now. To stop and wait for the next event, call skip_reply.',
    );
    assert.match(autoContinueNotice(2, 3, 'call skip_reply'), / Continuation 2 of 3 in a row: one more is left\.$/);
    assert.match(autoContinueNotice(3, 3, 'call skip_reply'), / This is the last continuation in a row \(3 of 3\)/);
    assert.match(autoContinueNotice(1, 1, 'call skip_reply'), /last continuation in a row \(1 of 1\)/);
    assert.equal(autoContinueNotice(1, 5, undefined), '[continue] Your last turn ended on its own, so another one starts now.');
  });
});
