/**
 * A tune-out cancel's `<tuned-out-backlog>` is one message in the resident's
 * window, and the resident's strategy cuts a message past its per-message cap
 * from the end, which would lose the dump's newest lines while they still
 * counted as shown. So the dump holds the newest lines that fit whole in one
 * of the resident's messages, the ones it leaves out count as truncated, and
 * the subconscious's report notice is told of them. A newest message too long
 * to fit alone is shown cut and marked. The last test runs it through the
 * framework, with context-manager's AutobiographicalStrategy for the resident
 * and test/tune-out-e2e.test.ts's MCPL fixture for the channel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }
interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const row = (author: string, t: string): Row =>
  ({ participant: 'user', content: [text(t)], metadata: { author: { name: author }, tuneOut: { epochId: 'eA' } } });
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const CUT_MARK = ' [cut to fit; fetch_history has it whole]';

/** Five stored messages, M1 the oldest, each line "Ann: Mk " and 40 x's. */
const FIVE = [1, 2, 3, 4, 5].map((k) => row('Ann', `M${k} ${'x'.repeat(40)}`));

/** Cancels epoch eA of disc:guild:a over the given messages, the resident
 *  shown `room` characters whole in one message (no cap when left out), and
 *  returns the dump's text, the report notice's, the rows after the notice
 *  and whose inference was requested. */
function cancelWith(opts: { backlogCap?: number; room?: number; source?: string; stored?: Row[]; held?: Row[]; note?: string }) {
  const added: Added[] = [];
  const inferences: string[] = [];
  const registry = {
    cancelTuneOut: () => ({
      params: { epochId: 'eA', cadenceSeconds: 300, backlogCap: opts.backlogCap ?? 10, maxWakes: 3, startedAtSequence: 0 },
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
    getStoredMessages: () => opts.stored ?? [],
    getDeferredMessages: () => opts.held ?? [],
    ...(opts.room !== undefined ? { residentMessageChars: () => opts.room } : {}),
    emitTrace: () => {},
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source ?? 'agent-tool', 'test', opts.note), { ok: true });
  const dumpRow = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(dumpRow, 'the cancel adds its dump');
  assert.equal(dumpRow.content.length, 1, 'the dump is one text block');
  const notice = added.find((m) => m.metadata?.kind === 'tune-out-cancel-report');
  return {
    dump: textOf(dumpRow.content),
    notice: notice ? textOf(notice.content) : undefined,
    held: added.filter((m) => m.metadata?.kind === 'tune-out-cancel-held').map((m) => m.content),
    inferences,
  };
}

/** The dump's length when it shows the newest k of the five, each whole:
 *  backlogCap k gives exactly that dump, with no room to fit. */
const lengthShowing = (k: number): number => cancelWith({ backlogCap: k, stored: FIVE }).dump.length;
const shownOf = (dump: string): string[] => [1, 2, 3, 4, 5].map((k) => `M${k}`).filter((m) => dump.includes(`Ann: ${m} `));

test('with room for the whole dump it shows every message, and one character less leaves the oldest out', () => {
  const whole = cancelWith({ room: lengthShowing(5), stored: FIVE });
  assert.deepEqual(shownOf(whole.dump), ['M1', 'M2', 'M3', 'M4', 'M5'], 'room for all five shows all five');
  assert.ok(whole.dump.includes('messages=5>'), 'and counts none as truncated');
  assert.ok(!whole.notice!.includes("weren't delivered raw"), 'so the report is told of none');

  const short = cancelWith({ room: lengthShowing(5) - 1, stored: FIVE });
  assert.ok(!shownOf(short.dump).includes('M1'), 'one character less leaves M1 out');
  assert.ok(shownOf(short.dump).includes('M5'), 'and keeps the newest');
  assert.ok(short.dump.length <= lengthShowing(5) - 1, 'and fits');
});

test('it keeps the newest lines that fit whole, counts those it leaves out, and tells the report how many', () => {
  const two = cancelWith({ room: lengthShowing(2), stored: FIVE });
  assert.deepEqual(shownOf(two.dump), ['M4', 'M5'], 'room for the newest two shows them');
  assert.ok(two.dump.includes('messages=5 truncated=3 (oldest; fetch_history covers the rest)>'), 'and counts the other three');
  assert.equal(two.dump.length, lengthShowing(2), 'filling the room exactly');
  assert.ok(two.dump.endsWith('</tuned-out-backlog>'), 'with its closing tag');
  assert.ok(two.notice!.includes("3 of 5 diverted messages, the oldest, weren't delivered raw to the resident."), 'the report is told of the three');

  const one = cancelWith({ room: lengthShowing(2) - 1, stored: FIVE });
  assert.deepEqual(shownOf(one.dump), ['M5'], 'one character less, and only the newest fits');
  assert.ok(one.dump.includes('messages=5 truncated=4 '), 'with the other four counted');
});

test('at every room the dump fits, shows as many of the newest as fit, and counts the rest', () => {
  const all = FIVE.map((r) => `Ann: ${textOf(r.content)}`);
  // The dump with no line and all five counted, the widest truncated= takes:
  // backlogCap 0 gives it with no room to fit.
  const frame = cancelWith({ backlogCap: 0, stored: FIVE }).dump.length;
  for (let room = 0; room <= lengthShowing(5) + 2; room++) {
    const { dump, notice } = cancelWith({ room, stored: FIVE });
    const body = dump.slice(dump.indexOf('>\n') + 2, dump.lastIndexOf('\n</tuned-out-backlog>'));
    const lines = body === '' ? [] : body.split('\n');
    const at = `at room ${room}`;
    if (room >= frame) assert.ok(dump.length <= room, `${at} the dump fits (it's ${dump.length})`);
    if (lines.length > 0 && lines[0]!.endsWith(CUT_MARK)) {
      assert.equal(lines.length, 1, `${at} a cut line is the only one`);
      assert.ok(all[4]!.startsWith(lines[0]!.slice(0, -CUT_MARK.length)), `${at} it's the newest's head`);
      assert.ok(all[4]!.length + frame > room, `${at} as the newest doesn't fit whole`);
      assert.equal(dump.length, room, `${at} and it fills the room`);
    } else {
      assert.deepEqual(lines, all.slice(5 - lines.length), `${at} the lines are the newest, whole`);
      if (lines.length < 5 && room >= frame) {
        const used = lines.join('\n').length;
        const older = all[4 - lines.length]!;
        assert.ok(frame + used + older.length + (lines.length > 0 ? 1 : 0) > room, `${at} the next older line wouldn't fit`);
        if (lines.length === 0) assert.ok(room - frame <= CUT_MARK.length, `${at} there's no room to show the newest cut`);
      }
    }
    const counted = 5 - lines.length;
    if (counted === 0) assert.ok(!dump.includes('truncated='), `${at} none is counted as left out`);
    else {
      assert.ok(dump.includes(`messages=5 truncated=${counted} (oldest;`), `${at} truncated= counts the ${counted} left out`);
      assert.ok(notice!.includes(`${counted} of 5 diverted messages, the oldest,`), `${at} and the report is told of them`);
    }
  }
});

test('a newest message too long to fit alone is shown cut to the room left and marked, with nothing older', () => {
  const long = row('Bo', `NEWEST ${'y'.repeat(500)}`);
  const room = lengthShowing(1) + 100;
  const { dump, notice } = cancelWith({ room, stored: [...FIVE, long] });
  assert.equal(dump.length, room, 'the dump fills the room');
  assert.ok(dump.includes(`\nBo: NEWEST yyy`) && dump.includes(`y${CUT_MARK}\n</tuned-out-backlog>`), "the newest message's head, marked as cut");
  assert.deepEqual(shownOf(dump), [], 'and no older message');
  assert.ok(dump.includes('messages=6 truncated=5 '), 'the five older ones are counted as left out');
  assert.ok(notice!.includes('5 of 6 diverted messages, the oldest,'), 'and the report is told of them');
});

test('a held newest message shown cut follows the notice whole, as its view lacks it; a stored one is in its view', () => {
  const longText = `NEWEST ${'y'.repeat(500)}`;
  const room = lengthShowing(1) + 100;
  const held = cancelWith({ room, stored: FIVE, held: [row('Bo', longText)] });
  assert.ok(held.dump.includes(CUT_MARK), 'the held newest is shown cut');
  assert.ok(held.notice!.includes('the 1 message after this one'), 'the notice counts it');
  assert.deepEqual(held.held, [[text('Bo:'), text(longText)]], 'and it follows the notice whole');

  const stored = cancelWith({ room, stored: [...FIVE, row('Bo', longText)] });
  assert.ok(stored.dump.includes(CUT_MARK), 'a stored newest is shown cut too');
  assert.deepEqual(stored.held, [], 'but no row follows the notice for it');
});

test('held messages the fit leaves out follow the notice as rows, and stored ones do not', () => {
  const stored = [row('Ann', `S1 ${'x'.repeat(40)}`), row('Ann', `S2 ${'x'.repeat(40)}`)];
  const held = [row('Bo', `H1 ${'x'.repeat(40)}`), row('Bo', `H2 ${'x'.repeat(40)}`)];
  const roomForOne = cancelWith({ backlogCap: 1, stored, held }).dump.length;
  const { dump, notice, held: rows } = cancelWith({ room: roomForOne, stored, held });
  assert.ok(dump.includes('Bo: H2 ') && !dump.includes('H1 ') && !dump.includes('S1 ') && !dump.includes('S2 '), 'only the newest fits');
  assert.ok(notice!.includes("3 of 4 diverted messages, the oldest, weren't delivered raw to the resident."), 'the report is told of the three');
  assert.deepEqual(rows, [[text('Bo:'), text(`H1 ${'x'.repeat(40)}`)]], 'the held one left out follows the notice; the stored ones are in its view');
});

test('without a per-message cap the dump is not fitted', () => {
  const { dump } = cancelWith({ stored: [...FIVE, row('Bo', 'z'.repeat(100_000))] });
  assert.deepEqual(shownOf(dump), ['M1', 'M2', 'M3', 'M4', 'M5'], 'every message is shown');
  assert.ok(!dump.includes('truncated=') && !dump.includes(CUT_MARK), 'none counted or cut');
});

test("a room smaller than the dump's frame shows no message and counts them all", () => {
  const { dump, notice } = cancelWith({ room: 10, stored: FIVE });
  assert.deepEqual(shownOf(dump), [], 'no line');
  assert.ok(!dump.includes(CUT_MARK), 'not even a cut one');
  assert.ok(dump.includes('messages=5 truncated=5 '), 'all five counted');
  assert.ok(notice!.includes('5 of 5 diverted messages'), 'and the report is told of all five');
});

test('the cut never ends on half of a surrogate pair', () => {
  const room = lengthShowing(1) + 100;
  // Each 😀 is two code units, so some cut lands between them unless it's moved.
  for (const pad of [0, 1]) {
    const { dump } = cancelWith({ room, stored: [...FIVE, row('Bo', `${'p'.repeat(pad)}${'😀'.repeat(400)}`)] });
    const line = dump.slice(dump.indexOf('\nBo: ') + 1, dump.indexOf(CUT_MARK));
    assert.ok(line.length > 0, 'the newest is shown cut');
    const last = line.charCodeAt(line.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `with pad ${pad}, it doesn't end on a high surrogate`);
    assert.ok(dump.length <= room, 'and fits');
  }
});

test('a cancel the subconscious makes itself with no note gets the notice and a report turn when the fit left messages out', () => {
  const cut = cancelWith({ room: lengthShowing(2), source: 'subconscious', stored: FIVE });
  assert.ok(cut.notice?.includes('3 of 5 diverted messages, the oldest,'), 'nothing else covers them, so the notice comes');
  assert.ok(cut.inferences.includes('Subconscious'), 'with a report turn');
  const whole = cancelWith({ room: lengthShowing(5), source: 'subconscious', stored: FIVE });
  assert.equal(whole.notice, undefined, 'with room for all, no notice');
  assert.ok(!whole.inferences.includes('Subconscious'), 'and no report turn');
});

// ---------------------------------------------------------------------------
// Through the framework: the resident's own request after the cancel.
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }> } }>;
  channelRegistry: { listChannelsRaw(): unknown[] } | null;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("the resident is shown the newest backlog lines whole under its strategy's per-message cap, and the report is told of the rest", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-dump-fit-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  // 170 tokens is 680 characters: room for the dump's frame and three of the
  // six 155-character lines below, where the whole dump is 1,079.
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout',
      model: 'test-model',
      systemPrompt: 'You are scout.',
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        foldingStrategy: 'kv-stable',
        recentWindowTokens: 30_000,
        kvStableReachTokens: 8_000,
        maxMessageTokens: 170,
      }) as never,
    }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{
      id: 'disc',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [],
  });
  try {
    await framework.start();
    const internals = framework as unknown as Internals;
    await waitFor('channel registration', () => (internals.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    assert.ok(internals.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok);

    const markers = [1, 2, 3, 4, 5, 6].map((k) => `P-MSG-${k}`);
    for (const marker of markers) appendFileSync(commandPath, `ambient ${marker.toLowerCase()} ${marker} ${'x'.repeat(140)}\n`);
    const stored = () => internals.agents.get('scout')!.getContextManager().getAllMessages();
    await waitFor('all six stored', () => markers.every((mk) => stored().some((m) => textOf(m.content).includes(mk) && m.metadata?.tuneOut)));

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
    assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'agent request').ok);
    const isScout = (r: NormalizedRequest): boolean => (r.system ?? '').includes('You are scout.');
    await waitFor("the resident's request after the cancel", () => membrane.calls.some(isScout));

    const request = membrane.calls.find(isScout)!;
    const dumps = request.messages.map((m) => textOf(m.content)).filter((t) => t.includes('<tuned-out-backlog'));
    assert.equal(dumps.length, 1, "the resident's request carries the dump");
    const dump = dumps[0]!;
    for (const mk of ['P-MSG-4', 'P-MSG-5', 'P-MSG-6']) {
      assert.ok(dump.includes(`antra: ${mk} ${'x'.repeat(140)}\n`), `the resident is shown ${mk} whole`);
    }
    for (const mk of ['P-MSG-1', 'P-MSG-2', 'P-MSG-3']) assert.ok(!dump.includes(mk), `and not ${mk}`);
    assert.ok(dump.includes('messages=6 truncated=3 (oldest; fetch_history covers the rest)>'), 'which it counts as left out');
    assert.ok(dump.endsWith('</tuned-out-backlog>') && !dump.includes('[truncated'), 'the strategy cut nothing');

    const notice = internals.agents.get('Subconscious')!.getContextManager().getAllMessages()
      .find((m) => textOf(m.content).includes('[Tune-out cancelled:'));
    assert.ok(notice, 'the report gets its notice');
    assert.ok(textOf(notice.content).includes("3 of 6 diverted messages, the oldest, weren't delivered raw to the resident."), 'which tells it of the three');
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
