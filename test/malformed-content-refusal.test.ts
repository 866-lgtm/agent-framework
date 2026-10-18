/**
 * MCPL content that context-manager won't store is refused where it would
 * be stored or queued. context-manager refuses a write whose content
 * doesn't match ContentBlock (MalformedContentError, its #185), and
 * malformedContentPlaces names where without throwing. The push and channel
 * lanes ask it first, so such a message stores no row, queues no wake and
 * never reaches the deferred queue, and their log line names where it came
 * from. Content the store mends, a tool_use whose input isn't an object, is
 * stored as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { logValue } from '../src/mcpl/log-value.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TS = '2026-10-18T00:00:00.000Z';

/** Content the store refuses, each with a phrase of the place it names. */
const MALFORMED: Array<[string, unknown[], string]> = [
  ['a block that is a string', ['hello'], 'content[0]'],
  ['a text block whose text is a number', [{ type: 'text', text: 'hi' }, { type: 'text', text: 5 }], 'content[1]'],
  ['an image whose source is a string', [{ type: 'image', source: 'data' }], 'content[0]'],
];

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'malformed-content-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules: [],
  });
  const added: string[] = [];
  const refused: Array<Record<string, unknown>> = [];
  let starts = 0;
  framework.onTrace((e: any) => {
    if (e.type === 'message:added') added.push(e.source);
    if (e.type === 'mcpl:malformed-content-refused') refused.push(e);
    if (e.type === 'inference:started') starts++;
  });
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  return {
    framework, membrane, added, refused, errors, starts: () => starts,
    close: async () => {
      console.error = error;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [label, content, place] of MALFORMED) {
  test(`push: ${label} is refused, storing no row and queueing no wake, and the line names the server and channel`, async (t) => {
    const x = await harness(); t.after(x.close);
    x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
    const placement = (x.framework as any).handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: 'e1',
      content, timestamp: TS, inferenceId: 'i', triggerInference: true,
      origin: { mcplChannelId: 'discord:g:c' },
    });
    await x.framework.runUntilIdle();
    assert.equal(placement, undefined, 'nothing was placed');
    assert.deepEqual(x.added, [], 'no row');
    assert.equal(x.starts(), 0, 'no wake');
    assert.equal(x.refused.length, 1);
    assert.equal(x.refused[0]!.lane, 'push');
    assert.equal(x.refused[0]!.serverId, 'module');
    assert.equal(x.refused[0]!.channelId, 'discord:g:c');
    assert.ok((x.refused[0]!.places as string[]).some((p) => p.includes(place)), JSON.stringify(x.refused[0]));
    const line = `[push-event-refused] server=module channel=${logValue('discord:g:c')} eventId=${logValue('e1')} reason=malformed-content: `;
    assert.ok(x.errors.some((e) => e.startsWith(line) && e.includes(place)), x.errors.join('\n'));
  });

  test(`channel: ${label} is refused, storing no row and queueing no wake, and the line names the server and channel`, async (t) => {
    const x = await harness(); t.after(x.close);
    x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
    const placement = await (x.framework as any).handleMcplChannelIncoming({
      type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:c', messageId: 'm1',
      author: { id: 'u', name: 'User' }, content, timestamp: TS, triggerInference: true,
    });
    await x.framework.runUntilIdle();
    assert.equal(placement, undefined, 'nothing was placed');
    assert.deepEqual(x.added, [], 'no row');
    assert.equal(x.starts(), 0, 'no wake');
    assert.deepEqual(x.refused.map((r) => [r.lane, r.serverId, r.channelId, r.messageId]), [['channel', 'discord', 'discord:g:c', 'm1']]);
    assert.ok((x.refused[0]!.places as string[]).some((p) => p.includes(place)), JSON.stringify(x.refused[0]));
    const line = `[channel-incoming-refused] server=discord channel=${logValue('discord:g:c')} messageId=${logValue('m1')} reason=malformed-content: `;
    assert.ok(x.errors.some((e) => e.startsWith(line) && e.includes(place)), x.errors.join('\n'));
  });
}

test('push: a tool_use whose input is not an object is mended by the store, so it is stored, not refused', async (t) => {
  const x = await harness(); t.after(x.close);
  x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'heard' }] as ContentBlock[]));
  (x.framework as any).handleMcplPushEvent({
    type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: 'e2',
    content: [{ type: 'text', text: 'a call' }, { type: 'tool_use', id: 't1', name: 'x', input: 'not an object' }],
    timestamp: TS, inferenceId: 'i', triggerInference: true,
  });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.refused, []);
  assert.equal(x.added.length, 1, 'stored');
  const stored = x.framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content).find((b) => b.type === 'tool_use') as { input?: unknown } | undefined;
  assert.deepEqual(stored?.input, {}, 'with its input mended to an object');
});
