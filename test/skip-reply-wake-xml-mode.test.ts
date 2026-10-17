/**
 * skip_reply's refused wake in XML tool mode: without an EventGate, a round
 * that calls skip_reply with wake_in_seconds is refused and the turn goes on.
 * That round's prose stays private, and the prose of every other round
 * reaches the channel, in order.
 *
 * In XML tool mode, tool-calls events carry no roundContent, so no round is
 * routed live: the turn's prose is delivered at its end, from the turn-end
 * response, which is membrane's own parse of the turn's text
 * (parseAccumulatedIntoBlocks, as its XML tool loop builds the final
 * response). The stream below builds its events as that loop does: each
 * round's roundPreamble is its own text, and with thinking on, each round
 * after the first starts inside a thinking block opened after the previous
 * round's results.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedRequest, NormalizedResponse, YieldingStream, StreamEvent } from '@animalabs/membrane';
import type { Module, ModuleContext, ProcessState, ProcessEvent, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

type Parsed = { blocks: unknown[]; toolCalls: unknown[]; toolResults: unknown[] };
const MEMBRANE = join(process.cwd(), 'node_modules/@animalabs/membrane');
const parse = async (text: string, startInsideBlock?: string): Promise<Parsed> =>
  ((await import(pathToFileURL(join(MEMBRANE, 'dist/utils/tool-parser.js')).href)) as { parseAccumulatedIntoBlocks(t: string, o?: unknown): Parsed })
    .parseAccumulatedIntoBlocks(text, startInsideBlock ? { startInsideBlock } : undefined);

type Round = { text: string; call: { id: string; name: string; input: Record<string, unknown> }; results: string };
const raw = (c: Round['call']) => `<function_calls><invoke name="${c.name}">${Object.entries(c.input).map(([k, v]) => `<parameter name="${k}">${String(v)}</parameter>`).join('')}</invoke></function_calls>`;
const echo = (id: string, text: string): Round => ({ text, call: { id, name: 'test--echo', input: { message: 'x' } }, results: '<function_results><result><stdout>{"echoed":"x"}</stdout></result></function_results>' });
const refusedWake = (id: string, text: string): Round => ({ text, call: { id, name: 'skip_reply', input: { reason: 'later', wake_in_seconds: 60 } }, results: '<function_results><error>refused</error></function_results>' });

class XmlStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private done = false;
  private waiting = false;
  private round = 0;
  private acc = '';
  private roundStart = 0;
  private pending: (() => void) | null = null;
  readonly received: unknown[][] = [];

  constructor(private rounds: Round[], private finalText: string, private thinking: boolean) { this.emitRound(); }

  private emitRound(): void {
    const r = this.rounds[this.round];
    if (!r) { void this.finish(); return; }
    const before = this.acc + r.text;
    this.events.push({
      type: 'tool-calls',
      calls: [{ id: r.call.id, name: r.call.name, input: r.call.input }],
      context: { rawText: raw(r.call), preamble: before, roundPreamble: before.slice(this.roundStart), depth: this.round, previousResults: [], accumulated: before + raw(r.call) },
    } as StreamEvent);
    this.acc = before + raw(r.call);
    this.waiting = true;
    this.wake();
  }

  private async finish(): Promise<void> {
    this.acc += this.finalText;
    const parsed = await parse(this.acc, this.thinking ? 'thinking' : undefined);
    this.events.push({ type: 'complete', response: {
      content: parsed.blocks, rawAssistantText: this.acc, toolCalls: parsed.toolCalls, toolResults: parsed.toolResults,
      stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, details: { raw: {} },
    } as unknown as NormalizedResponse } as StreamEvent);
    this.done = true;
    this.wake();
  }

  provideToolResults(results: unknown[]): void {
    if (!this.waiting) throw new Error('Not waiting for tools');
    this.received.push(results);
    this.waiting = false;
    this.acc += this.rounds[this.round]!.results + (this.thinking ? '\n<thinking>' : '');
    this.roundStart = this.acc.length;
    this.round++;
    this.emitRound();
  }

  cancel(): void { this.done = true; this.events.push({ type: 'aborted', reason: 'user' } as StreamEvent); this.wake(); }
  private wake(): void { if (this.pending) { const r = this.pending; this.pending = null; r(); } }
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds(): string[] { return this.waiting ? [this.rounds[this.round]!.call.id] : []; }
  get toolDepth() { return this.round; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') return;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.pending = resolve; });
    }
  }
}

class EchoModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'Echoes', inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'm' } }, required: ['message'] } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> { return { success: true, data: { echoed: (call.input as { message: string }).message } }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

/** One XML-mode turn with no EventGate: what reached the channel, and whether each round's result was an error. */
async function xmlTurn(rounds: Round[], finalText: string, thinking = false) {
  let stream: XmlStream | undefined;
  const membrane = {
    async complete(_r: NormalizedRequest): Promise<NormalizedResponse> { throw new Error('not used'); },
    streamYielding(_r: NormalizedRequest): YieldingStream {
      stream = new XmlStream(rounds, finalText, thinking);
      return stream;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'skip-wake-xml-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane as unknown as import('@animalabs/membrane').Membrane,
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [new EchoModule()],
  });
  const routed: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    getChannelTools: () => [], resolveLocus: () => 'channel:test',
    routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'channel:test' }; },
    handleChannelToolCall: async () => ({ success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } }),
  }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
  try {
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger: unknown): Promise<void> })
      .startAgentStream(agent, { agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    const errors = (stream?.received ?? []).map((r) => (r[0] as { isError?: boolean } | undefined)?.isError === true);
    return { routed, errors };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('skip_reply refused in XML tool mode: its round stays private, and every other round reaches the channel', () => {
  it('a refused round, then a reply', async () => {
    const r = await xmlTurn([refusedWake('w1', 'REFUSED_PRIVATE')], '\nFINAL_REPLY');
    assert.deepEqual(r.errors, [true], 'the wake was refused and the turn went on');
    assert.deepEqual(r.routed, ['FINAL_REPLY']);
  });

  it('control: a module tool in the refused round\'s place, so both rounds reach the channel', async () => {
    const r = await xmlTurn([echo('e1', 'ROUND_ONE')], '\nFINAL_REPLY');
    assert.deepEqual(r.errors, [false]);
    assert.deepEqual(r.routed, ['ROUND_ONE', 'FINAL_REPLY']);
  });

  it('with thinking on, where each round after the first starts inside a thinking block', async () => {
    const r = await xmlTurn([
      echo('e1', 'plan one</thinking>\nPUBLIC_ONE'),
      refusedWake('w1', 'plan two</thinking>\nREFUSED_PRIVATE'),
    ], 'plan three</thinking>\nFINAL_REPLY', true);
    assert.deepEqual(r.errors, [false, true]);
    assert.deepEqual(r.routed, ['PUBLIC_ONE', 'FINAL_REPLY']);
  });

  it('when the refused round\'s text holds the model\'s own thinking markup', async () => {
    const r = await xmlTurn([refusedWake('w1', '<thinking>a plan</thinking>\nREFUSED_PRIVATE')], '\nFINAL_REPLY');
    assert.deepEqual(r.errors, [true]);
    assert.deepEqual(r.routed, ['FINAL_REPLY']);
  });

  it('when the refused round repeats an earlier round\'s prose, the earlier copy goes out in its place', async () => {
    const r = await xmlTurn([
      echo('e1', 'Checking now.'),
      echo('e2', 'MIDDLE_PUBLIC'),
      refusedWake('w1', 'Checking now.'),
    ], '\nFINAL_REPLY');
    assert.deepEqual(r.errors, [false, false, true]);
    assert.deepEqual(r.routed, ['Checking now.', 'MIDDLE_PUBLIC', 'FINAL_REPLY']);
  });

  it('after a round with no prose, the refused round is still the one kept private', async () => {
    const r = await xmlTurn([echo('e1', ''), refusedWake('w1', 'REFUSED_PRIVATE')], '\nTHIRD');
    assert.deepEqual(r.errors, [false, true]);
    assert.deepEqual(r.routed, ['THIRD']);
  });

  it('after a round with no prose between two others, the refused round is still the one kept private', async () => {
    const r = await xmlTurn([echo('e1', 'ONE'), echo('e2', ''), refusedWake('w1', 'REFUSED_PRIVATE')], '\nTHIRD');
    assert.deepEqual(r.errors, [false, false, true]);
    assert.deepEqual(r.routed, ['ONE', 'THIRD']);
  });

  it('a refused round with no prose keeps the next round\'s prose', async () => {
    const r = await xmlTurn([echo('e1', 'ONE'), refusedWake('w1', ''), echo('e2', 'TWO')], '\nTHIRD');
    assert.deepEqual(r.errors, [false, true, false]);
    assert.deepEqual(r.routed, ['ONE', 'TWO', 'THIRD']);
  });
});
