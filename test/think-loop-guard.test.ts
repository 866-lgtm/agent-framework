/**
 * Think loop guard (fork e69f17f): consecutive think-only inference rounds.
 *
 * think() carries no endTurn, so a model can reason round after round without
 * replying or acting. After THINK_SOFT_CAP (default 3) consecutive think-only
 * rounds the think tool result carries a firm steer; at THINK_HARD_CAP
 * (default 8) the turn ends.
 *
 * Regression covered here: in the upstream merge the guard ran AFTER the
 * round's tool results were serialized (history copy + wire copy), so the
 * soft-cap steer rewrote an object nobody read again — it reached neither the
 * model nor the stored history, and only the hard cap had any effect. The
 * steer must be in BOTH, byte-matched.
 *
 * These tests rely on the default caps (3 / 8): the caps are read once at
 * import, so THINK_SOFT_CAP / THINK_HARD_CAP must be unset in the test env.
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
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

const STEER = /You have used think (\d+) times in a row without replying or acting/;

class ToolsModule implements Module {
  readonly name = 'tools';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'A concrete tool.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { ok: true, tool: call.name } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content ?? '');
    return {
      addMessages: [{ participant: 'Helen', content: [{ type: 'text', text }] }],
      requestInference: text === 'go',
    };
  }
}

/** Channel registry stand-in: answers think like the real registry does
 *  (a fresh data object per call) and records routed prose. */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: string[] = [];
  const explicit: Record<string, unknown> = {
    getChannelTools: () => [{
      name: 'think',
      description: 'private reasoning',
      inputSchema: { type: 'object' as const, properties: { content: { type: 'string' } }, required: [] },
    }],
    handleChannelToolCall: async (toolName: string) => toolName === 'think'
      ? { success: true, data: { noted: true, note: 'Thought recorded (private — not sent anywhere).' } }
      : { success: false, error: `Unknown channel tool: ${toolName}`, isError: true },
    resolveLocus: () => 'chan-test',
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push(text);
      return locus ? { delivered: true, channelId: locus } : null;
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

const thinkRound = (i: number): ContentBlock[] => [
  { type: 'tool_use', id: `think-${i}`, name: 'think', input: { content: `pondering ${i}` } },
] as ContentBlock[];

/** The wire copy of a round's single tool result, as a string. */
function wireText(results: unknown[]): string {
  const r = results[0] as { content: unknown };
  return typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
}

describe('think loop guard', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'think-guard-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework() {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [new ToolsModule()],
    });
    const routed = stubChannelRegistry(framework);
    const turnEnded: string[] = [];
    framework.onTrace((event) => {
      const e = event as { type: string; agentName?: string };
      if (e.type === 'inference:turn_ended') turnEnded.push(e.agentName ?? '');
    });
    return { framework, routed, turnEnded };
  }

  function trigger(framework: AgentFramework): void {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
  }

  /** Stored tool_result blocks for `think`, in window order. */
  function storedThinkResults(framework: AgentFramework): string[] {
    const cm = framework.getAgent('agent')!.getContextManager();
    return cm.getAllMessages()
      .flatMap((m) => m.content as Array<{ type: string; toolName?: string; toolUseId?: string; content?: unknown }>)
      .filter((b) => b.type === 'tool_result' && (b.toolUseId ?? '').startsWith('think-'))
      .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)));
  }

  it('the soft-cap steer reaches the model AND the stored history (byte-matched)', async () => {
    for (let i = 1; i <= 3; i++) membrane.pushResponse(createMockResponse(thinkRound(i), 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Here is my answer.' }] as ContentBlock[]));

    const { framework, routed, turnEnded } = await createFramework();
    trigger(framework);
    await framework.runUntilIdle();

    const wire = membrane.lastStream!.receivedToolResults.map(wireText);
    assert.equal(wire.length, 3, 'three think rounds were answered on the wire');
    assert.doesNotMatch(wire[0], STEER, 'round 1: no steer yet');
    assert.doesNotMatch(wire[1], STEER, 'round 2: no steer yet');
    assert.match(wire[2], STEER, 'round 3 (soft cap): the model reads the steer');
    assert.equal(wire[2].match(STEER)![1], '3');

    const stored = storedThinkResults(framework);
    assert.equal(stored.length, 3);
    assert.match(stored[2], STEER, 'the stored history carries the same steer');
    assert.deepEqual(stored, wire, 'window and wire byte-match for every round');

    // The soft cap only steers: the turn continues and the reply is delivered.
    assert.deepEqual(routed, ['Here is my answer.']);
    assert.deepEqual(turnEnded, [], 'the soft cap does not end the turn');

    await framework.stop();
  });

  it('the hard cap ends the turn at the 8th consecutive think-only round', async () => {
    for (let i = 1; i <= 9; i++) membrane.pushResponse(createMockResponse(thinkRound(i), 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'never reached' }] as ContentBlock[]));

    const { framework, routed, turnEnded } = await createFramework();
    trigger(framework);
    await framework.runUntilIdle();

    const wire = membrane.lastStream!.receivedToolResults.map(wireText);
    // Rounds 1..7 resumed the stream; the 8th tripped the hard cap, so its
    // results were stored but never submitted and the stream was cancelled.
    assert.equal(wire.length, 7, 'the stream was not resumed after the 8th think round');
    assert.deepEqual(
      wire.map((w) => w.match(STEER)?.[1] ?? null),
      [null, null, '3', '4', '5', '6', '7'],
      'every round from the soft cap up to the hard cap carries the steer with its count',
    );
    assert.deepEqual(turnEnded, ['agent'], 'the hard cap ended the turn');
    assert.deepEqual(routed, [], 'nothing past the hard cap was generated or delivered');

    const stored = storedThinkResults(framework);
    assert.equal(stored.length, 8, 'all eight think results are in history');
    assert.deepEqual(stored.slice(0, 7), wire, 'window and wire byte-match for the submitted rounds');

    await framework.stop();
  });

  it('a non-think round resets the count', async () => {
    membrane.pushResponse(createMockResponse(thinkRound(1), 'tool_use'));
    membrane.pushResponse(createMockResponse(thinkRound(2), 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse(thinkRound(3), 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]));

    const { framework, routed } = await createFramework();
    trigger(framework);
    await framework.runUntilIdle();

    const wire = membrane.lastStream!.receivedToolResults.map(wireText);
    assert.equal(wire.length, 4);
    assert.ok(wire.every((w) => !STEER.test(w)), 'think #3 overall is only the 1st since the ping: no steer');
    assert.deepEqual(routed, ['done']);

    await framework.stop();
  });
});
