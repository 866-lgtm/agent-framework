/**
 * Explicit prose routing (docs/explicit-prose-routing.md).
 *
 * The model names every destination in-band (`>>` prefixes); unprefixed prose
 * is NEVER delivered — it bounces to a held draft for a prefixed resend. The
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
import { ProseStreamRouter } from '../src/mcpl/prose-stream-router.js';
import { draftState, type ProseDraftStore } from '../src/prose-drafts.js';
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
function stubRegistry(framework: AgentFramework, plan: Array<'delivered' | 'false' | 'unknown' | 'throw'> = []) {
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
  const deliverSpeech = async (_agent: string, text: string, locus?: string | null) => {
    routed.push({ text, locus: locus ?? null });
    const behavior = plan.shift() ?? 'delivered';
    if (behavior === 'throw') throw new Error('synthetic publication failure');
    const destination = { serverId: 'stub', channelId: locus ?? '' };
    if (behavior === 'unknown') {
      return { status: 'unknown' as const, destination, reason: 'stub delivery uncertain', at: Date.now() };
    }
    return behavior === 'delivered'
      ? { status: 'delivered' as const, destination, at: Date.now() }
      : { status: 'failed' as const, destination, reason: 'stub reported delivered:false', at: Date.now() };
  };
  const explicit: Record<string, unknown> = {
    resolveProseTarget: (spec: string) =>
      known[spec] ?? { error: 'no channel matches "' + spec + '"' },
    deliverSpeech,
    routeSpeech: async (agent: string, text: string, locus?: string | null) => {
      const outcome = await deliverSpeech(agent, text, locus);
      return outcome.status === 'delivered'
        ? { delivered: true, channelId: outcome.destination.channelId }
        : null;
    },
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
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

  it('unprefixed prose NEVER delivers — bounces to a held draft, then a prefixed {{unsent}} resend delivers verbatim (laria regression)', async () => {
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
    assert.equal(routed[0]!.text, original, '{{unsent}} substitution is verbatim');
    const notices = context(framework).texts.filter((t) => t.startsWith('[prose-routing]'));
    assert.ok(notices.length > 0, 'the bounce notice is in the context');
    assert.ok(notices.every((t) => !t.includes('Two words through the keyhole')), `the bounce notice quotes none of the words: ${notices.join(' | ')}`);

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

  type DraftsView = ProseDraftStore;
  const draftsOf = (framework: AgentFramework): DraftsView =>
    (framework as unknown as { proseDrafts: DraftsView }).proseDrafts;

  for (const failure of ['false', 'throw'] as const) {
    it('an explicit ' + failure + ' delivery holds its body as a bounce and names it privately', async () => {
      const framework = await createFramework();
      try {
        const routed = stubRegistry(framework, [failure]);
        const agent = framework.getAgent('assistant')!;
        const gateway = framework as unknown as {
          deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
        };
        await gateway.deliverProse(agent, '>>#alpha keep these words', { notice: 'later' });
        assert.deepEqual(routed, [{ text: 'keep these words', locus: 'chan-alpha' }]);
        const held = draftsOf(framework).open('assistant');
        assert.equal(held.length, 1, 'the failed envelope became one draft');
        assert.equal(held[0]!.reason, 'bounced');
        assert.equal(held[0]!.text, 'keep these words');
        assert.ok(context(framework).texts.some((t) => t.includes('[prose-routing]') && t.includes(held[0]!.id)));
      } finally {
        await framework.stop();
      }
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it('an unknown ' + mode + ' delivery is not offered as a fresh bounce draft', async () => {
      const framework = await createFramework(mode);
      try {
        const routed = stubRegistry(framework, ['unknown']);
        const agent = framework.getAgent('assistant')!;
        const gateway = framework as unknown as {
          deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
          deliverHybridProse(a: unknown, text: string, locus: null, allowLocus: boolean, hold: { notice: 'later' }): Promise<void>;
        };
        if (mode === 'explicit') await gateway.deliverProse(agent, '>>#alpha uncertain words', { notice: 'later' });
        else await gateway.deliverHybridProse(agent, '>>>#alpha uncertain words', null, true, { notice: 'later' });
        assert.deepEqual(routed, [{ text: 'uncertain words', locus: 'chan-alpha' }], 'the uncertain attempt was made');
        assert.deepEqual(draftsOf(framework).open('assistant'), []);
        assert.equal(context(framework).bounces, 0);
      } finally {
        await framework.stop();
      }
    });
  }

  it('{{unsent}} that names no held draft sends nothing, and holds the envelope\'s other words', async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      const agent = framework.getAgent('assistant')!;
      // Nothing was ever bounced: a bare {{unsent}} sends nothing and says so.
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed, [], 'nothing is sent');
      assert.deepEqual(store.open('assistant'), [], 'and nothing is held');
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing] {{unsent}} names no held bounce draft') && t.includes('nothing was sent')));
      // With words of its own, those are held as a bounce draft rather than
      // posted as a fragment.
      await gateway.deliverProse(agent, '>>#alpha Here it is again: {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed, [], 'still nothing is sent');
      const [held] = store.open('assistant');
      assert.equal(held?.text, 'Here it is again:');
      assert.equal(store.latestBounce('assistant')?.id, held?.id);
    } finally {
      await framework.stop();
    }
  });

  it('{{unsent}} after its draft was sent names nothing, so the envelope sends nothing', async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      const agent = framework.getAgent('assistant')!;
      await gateway.deliverProse(agent, '>>#nowhere the words', { notice: 'later' });
      const bounce = store.latestBounce('assistant')!;
      assert.equal(bounce.text, 'the words');
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['the words'], 'the first {{unsent}} sends the bounce');
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['the words'], 'a second one, with the draft delivered, sends nothing');
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing] {{unsent}} names no held bounce draft')),
        'and says why');
    } finally {
      await framework.stop();
    }
  });

  for (const sent of ['{{unsent}} plus a line', '{{unsent}}'] as const) {
  it(`a failed '${sent}' send that a later turn overtook holds the words it attempted, not the newer bounce`, async () => {
    // Turn one queues '>>#alpha {{unsent}} plus a line' and skip_reply ends
    // it while that publish is held. Turn two bounces new words. When turn
    // one's send then fails, its draft must hold what it attempted.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `>>#alpha ${sent}` },
      { type: 'tool_use', id: 'delayed-1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'delayed-2', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));
    const framework = await createFramework();
    const routed = stubRegistry(framework, ['false']);
    answerSkipReply(framework);
    const store = draftsOf(framework);
    const original = store.hold('assistant', [{ text: 'ORIGINAL WORDS', source: { branch: 'main', turn: 0, round: 0, segment: 0 } }], 'bounced').held[0]!;
    const internals = framework as unknown as {
      channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> };
      proseSpeechChains: Map<string, Promise<void>>;
    };
    const deliver = internals.channelRegistry.deliverSpeech;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    internals.channelRegistry.deliverSpeech = async (...args: unknown[]) => {
      const outcome = await deliver(...args);
      entered();
      await held;
      return outcome;
    };
    let starts = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      starts++;
      if (starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>#nowhere NEW WORDS' }]));
      if (starts >= 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
    });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      await reached;
      const firstChain = internals.proseSpeechChains.get('assistant')!;
      const attempted = sent === '{{unsent}}' ? 'ORIGINAL WORDS' : 'ORIGINAL WORDS plus a line';
      assert.deepEqual(routed.map((r) => r.text), [attempted]);
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(store.latestBounce('assistant')?.text, 'NEW WORDS', 'the next turn bounced before the earlier send answered');
      release();
      await firstChain;
      const heldTexts = store.open('assistant').map((d) => d.text);
      assert.ok(heldTexts.includes(attempted), `the failed send holds the words it attempted: ${JSON.stringify(heldTexts)}`);
      assert.ok(!heldTexts.includes('NEW WORDS plus a line'), 'not the newer bounce');
      const copy = store.open('assistant').find((d) => d.text === attempted)!;
      assert.equal(copy.inheritedRisk, undefined, 'a definite failure leaves no risk to inherit');
      if (sent === '{{unsent}}') {
        // The bare send re-bounces the draft it sent, which the newer bounce
        // displaced as the latest: {{unsent}} now names that one, so the
        // notice offers only the drafts tool for this one.
        assert.equal(copy.id, original.id);
        assert.equal(store.latestBounce('assistant')?.text, 'NEW WORDS');
        const notice = context(framework).texts.filter((t) => t.startsWith('[prose-routing]') && t.includes(original.id)).at(-1)!;
        assert.ok(notice.includes(`drafts(action: "resend", draftIds: ["${original.id}"]`), notice);
        assert.ok(!notice.includes('{{unsent}}'), `the notice doesn't offer {{unsent}}, which names the newer bounce: ${notice}`);
      } else {
        assert.notEqual(copy.id, original.id);
        assert.equal(store.latestBounce('assistant')?.id, copy.id, 'the re-held words are the latest bounce, as {{unsent}} names');
      }
    } finally {
      release();
      await framework.stop();
    }
  });
  }

  it('a thrown explicit unsent delivery re-bounces the authored body with its unresolved attempt risk', async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework, ['throw']);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{
        text: 'earlier words', source: { branch: 'main', turn: 1, round: 1, segment: 0 },
      }], 'bounced').held[0]!;
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}} plus a line', { notice: 'later' });
      const copy = store.open('assistant').find((d) => d.id !== original.id)!;
      assert.ok(copy, 'the failed envelope is retained');
      assert.equal(copy.text, 'earlier words plus a line');
      assert.equal(copy.inheritedRisk?.draftId, original.id);
      assert.equal(draftState(copy), 'unconfirmed', 'a fresh draft cannot erase its source attempt risk');
      const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing]') && t.includes(copy.id))!;
      assert.doesNotMatch(notice, /was not delivered/, 'an unconfirmed send is not also declared undelivered');
      assert.ok(notice.includes(`draftIds: ["${copy.id}"], destination: "#channel", confirmDuplicate: true`), notice);
      assert.ok(!notice.includes('{{unsent}}'), `{{unsent}} would refuse it, so the notice doesn't offer it: ${notice}`);
    } finally {
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    for (const failure of ['false', 'throw'] as const) {
      it(`${mode}: a ${failure === 'false' ? 'failed' : 'thrown'} {{unsent}} send re-holds the draft it substituted, though a newer bounce landed while it waited`, async () => {
        const framework = await createFramework(mode);
        try {
          stubRegistry(framework, [failure]);
          const store = draftsOf(framework);
          const original = store.hold('assistant', [{ text: 'ORIGINAL WORDS', source: { branch: 'main', turn: 1, round: 1, segment: 0 } }], 'bounced').held[0]!;
          const internals = framework as unknown as {
            channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> };
            deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
            deliverHybridProse(a: unknown, text: string, locus: string | null, allowLocus: boolean, hold: { notice: 'later' }): Promise<void>;
          };
          const deliver = internals.channelRegistry.deliverSpeech;
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          let entered!: () => void;
          const reached = new Promise<void>((resolve) => { entered = resolve; });
          internals.channelRegistry.deliverSpeech = async (...args: unknown[]) => {
            entered();
            await held;
            return deliver(...args);
          };
          const agent = framework.getAgent('assistant')!;
          const sending = mode === 'explicit'
            ? internals.deliverProse(agent, '>>#alpha {{unsent}} plus a line', { notice: 'later' })
            : internals.deliverHybridProse(agent, '>>>#alpha {{unsent}} plus a line', null, true, { notice: 'later' });
          await reached;
          // A newer bounce becomes the latest while the send waits.
          store.hold('assistant', [{ text: 'NEW WORDS', source: { branch: 'main', turn: 2, round: 1, segment: 0 } }], 'bounced');
          release();
          await sending;
          const texts = store.open('assistant').map((d) => d.text);
          assert.ok(texts.includes('ORIGINAL WORDS plus a line'), `it re-holds the words it attempted: ${JSON.stringify(texts)}`);
          assert.ok(!texts.includes('NEW WORDS plus a line'), 'not the newer bounce');
          const copy = store.open('assistant').find((d) => d.text === 'ORIGINAL WORDS plus a line')!;
          if (failure === 'throw') assert.equal(copy.inheritedRisk?.draftId, original.id, "a thrown send's copy carries its source's risk");
          else assert.equal(copy.inheritedRisk, undefined);
        } finally {
          await framework.stop();
        }
      });
    }
  }

  it("{{unsent}} puts a draft's words in exactly, `$&` and `$$` included", async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      store.hold('assistant', [{ text: 'costs $$5, see $& and $1', source: { branch: 'main', turn: 1, round: 1, segment: 0 } }], 'bounced');
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}} (again)', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['costs $$5, see $& and $1 (again)']);
    } finally {
      await framework.stop();
    }
  });

  it('a thrown bare {{unsent}} delivery says its draft may already have been posted', async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework, ['throw']);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{
        text: 'earlier words', source: { branch: 'main', turn: 1, round: 1, segment: 0 },
      }], 'bounced').held[0]!;
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(store.open('assistant').map((d) => d.id), [original.id], 'a bare {{unsent}} holds no copy');
      assert.equal(draftState(store.get('assistant', original.id)!), 'unconfirmed');
      const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing]') && t.includes(original.id))!;
      assert.match(notice, /may already have been posted/);
      assert.doesNotMatch(notice, /was not delivered/, 'an unconfirmed send is not also declared undelivered');
      assert.match(notice, /may not have been delivered/);
      assert.ok(notice.includes(`draftIds: ["${original.id}"], destination: "#channel", confirmDuplicate: true`), notice);
      assert.ok(!notice.includes('{{unsent}}'), notice);
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a >>> envelope whose {{unsent}} names no held bounce sends nothing, and holds its other words', async () => {
    const framework = await createFramework('hybrid');
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverHybridProse(a: unknown, text: string, locus: string | null, allowLocus: boolean, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverHybridProse(framework.getAgent('assistant')!, '>>>#alpha {{unsent}} and a note', null, true, { notice: 'later' });
      assert.deepEqual(routed, [], 'no fragment goes out');
      assert.deepEqual(store.open('assistant').map((d) => d.text), ['and a note']);
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing]') && t.includes('{{unsent}} names no held bounce draft')));
    } finally {
      await framework.stop();
    }
  });

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
    assert.deepEqual(draftsOf(framework).open('assistant'), [], 'no draft is held');
    assert.equal(draftsOf(framework).latestBounce('assistant'), undefined, 'and {{unsent}} names nothing');
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
    const retained: Array<NonNullable<ReturnType<DraftsView['latestBounce']>>> = [];
    let turns = 0;
    framework.onTrace((event) => {
      if (event.type === 'inference:started' && ++turns === 2) {
        const draft = draftsOf(framework).latestBounce('assistant');
        if (draft) retained.push(draft);
      }
    });
    feedTurn(framework, 2, [
      { type: 'text', text: '>>skip_reply {{unsent}}' },
      { type: 'tool_use', id: 'sr4', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use');

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the bounce wake ran the skip_reply round');
    assert.equal(routed.length, 0);
    assert.equal(retained.length, 1, 'turn one really held a bounce before the dismissal');
    assert.equal(retained[0]!.text, 'An answer with nowhere to go.');
    assert.equal(draftState(draftsOf(framework).get('assistant', retained[0]!.id)!), 'dismissed');
    assert.equal(draftsOf(framework).latestBounce('assistant'), undefined, 'the bounced draft is set aside, as >>skip_reply {{unsent}} says');

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

  it('the stream reads leading whitespace and a token\'s end as delivery does', async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as { deliverProse(agent: unknown, text: string): Promise<void> };
    const agent = framework.getAgent('assistant')!;
    const cases = ['  >>#alpha hello', '\u00a0>>#alpha hello', '\u2003>>#alpha hello', '\r>>#alpha hello', '\t>>#alpha\r\nhello'];
    try {
      for (const text of cases) {
        routed.length = 0;
        await gateway.deliverProse(agent, text);
        const router = new ProseStreamRouter({
          mode: 'explicit', initialTarget: null, resolve: (spec) => (spec === '#alpha' ? 'chan-alpha' : null),
        });
        const streamed = [...router.feed(text), ...router.finish()];
        assert.deepEqual(routed.map((r) => r.locus), ['chan-alpha'], `delivery sends ${JSON.stringify(text)} to #alpha`);
        assert.ok(streamed.length > 0 && streamed.every((d) => d.channelId === 'chan-alpha'),
          `the stream sends ${JSON.stringify(text)} there too`);
      }
    } finally {
      await framework.stop();
    }
  });

  it("a round's destination, decided at its boundary, is the sticky destination its delivery leaves", async () => {
    const framework = await createFramework();
    stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string): Promise<void>;
      admitProse(text: string): unknown[];
      roundDestination(current: string | null, envelopes: unknown[]): string | null;
      proseTargetPins: Map<string, string>;
    };
    const agent = framework.getAgent('assistant')!;
    const rounds: string[][] = [
      ['>>#alpha first\n>>#alpha'],
      ['  >>#alpha indented'],
      ['>>#nowhere bounced'],
      ['>>skip_reply kept\nand unprefixed'],
      ['unprefixed', '>>#alpha second segment'],
    ];
    try {
      for (const segments of rounds) {
        for (const start of [null, 'chan-alpha']) {
          internals.proseTargetPins.clear();
          if (start) internals.proseTargetPins.set('assistant', start);
          for (const segment of segments) await internals.deliverProse(agent, segment);
          const admitted = segments.flatMap((segment) => internals.admitProse(segment));
          assert.equal(internals.roundDestination(start, admitted), internals.proseTargetPins.get('assistant') ?? null,
            `${JSON.stringify(segments)} from ${start}`);
        }
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a `>>>` envelope with no target streams nothing, as delivery bounces it', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean): Promise<void>;
    };
    const agent = framework.getAgent('assistant')!;
    // The registry's resolver trims its argument, as the router's must here.
    const resolve = (spec: string) => (spec.trim() === '#alpha' ? 'chan-alpha' : null);
    const cases = ['>>>\r\nsecret', '>>>\nsecret', '>>>\u00a0#alpha secret', '>>> \u00a0#alpha secret'];
    try {
      for (const text of cases) {
        routed.length = 0;
        await gateway.deliverHybridProse(agent, text, 'chan-locus', true);
        const router = new ProseStreamRouter({ mode: 'hybrid', initialTarget: 'chan-locus', resolve });
        const streamed = [...router.feed(text), ...router.finish()];
        assert.equal(routed.length, 0, `delivery bounces ${JSON.stringify(text)}`);
        assert.deepEqual(streamed, [], `and the stream sends none of ${JSON.stringify(text)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a segment that is only `>>>`, or `>>>` and a gap, holds back the next segment, as delivery does', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: string, allowLocus: boolean): Promise<void>;
    };
    const agent = framework.getAgent('assistant')!;
    const resolve = (spec: string) => (spec.trim() === '#alpha' ? 'chan-alpha' : null);
    try {
      for (const prefix of ['>>>', '>>> ', '>>>\t']) {
        routed.length = 0;
        await gateway.deliverHybridProse(agent, '>>>#alpha first', 'chan-locus', true);
        await gateway.deliverHybridProse(agent, prefix, 'chan-locus', true);
        await gateway.deliverHybridProse(agent, 'secret', 'chan-locus', true);
        const router = new ProseStreamRouter({ mode: 'hybrid', initialTarget: 'chan-locus', resolve });
        const streamed = [
          ...router.feed('>>>#alpha first'), ...router.endSegment(),
          ...router.feed(prefix), ...router.endSegment(),
          ...router.feed('secret'), ...router.finish(),
        ];
        assert.deepEqual(routed.map((r) => r.text), ['first'], `delivery sends only first, after ${JSON.stringify(prefix)}`);
        assert.equal(streamed.filter((d) => d.delta.includes('secret')).length, 0,
          `and the stream holds secret back after ${JSON.stringify(prefix)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('admission turns a resolver that throws into an envelope that bounces', async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      channelRegistry: { resolveProseTarget: (spec: string) => unknown };
      admitProse(text: string): Array<{ text: string; resolved?: { channelId?: string; error?: string } }>;
      deliverAdmittedProse(agent: unknown, envelopes: unknown[]): Promise<void>;
    };
    const resolve = internals.channelRegistry.resolveProseTarget.bind(internals.channelRegistry);
    internals.channelRegistry.resolveProseTarget = (spec: string) => {
      if (spec === '#boom') throw new Error('directory unavailable');
      return resolve(spec);
    };
    try {
      const admitted = internals.admitProse('>>#boom one\n>>#alpha two');
      assert.match(admitted[0]!.resolved?.error ?? '', /directory unavailable/);
      await internals.deliverAdmittedProse(framework.getAgent('assistant')!, admitted);
      assert.deepEqual(routed.map((r) => r.text), ['two'], 'the other envelope still goes out');
    } finally {
      await framework.stop();
    }
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
    assert.ok(texts.some(t => t.startsWith('[delivered] nothing') && /2 plain-speech segment\(s\) held as drafts d-[a-z2-9]{5}, d-[a-z2-9]{5}/.test(t)));
    // The held words are the envelope's body, not its routing syntax; the
    // destination the resident wrote stays with the draft as a note.
    const drafts = (framework as unknown as { proseDrafts: { open(a: string): Array<{ text: string; note?: string; reason: string }> } })
      .proseDrafts.open('assistant').reverse();
    assert.deepEqual(drafts.map(d => [d.text, d.note, d.reason]), [
      ['wrong-locus duplicate', 'written for >>>#cafe', 'explicit-send'],
      ['tool completed', undefined, 'explicit-send'],
    ]);
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
