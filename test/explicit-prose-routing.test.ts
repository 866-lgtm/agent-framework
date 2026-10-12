/**
 * Explicit prose routing (docs/explicit-prose-routing.md).
 *
 * The model names every destination in-band (`>>` prefixes); unprefixed prose
 * is NEVER delivered — it bounces to a clipboard for a prefixed resend. The
 * laria regression (2026-07-24): a DM reply generated while the host-inferred
 * locus pointed at a guild channel was misdelivered there. In explicit mode
 * that class is structurally impossible: the worst case is a bounce.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
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
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

class ToolboxModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'move',
      description: 'Move the robot',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    }, {
      name: 'say',
      description: 'Publish speech into the world',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { ok: true, published: call.name.endsWith('--say') } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      return {
        addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }],
        requestInference: text === 'go',
      };
    }
    return {};
  }
}

/** Registry stub: two known channels (#alpha guild, laria's DM) + capture. */
function stubRegistry(framework: AgentFramework, plan: Array<'delivered' | 'false' | 'throw'> = []) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const known: Record<string, { channelId: string; label: string }> = {
    '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '#cafe': { channelId: 'discord:g:cafe', label: '#cafe' },
    'world:commons': { channelId: 'world:commons', label: 'world:commons' },
    'alpha': { channelId: 'chan-alpha', label: '#alpha' },
    'chan-alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '@laria': { channelId: 'discord:dm:99', label: 'DM: laria' },
    'discord:dm:99': { channelId: 'discord:dm:99', label: 'DM: laria' },
  };
  const explicit: Record<string, unknown> = {
    resolveProseTarget: (spec: string) =>
      known[spec] ?? { error: `no channel matches "${spec}"` },
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push({ text, locus: locus ?? null });
      const behavior = plan.shift() ?? 'delivered';
      if (behavior === 'throw') throw new Error('synthetic publication failure');
      return { delivered: behavior === 'delivered', channelId: locus ?? '' };
    },
    resolveLocus: () => 'world:commons',
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

describe('explicit prose routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: ToolboxModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'epr-test-'));
    membrane = new MockMembrane();
    module = new ToolboxModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(mode: 'explicit' | 'hybrid' | 'disabled' = 'explicit'): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant',
        model: 'test-model',
        systemPrompt: 'You are a test agent.',
        proseRouting: mode,
      }],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  function trigger(framework: AgentFramework): void {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
  }

  /** Feed a response for the Nth turn (1-based) the moment it starts —
   *  MockMembrane hands ALL remaining responses to the first stream, so
   *  later turns must receive theirs at inference:started time. */
  function feedTurn(framework: AgentFramework, turn: number, blocks: ContentBlock[], stop?: string): void {
    let count = 0;
    const off = framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      count++;
      if (count === turn) {
        membrane.pushResponse(createMockResponse(blocks, stop as never));
        off();
      }
    });
  }

  it('unprefixed prose NEVER delivers — bounces to clipboard, then a prefixed {{unsent}} resend delivers verbatim (laria regression)', async () => {
    const original = 'laria.\n\nYes, I remember. Two words through the keyhole.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: original }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    // Turn 2 = the bounce-wake: model resends with a destination.
    feedTurn(framework, 2, [{ type: 'text', text: '>>@laria {{unsent}}' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(bounceNotices.length, 1, 'exactly one bounce notice');
    assert.equal(routed.length, 1, 'only the prefixed resend delivered');
    assert.equal(routed[0]!.locus, 'discord:dm:99', 'delivered to the DM the model named');
    assert.equal(routed[0]!.text, original, 'clipboard substitution is verbatim');

    await framework.stop();
  });

  it('resolves label prefixes and applies the sticky turn target to later unprefixed segments', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first segment' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'chan-alpha' },
      { text: 'second segment, no prefix', locus: 'chan-alpha' },
    ], 'prefix stripped on wire; sticky target carries the second segment');

    await framework.stop();
  });

  it('>>skip_reply keeps the text in context — nothing delivered, no bounce', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>skip_reply\nWorking through the plan here.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(routed.length, 0, 'skip_reply text is never delivered');
    assert.equal(bounceNotices.length, 0, 'skip_reply text never bounces');

    await framework.stop();
  });

  /** The registry stub answers skip_reply as the real registry does: the turn ends, and nothing is sent. */
  function answerSkipReply(framework: AgentFramework): { calls: number } {
    const answered = { calls: 0 };
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async (name: string) => {
      if (name === 'skip_reply') answered.calls++;
      return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
    };
    return answered;
  }

  /** What the registry stub's streaming surface receives (MCPL Spec 14.3 chunk and complete). */
  function captureStream(framework: AgentFramework) {
    const chunks: Array<{ channelId: string; delta: string }> = [];
    const completes: Array<{ channelId: string; text: string }> = [];
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.sendOutgoingChunk = (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      chunks.push({ channelId, delta });
    };
    registry.sendOutgoingComplete = (channelId: string, _agent: string, _id: string, text: string) => {
      completes.push({ channelId, text });
    };
    return { chunks, completes };
  }

  /** The texts of the agent's context, and the bounce notices among them. */
  function context(framework: AgentFramework): { texts: string[]; bounces: number } {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { kind?: string };
    }>;
    return {
      texts: messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')),
      bounces: messages.filter((m) => m.metadata?.kind === 'prose-bounce').length,
    };
  }

  const clipboardOf = (framework: AgentFramework): string | undefined =>
    (framework as unknown as { proseClipboards: Map<string, string> }).proseClipboards.get('assistant');

  it('a round that calls skip_reply keeps its unprefixed prose private: nothing delivered, bounced, retained or woken for', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Weighing whether this needs an answer from me.' },
      { type: 'tool_use', id: 'sr1', name: 'skip_reply', input: { reason: 'nothing to add' } },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // Were the text bounced, its wake would start a second turn: give that
    // turn a response, so the test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'nothing is delivered');
    const seen = context(framework);
    assert.equal(seen.bounces, 0, 'no bounce notice reaches the context');
    assert.ok(seen.texts.some((t) => t.includes('Weighing whether this needs an answer')), 'the text stays in the context');
    assert.equal(clipboardOf(framework), undefined, 'nothing is retained for {{unsent}}');
    assert.equal(turns, 1, 'no bounce wake starts another turn');

    await framework.stop();
  });

  it('a round that calls skip_reply keeps its unprefixed prose from a sticky destination', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first, deliberately' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Second thoughts I keep to myself.' },
      { type: 'tool_use', id: 'sr2', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.deepEqual(routed, [{ text: 'first, deliberately', locus: 'chan-alpha' }],
      'only the earlier, deliberately addressed segment goes out');
    assert.ok(context(framework).texts.some((t) => t.includes('Second thoughts I keep to myself.')), 'the text stays in the context');

    await framework.stop();
  });

  it('a round that calls skip_reply sends nothing, a prefixed segment included, and asks for no continuation', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! addressed, then thought better of' },
      { type: 'tool_use', id: 'sr3', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // A continuation would start a second turn: give it a response, so the
    // test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'skip_reply ends the turn without sending anything');
    assert.equal(context(framework).bounces, 0);
    assert.equal(turns, 1, "the round's ' !' starts no continuation after skip_reply ended the turn");

    await framework.stop();
  });

  it("a private round's ' !' leaves no continuation request behind", async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string, round?: { keepPrivate?: boolean }): Promise<void>;
      proseContinuations: Set<string>;
    };
    const agent = framework.getAgent('assistant')!;

    // When skip_reply ends an explicit turn, the speech chain isn't awaited,
    // so the round's delivery can run once the next turn has begun.
    await internals.deliverProse(agent, '>>#alpha ! kept private', { keepPrivate: true });
    assert.equal(routed.length, 0, 'nothing is delivered');
    assert.equal(internals.proseContinuations.has('assistant'), false, 'and no continuation is asked for');

    // The same envelope outside a private round asks for one.
    await internals.deliverProse(agent, '>>#alpha ! sent');
    assert.equal(routed.length, 1);
    assert.equal(internals.proseContinuations.has('assistant'), true);

    await framework.stop();
  });

  it('a skip_reply round that sets the retained text aside with >>skip_reply {{unsent}} clears it', async () => {
    // Turn 1 bounces its text, which retains it and wakes turn 2.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'An answer with nowhere to go.' }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    feedTurn(framework, 2, [
      { type: 'text', text: '>>skip_reply {{unsent}}' },
      { type: 'tool_use', id: 'sr4', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use');

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the bounce wake ran the skip_reply round');
    assert.equal(routed.length, 0);
    assert.equal(clipboardOf(framework), undefined, 'the retained text is set aside, as >>skip_reply {{unsent}} says');

    await framework.stop();
  });

  it('explicit mode streams nothing before a destination: unprefixed text never reaches the trigger channel', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Unprefixed musing.\n>>#alpha streamed after the prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);
    const stream = captureStream(framework);
    // The unprefixed line bounces, and its wake starts a second turn.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    // A turn the trigger channel woke: chan-alpha is where its typing shows.
    const internals = framework as unknown as {
      pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
      channelId: 'chan-alpha', addressed: true,
    });
    await internals.processInferenceRequests();
    await framework.runUntilIdle();

    const streamed = stream.chunks.map((c) => c.delta).join('');
    assert.ok(streamed.includes('streamed after the prefix'), 'prefixed text streams to its destination');
    assert.equal(streamed.includes('Unprefixed musing.'), false, 'unprefixed text is never streamed');
    assert.equal(stream.completes.some((c) => c.text.includes('Unprefixed musing.')), false,
      'nor finalized by the stream complete');

    await framework.stop();
  });

  it("' !' continuation starts another turn immediately after prose ends the current one", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! step one done, continuing' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    feedTurn(framework, 2, [{ type: 'text', text: '>>#alpha step two done' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'a second inference ran without any external event');
    assert.deepEqual(routed.map((r) => r.text), ['step one done, continuing', 'step two done']);
    assert.deepEqual(routed.map((r) => r.locus), ['chan-alpha', 'chan-alpha']);

    await framework.stop();
  });

  it('appends the mode primer exactly once across turns', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha hello' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);

    const primers: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-routing-primer') primers.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'primer on first explicit turn');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha again' },
    ] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'no re-priming on later turns');

    await framework.stop();
  });

  it('prose_help tool returns the routing reference on demand', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'prose_help', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha got it' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const stream = membrane.lastStream!;
    assert.equal(stream.receivedToolResults.length, 1);
    const result = JSON.stringify(stream.receivedToolResults[0]);
    assert.ok(result.includes('destination'), 'help text served as tool result');
    assert.deepEqual(routed, [{ text: 'got it', locus: 'chan-alpha' }]);

    await framework.stop();
  });

  it('multi-envelope prose: each >> line routes independently (Tilde scenario)', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha part one for the channel\n>>@laria part two, just for you\nwith a second line\n>> quoted arrow stays in body' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'part one for the channel', locus: 'chan-alpha' },
      { text: 'part two, just for you\nwith a second line\n>> quoted arrow stays in body', locus: 'discord:dm:99' },
    ], 'two envelopes, two destinations; quoted arrow not split');

    await framework.stop();
  });


  it('hybrid preserves authored >>> envelope, publishes only body cross-surface, and records canonical receipt', async () => {
    const authored = '>>>#cafe\nA message meant for the café.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'A message meant for the café.', locus: 'discord:g:cafe' }]);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'source/author view retains exact envelope');
    assert.ok(texts.includes('[delivered] plain speech → discord:g:cafe'), 'canonical destination receipt enters context');
    await framework.stop();
  });

  it('hybrid leaves unprefixed prose on the frozen locus', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Ordinary field speech.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Ordinary field speech.', locus: 'world:commons' }]);
    await framework.stop();
  });

  it('hybrid accepts permissive whitespace but missing targets bounce and publish nowhere', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '  >>>   #missing\nDo not guess.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('not delivered') && t.includes('>>>#channel {{unsent}}')));
    await framework.stop();
  });


  it('hybrid keeps an explicit target sticky across tool-round segments in the same turn', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe first segment' },
      { type: 'tool_use', id: 'hc1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no repeated envelope' },
    ] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'discord:g:cafe' },
      { text: 'second segment, no repeated envelope', locus: 'discord:g:cafe' },
    ]);
    await framework.stop();
  });


  it('hybrid target-only envelope establishes the sticky destination for the next tool-round segment', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe' },
      { type: 'tool_use', id: 'hc2', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'body follows' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'body follows', locus: 'discord:g:cafe' }]);
    await framework.stop();
  });


  it('hybrid >>>skip_reply clears a sticky target until a fresh valid envelope', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'sk1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply hidden' }, { type: 'tool_use', id: 'sk2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'sk3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
    await framework.stop();
  });

  for (const failure of ['false', 'throw'] as const) {
    it(`hybrid ${failure} delivery clears sticky authority, suppresses later prose, and a fresh target resumes`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'fl1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#alpha fails' }, { type: 'tool_use', id: 'fl2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'fl3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
      const framework = await createFramework('hybrid');
      const routed = stubRegistry(framework, ['delivered', failure, 'delivered']);
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(routed.some(r => r.text.includes('plain text must remain suppressed')), false);
      assert.deepEqual(routed.filter(r => r.text !== 'fails'), [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
      const cm = framework.getAgent('assistant')!.getContextManager();
      const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
      assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('>>>#channel {{unsent}}')));
      await framework.stop();
    });
  }


  it('hybrid same-round successful say tool outranks a contradictory prose envelope', async () => {
    const authored = '>>>#cafe wrong-locus duplicate';
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: authored },
      { type: 'tool_use', id: 'say1', name: 'robot--say', input: { text: 'Hello Sill in the world' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tool completed' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(module.calls.filter(c => c.name === 'say' || c.name.endsWith('--say')).length, 1);
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored));
    assert.ok(texts.some(t => t.startsWith('[delivered] nothing') && t.includes('suppressed')));
    await framework.stop();
  });


  it('disabled mode suppresses text-only prose without a bounce, primer, or channel delivery', async () => {
    const authored = 'Internal continuity summary that must never publish.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);
    const sources: string[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source) sources.push(ev.source);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'disabled prose never reaches a channel');
    assert.equal(sources.includes('prose-bounce'), false, 'disabled prose does not bounce');
    assert.equal(sources.includes('prose-routing-primer'), false, 'disabled mode injects no model-visible primer');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'authored prose remains in Chronicle');
    assert.ok(texts.some(t => t.includes('[delivered] nothing') && t.includes('proseRouting=disabled')),
      'private suppression receipt explains the unsent prose');

    await framework.stop();
  });

  it('disabled mode ignores destination prefixes but explicit publish tools still execute', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha this prefix must not bypass disabled mode' },
      { type: 'tool_use', id: 'd1', name: 'robot--say', input: { text: 'published explicitly' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'trailing prose must also remain private' },
    ] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'neither prefixed nor trailing prose routed');
    assert.equal(module.calls.length, 1, 'explicit tool call executed');
    assert.equal(module.calls[0]!.name, 'say');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[delivered] nothing') && t.includes('2 plain-speech segment(s) suppressed')),
      'one receipt accounts for mid-turn and trailing prose');

    await framework.stop();
  });

});
