/**
 * Content context-manager won't store is refused where the framework writes
 * it, whether the write would be stored at once or deferred while a turn
 * runs, as the store's own write and edit refuse it: a module's write, an
 * edit of a write still held for the turn's end, and a process response's
 * messages throw context-manager's MalformedContentError. Before, a deferred
 * write was refused only at a later flush, where the writer never heard of
 * it, and a held write's edit could replace valid content with content the
 * drain then dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { MalformedContentError } from '@animalabs/context-manager';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];
/** A text block whose text isn't a string, which the store refuses. */
const MALFORMED = [{ type: 'text', text: 5 }] as unknown as ContentBlock[];

/** A module with one tool, `act`, that runs `during` while the turn waits
 *  for it, and that answers a `ping` with `onPing`'s response. */
class Writer implements Module {
  readonly name: string;
  ctx!: ModuleContext;
  during: (() => void) | null = null;
  onPing: EventResponse = {};
  constructor(name = 'writer') { this.name = name; }
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    during?.();
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') return { addMessages: [{ participant: 'Antra', content: text('go') }], requestInference: true };
    if ((event as { type: string }).type === 'ping') return this.onPing;
    return {};
  }
}

async function harness(modules: Writer[]) {
  const dir = mkdtempSync(join(tmpdir(), 'malformed-writes-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules,
  });
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const window = () => framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .map((m) => `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
  const queued = () => (framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length;
  return {
    framework, membrane, errors, window, queued,
    close: async () => {
      console.error = error;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A turn that calls `writer--act` once, then answers. */
function scriptTurn(membrane: MockMembrane): void {
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Acting.' },
    { type: 'tool_use', id: 'c1', name: 'writer--act', input: {} },
  ] as ContentBlock[], 'tool_use'));
  membrane.pushResponse(createMockResponse(text('Done.')));
}

function catchFrom(f: () => unknown): unknown {
  try { f(); } catch (error) { return error; }
  return undefined;
}

test("a module's malformed write throws while a turn runs, as it does while the agent is idle, and nothing is queued", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  scriptTurn(x.membrane);
  let duringTurn: unknown;
  let queuedThen = -1;
  writer.during = () => {
    duringTurn = catchFrom(() => writer.ctx.addMessage('Antra', MALFORMED));
    queuedThen = x.queued();
    writer.ctx.addMessage('Antra', text('look right'));
  };
  x.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.ok(duringTurn instanceof MalformedContentError, String(duringTurn));
  assert.match((duringTurn as Error).message, /^Message refused: content\[0\]/);
  assert.equal(queuedThen, 0, 'the refused write was never queued');
  assert.ok(x.window().includes('Antra: look right'), 'the next write landed');
  const idle = catchFrom(() => writer.ctx.addMessage('Antra', MALFORMED));
  assert.ok(idle instanceof MalformedContentError, String(idle));
  assert.equal((idle as Error).message, (duringTurn as Error).message, 'the same refusal either way');
});

test("an edit of a held write to malformed content throws and leaves the write as it was, which lands", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  scriptTurn(x.membrane);
  const edits: unknown[] = [];
  writer.during = () => {
    const held = writer.ctx.addMessage('Antra', text('original'));
    edits.push(catchFrom(() => writer.ctx.editMessage(held, MALFORMED)));
    edits.push(catchFrom(() => writer.ctx.editMessage(held, [null] as unknown as ContentBlock[])));
  };
  x.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.equal(edits.length, 2);
  for (const edit of edits) {
    assert.ok(edit instanceof MalformedContentError, String(edit));
    assert.match((edit as Error).message, /^Edit of .* refused: content\[0\]/);
  }
  const window = x.window();
  assert.ok(window.includes('Antra: original'), `the held write landed as it was:\n${window.join('\n')}`);
  assert.equal(window.at(-1), 'assistant: Done.', 'and the turn went on past its tool boundary');
});

test("a process response with a malformed message is refused whole, queueing no inference, and other modules' responses still apply", async (t) => {
  const bad = new Writer('bad');
  const good = new Writer('good');
  bad.onPing = { addMessages: [{ participant: 'Antra', content: text('first') }, { participant: 'Antra', content: MALFORMED }], requestInference: true };
  good.onPing = { addMessages: [{ participant: 'Good', content: text('from good') }] };
  const x = await harness([bad, good]); t.after(x.close);
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  const window = x.window();
  assert.ok(!window.includes('Antra: first'), `none of the refused response's messages was added:\n${window.join('\n')}`);
  assert.ok(window.includes('Good: from good'), 'the other module\'s response was applied');
  assert.equal(x.membrane.calls.length, 0, 'no inference ran');
  assert.ok(x.errors.some((e) => e.startsWith('[process-response-refused] module=bad event=ping reason=malformed-content: ') && e.includes('addMessages[1]')), x.errors.join('\n'));
});
