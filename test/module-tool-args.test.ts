/**
 * A module tool's call is checked against the tool's declared inputSchema
 * before the module runs: an input that isn't an object, or one missing a
 * required key, is refused with what to send, and the handler never sees the
 * call. Values go to the handler as they came, since a handler may take more
 * than its schema can say. The utils tool checks a utility's values too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import { toolArgsProblems } from '../src/tool-args.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    count: { type: 'integer' },
    mode: { type: 'string', enum: ['a', 'b'] },
    id: { type: 'number' },
    note: { type: ['string', 'null'] },
    opts: { type: 'object' },
  },
  required: ['path'],
};

const WRITE_SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
};

/** A module with one declared tool, and a handler that also answers a name it doesn't declare. */
class ProbeModule implements Module {
  readonly name = 'probe';
  calls: ToolCall[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'echo', description: 'Echo the input.', inputSchema: SCHEMA },
      { name: 'write', description: 'Take two required keys.', inputSchema: WRITE_SCHEMA },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name, input: call.input } };
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

async function withFramework(
  fn: (framework: AgentFramework, probe: ProbeModule, membrane: MockMembrane) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'module-tool-args-'));
  const probe = new ProbeModule();
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [probe],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    await fn(framework, probe, membrane);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (framework: AgentFramework, input: unknown, name = 'probe--echo'): Promise<ToolResult> =>
  framework.executeToolCall({ id: 'zz-1', name, input: input as Record<string, unknown>, callerAgentName: 'agent' });

describe('a module tool\'s arguments are checked before the module runs', () => {
  it('refuses a call missing a required argument, naming it and its type', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {});
      assert.equal(result.isError, true);
      assert.equal(result.error, 'Nothing was done: probe--echo needs "path" (a string), and this call gave none.');
      assert.equal(probe.calls.length, 0, 'the handler never saw the call');
    });
  });

  it('names every missing required key at once', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {}, 'probe--write');
      assert.equal(result.error,
        'Nothing was done: probe--write needs "path" (a string), and this call gave none; ' +
        'needs "content" (a string), and this call gave none.');
      assert.equal(probe.calls.length, 0);
    });
  });

  it('passes a well-formed call to the module as it came, unknown keys included', async () => {
    await withFramework(async (framework, probe) => {
      const input = { path: 'work/a.txt', count: 2, mode: 'b', note: null, zz_extra: true };
      const result = await call(framework, input);
      assert.equal(result.success, true, result.error);
      assert.deepEqual(probe.calls[0]!.input, input);
    });
  });

  it('leaves values to the module, which may take more than its schema says', async () => {
    await withFramework(async (framework, probe) => {
      // One name where a list is declared, a number as text, a value outside
      // the enum: the module decides.
      const input = { path: 'p', count: '3', mode: 'z', opts: ['zz-one'] };
      const result = await call(framework, input);
      assert.equal(result.success, true, result.error);
      assert.deepEqual(probe.calls[0]!.input, input);
    });
  });

  it('refuses an input that isn\'t an object', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, null);
      assert.equal(result.error, 'Nothing was done: probe--echo its input must be an object, and this call gave null.');
      assert.equal(probe.calls.length, 0);
    });
  });

  it('leaves a name the module answers but doesn\'t declare unchecked', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {}, 'probe--undeclared');
      assert.equal(result.success, true, result.error);
      assert.equal(probe.calls[0]!.name, 'undeclared');
    });
  });

  it('answers a model\'s call with the refusal, as an error tool result', async () => {
    await withFramework(async (framework, probe, membrane) => {
      membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'zz-call', name: 'probe--echo', input: {} }], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-done' }]));
      framework.start();
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'agent', reason: 'external-message', source: 'test', timestamp: Date.now(),
      });
      const stream = () => membrane.lastStream as unknown as { receivedToolResults: unknown[][] } | undefined;
      const deadline = Date.now() + 5_000;
      while ((stream()?.receivedToolResults.length ?? 0) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      const results = stream()?.receivedToolResults[0] as Array<{ isError?: boolean; content?: unknown }> | undefined;
      assert.ok(results, 'the model was answered');
      assert.equal(results!.length, 1);
      assert.equal(results![0]!.isError, true);
      assert.ok(JSON.stringify(results![0]!.content).includes('Nothing was done: probe--echo needs \\"path\\" (a string), and this call gave none.'),
        JSON.stringify(results));
      assert.equal(probe.calls.length, 0);
    });
  });
});

describe('toolArgsProblems', () => {
  it('has nothing to say without a schema, or about keys the schema doesn\'t declare', () => {
    assert.deepEqual(toolArgsProblems({ a: 1 }, undefined), []);
    assert.deepEqual(toolArgsProblems({ zz: 1 }, { type: 'object' }, { values: true }), []);
  });

  it('checks values only when asked, and then reports every problem at once', () => {
    const input = { count: '3', mode: 'z', opts: [1] };
    assert.deepEqual(toolArgsProblems(input, SCHEMA), ['needs "path" (a string), and this call gave none']);
    assert.deepEqual(toolArgsProblems(input, SCHEMA, { values: true }), [
      'needs "path" (a string), and this call gave none',
      '"count" must be a number, and this call gave a string',
      '"mode" must be one of "a" or "b", and this call gave "z"',
      '"opts" must be an object, and this call gave an array',
    ]);
  });

  it('takes the digits of a large integer for a number, as membrane passes them', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '1234567890123456789' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '12' }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave a string']);
  });

  it('reads a type list as any of its types', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', note: 'hi' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', note: null }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', note: 7 }, SCHEMA, { values: true }),
      ['"note" must be a string or null, and this call gave a number']);
  });

  it('counts null as given, and checks its type', () => {
    assert.deepEqual(toolArgsProblems({ path: null }, SCHEMA, { values: true }), ['"path" must be a string, and this call gave null']);
  });

  it('shows a long value briefly', () => {
    const [problem] = toolArgsProblems({ path: 'p', mode: 'x'.repeat(200) }, SCHEMA, { values: true });
    assert.ok(problem!.endsWith('…'), problem);
    assert.ok(problem!.length < 160, problem);
  });
});
