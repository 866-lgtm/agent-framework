import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { AgentConfig } from '../src/types/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import { createMockResponse } from './helpers/mock-membrane.js';

/** buildActivationRequest only needs compile(); membrane is never touched. */
const stubContextManager = {
  compile: async () => ({ messages: [], systemInjections: [] }),
} as unknown as ContextManager;

function createAgent(config: Partial<AgentConfig>): Agent {
  return new Agent(
    { name: 'tester', model: 'test-model', systemPrompt: 'sys', ...config },
    stubContextManager,
    {} as Membrane,
  );
}

describe('Agent cacheTtl forwarding', () => {
  it('forwards cacheTtl on the activation request when configured', async () => {
    const agent = createAgent({ cacheTtl: '1h' });
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.promptCaching, true);
    assert.equal(request.cacheTtl, '1h');
  });

  it('defaults cacheTtl to 1h when unset', async () => {
    const agent = createAgent({});
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.promptCaching, true);
    assert.equal(request.cacheTtl, '1h');
  });

  it('preserves an explicit 5m override', async () => {
    const agent = createAgent({ cacheTtl: '5m' });
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.cacheTtl, '5m');
  });
});

describe('Agent provider parameter forwarding', () => {
  it('forwards stateless Responses reasoning and compaction settings unchanged', async () => {
    const providerParams = {
      reasoning: { effort: 'high', context: 'all_turns' },
      context_management: [{ type: 'compaction', compact_threshold: 850000 }],
    };
    const agent = createAgent({ providerParams });
    const request = await agent.buildActivationRequest([]);
    assert.deepEqual(request.providerParams, providerParams);
  });
});

describe('the direct API sends the agent request settings', () => {
  /** runInference also stores the reply it gets. */
  const directContextManager = {
    compile: async () => ({ messages: [], systemInjections: [] }),
    addMessage: () => 'reply',
  } as unknown as ContextManager;

  /** An agent whose membrane records each request runInference sends. */
  function directAgent(config: Partial<AgentConfig>): { agent: Agent; sent: NormalizedRequest[] } {
    const sent: NormalizedRequest[] = [];
    const membrane = {
      stream: async (request: NormalizedRequest) => {
        sent.push(request);
        return createMockResponse([{ type: 'text', text: 'ok' }]);
      },
    } as unknown as Membrane;
    return { agent: new Agent({ name: 'tester', model: 'test-model', systemPrompt: 'sys', ...config }, directContextManager, membrane), sent };
  }

  it('carries promptCaching, cacheTtl and prefillUserMessage', async () => {
    const { agent, sent } = directAgent({ promptCaching: false, cacheTtl: '5m', prefillUserMessage: 'scaffold' });
    await agent.runInference([]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].promptCaching, false);
    assert.equal(sent[0].cacheTtl, '5m');
    assert.equal(sent[0].prefillUserMessage, 'scaffold');
  });

  it("sends the same settings as the agent's framework turn", async () => {
    const config: Partial<AgentConfig> = {
      maxTokens: 1234, temperature: 0.3, thinking: { enabled: true, budgetTokens: 2048 },
      promptCaching: false, cacheTtl: '5m', prefillUserMessage: 'scaffold', providerParams: { reasoning: { effort: 'low' } },
    };
    const { agent, sent } = directAgent(config);
    await agent.runInference([]);
    const activation = await directAgent(config).agent.buildActivationRequest([]);
    // Everything but what each path assembles for itself: the messages, the
    // system prompt and the tools, and the KV-unified markers, which only a
    // framework turn uses.
    const settings = (request: NormalizedRequest) => {
      const { messages: _m, system: _s, tools: _t, cacheMarkers: _c, ...rest } = request as NormalizedRequest & { cacheMarkers?: unknown };
      return rest;
    };
    assert.deepEqual(settings(sent[0]), settings(activation));
  });
});
