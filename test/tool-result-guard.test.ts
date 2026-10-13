import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassthroughStrategy, type StoredMessage, type StrategyContext } from '@animalabs/context-manager';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, YieldingStreamOptions } from '@animalabs/membrane';
import { Membrane as RealMembrane, NativeFormatter, type ProviderAdapter, type ProviderRequest,
  type ProviderResponse, type StreamCallbacks } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type AgentSettingsExtension, type Module, type ModuleContext,
  type ToolCall, type ToolResult, type ProcessEvent, type ProcessState } from '../src/index.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE, TOOL_RESULT_GUARD_NOTICE } from '../src/tool-result-guard.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const answer = () => createMockResponse([{ type: 'text', text: 'continued' }]);
const refused = () => ({
  ...createMockResponse([{ type: 'text', text: 'discard-this-partial-output' }], 'refusal'),
  raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
}) as NormalizedResponse;
const calls = (...ids: string[]) => createMockResponse(ids.map((id) => ({
  type: 'tool_use', id, name: 'test--read', input: {},
})), 'tool_use');

class ScriptMembrane {
  requests: NormalizedRequest[] = [];
  streams: MockYieldingStream[] = [];
  retriesAtSubmission: number[] = [];
  onSubmit?: () => void;
  constructor(readonly scripts: NormalizedResponse[][]) {}
  streamYielding(request: NormalizedRequest, options: YieldingStreamOptions = {}) {
    this.requests.push(structuredClone({ ...request, onCacheWireReceipt: undefined }));
    const script = this.scripts.shift();
    assert.ok(script, 'unexpected extra inference');
    const stream = new MockYieldingStream(script);
    const provide = stream.provideToolResults.bind(stream);
    stream.provideToolResults = (...args) => {
      this.retriesAtSubmission.push(options.refusalRetries ?? 0);
      this.onSubmit?.();
      provide(...args);
    };
    this.streams.push(stream);
    return stream;
  }
  asMembrane() { return this as unknown as Membrane; }
}

class ReadModule implements Module {
  readonly name = 'test';
  readonly calls: string[] = [];
  readonly speeches: string[] = [];
  constructor(readonly results: Record<string, ToolResult> = {}) {}
  async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); }
  async stop() {}
  getTools() {
    return [
      { name: 'read', description: 'Read a result', inputSchema: { type: 'object' as const, properties: {} } },
      { name: 'send_message', description: 'Explicit send', inputSchema: { type: 'object' as const, properties: {} } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call.id);
    return this.results[call.id] ?? { success: true, data: `payload-${call.id}` };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true }
      : {};
  }
  async onAgentSpeech(_name: string, content: ContentBlock[]) {
    this.speeches.push(...content.flatMap((block) => block.type === 'text' ? [block.text] : []));
  }
}

class IngressObserver extends PassthroughStrategy {
  snapshots: string[] = [];
  async onNewMessage(_message: StoredMessage, ctx: StrategyContext) {
    this.snapshots.push(JSON.stringify(ctx.messageStore.getAll()));
  }
}

async function harness(scripts: NormalizedResponse[][], config: Partial<AgentConfig> = {}, results?: Record<string, ToolResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'af-tool-result-guard-')); dirs.push(dir);
  const membrane = new ScriptMembrane(scripts);
  const module = new ReadModule(results);
  const base = { storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', ...config }], modules: [module], syncIntervalMs: 0 };
  const framework = await AgentFramework.create(base);
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, membrane, module, base, run };
}

function extension(framework: AgentFramework): AgentSettingsExtension {
  const extensions = (framework as unknown as {
    collectAgentSettingsExtensions(): Map<string, AgentSettingsExtension>;
  }).collectAgentSettingsExtensions();
  return [...extensions.values()].find((ext) => ext.keys.includes('tool_result_guard'))!;
}

function toolResults(framework: AgentFramework) {
  return framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
}

test('default off retains existing refusal behavior and original tool output', async () => {
  const h = await harness([[calls('one'), refused()]]);
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 1);
    assert.match(JSON.stringify(toolResults(h.framework)), /payload-one/);
    assert.equal(extension(h.framework).get('assistant').tool_result_guard, false);
  } finally { await h.framework.stop(); }
});

test('withholds the entire latest batch, retries inference once, and keeps originals in Chronicle', async () => {
  const strategy = new IngressObserver();
  const image = Buffer.from('original-image-bytes').toString('base64');
  const h = await harness([[calls('text', 'image', 'error'), refused()], [answer()]],
    { toolResultGuard: true, strategy, refusalHandling: { retries: 3 } }, {
      text: { success: true, data: 'original-text-payload' },
      image: { success: true, data: [{ type: 'image', mimeType: 'image/png', data: image }] },
      error: { success: false, isError: true, error: 'original-error-payload' },
    });
  let stagedSequence = 0;
  let originalStopped = false;
  h.membrane.onSubmit = () => { stagedSequence = h.framework.getStore().currentSequence(); };
  try {
    await h.run();
    assert.deepEqual(h.module.calls.sort(), ['error', 'image', 'text']);
    assert.equal(h.membrane.requests.length, 2);
    assert.deepEqual(h.membrane.retriesAtSubmission, [0], 'first refusal must reach guard before plain retries');
    const retry = h.membrane.requests[1];
    assert.equal(retry.config.model, 'test');
    assert.doesNotMatch(JSON.stringify(retry), /original-text-payload|original-error-payload|discard-this-partial-output|test-category/);
    assert.ok(!JSON.stringify(retry).includes(image));
    assert.equal(retry.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').length, 3);
    const guarded = toolResults(h.framework);
    assert.equal(guarded.length, 3);
    assert.ok(guarded.every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
    assert.equal(guarded.find((b) => b.toolUseId === 'error')?.isError, true);
    assert.deepEqual(h.module.speeches, ['continued']);
    assert.ok(strategy.snapshots.every((s) => !s.includes('original-text-payload') && !s.includes(image)),
      'background strategy ingress must never see withheld payloads');

    const store = h.framework.getStore();
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.match(JSON.stringify(audit[0]), /original-text-payload|original-error-payload/);
    assert.ok(JSON.stringify(audit[0]).includes(image));
    assert.equal(audit.at(-1)?.type, 'withheld');
    const historical = store.getStateJsonAt(TOOL_RESULT_GUARD_AUDIT_STATE, stagedSequence) as unknown[];
    assert.deepEqual(audit[0], historical[0], 'redaction only appends; original Chronicle record is unchanged');
    const original = structuredClone(audit[0]);
    extension(h.framework).update('assistant', { tool_result_guard: false });
    assert.ok(toolResults(h.framework).every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
    await h.framework.stop();
    originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.equal(extension(restarted).get('assistant').tool_result_guard, false, 'explicit disable persists');
      assert.ok(toolResults(restarted).every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
      assert.deepEqual((restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as unknown[])[0], original);
      const preview = await restarted.previewActivation('assistant');
      assert.doesNotMatch(JSON.stringify(preview), /original-text-payload|original-error-payload/);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

test('successful physical rounds admit results; refusal affects only the newest batch', async () => {
  const h = await harness([[calls('accepted'), calls('withheld'), refused()], [answer()]], { toolResultGuard: true });
  try {
    await h.run();
    const results = toolResults(h.framework);
    assert.match(String(results.find((b) => b.toolUseId === 'accepted')?.content), /payload-accepted/);
    assert.equal(results.find((b) => b.toolUseId === 'withheld')?.content, TOOL_RESULT_GUARD_NOTICE);
    assert.deepEqual(h.module.calls, ['accepted', 'withheld']);
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.enabled, true);
  } finally { await h.framework.stop(); }
});

test('a second refusal stops recovery without auto-rewinding older or human messages', async () => {
  const h = await harness([[calls('one'), refused()], [refused()]],
    { toolResultGuard: true, refusalHandling: { autoRewind: true, retries: 3 } });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.deepEqual(h.module.calls, ['one']);
    assert.deepEqual(h.module.speeches, []);
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.ok(messages.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'read')));
    assert.doesNotMatch(JSON.stringify(messages), /discard-this-partial-output|refusal-rewind/);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('durable typed agent setting can be enabled, disabled, and explicitly reset', async () => {
  const h = await harness([]);
  let originalStopped = false;
  try {
    const ext = extension(h.framework);
    for (const value of ['true', 1, null, {}]) {
      assert.throws(() => ext.update('assistant', { tool_result_guard: value }), /must be a boolean/);
    }
    ext.update('assistant', { tool_result_guard: true });
    assert.equal(ext.get('assistant').tool_result_guard, true);
    await h.framework.stop();
    originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      const restored = extension(restarted);
      assert.equal(restored.get('assistant').tool_result_guard, true);
      assert.equal(restored.get('assistant').tool_result_guard_source, 'runtime_override');
      restored.reset!('assistant');
      assert.equal(restored.get('assistant').tool_result_guard, false);
      const tool = restarted.getAllTools().find((t) => t.name === 'agent_settings')!;
      assert.equal((tool.inputSchema.properties as Record<string, { type: string }>).tool_result_guard.type, 'boolean');
      assert.doesNotMatch(JSON.stringify(tool), /classifier/i);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

test('a normal successful response releases the pending output into versioned history', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 1);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(records.at(-1)?.type, 'accepted');
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.enabled, true);
  } finally { await h.framework.stop(); }
});

test('refusal without a new tool result does not invoke tool guard recovery', async () => {
  const h = await harness([[refused()]], { toolResultGuard: true });
  try { await h.run(); assert.equal(h.membrane.requests.length, 1); }
  finally { await h.framework.stop(); }
});

test('budget restart submits staged originals, then recovers without re-executing tools', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], { toolResultGuard: true, maxStreamTokens: 1 });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 3);
    assert.match(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[2]), /payload-one/);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('ephemeral run settles only after recovery and counts each tool once', async () => {
  const h = await harness([[calls('one'), refused()], [answer()]]);
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    const result = await completion;
    assert.deepEqual(result, { speech: 'continued', toolCallsCount: 1 });
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(h.membrane.requests.length, 2);
  } finally { await h.framework.stop(); }
});

test('quiesced scheduler admits a queued guard recovery as a continuation', async () => {
  const h = await harness([[answer()]], { toolResultGuard: true });
  try {
    await h.framework.quiesce();
    h.framework.getAgent('assistant')!.getContextManager().addMessage('user', [{
      type: 'text', text: TOOL_RESULT_GUARD_NOTICE,
    }]);
    // A recovery can be requeued while waiting for provider admission. It
    // must finish the held turn even after the host stops admitting new work.
    (h.framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.push({
      agentName: 'assistant', reason: 'tool_result_guard_retry', source: 'framework', timestamp: Date.now(),
    });
    await h.framework.runUntilIdle();
    assert.equal(h.membrane.requests.length, 1);
    assert.equal(h.framework.getHostModeStatus().quiesced, true);
  } finally { await h.framework.stop(); }
});

test('native Membrane observes the first refusal even when guard is enabled by a tool mid-stream', async () => {
  const h = await harness([]);
  await h.framework.stop();
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: 'test', usageCacheConvention: 'cache-excluded', supportsModel: () => true,
    complete: async () => { throw new Error('unexpected complete'); },
    stream: async (request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> => {
      requests.push(structuredClone(request));
      const index = requests.length;
      assert.ok(index <= 3, 'must not retry unchanged refused input');
      const content = index === 1 ? [
        { type: 'tool_use', id: 'enable', name: 'agent_settings', input: { action: 'update', tool_result_guard: true } },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] : [{ type: 'text', text: index === 2 ? 'discard-native-partial' : 'continued' }];
      if (index > 1) callbacks.onChunk?.(index === 2 ? 'discard-native-partial' : 'continued');
      return {
        content, stopReason: index === 1 ? 'tool_use' : index === 2 ? 'refusal' : 'end_turn',
        usage: { inputTokens: 20, outputTokens: 5 }, model: 'test',
        raw: { response: { stop_details: { category: 'test-category' } } },
      } as ProviderResponse;
    },
  };
  const framework = await AgentFramework.create({ ...h.base,
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', refusalHandling: { retries: 4 } }],
    membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }),
  });
  const routed: string[] = [];
  const outgoing: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveLocus: () => 'world:test',
    routeSpeech: async (_agent: string, speech: string) => {
      routed.push(speech); return { delivered: true, channelId: 'world:test' };
    },
    sendOutgoingChunk: (_channel: string, _agent: string, _id: string, _index: number, delta: string) => { outgoing.push(delta); },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const tokenTraces: string[] = [];
  framework.onTrace((event) => {
    if (event.type === 'inference:tokens') tokenTraces.push(String((event as { content?: unknown }).content));
  });
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1]), /payload-one/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /payload-one|discard-native-partial|test-category/);
    assert.match(JSON.stringify(requests[2]), /Tool result withheld by the guard/);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(extension(framework).get('assistant').tool_result_guard, true);
    assert.deepEqual(h.module.speeches, ['continued']);
    assert.deepEqual(routed, ['continued']);
    assert.doesNotMatch(outgoing.join(''), /discard-native-partial/);
    assert.match(outgoing.join(''), /continued/, 'accepted answer must reach outgoing-stream consumers');
    assert.doesNotMatch(tokenTraces.join(''), /discard-native-partial/, 'inference:tokens must not leak refused text');
    assert.match(tokenTraces.join(''), /continued/);
  } finally { await framework.stop(); }
});

test('explicit mode: a guard retry streams on to the sticky destination delivery uses', async () => {
  const h = await harness([
    [createMockResponse([
      { type: 'text', text: '>>#alpha first' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'), refused()],
    [answer()],
  ], { toolResultGuard: true, proseRouting: 'explicit', refusalHandling: { retries: 3 } });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, speech: string, channelId: string) => {
      routed.push({ text: speech, channelId }); return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2, 'the guard retried once');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ], 'delivery keeps the sticky destination across the retry');
    const toAlpha = streamed.filter((d) => d.channelId === 'chan-alpha').map((d) => d.delta).join('');
    assert.match(toAlpha, /continued/, 'the resumed stream follows delivery there');
    assert.doesNotMatch(streamed.map((d) => d.delta).join(''), /discard-this-partial-output/);
  } finally { await h.framework.stop(); }
});

test('explicit mode: a budget restart streams on to the destination the turn last addressed, before delivery catches up', { timeout: 15000 }, async () => {
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: '>>#alpha first' },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: '>>#cafe second' },
        { type: 'tool_use', id: 'two', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
    ],
    [answer()],
  ], { proseRouting: 'explicit', maxStreamTokens: 1000 });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  // Delivery of 'first' is held until the resumed stream has written
  // 'continued', so '>>#cafe second' is still queued, and delivery's sticky
  // destination still #alpha, when the restart begins.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondDelivered!: () => void;
  const secondDone = new Promise<void>((resolve) => { secondDelivered = resolve; });
  // The second tool call drops the stream budget, so the turn restarts.
  const handle = h.module.handleToolCall.bind(h.module);
  h.module.handleToolCall = async (call: ToolCall) => {
    if (call.id === 'two') h.framework.getAgent('assistant')!.maxStreamTokens = 1;
    return handle(call);
  };
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    if (h.membrane.requests.length === 2) {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
        const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string; content?: unknown }>;
        for await (const event of events) {
          yield event;
          if (event.type === 'tokens' && event.content === 'continued') {
            releaseFirst();
            await secondDone;
          }
        }
      };
    }
    return stream;
  };
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text, channelId });
      if (text === 'first') await firstHeld;
      if (text === 'second') secondDelivered();
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(streamed.filter((d) => d.delta.includes('second')).map((d) => d.channelId), ['chan-cafe'],
      "the second round's prefix starts a new line in the stream, as delivery reads it");
    assert.equal(streamed.some((d) => d.delta.includes('>>')), false, 'no prefix is streamed as text');
    assert.deepEqual(streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe'],
      'the resumed stream follows the destination the turn last addressed');
  } finally {
    releaseFirst();
    secondDelivered();
    await h.framework.stop();
  }
});

test("explicit mode: a private round's prefix doesn't move where a budget restart resumes", { timeout: 15000 }, async () => {
  // A same-round private think keeps its round's text out of delivery, so
  // its `>>#cafe` sets no destination: the resumed reply goes to #alpha.
  const privateRound = createMockResponse([
    { type: 'text', text: '>>#cafe private plan' },
    { type: 'tool_use', id: 'two', name: 'think', input: { content: 'plan privately' } },
  ] as ContentBlock[], 'tool_use');
  privateRound.usage = { inputTokens: 100, outputTokens: 5 };
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: '>>#alpha first\n' },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      privateRound,
    ],
    [answer()],
  ], { proseRouting: 'explicit', maxStreamTokens: 20, sameRoundThinkTextPolicy: 'private' });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text, channelId });
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    handleChannelToolCall: async () => ({ success: true, data: { noted: true } }),
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    getChannelTools: () => [{ name: 'think', description: 'Reason privately', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ], 'the private round moves no destination');
    assert.deepEqual(streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-alpha'],
      'the resumed reply streams where it is delivered');
  } finally {
    await h.framework.stop();
  }
});

/**
 * A budget-restart turn whose first round's delivery is held: round one
 * writes `first`, round two `second` and crosses the budget, and the resumed
 * stream writes `continued`. `held` resolves once the resumed stream has
 * handed over its 'complete' and either its reply has gone out or the event
 * loop has turned 200 times, enough for a delivery that doesn't wait on the
 * held one to run; `release` lets the held delivery finish.
 */
async function heldRestart(mode: 'explicit' | 'locus', texts: { first: string; second: string; continued: string }) {
  const secondRound = createMockResponse([
    { type: 'text', text: texts.second },
    { type: 'tool_use', id: 'two', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  secondRound.usage = { inputTokens: 100, outputTokens: 5 };
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: texts.first },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      secondRound,
    ],
    [createMockResponse([{ type: 'text', text: texts.continued }] as ContentBlock[])],
  ], { proseRouting: mode, maxStreamTokens: 20 });
  const routed: Array<{ text: string; channelId: string | null }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  // What the registry's #cafe names; a test may rebind it while 'first' is held.
  const directory = { cafe: 'chan-cafe' };
  let release!: () => void;
  const firstHeld = new Promise<void>((resolve) => { release = resolve; });
  let resumedEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resumedEnded = resolve; });
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    if (h.membrane.requests.length === 2) {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
        // The framework stops pulling once it has 'complete', so the signal
        // goes with that event rather than after the loop.
        const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string }>;
        for await (const event of events) {
          if (event.type === 'complete') resumedEnded();
          yield event;
        }
      };
    }
    return stream;
  };
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: directory.cafe } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string | null) => {
      routed.push({ text: text.trim(), channelId });
      if (text.trim() === 'first') await firstHeld;
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  const run = h.run();
  const held = ended.then(async () => {
    for (let turn = 0; turn < 200 && !routed.some((r) => r.text === texts.continued.replace(/^>>\S+\s*/, '').trim()); turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
  return { h, run, held, release, routed, streamed, restarts, directory };
}

test("explicit mode: a resumed stream's deliveries queue behind the turn's earlier ones", { timeout: 15000 }, async () => {
  // From a review's probe. While 'first' is still posting, '>>#cafe second'
  // is queued behind it, and the resumed reply waits behind both: it then
  // goes to #cafe, where the turn last addressed, as the stream sends it.
  const t = await heldRestart('explicit', { first: '>>#alpha first\n', second: '>>#cafe second', continued: 'continued' });
  try {
    await t.held;
    assert.deepEqual(t.routed.map((r) => r.text), ['first'], 'nothing goes out while the first post is held');
    t.release();
    await t.run;
    assert.equal(t.h.membrane.requests.length, 2);
    assert.ok(t.restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(t.routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ], 'the turn delivers in the order it wrote');
    assert.deepEqual(t.streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe']);
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});

test("locus mode: a resumed stream's deliveries queue behind the turn's earlier ones", { timeout: 15000 }, async () => {
  const t = await heldRestart('locus', { first: 'first', second: 'second', continued: 'continued' });
  try {
    await t.held;
    assert.deepEqual(t.routed.map((r) => r.text), ['first'], 'nothing goes out while the first post is held');
    t.release();
    await t.run;
    assert.ok(t.restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(t.routed.map((r) => r.text), ['first', 'second', 'continued'], 'the turn delivers in the order it wrote');
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});

/**
 * The registry stub for one-stream explicit turns: #alpha and #cafe resolve,
 * deliveries and stream chunks are recorded, and a `think` tool is offered.
 */
function explicitRegistry(h: Awaited<ReturnType<typeof harness>>) {
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text: text.trim(), channelId });
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    handleChannelToolCall: async () => ({ success: true, data: { noted: true } }),
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    getChannelTools: () => [{ name: 'think', description: 'Reason privately', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  return { routed, streamed };
}

test("explicit mode: within one stream, each round after a private round or >>skip_reply streams where delivery sends it", { timeout: 15000 }, async () => {
  // The stream follows each prefix as it's written, a private round's too.
  // At each round's end it returns to the turn's destination, which a private
  // think's >>#cafe and a >>skip_reply envelope leave at #alpha.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first\n' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: '>>#cafe private plan' },
      { type: 'tool_use', id: 'two', name: 'think', input: { content: 'plan privately' } },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: 'middle' },
      { type: 'tool_use', id: 'three', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: '>>skip_reply aside' },
      { type: 'tool_use', id: 'four', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'later' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit', sameRoundThinkTextPolicy: 'private' });
  const { routed, streamed } = explicitRegistry(h);
  try {
    await h.run();
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'middle', channelId: 'chan-alpha' },
      { text: 'later', channelId: 'chan-alpha' },
    ]);
    for (const text of ['middle', 'later']) {
      assert.deepEqual(streamed.filter((d) => d.delta.includes(text)).map((d) => d.channelId), ['chan-alpha'],
        `${text} streams to #alpha`);
    }
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a membrane retry within a stream starts again at the turn's destination", { timeout: 15000 }, async () => {
  // Round one set #alpha. The membrane then refuses the next attempt and
  // retries it; the retried attempt's unprefixed reply is delivered to
  // #alpha, and streams there too.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first\n' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit' });
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
      const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string; content?: unknown }>;
      for await (const event of events) {
        if (event.type === 'tokens' && event.content === 'continued') {
          yield { type: 'tokens', content: 'refused partial', meta: { type: 'text', visible: true, blockIndex: 0 } };
          yield { type: 'retrying', attempt: 1, maxAttempts: 3 };
        }
        yield event;
      }
    };
    return stream;
  };
  const { routed, streamed } = explicitRegistry(h);
  try {
    await h.run();
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ]);
    assert.deepEqual(streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-alpha']);
    assert.equal(streamed.some((d) => d.delta.includes('refused partial')), true,
      'the refused attempt had streamed, as text streams before a refusal is known');
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a round's later text block starts a new line for the stream, as delivery joins blocks", { timeout: 15000 }, async () => {
  // Two text blocks in one round, the second opening with a prefix, the first
  // not ending with a newline. Delivery reads them joined by a newline.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first part' },
      { type: 'text', text: '>>#cafe second' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit' });
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
      const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string; content?: unknown }>;
      let split = false;
      for await (const event of events) {
        if (!split && event.type === 'tokens' && typeof event.content === 'string' && event.content.includes('>>#cafe')) {
          // The mock streams a round's text as one token: stream it as the
          // two blocks the round holds.
          split = true;
          yield { type: 'tokens', content: '>>#alpha first part', meta: { type: 'text', visible: true, blockIndex: 0 } };
          yield { type: 'tokens', content: '>>#cafe second', meta: { type: 'text', visible: true, blockIndex: 1 } };
          continue;
        }
        yield event;
      }
    };
    return stream;
  };
  const { routed, streamed } = explicitRegistry(h);
  try {
    await h.run();
    assert.deepEqual(routed.slice(0, 2), [
      { text: 'first part', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(streamed.filter((d) => d.delta.includes('second')).map((d) => d.channelId), ['chan-cafe']);
    assert.equal(streamed.some((d) => d.delta.includes('>>')), false, 'no prefix is streamed as text');
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a round's targets are resolved once, when it ends, for its delivery and the resumed stream alike", { timeout: 15000 }, async () => {
  // From a review's probe. Both rounds that name #cafe have ended, and their
  // deliveries wait behind 'first', when the registry's #cafe starts naming
  // another channel. Each goes to the channel #cafe named when its round
  // ended, where the stream sent it: the queued '>>#cafe second', and the
  // resumed '>>#cafe continued', whose text-only round ended before the wait.
  const t = await heldRestart('explicit', { first: '>>#alpha first\n', second: '>>#cafe second', continued: '>>#cafe continued' });
  try {
    await t.held;
    t.directory.cafe = 'chan-rebound';
    t.release();
    await t.run;
    assert.deepEqual(t.routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(t.streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe']);
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});

test("a fresh turn that delivers nothing still replaces an earlier turn's speech chain for its restart", { timeout: 15000 }, async () => {
  // An earlier turn's delivery that never settles: a stream resuming this
  // turn must not queue behind it.
  const quiet = createMockResponse([
    { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  quiet.usage = { inputTokens: 100, outputTokens: 5 };
  // The reply names its destination, so nothing bounces into another turn.
  const reply = createMockResponse([{ type: 'text', text: '>>#alpha continued' }] as ContentBlock[], 'end_turn');
  const h = await harness([[quiet], [reply]], { proseRouting: 'explicit', maxStreamTokens: 20 });
  (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> })
    .proseSpeechChains.set('assistant', new Promise<void>(() => {}));
  const routed: string[] = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push(text);
      return { delivered: true, channelId };
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    const run = h.run();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 10000); });
    try {
      assert.notEqual(await Promise.race([run.then(() => 'done' as const), timeout]), 'timeout',
        'the resumed turn finishes');
    } finally {
      clearTimeout(timer);
    }
    assert.equal(h.membrane.requests.length, 2);
    assert.deepEqual(routed.map((text) => text.trim()), ['continued']);
  } finally {
    await h.framework.stop();
  }
});

test("a fresh turn clears the sticky destination and the turn's destination in every mode", async () => {
  for (const mode of ['explicit', 'hybrid', 'locus'] as const) {
    const h = await harness([[answer()]], { proseRouting: mode });
    const internals = h.framework as unknown as {
      proseTurnDestinations: Map<string, string | null>;
      proseTargetPins: Map<string, string>;
    };
    internals.proseTurnDestinations.set('assistant', 'chan-earlier');
    internals.proseTargetPins.set('assistant', 'chan-earlier');
    try {
      await h.run();
      assert.equal(internals.proseTurnDestinations.has('assistant'), false, `${mode}: the turn's destination`);
      assert.equal(internals.proseTargetPins.has('assistant'), false, `${mode}: the sticky destination`);
    } finally {
      await h.framework.stop();
    }
  }
});

test('backward-compatible direct Agent inference also guards tool results', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses = [calls('one'), refused(), answer()];
  const requests: NormalizedRequest[] = [];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  try {
    const agent = h.framework.getAgent('assistant')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    const first = await agent.runInference(h.framework.getAllTools());
    assert.equal(first.toolCalls.length, 1);
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const final = await agent.runInference(h.framework.getAllTools());
    assert.deepEqual(final.speechContent, [{ type: 'text', text: 'continued' }]);
    assert.equal(requests.length, 3);
    assert.equal(final.usage?.inputTokens, 20, 'abandoned refused attempt usage is included');
    assert.match(JSON.stringify(requests[1]), /direct-original/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /direct-original|discard-this/);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('full oversized output survives withholding and reopening as a Chronicle blob', async () => {
  const original = 'original-large-'.repeat(8_000) + 'end-of-original';
  const h = await harness([[calls('large'), refused()], [answer()]], { toolResultGuard: true }, {
    large: { success: true, data: original },
  });
  let originalStopped = false;
  try {
    await h.run();
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<{
      originals: { blobId: string };
    }>;
    const blobId = audit[0].originals.blobId;
    assert.equal(typeof blobId, 'string');
    const blob = h.framework.getStore().getBlob(blobId)!;
    assert.equal(JSON.parse(blob.toString())[0].result.data, original, 'keep pre-truncation bytes');
    await h.framework.stop(); originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.deepEqual(restarted.getStore().getBlob(blobId), blob);
      assert.equal(toolResults(restarted)[0].content, TOOL_RESULT_GUARD_NOTICE);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// Review regressions (PR #159): guard effects apply only to a batch that was
// actually SUBMITTED to the provider in the current turn.
// ---------------------------------------------------------------------------

class OmitToolExchange extends PassthroughStrategy {
  select(...args: Parameters<PassthroughStrategy['select']>) {
    return super.select(...args).filter((entry) =>
      !entry.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result'));
  }
}

test('a staged batch omitted by compilation does not claim the refusal; autoRewind proceeds', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, maxStreamTokens: 1, strategy: new OmitToolExchange(),
    refusalHandling: { autoRewind: true },
  });
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false, 'unsubmitted batch must be settled, not stranded');
    assert.equal(guard.recovering, false);
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    assert.equal(h.membrane.requests.length, 3, 'ordinary refusal rewind retry must run');
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.ok(audit.some((r) => r.type === 'withheld' && r.reason === 'unsubmitted'));
  } finally { await h.framework.stop(); }
});

test('a turn ended by an endTurn tool settles (accepts) its batch', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true },
    { one: { success: true, data: 'payload-one', endTurn: true } });
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(audit.at(-1)?.type, 'accepted');
    assert.equal(audit.at(-1)?.reason, 'turn_ended');
  } finally { await h.framework.stop(); }
});

test('a refusal on the next turn after endTurn uses ordinary refusal handling', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, refusalHandling: { autoRewind: true, retries: 2 },
  }, { one: { success: true, data: 'payload-one', endTurn: true } });
  try {
    await h.run();
    await h.run();
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/, 'autoRewind must not be suppressed');
    assert.equal(h.membrane.requests.length, 3);
  } finally { await h.framework.stop(); }
});

test('budget restart reserves the real wire cost of the pending batch', async () => {
  const big = 'x'.repeat(40_000); // ~10k tokens on the wire, notice is ~20
  const budget = 14_000;
  const h = await harness([[calls('one')], [answer()]], {
    toolResultGuard: true, maxStreamTokens: 1, contextBudgetTokens: budget, maxTokens: 1_000,
  }, { one: { success: true, data: big } });
  try {
    const cm = h.framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 20; i++) {
      cm.addMessage('user', [{ type: 'text', text: `filler-${i} ` + 'y'.repeat(2_000) }]);
    }
    await h.run();
    const rebuilt = h.membrane.requests[1];
    assert.match(JSON.stringify(rebuilt), /xxxxxxxx/, 'pending original still submitted');
    const chars = rebuilt.messages.flatMap((m) => m.content).reduce((n, b) =>
      n + JSON.stringify(b).length, 0);
    assert.ok(Math.ceil(chars / 4) <= budget - 1_000,
      `rebuilt request ~${Math.ceil(chars / 4)} tokens exceeds budget ${budget - 1_000}`);
  } finally { await h.framework.stop(); }
});

test('audit is synced before the pending batch is submitted', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  let syncedWhilePending = false;
  (store as { sync: () => void }).sync = () => {
    if (h.framework.getAgent('assistant')!.toolResultGuard.hasPending) syncedWhilePending = true;
    sync();
  };
  let durableAtSubmit = false;
  h.membrane.onSubmit = () => { durableAtSubmit = syncedWhilePending; };
  try {
    await h.run();
    assert.equal(durableAtSubmit, true);
  } finally { (store as { sync: () => void }).sync = sync; await h.framework.stop(); }
});

test('direct API: a transient compile failure does not wedge the guard', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses = [calls('one'), answer()];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream =
    async () => responses.shift()!;
  try {
    const agent = h.framework.getAgent('assistant')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const compile = agent.compileWithInjections.bind(agent);
    let failed = false;
    agent.compileWithInjections = async (...args) => {
      if (!failed) { failed = true; throw new Error('transient compile failure'); }
      return compile(...args);
    };
    await assert.rejects(agent.runInference(h.framework.getAllTools()), /transient compile failure/);
    const final = await agent.runInference(h.framework.getAllTools());
    assert.deepEqual(final.speechContent, [{ type: 'text', text: 'continued' }]);
    assert.equal(toolResults(h.framework).length, 1, 'batch staged exactly once');
    assert.match(String(toolResults(h.framework)[0].content), /direct-original/);
  } finally { await h.framework.stop(); }
});

test('usage of an abandoned guarded round is counted in session totals', async () => {
  const withUsage = (r: NormalizedResponse, input: number) =>
    ({ ...r, details: { ...(r.details ?? {}), usage: { inputTokens: input, outputTokens: 1 } } }) as NormalizedResponse;
  const h = await harness([[calls('one'), withUsage(refused(), 1_000)], [withUsage(answer(), 7)]], { toolResultGuard: true });
  try {
    await h.run();
    const totals = h.framework.getSessionUsage().totals as unknown as Record<string, number>;
    assert.ok(totals.inputTokens >= 1_007, `refused round usage missing: ${JSON.stringify(totals)}`);
  } finally { await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// Greptile review regressions (PR #159, head 647f081).
// ---------------------------------------------------------------------------

function fakeRegistry(framework: AgentFramework) {
  const routed: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveLocus: () => 'world:test',
    routeSpeech: async (_agent: string, speech: string) => {
      routed.push(speech); return { delivered: true, channelId: 'world:test' };
    },
    sendOutgoingChunk: () => {},
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  return routed;
}

test('failed audit sync fails closed: originals are never submitted', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  (store as { sync: () => void }).sync = () => {
    if (h.framework.getAgent('assistant')!.toolResultGuard.hasPending) throw new Error('disk full');
    sync();
  };
  try {
    await h.run();
    const provided = JSON.stringify(h.membrane.streams[0].receivedToolResults);
    assert.doesNotMatch(provided, /payload-one/, 'non-durable audit must not release originals');
    assert.match(provided, /Tool result withheld by the guard/);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false);
  } finally { (store as { sync: () => void }).sync = sync; await h.framework.stop(); }
});

test('an aborted stream settles its submitted batch; the next turn neither resubmits nor claims it', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, refusalHandling: { autoRewind: true },
  });
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false, 'aborted batch must not stay pending');
    h.membrane.onSubmit = undefined;
    await h.run();
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/, 'old originals must not be resubmitted');
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/, 'ordinary autoRewind must run');
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.ok(audit.some((r) => r.type === 'withheld' && r.reason === 'aborted'));
  } finally { await h.framework.stop(); }
});

test('guard recovery keeps same-turn explicit-send suppression', async () => {
  const h = await harness([[createMockResponse([
    { type: 'tool_use', id: 'send', name: 'test--send_message', input: {} },
    { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
  ], 'tool_use'), refused()], [createMockResponse([{ type: 'text', text: 'postscript' }])]], { toolResultGuard: true });
  const routed = fakeRegistry(h.framework);
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(!routed.some((text) => text.includes('postscript')), `postscript routed: ${JSON.stringify(routed)}`);
  } finally { await h.framework.stop(); }
});

test('a failed audit append while settling an aborted batch does not block teardown', async () => {
  const h = await harness([[calls('one')], [answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.hasPending, false);
    failAborted = false;
    h.membrane.onSubmit = undefined;
    await h.run();
    assert.equal(h.membrane.requests.length, 2, 'agent must accept a later turn after teardown');
    assert.deepEqual(h.module.speeches.at(-1), 'continued');
  } finally { (store as { appendToStateJson: typeof append }).appendToStateJson = append; await h.framework.stop(); }
});

test('an aborted outcome that failed to append is recorded on the next guard write or stop', async () => {
  const h = await harness([[calls('one')], [calls('two'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    failAborted = false;
    h.membrane.onSubmit = undefined;
    await h.run();
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const first = audit[0].batchId;
    const outcome = audit.findIndex((r) => r.batchId === first && r.type === 'withheld' && r.reason === 'aborted');
    assert.ok(outcome > 0, 'lost aborted outcome must be retried');
    const nextStaged = audit.findIndex((r, i) => i > 0 && r.type === 'staged');
    assert.ok(outcome < nextStaged, 'retried outcome lands before the next batch');
  } finally { (store as { appendToStateJson: typeof append }).appendToStateJson = append; await h.framework.stop(); }
});

test('a lost aborted outcome is flushed at stop', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    await h.run().catch(() => {});
    failAborted = false;
    const written: Array<Record<string, unknown>> = [];
    (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
      if (id === TOOL_RESULT_GUARD_AUDIT_STATE) written.push(value as Record<string, unknown>);
      return append(id, value);
    };
    await h.framework.stop(); stopped = true;
    assert.ok(written.some((r) => r.type === 'withheld' && r.reason === 'aborted'), 'outcome flushed at stop');
  } finally { if (!stopped) await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// Compression holds (CM 0.12): real Autobiographical compression with the
// guard on (Codex 09-26 P1 repro / review finding #3).
// ---------------------------------------------------------------------------

async function compressionRig() {
  const { ContextManager, AutobiographicalStrategy } = await import('@animalabs/context-manager');
  const { ToolResultGuard } = await import('../src/tool-result-guard.js');
  const dir = mkdtempSync(join(tmpdir(), 'af-guard-compression-')); dirs.push(dir);
  const prompts: string[] = [];
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0,
    recentWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: {
    complete: async (req: unknown) => {
      prompts.push(JSON.stringify(req));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${prompts.length}` }] };
    },
  } as never });
  cm.setToolDefinitions([{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }]);
  const filler = (n: number) => 'word '.repeat(n);
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: filler(30) }]);
  cm.addMessage('Claude', [{ type: 'text', text: filler(20) }, { type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
  const guard = new ToolResultGuard('Claude', cm, true);
  const REAL = 'REAL-ACCEPTED-TOOL-OUTPUT';
  const content: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'tu-1', content: REAL }];
  const messageId = guard.storeResults(content, [{ toolUseId: 'tu-1', content: REAL }], []);
  // Deferred messages flushed right behind the staged batch push it out of
  // the protected tail.
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 === 0 ? 'Claude' : 'User', [{ type: 'text', text: filler(30) }]);
  const drain = async () => {
    const s = strategy as unknown as { compressionQueue: number[] };
    await cm.compile();
    let n = 0;
    while (s.compressionQueue.length > 0 && n++ < 50) await cm.tick();
  };
  return { cm, guard, prompts, drain, messageId, REAL };
}

test('real compression: a pending batch is held; accepted output reaches memory, placeholder never does', async () => {
  const r = await compressionRig();
  try {
    assert.deepEqual([...r.cm.getCompressionHolds()], [r.messageId], 'staged with a compression hold');
    await r.drain();
    assert.ok(r.prompts.length > 0, 'history before the hold still compresses');
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder summarized while pending');
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    r.guard.accept();
    assert.equal(r.cm.getCompressionHolds().size, 0, 'accept releases the hold');
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(r.REAL)), 'accepted output must reach the compression request');
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder must never be summarized');
  } finally { r.cm.close(); }
});

test('real compression: a withheld batch releases its hold and the placeholder compresses normally', async () => {
  const r = await compressionRig();
  try {
    await r.drain();
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.ok(r.guard.withhold('test-category'));
    assert.equal(r.cm.getCompressionHolds().size, 0, 'withhold releases the hold');
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder compresses after release');
    assert.ok(!r.prompts.some((p) => p.includes(r.REAL)), 'withheld output never reaches memory');
  } finally { r.cm.close(); }
});

test('every settlement path releases the hold, even when the audit write fails', async () => {
  const paths: Array<[string, (g: InstanceType<typeof import('../src/tool-result-guard.js').ToolResultGuard>) => void]> = [
    ['accept-submitted', (g) => { g.submissionResults([{ toolUseId: 'tu-1', content: 'x' }]); g.accept(); }],
    ['accept-unsubmitted', (g) => g.accept()],
    ['withhold', (g) => { g.submissionResults([{ toolUseId: 'tu-1', content: 'x' }]); g.withhold('c'); }],
    ['turn-ended', (g) => g.settleTurnEnded()],
    ['unsubmitted', (g) => g.settleUnsubmitted('c')],
    ['abandon', (g) => g.abandon('aborted')],
  ];
  for (const [name, settle] of paths) {
    const r = await compressionRig();
    try {
      const store = r.cm.getStore();
      (store as { appendToStateJson: unknown }).appendToStateJson = () => { throw new Error('storage down'); };
      try { settle(r.guard); } catch { /* audit failure surfaces; hold must still go */ }
      assert.equal(r.guard.hasPending, false, `${name}: batch cleared`);
      assert.equal(r.cm.getCompressionHolds().size, 0, `${name}: hold released`);
    } finally { r.cm.close(); }
  }
});

for (const failedType of ['staged', 'linked']) {
  test(`storage recovery: failed ${failedType} append continues with placeholders and releases the hold`, async () => {
    const h = await harness([[calls('one'), answer()], [answer()]], { toolResultGuard: true });
    const store = h.framework.getStore();
    const append = store.appendToStateJson.bind(store);
    let failing = true;
    store.appendToStateJson = (id, value) => {
      if (failing && id === TOOL_RESULT_GUARD_AUDIT_STATE && value?.type === failedType) {
        throw new Error(`injected ${failedType} append failure`);
      }
      return append(id, value);
    };
    try {
      await assert.doesNotReject(h.run(), 'storage failure must not strand the live tool loop');
      const agent = h.framework.getAgent('assistant')!;
      assert.equal(agent.state.status, 'idle');
      assert.equal(agent.toolResultGuard.hasPending, false);
      assert.equal(agent.getContextManager().getCompressionHolds().size, 0);
      assert.match(JSON.stringify(h.membrane.streams[0].receivedToolResults), /Tool result withheld/);
      assert.doesNotMatch(JSON.stringify(h.membrane.streams[0].receivedToolResults), /payload-one/);
      failing = false;
      await h.run(); // A normal activation, with no new tool call, retries the audit.
      const records = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.deepEqual(records.map((r) => r.type), ['staged', 'linked', 'withheld']);
      assert.match(JSON.stringify(records[0]), /payload-one/, 'the original is recoverable after storage returns');
      assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
      assert.deepEqual(h.module.calls, ['one']);
    } finally {
      store.appendToStateJson = append;
      for (const stream of h.membrane.streams) stream.cancel();
      await h.framework.stop();
    }
  });
}

test('storage recovery: failed accepted edit is retried before the next activation without rerunning tools', async () => {
  const h = await harness([[calls('one'), answer()], [answer()]], { toolResultGuard: true });
  const agent = h.framework.getAgent('assistant')!;
  const cm = agent.getContextManager();
  const edit = cm.editMessage.bind(cm);
  let failing = true;
  cm.editMessage = (id, content) => {
    if (failing && JSON.stringify(content).includes('payload-one')) throw new Error('injected edit failure');
    edit(id, content);
  };
  try {
    await h.run();
    assert.equal(agent.state.status, 'idle');
    assert.equal(agent.toolResultGuard.hasPending, false, 'an accepted batch cannot claim another refusal');
    assert.equal(cm.getCompressionHolds().size, 1, 'keep provisional history out of compression until repaired');
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
    assert.throws(() => agent.toolResultGuard.flushUnrecorded(), /injected edit failure/);
    failing = false;
    await h.run();
    assert.match(JSON.stringify(h.membrane.requests[1]), /payload-one/, 'next activation must see the accepted result');
    assert.equal(cm.getCompressionHolds().size, 0);
    const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(records.filter((r) => r.type === 'accepted').length, 1);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(h.module.speeches.at(-1), 'continued');
    assert.equal(cm.getAllMessages().filter((message) => message.participant === 'assistant'
      && message.content.some((block) => block.type === 'text' && block.text === 'continued')).length, 2);
  } finally { cm.editMessage = edit; await h.framework.stop(); }
});

test('storage recovery: failed accepted edit stays held until the real compressor can see the original', async () => {
  const r = await compressionRig();
  const edit = r.cm.editMessage.bind(r.cm);
  r.cm.editMessage = () => { throw new Error('injected edit failure'); };
  try {
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.doesNotThrow(() => r.guard.accept());
    assert.equal(r.cm.getCompressionHolds().size, 1);
    await r.drain();
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)));
    r.cm.editMessage = edit;
    r.guard.flushUnrecorded();
    assert.equal(r.cm.getCompressionHolds().size, 0);
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(r.REAL)));
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)));
  } finally { r.cm.editMessage = edit; r.cm.close(); }
});

test('storage recovery: failed accepted edit and its audit outcome are repaired at stop', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  cm.editMessage = () => { throw new Error('injected edit failure'); };
  let stopped = false;
  try {
    await h.run();
    cm.editMessage = edit;
    await h.framework.stop(); stopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.match(String(toolResults(restarted)[0].content), /payload-one/);
      const records = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.type, 'accepted');
    } finally { await restarted.stop(); }
  } finally { cm.editMessage = edit; if (!stopped) await h.framework.stop(); }
});

test('storage recovery: endTurn never admits a batch whose audit sync failed', async () => {
  const h = await harness([[calls('one')], [answer()]], { toolResultGuard: true }, {
    one: { success: true, data: 'payload-one', endTurn: true },
  });
  const agent = h.framework.getAgent('assistant')!;
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  store.sync = () => {
    if (agent.toolResultGuard.hasPending) throw new Error('injected sync failure');
    sync();
  };
  try {
    await h.run();
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
    assert.equal(agent.getContextManager().getCompressionHolds().size, 0);
    assert.equal(agent.toolResultGuard.hasPending, false);
    store.sync = sync;
    await h.run();
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    const records = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(records.at(-1)?.type, 'withheld');
    assert.match(JSON.stringify(records[0]), /payload-one/, 'the original is still archived');
  } finally { store.sync = sync; await h.framework.stop(); }
});

for (const supersedingAction of ['edit', 'branch']) {
  test(`storage recovery: queued acceptance respects an operator ${supersedingAction}`, async () => {
    const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
    const agent = h.framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    const edit = cm.editMessage.bind(cm);
    cm.editMessage = () => { throw new Error('injected edit failure'); };
    try {
      await h.run();
      cm.editMessage = edit;
      const result = cm.getAllMessages().find((message) => message.content.some((block) => block.type === 'tool_result'))!;
      if (supersedingAction === 'edit') {
        cm.editMessage(result.id, [{ type: 'tool_result', toolUseId: 'one', content: 'operator replacement' }]);
      } else {
        await cm.fork('operator-branch');
      }
      agent.toolResultGuard.flushUnrecorded();
      assert.equal(toolResults(h.framework)[0].content,
        supersedingAction === 'edit' ? 'operator replacement' : TOOL_RESULT_GUARD_NOTICE);
      assert.equal(cm.getCompressionHolds().size, 0);
      const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.historyUpdate, 'superseded');
      assert.match(JSON.stringify(records[0]), /payload-one/, 'original audit remains intact');
    } finally { cm.editMessage = edit; await h.framework.stop(); }
  });
}

test('storage recovery: idle maintenance retries acceptance without a new activation', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  cm.editMessage = () => { throw new Error('injected edit failure'); };
  try {
    await h.run();
    assert.equal(cm.getCompressionHolds().size, 1);
    cm.editMessage = edit;
    h.framework.start();
    await h.framework.maintenanceTick();
    assert.equal(cm.getCompressionHolds().size, 0);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    assert.equal(h.membrane.requests.length, 1);
  } finally { cm.editMessage = edit; await h.framework.stop(); }
});

test('storage recovery: shutdown retries edits queued by its terminating stream', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  let failOnce = true;
  cm.editMessage = (id, content) => {
    if (failOnce) { failOnce = false; throw new Error('injected edit failure'); }
    edit(id, content);
  };
  let stopping: Promise<void> | undefined;
  h.membrane.onSubmit = () => { stopping = h.framework.stop(); };
  try {
    await h.run();
    assert.ok(stopping);
    await stopping;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.match(String(toolResults(restarted)[0].content), /payload-one/);
      const records = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.type, 'accepted');
    } finally { await restarted.stop(); }
  } finally { cm.editMessage = edit; if (stopping) await stopping; else await h.framework.stop(); }
});
