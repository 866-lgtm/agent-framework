import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedResponse } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class RefusalHarnessModule implements Module {
  readonly name = 'test';
  readonly toolCalls: ToolCall[] = [];
  readonly speeches: string[] = [];
  private ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    ctx.registerSpeechHandler('*');
  }

  async stop(): Promise<void> {
    this.ctx?.unregisterSpeechHandler();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [{
      name: 'echo',
      description: 'Echo input',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.toolCalls.push(call);
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{
        participant: 'User',
        content: [{ type: 'text', text: String(event.content) }],
      }],
      requestInference: true,
    };
  }

  async onAgentSpeech(_agentName: string, content: ContentBlock[]): Promise<void> {
    const text = content
      .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text) this.speeches.push(text);
  }
}

function refusalResponse(content: ContentBlock[] = []): NormalizedResponse {
  return {
    ...createMockResponse(content, 'refusal'),
    content,
    stopReason: 'refusal',
    toolCalls: [],
    rawAssistantText: content
      .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    usage: { inputTokens: 40, outputTokens: 0 },
    details: {
      stop: { reason: 'refusal', wasTruncated: false },
      usage: { inputTokens: 40, outputTokens: 0 },
      timing: { totalDurationMs: 100, attempts: 1 },
      model: { requested: 'test-model', actual: 'test-model', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: {
      request: {},
      response: {
        stop_details: { category: 'reasoning_extraction' },
      },
    },
  } as unknown as NormalizedResponse;
}

async function createFramework(
  storePath: string,
  membrane: MockMembrane,
  module: RefusalHarnessModule,
): Promise<AgentFramework> {
  return AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'assistant',
      model: 'test-model',
      systemPrompt: 'system',
    }],
    modules: [module],
    syncIntervalMs: 0,
  });
}

function pendingRequests(framework: AgentFramework): unknown[] {
  return (framework as unknown as { pendingRequests: unknown[] }).pendingRequests;
}

test('zero-output refusal makes exactly one provider call and restart stays idle', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-refusal-zero-'));
  const storePath = join(tempDir, 'store.chronicle');
  let framework: AgentFramework | undefined;
  let restarted: AgentFramework | undefined;

  try {
    const firstModule = new RefusalHarnessModule();
    const firstMembrane = new MockMembrane();
    firstMembrane.pushResponse(refusalResponse());

    framework = await createFramework(storePath, firstMembrane, firstModule);
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'trigger refusal',
      metadata: {},
    });
    await framework.runUntilIdle();

    assert.equal(firstMembrane.calls.length, 1);
    assert.equal(firstModule.toolCalls.length, 0);
    assert.deepEqual(firstModule.speeches, []);
    assert.equal(pendingRequests(framework).length, 0);

    await framework.stop();
    framework = undefined;

    const secondModule = new RefusalHarnessModule();
    const secondMembrane = new MockMembrane();
    restarted = await createFramework(storePath, secondMembrane, secondModule);

    assert.equal(secondMembrane.calls.length, 0, 'restart must not redispatch a refused turn');
    assert.equal(secondModule.toolCalls.length, 0);
    assert.deepEqual(secondModule.speeches, []);
    assert.equal(pendingRequests(restarted).length, 0);
  } finally {
    await restarted?.stop();
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('partial refusal output remains single-call, does not execute tools, and restart stays idle', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-refusal-partial-'));
  const storePath = join(tempDir, 'store.chronicle');
  let framework: AgentFramework | undefined;
  let restarted: AgentFramework | undefined;

  try {
    const firstModule = new RefusalHarnessModule();
    const firstMembrane = new MockMembrane();
    firstMembrane.pushResponse(refusalResponse([
      { type: 'text', text: 'partial before' },
      { type: 'tool_use', id: 'call-1', name: 'test--echo', input: { message: 'should-not-run' } } as ContentBlock,
      { type: 'text', text: 'partial after' },
    ]));

    framework = await createFramework(storePath, firstMembrane, firstModule);
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'trigger partial refusal',
      metadata: {},
    });
    await framework.runUntilIdle();

    assert.equal(firstMembrane.calls.length, 1);
    assert.equal(firstModule.toolCalls.length, 0, 'refused tool blocks must not execute');
    assert.deepEqual(firstModule.speeches, ['partial before\npartial after']);
    assert.equal(pendingRequests(framework).length, 0);

    await framework.stop();
    framework = undefined;

    const secondModule = new RefusalHarnessModule();
    const secondMembrane = new MockMembrane();
    restarted = await createFramework(storePath, secondMembrane, secondModule);

    assert.equal(secondMembrane.calls.length, 0, 'restart must not invent a transformed retry');
    assert.equal(secondModule.toolCalls.length, 0);
    assert.deepEqual(secondModule.speeches, []);
    assert.equal(pendingRequests(restarted).length, 0);
  } finally {
    await restarted?.stop();
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
