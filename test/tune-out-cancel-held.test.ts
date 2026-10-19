/**
 * What a tune-out's cancel makes of the messages still held when it ends.
 * The dump and the subconscious's report notice take the ended epoch's
 * messages only. The notice carries, each with its own content, the held
 * ones the cap leaves out of the dump and the held ones the dump shows whose
 * media its text lines drop, since the subconscious's view holds stored
 * messages only. A cancel the subconscious makes itself gets that notice and
 * a report turn only when some held message goes to it.
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
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source, 'test'), { ok: true });
  const dump = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(dump, 'the cancel adds its dump');
  return { dump: textOf(dump.content), notice: added.find((m) => m.metadata?.kind === 'tune-out-cancel-report'), inferences };
}

const OTHERS = {
  stored: [row('Bo', [text('B1 stored')], 'eB'), row('Cy', [text('P plain')])],
  held: [row('Bo', [text('B2 held')], 'eB')],
};

test("a cancel's dump shows only its own epoch's messages, and its notice tells the report of nothing more when the dump shows them all", () => {
  const { dump, notice, inferences } = cancelWith({
    backlogCap: 10,
    source: 'agent-tool',
    stored: [row('Ann', [text('A1 stored')], 'eA'), ...OTHERS.stored],
    held: [row('Ann', [text('A2 held')], 'eA'), ...OTHERS.held],
  });
  assert.ok(dump.includes('messages=2') && !dump.includes('truncated='), "the backlog is epoch eA's two messages, both shown");
  assert.ok(dump.includes('Ann: A1 stored') && dump.includes('Ann: A2 held'), 'the dump shows them');
  for (const other of ['B1 stored', 'P plain', 'B2 held']) assert.ok(!dump.includes(other), `and no "${other}"`);
  assert.ok(notice, 'the report gets its notice');
  assert.ok(!textOf(notice.content).includes('above the cap'), 'with no count above the cap, as none is');
  assert.ok(!textOf(notice.content).includes('Still held'), 'and no held message, as the dump shows them all');
  assert.ok(inferences.includes('Subconscious'), 'and a report turn is requested');
});

test('the notice carries the held messages the cap leaves out, each under its author with its content, and the count above the cap', () => {
  const { dump, notice } = cancelWith({
    backlogCap: 0,
    source: 'agent-tool',
    stored: [row('Ann', [text('A1 stored')], 'eA'), ...OTHERS.stored],
    held: [row('Ann', [IMAGE], 'eA'), row('Bo', [text('A3 held')], 'eA'), ...OTHERS.held],
  });
  assert.ok(dump.includes('messages=3 truncated=3'), "the backlog is epoch eA's three messages, all above the cap");
  assert.ok(notice, 'the report gets its notice');
  assert.equal(notice.forAgent, 'Subconscious');
  const noticeText = textOf(notice.content);
  assert.ok(noticeText.includes('3 of 3 diverted messages were above the cap and not delivered raw to the resident'), 'it gives the count');
  const author = notice.content.findIndex((b) => b.type === 'text' && (b as { text: string }).text === 'Ann:');
  const image = notice.content.findIndex((b) => b === IMAGE);
  const next = notice.content.findIndex((b) => b.type === 'text' && (b as { text: string }).text === 'Bo:');
  assert.ok(author !== -1 && image === author + 1, 'the held image comes as it came, right under its author');
  assert.ok(next > image && noticeText.includes('A3 held'), 'and the next held message after it');
  assert.ok(!noticeText.includes('B2 held'), "another epoch's held message stays out");
  assert.ok(!noticeText.includes('A1 stored'), 'and a stored one, which its view has');
});

test("a held image the dump shows goes to the report too, as the dump's text lines drop it", () => {
  const { dump, notice } = cancelWith({ backlogCap: 10, source: 'agent-tool', stored: [], held: [row('Ann', [text('look:'), IMAGE], 'eA')] });
  assert.ok(dump.includes('Ann: look:'), "the dump shows the message's text");
  assert.ok(notice, 'the report gets its notice');
  assert.ok(notice.content.includes(IMAGE), 'with the image the dump drops');
});

test('a cancel the subconscious makes itself gets the notice and a report turn only when a held message goes to it', () => {
  const leftOut = cancelWith({ backlogCap: 0, source: 'subconscious', stored: [], held: [row('Ann', [text('A2 held')], 'eA')] });
  assert.ok(leftOut.notice, 'a held message left out brings the notice');
  assert.ok(textOf(leftOut.notice.content).includes('A2 held'), 'with the held message');
  assert.ok(textOf(leftOut.notice.content).includes('1 of 1 diverted messages were above the cap'), 'and the count, since its note is optional');
  assert.ok(leftOut.inferences.includes('Subconscious'), 'and a report turn');

  const mediaShown = cancelWith({ backlogCap: 10, source: 'subconscious', stored: [], held: [row('Ann', [text('look:'), IMAGE], 'eA')] });
  assert.ok(mediaShown.notice, 'a held image the dump shows brings the notice too');
  assert.ok(mediaShown.notice.content.includes(IMAGE), 'with the image');
  assert.ok(mediaShown.inferences.includes('Subconscious'), 'and a report turn');

  const allShown = cancelWith({ backlogCap: 10, source: 'subconscious', stored: [], held: [row('Ann', [text('A2 held')], 'eA')] });
  assert.ok(allShown.dump.includes('A2 held'), 'the dump shows the held message');
  assert.equal(allShown.notice, undefined, 'so the subconscious gets no notice');
  assert.ok(!allShown.inferences.includes('Subconscious'), 'and no report turn');

  const storedCut = cancelWith({
    backlogCap: 1,
    source: 'subconscious',
    stored: [row('Ann', [text('S1 stored')], 'eA'), row('Ann', [text('S2 stored')], 'eA')],
    held: [],
  });
  assert.ok(storedCut.dump.includes('truncated=1'), 'the cap cuts a stored message');
  assert.equal(storedCut.notice, undefined, 'which its view has, so no notice');
  assert.ok(!storedCut.inferences.includes('Subconscious'), 'and no report turn');
});
