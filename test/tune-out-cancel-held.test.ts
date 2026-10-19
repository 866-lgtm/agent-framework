/**
 * What a tune-out's cancel makes of the messages still held when it ends.
 * The dump and the subconscious's report notice take the ended epoch's
 * messages only. The notice carries the held ones the cap leaves out of the
 * dump, each with its own content, since the subconscious's view holds stored
 * messages only. A cancel the subconscious makes itself gets that notice and
 * a report turn only when it leaves held messages out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }
interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const IMAGE = { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', mediaType: 'image/png' } } as ContentBlock;
const row = (author: string, content: ContentBlock[], epochId?: string): Row =>
  ({ participant: 'user', content, metadata: { author: { name: author }, ...(epochId ? { tuneOut: { epochId } } : {}) } });
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

/** Cancels epoch eA of disc:guild:a with the given cap and source, over the
 *  given stored and held messages, and returns what the coordinator added
 *  and whose inference it requested. */
function cancelWith(opts: { backlogCap: number; source: string; stored: Row[]; held: Row[] }) {
  const added: Added[] = [];
  const inferences: string[] = [];
  const registry = {
    cancelTuneOut: () => ({
      params: { epochId: 'eA', cadenceSeconds: 300, backlogCap: opts.backlogCap, maxWakes: 3, startedAtSequence: 0 },
      wakeCount: 0,
    }),
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      added.push({ participant, content, metadata, forAgent });
    },
    requestInference: (agentName: string) => { inferences.push(agentName); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => opts.stored,
    getDeferredMessages: () => opts.held,
    emitTrace: () => {},
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  const note = opts.source === 'subconscious' ? 'My note on the channel.' : undefined;
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source, 'test', note), { ok: true });
  const dump = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(dump, 'the cancel adds its dump');
  return { dump: textOf(dump.content), notice: added.find((m) => m.metadata?.kind === 'tune-out-cancel-report'), inferences };
}

test("a cancel takes only its own epoch's messages, and hands the report the held ones the cap leaves out with their content", () => {
  const { dump, notice, inferences } = cancelWith({
    backlogCap: 0,
    source: 'agent-tool',
    stored: [row('Ann', [text('A1 stored')], 'eA'), row('Bo', [text('B1 stored')], 'eB'), row('Cy', [text('P plain')])],
    held: [row('Ann', [IMAGE], 'eA'), row('Bo', [text('B2 held')], 'eB')],
  });
  assert.ok(dump.includes('messages=2 truncated=2'), "the backlog is epoch eA's stored message and its held one");
  for (const other of ['A1 stored', 'B1 stored', 'P plain', 'B2 held']) assert.ok(!dump.includes(other), `the dump shows no "${other}"`);
  assert.ok(notice, 'the report gets its notice');
  assert.equal(notice.forAgent, 'Subconscious');
  assert.ok(notice.content.some((b) => b === IMAGE), "the held image goes to the report as it came");
  assert.ok(textOf(notice.content).includes('Ann:'), 'under its author');
  assert.ok(!textOf(notice.content).includes('B2 held'), "another epoch's held message stays out");
  assert.ok(!textOf(notice.content).includes('A1 stored'), 'and a stored one, which its view has');
  assert.ok(inferences.includes('Subconscious'), 'and a report turn is requested');
});

test('a cancel the subconscious makes itself gets the notice and a report turn only when it leaves held messages out', () => {
  const leftOut = cancelWith({ backlogCap: 0, source: 'subconscious', stored: [], held: [row('Ann', [text('A2 held')], 'eA')] });
  assert.ok(leftOut.notice, 'a held message left out brings the notice');
  assert.ok(textOf(leftOut.notice.content).includes('A2 held'), 'with the held message');
  assert.ok(!textOf(leftOut.notice.content).includes('above the cap'), 'and nothing of what its own note covered');
  assert.ok(leftOut.inferences.includes('Subconscious'), 'and a report turn');

  const allShown = cancelWith({ backlogCap: 10, source: 'subconscious', stored: [], held: [row('Ann', [text('A2 held')], 'eA')] });
  assert.ok(allShown.dump.includes('A2 held'), 'the dump shows the held message');
  assert.equal(allShown.notice, undefined, 'so the subconscious gets no notice');
  assert.ok(!allShown.inferences.includes('Subconscious'), 'and no report turn');
});
