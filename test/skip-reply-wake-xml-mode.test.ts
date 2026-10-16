/**
 * Review probe for agent-framework #198 at 653fdd25 (not part of the PR).
 *
 * XML tool mode: tool-calls events carry no roundContent, so no round is
 * live-routed, and the turn-end response is membrane's own parse of the
 * whole turn's accumulated text (parseAccumulatedIntoBlocks, the parse its
 * buildFinalResponse runs in XML mode). Without an EventGate, a round of
 * text and skip_reply(wake_in_seconds: 60) is refused, and the turn goes on
 * to a round of plain text. The probe records what reaches the channel.
 *
 * Control: the same turn with a module tool in place of skip_reply, so the
 * harness's turn-end routing is seen to deliver in XML mode.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedRequest, NormalizedResponse, YieldingStream, StreamEvent } from '@animalabs/membrane';
import type { Module, ModuleContext, ProcessState, ProcessEvent, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

type Parsed = { blocks: unknown[]; toolCalls: unknown[]; toolResults: unknown[] };
const MEMBRANE = join(process.cwd(), 'node_modules/@animalabs/membrane');
const membraneVersion = (JSON.parse(readFileSync(join(MEMBRANE, 'package.json'), 'utf8')) as { version: string }).version;
const parseAccumulated = async (text: string): Promise<Parsed> =>
  ((await import(pathToFileURL(join(MEMBRANE, 'dist/utils/tool-parser.js')).href)) as { parseAccumulatedIntoBlocks(t: string): Parsed })
    .parseAccumulatedIntoBlocks(text);

const R1 = 'ROUND_ONE_TEXT the build is running';
const FINAL = 'NEXT_ROUND_REPLY here is the answer';

class XmlStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private _done = false;
  private _waiting = false;
  private _round = 0;
  private pending: (() => void) | null = null;
  readonly received: unknown[][] = [];

  constructor(private call: { id: string; name: string; input: Record<string, unknown>; raw: string }, private finalResponse: NormalizedResponse) {
    this._waiting = true;
    this.events.push({
      type: 'tool-calls',
      calls: [{ id: call.id, name: call.name, input: call.input }],
      context: { rawText: call.raw, preamble: R1 + '\n', depth: 0, previousResults: [], accumulated: R1 + '\n' + call.raw },
    } as StreamEvent);
  }

  provideToolResults(results: unknown[]): void {
    if (!this._waiting) throw new Error('Not waiting for tools');
    this.received.push(results);
    this._waiting = false;
    this._round++;
    this.events.push({ type: 'complete', response: this.finalResponse } as StreamEvent);
    this._done = true;
    if (this.pending) { const r = this.pending; this.pending = null; r(); }
  }

  cancel(): void {
    this._done = true;
    this.events.push({ type: 'aborted', reason: 'user' } as StreamEvent);
    if (this.pending) { const r = this.pending; this.pending = null; r(); }
  }

  get isWaitingForTools() { return this._waiting; }
  get pendingToolCallIds(): string[] { return this._waiting ? [this.call.id] : []; }
  get toolDepth() { return this._round; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') return;
      }
      if (this._done) return;
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

async function xmlTurn(call: { id: string; name: string; input: Record<string, unknown>; raw: string }, results: string) {
  const accumulated = `${R1}\n${call.raw}\n${results}\n${FINAL}`;
  const parsed = await parseAccumulated(accumulated);
  const finalResponse = {
    content: parsed.blocks, rawAssistantText: accumulated, toolCalls: parsed.toolCalls, toolResults: parsed.toolResults,
    stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, details: { raw: {} },
  } as unknown as NormalizedResponse;
  let stream: XmlStream | undefined;
  const membrane = {
    async complete(_r: NormalizedRequest): Promise<NormalizedResponse> { throw new Error('not used'); },
    streamYielding(_r: NormalizedRequest): YieldingStream { stream = new XmlStream(call, finalResponse); return stream; },
  };
  const dir = mkdtempSync(join(tmpdir(), 'probe-198-xml-'));
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
    const toolUseNames = (parsed.blocks as Array<{ type: string; name?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.name);
    return { routed, results: stream?.received ?? [], toolUseNames };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#198 probe: XML tool mode', () => {
  it('a refused wake keeps its round private and routes the next round', async () => {
    const r = await xmlTurn({
      id: 'wake-1', name: 'skip_reply', input: { reason: 'later', wake_in_seconds: 60 },
      raw: '<function_calls><invoke name="skip_reply"><parameter name="reason">later</parameter><parameter name="wake_in_seconds">60</parameter></invoke></function_calls>',
    }, '<function_results><error>Your turn did not end, and no wake was set.</error></function_results>');
    console.log(`[probe-198-xml] membrane ${membraneVersion}; refused wake: tool_use blocks in the turn-end response ${JSON.stringify(r.toolUseNames)}; results ${JSON.stringify(r.results)}; routed ${JSON.stringify(r.routed)}`);
    assert.equal((r.results[0]?.[0] as { isError?: boolean } | undefined)?.isError, true, 'the wake was refused and the turn went on');
    assert.deepEqual(r.routed, [FINAL], 'the refused round stays private while the later round routes');
  });

  it('control: a module tool in place of skip_reply', async () => {
    const r = await xmlTurn({
      id: 'echo-1', name: 'test--echo', input: { message: 'x' },
      raw: '<function_calls><invoke name="test--echo"><parameter name="message">x</parameter></invoke></function_calls>',
    }, '<function_results><result><stdout>{"echoed":"x"}</stdout></result></function_results>');
    console.log(`[probe-198-xml] membrane ${membraneVersion}; control: tool_use blocks ${JSON.stringify(r.toolUseNames)}; routed ${JSON.stringify(r.routed)}`);
    assert.ok(r.routed.some((t) => t.includes('NEXT_ROUND_REPLY')), 'the harness routes a tool turn\'s prose at turn end in XML mode');
  });
});
