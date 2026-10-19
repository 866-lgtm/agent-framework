/**
 * What a tune-out's cancel makes of the messages still held when it ends.
 * The dump and the subconscious's report notice take the ended epoch's
 * messages only. The notice carries, each with its own content, the held
 * ones the cap leaves out of the dump and the held ones the dump shows whose
 * media its text lines drop, since the subconscious's view holds stored
 * messages only. A cancel the subconscious makes itself gets that notice and
 * a report turn when some held message goes to it, or when it wrote no note
 * and the cap cut anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }
interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const IMAGE = { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', mediaType: 'image/png' } } as ContentBlock;
const URL_IMAGE = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } } as ContentBlock;
const AUDIO = { type: 'audio', source: { type: 'base64', data: 'T2dnUw==', mediaType: 'audio/ogg' } } as ContentBlock;
const STILL_HELD = text('Still held at the cancel, so your view may not have them yet:');
const row = (author: string, content: ContentBlock[], epochId?: string): Row =>
  ({ participant: 'user', content, metadata: { author: { name: author }, ...(epochId ? { tuneOut: { epochId } } : {}) } });
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

/** Cancels epoch eA of disc:guild:a with the given cap and source, over the
 *  given stored and held messages, and returns what the coordinator added
 *  and whose inference it requested. */
function cancelWith(opts: { backlogCap: number; source: string; stored: Row[]; held: Row[]; note?: string }) {
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
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source, 'test', opts.note), { ok: true });
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
  assert.deepEqual(notice.content.slice(1), [STILL_HELD, text('Ann:'), IMAGE, text('Bo:'), text('A3 held')],
    'each held message once, oldest first, right under its author, the held image as it came');
  assert.equal(notice.content[3], IMAGE, 'the very block that came');
  assert.ok(!noticeText.includes('B2 held'), "another epoch's held message stays out");
  assert.ok(!noticeText.includes('A1 stored'), 'and a stored one, which its view has');
});

test("a held image the dump shows goes to the report too, as the dump's text lines drop it", () => {
  const { dump, notice } = cancelWith({ backlogCap: 10, source: 'agent-tool', stored: [], held: [row('Ann', [text('look:'), IMAGE], 'eA')] });
  assert.ok(dump.includes('Ann: look:'), "the dump shows the message's text");
  assert.ok(notice, 'the report gets its notice');
  assert.ok(notice.content.includes(IMAGE), 'with the image the dump drops');
});

test('with media on both sides of the cut, the notice carries each held message it should once, in order, with its blocks as they came', () => {
  // The cap of 2 shows Bo's URL image and Cy's audio, each a media-only
  // message the dump's text lines render empty, and leaves Ann's out.
  const { dump, notice } = cancelWith({
    backlogCap: 2,
    source: 'agent-tool',
    stored: [],
    held: [row('Ann', [text('A1 look:'), IMAGE], 'eA'), row('Bo', [URL_IMAGE], 'eA'), row('Cy', [AUDIO], 'eA')],
  });
  assert.ok(dump.includes('messages=3 truncated=1'), 'the cap shows the newer two and cuts Ann');
  assert.ok(!dump.includes('A1 look:'), "the dump leaves Ann's message out");
  assert.ok(notice, 'the report gets its notice');
  assert.ok(textOf(notice.content).includes('1 of 3 diverted messages were above the cap'), 'with the count');
  assert.deepEqual(notice.content.slice(1), [
    STILL_HELD,
    text('Ann:'), text('A1 look:'), IMAGE,
    text('Bo:'), URL_IMAGE,
    text('Cy:'), AUDIO,
  ], "Ann's left out, then the media the dump shows, each once and oldest first");
  assert.equal(notice.content[4], IMAGE);
  assert.equal(notice.content[6], URL_IMAGE);
  assert.equal(notice.content[8], AUDIO);
});

test('a cancel the subconscious makes itself gets the notice and a report turn when a held message goes to it', () => {
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
});

test('a cancel the subconscious makes itself with no note gets the notice and a report turn when the cap cut stored messages', () => {
  const twoStored = [row('Ann', [text('S1 stored')], 'eA'), row('Ann', [text('S2 stored')], 'eA')];
  const storedCut = cancelWith({ backlogCap: 0, source: 'subconscious', stored: twoStored, held: [] });
  assert.ok(storedCut.dump.includes('messages=2 truncated=2'), 'at backlogCap 0 the dump counts both stored messages');
  assert.ok(!storedCut.dump.includes('S1 stored') && !storedCut.dump.includes('S2 stored'), 'and shows neither');
  assert.ok(storedCut.notice, 'with no note, nothing else covers them, so the notice comes');
  assert.ok(textOf(storedCut.notice.content).includes('2 of 2 diverted messages were above the cap'), 'with the count');
  assert.ok(!textOf(storedCut.notice.content).includes('Still held'), 'and no held message, as none is');
  assert.ok(storedCut.inferences.includes('Subconscious'), 'and a report turn');

  const storedCutNoted = cancelWith({ backlogCap: 0, source: 'subconscious', stored: twoStored, held: [], note: 'Someone needs you here.' });
  assert.equal(storedCutNoted.notice, undefined, 'its note speaks for the stored messages it saw, so no notice');
  assert.ok(!storedCutNoted.inferences.includes('Subconscious'), 'and no report turn');

  const nothingCut = cancelWith({ backlogCap: 10, source: 'subconscious', stored: twoStored, held: [] });
  assert.equal(nothingCut.notice, undefined, 'with nothing cut and nothing held, no notice');
  assert.ok(!nothingCut.inferences.includes('Subconscious'), 'and no report turn');
});
