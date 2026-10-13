/**
 * Over-budget restart: per provider call, cache-inclusive.
 *
 * Membrane's `usage` stream events are RUNNING TOTALS across the tool loop,
 * and report input cache-EXCLUDED (fresh input; cached prompt tokens ride in
 * cacheReadTokens). The budget restart must compare the CURRENT call's real
 * prompt — fresh + cache write + cache read of the most recent call — with
 * maxStreamTokens:
 *  - fresh input alone is a few percent of a warm prompt, so a cache-heavy
 *    stream never tripped the guard and mid-turn growth was unbounded;
 *  - the running total sums every earlier round, so round 2 tripped on
 *    roughly twice its real size.
 *
 * Usage below is scripted the way membrane emits it: each event is the
 * cumulative total of the stream so far.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** One explicit response queue per streamYielding call, so a restart is
 *  visible as a second stream. */
class QueuedStreamsMembrane extends MockMembrane {
  constructor(private queues: NormalizedResponse[][]) {
    super();
  }
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.queues.shift() ?? []);
    this.lastStream = stream;
    return stream;
  }
}

interface Sample { input: number; real: number; output: number }

/** Records the agent's last-call counters at each tool dispatch — i.e.
 *  right after the usage event of the round that asked for the tool. */
class ProbeModule implements Module {
  readonly name = 'probe';
  samples: Sample[] = [];
  constructor(private readFramework: () => AgentFramework | undefined) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'look', description: 'look', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    const agent = this.readFramework()?.getAgent('prime');
    if (agent) {
      this.samples.push({
        input: agent.lastStreamInputTokens,
        real: agent.lastStreamRealInputTokens,
        output: agent.lastStreamOutputTokens,
      });
    }
    return { success: true, data: { seen: 'ok' } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

let callSeq = 0;

/** A tool round whose usage event carries the given CUMULATIVE totals. */
function toolRound(cumulative: { input: number; cacheRead: number; cacheWrite?: number; output: number }): NormalizedResponse {
  const r = createMockResponse([
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: `call_${++callSeq}`, name: 'probe--look', input: {} },
  ], 'tool_use');
  (r as { usage: unknown }).usage = {
    inputTokens: cumulative.input,
    outputTokens: cumulative.output,
    cacheReadTokens: cumulative.cacheRead,
    cacheCreationTokens: cumulative.cacheWrite ?? 0,
  };
  return r;
}

function finalRound(text: string): NormalizedResponse {
  const r = createMockResponse([{ type: 'text', text }]);
  (r as { usage: unknown }).usage = undefined;
  return r;
}

async function pollUntil(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function storedTexts(framework: AgentFramework): string {
  const cm = framework.getAgent('prime')?.getContextManager();
  const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; text?: string }>;
  }>;
  return msgs
    .flatMap((m) => m.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function runTurn(
  queues: NormalizedResponse[][],
  agentExtra: Record<string, unknown>,
  expectText: string,
): Promise<{ membrane: QueuedStreamsMembrane; traces: TraceEvent[]; samples: Sample[] }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'stream-budget-'));
  const membrane = new QueuedStreamsMembrane(queues);
  let framework: AgentFramework | undefined;
  const probe = new ProbeModule(() => framework);
  framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      maxTokens: 4_000,
      ...agentExtra,
    }],
    modules: [probe],
    syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  framework.start();
  try {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'look around' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
    const fw = framework;
    const done = await pollUntil(() => storedTexts(fw).includes(expectText));
    assert.ok(done, `turn should complete with "${expectText}"`);
    return { membrane, traces, samples: probe.samples };
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type Restart = { type: string; reason?: string; inputTokens?: number; budget?: number };
const restartsOf = (traces: TraceEvent[]): Restart[] =>
  traces.filter((e) => e.type === 'inference:stream_restarted') as unknown as Restart[];

describe('over-budget restart compares the current call\'s real prompt', () => {
  it('records the last call\'s counters per call, not as the stream\'s running total', async () => {
    // Round 1: 200 fresh + 2000 cached = 2200 real. Round 2: 200 fresh +
    // 2200 cached = 2400 real; the running totals read 400 + 4200 = 4600.
    const { samples } = await runTurn([[
      toolRound({ input: 200, cacheRead: 2_000, output: 30 }),
      toolRound({ input: 400, cacheRead: 4_200, output: 70 }),
      finalRound('Seen enough.'),
    ]], {}, 'Seen enough.');
    assert.deepStrictEqual(samples, [
      { input: 200, real: 2_200, output: 30 },
      { input: 200, real: 2_400, output: 40 },
    ]);
  });

  it('does not fire on cache-heavy rounds below the cap, however long the turn runs', async () => {
    // Each call is ~100k real against a 150k cap; the running real total
    // passes 150k on round 2 and 300k by round 3. A declared 200k physical
    // window must not trip either: the projection starts from the prior
    // CALL's prompt, not the stream total.
    const { membrane, traces, samples } = await runTurn([[
      toolRound({ input: 2_000, cacheRead: 98_000, output: 50 }),
      toolRound({ input: 4_000, cacheRead: 198_000, output: 100 }),
      toolRound({ input: 6_000, cacheRead: 300_000, output: 150 }),
      finalRound('Long turn, under budget.'),
    ]], { maxStreamTokens: 150_000, physicalWindowTokens: 200_000 }, 'Long turn, under budget.');
    assert.deepStrictEqual(restartsOf(traces), [], 'no restart below the cap');
    assert.strictEqual(membrane.calls.length, 1, 'the turn stays on its first stream');
    assert.deepStrictEqual(samples.map((s) => s.real), [100_000, 102_000, 104_000]);
  });

  it('fires when a cache-heavy round\'s real prompt crosses the cap, though its fresh input is small', async () => {
    // Round 1: 100k real. Round 2: 3k fresh + 150k cached + 2k cache write
    // = 155k real > 150k. Fresh input alone (3k, or 5k as a running total)
    // is far under the cap — the cache-excluded comparison never fired.
    const { membrane, traces } = await runTurn([
      [
        toolRound({ input: 2_000, cacheRead: 98_000, output: 50 }),
        toolRound({ input: 5_000, cacheRead: 248_000, cacheWrite: 2_000, output: 100 }),
        finalRound('never reached on this stream'),
      ],
      [finalRound('Recovered after the restart.')],
    ], { maxStreamTokens: 150_000 }, 'Recovered after the restart.');
    const restarts = restartsOf(traces);
    assert.strictEqual(restarts.length, 1, 'exactly one restart');
    assert.strictEqual(restarts[0]!.reason, 'context_budget');
    assert.strictEqual(restarts[0]!.inputTokens, 155_000, 'the trace carries the call\'s real prompt');
    assert.strictEqual(restarts[0]!.budget, 150_000);
    assert.strictEqual(membrane.calls.length, 2, 'the restart opens a fresh stream');
  });

  it('fires on the first round when that call alone is over the cap', async () => {
    const { membrane, traces } = await runTurn([
      [toolRound({ input: 3_000, cacheRead: 160_000, output: 20 }), finalRound('never reached')],
      [finalRound('Recovered from round one.')],
    ], { maxStreamTokens: 150_000 }, 'Recovered from round one.');
    const restarts = restartsOf(traces);
    assert.strictEqual(restarts.length, 1);
    assert.strictEqual(restarts[0]!.reason, 'context_budget');
    assert.strictEqual(restarts[0]!.inputTokens, 163_000);
    assert.strictEqual(membrane.calls.length, 2);
  });
});
