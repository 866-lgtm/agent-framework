/**
 * The Discord awareness-mark journal: an append-only record of what was
 * asked and what was answered, kept as typed records in the Chronicle store
 * (RecordJournal), never a model of what is on Discord.
 *
 * Contract (since a field incident in which a web-UI rollback queued 918 💤
 * reactions on other people's messages):
 * marks are an explicit publication choice (default none); one-shot, so
 * branch moves and restarts never derive operations from branch state; and
 * cancel / retract / release are explicit operator acts whose receipts say
 * what history establishes and what it leaves open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import {
  DISCORD_AWARENESS_RECORD_TYPE,
  DiscordAwarenessOutbox,
  DiscordAwarenessRefusal,
  boundDiscordAwarenessText,
  isPermanentDiscordReactionFailure,
  extractDiscordAwarenessRefs,
  selectDiscordAwarenessRefs,
  type DiscordAwarenessBatchView,
  type DiscordAwarenessRef,
  type DiscordAwarenessRetractView,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import { OperatorLog } from '../src/operator-log.js';
import { RecordJournal } from '../src/record-journal.js';

const ref = (messageId: string, channel = 'c1'): DiscordAwarenessRef =>
  ({ serverId: 'discord', channelId: `discord:g1:${channel}`, messageId });

interface Harness {
  store: JsStore;
  dir: string;
  legacyPath: string;
  /** A fresh instance over the same store: what a restarted process reads. */
  reopen(): DiscordAwarenessOutbox;
}

function withJournal(fn: (outbox: DiscordAwarenessOutbox, h: Harness) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const legacyPath = join(dir, 'recovery', 'discord-awareness-outbox.json');
    const h: Harness = { store, dir, legacyPath, reopen: () => new DiscordAwarenessOutbox(store, { legacyPath }) };
    try {
      await fn(h.reopen(), h);
    } finally {
      if (!store.isClosed()) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function activeBatch(outbox: DiscordAwarenessOutbox, refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) {
  const batch = outbox.prepare({
    agentName: 'cairn',
    sourceBranch: 'main',
    targetBranch: 'rollback/cairn/1',
    refs,
    scope: 'all',
    ...extra,
  })!;
  outbox.activate(batch.id);
  return batch;
}

/** Claim and answer one dispatch for a message. */
function answer(
  outbox: DiscordAwarenessOutbox,
  messageId: string,
  outcome: 'confirmed' | 'failed' | 'not-sent' | 'unknown',
  detail: { permanent?: boolean; error?: string } = {},
) {
  const claimed = outbox.claimDispatch('discord', (d) => d.key.messageId !== messageId);
  assert.ok(claimed, `a dispatch for ${messageId} is due`);
  const ended = outbox.recordOutcome(claimed.attempts, outcome, detail);
  return { ...claimed, ended };
}

const batches = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessBatchView => v.kind === 'batch');
const retracts = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessRetractView => v.kind === 'retract');

/**
 * A held batch, which only an import makes: a pre-journal ledger's prepared
 * batch with marks, written where the store keeps one and imported by the
 * returned outbox's first read.
 */
function importHeld(h: Harness, id: string, refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) {
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 2,
    batches: [{
      id, status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: `legacy/${id}`, emoji: '💤', createdAt: 1,
      refs: refs.map((r) => ({ ...r, desired: false, markerPresent: false, deliveryStatus: 'applied' })),
      ...extra,
    }],
  }));
  const outbox = h.reopen();
  assert.equal(outbox.batches().find((batch) => batch.id === id)?.status, 'held');
  return outbox;
}

test('extractDiscordAwarenessRefs keeps only direct Discord addressing metadata', () => {
  const refs = extractDiscordAwarenessRefs([
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'portal', channelId: 'portal:thread-1', messageId: 'p1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1' } },
  ]);
  assert.deepEqual(refs, [ref('m1')]);
});

test('selection: none marks nothing; addressed means the chat:addressed tag; refs bind the set', () => {
  const messages = [
    { metadata: { ...ref('a1'), tags: ['chat:addressed', 'chat:mention'] } },
    { metadata: { ...ref('b1'), tags: ['chat:ambient'] } },
    { metadata: { ...ref('b2') } },
    { metadata: { ...ref('a2', 'dm'), tags: ['chat:addressed', 'chat:dm'] } },
  ];
  assert.deepEqual(selectDiscordAwarenessRefs(messages, 'none'), { refs: [], addressable: 4, unmarked: 4, notRemoved: 0 });
  const addressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed' });
  assert.deepEqual(addressed.refs.map((r) => r.messageId), ['a1', 'a2']);
  assert.equal(addressed.unmarked, 2);
  assert.equal(selectDiscordAwarenessRefs(messages, { scope: 'all' }).refs.length, 4);
  // A frozen choice: only previewed refs, and never anything else removed.
  const frozen = selectDiscordAwarenessRefs(messages, { scope: 'all', refs: [ref('a1'), ref('gone')] });
  assert.deepEqual(frozen.refs.map((r) => r.messageId), ['a1']);
  assert.equal(frozen.notRemoved, 1);
  assert.equal(frozen.unmarked, 3);
  // Scope still applies to authorized refs.
  const frozenAddressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed', refs: [ref('b1'), ref('a2', 'dm')] });
  assert.deepEqual(frozenAddressed.refs.map((r) => r.messageId), ['a2']);
});

test('the journal is typed records in the store: activation queues one add per ref, written ahead of dispatch', withJournal((outbox, h) => {
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
  })!;
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'prepared work is not deliverable');
  assert.equal(outbox.activate(batch.id), 2);
  assert.ok(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length >= 2);

  const claimed = outbox.claimDispatch('discord')!;
  assert.equal(claimed.dispatch.action, 'add');
  // The write-ahead record is in the store before the request could leave:
  // a fresh reader (a restarted process) sees the attempt, outcome unknown.
  const other = h.reopen();
  const op = other.operations().find((candidate) => candidate.opId === claimed.attempts[0].opId)!;
  assert.equal(op.attempts.length, 1);
  assert.equal(other.operationStatus(op), 'unknown');

  outbox.recordOutcome(claimed.attempts, 'confirmed');
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => d.key.messageId), [claimed.dispatch.key.messageId === 'm1' ? 'm2' : 'm1']);
}));

test('startup activates nothing: it retires what interrupted surgeries left, and a pending suppression waits for its branch', withJournal((outbox, h) => {
  // A rollback interrupted after its switch (its branch active), one
  // interrupted before it, and one whose marks an operator cancelled.
  const crashed = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all' })!;
  const elsewhere = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/2', refs: [ref('m2')], scope: 'addressed' })!;
  const cancelled = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/3', refs: [ref('m5')], scope: 'all' })!;
  outbox.cancel(cancelled.id, 'operator');
  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'suppress/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  const active = activeBatch(outbox, [ref('m4')]);
  outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm4'); // dies with this request on the wire

  const exists = new Set(['main', 'rollback/cairn/1', 'rollback/cairn/2', 'rollback/cairn/3', 'suppress/cairn/1']);
  const restarted = h.reopen();
  const recovered = restarted.recoverAtStartup((name) => exists.has(name));
  assert.deepEqual(
    recovered.retired.map((r) => [r.batchId, r.reason, r.marks, r.suppression, r.sourceBranch, r.targetBranch]),
    [
      [crashed.id, 'interrupted', 1, false, 'main', 'rollback/cairn/1'],
      [elsewhere.id, 'interrupted', 1, false, 'main', 'rollback/cairn/2'],
      [cancelled.id, 'interrupted', 0, false, 'main', 'rollback/cairn/3'],
    ],
  );
  assert.equal(recovered.unknownAttempts, 1);
  const status = new Map(restarted.batches().map((b) => [b.id, b.status]));
  assert.equal(status.get(crashed.id), 'discarded');
  assert.equal(status.get(elsewhere.id), 'discarded');
  assert.equal(status.get(cancelled.id), 'discarded');
  assert.equal(status.get(suppression.id), 'prepared', 'its body waits for a start on its branch');
  assert.equal(status.get(active.id), 'active');
  // None of a retired batch's marks is sent; the unanswered add is unknown
  // and, still the newest for its key, retried.
  assert.deepEqual(restarted.pendingDispatches('discord').map((d) => d.key.messageId), ['m4']);
  // A later restart changes nothing.
  assert.deepEqual(h.reopen().recoverAtStartup((name) => exists.has(name)), { retired: [], unknownAttempts: 0, givenUp: 0 });
}));

test('a dispatch is admitted from the journal as it is now: a cancel during an in-flight request stops the rest', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  // A drain computed this list, then sent the first while holding the rest.
  const stale = outbox.pendingDispatches('discord');
  assert.equal(stale.length, 3);
  const first = outbox.recordDispatching(stale[0]);
  assert.equal(first.length, 1);
  const receipt = outbox.cancel(batch.id, 'operator');
  assert.equal(receipt.cancelled, 2);
  assert.equal(receipt.inFlight, 1);
  // The stale list can no longer authorize anything.
  assert.deepEqual(outbox.recordDispatching(stale[1]), []);
  assert.deepEqual(outbox.recordDispatching(stale[2]), []);
  outbox.recordOutcome(first, 'confirmed');
  assert.equal(outbox.claimDispatch('discord'), null);
}));

test('cancel stops every further send of a batch, never removes, and reports what may still land', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4')]);
  answer(outbox, 'm1', 'confirmed');
  answer(outbox, 'm2', 'unknown', { error: 'did not respond' });
  const m3 = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!; // on the wire

  const receipt = outbox.cancel(batch.id, 'operator');
  assert.deepEqual(
    { target: receipt.target, kind: receipt.kind, cancelled: receipt.cancelled, inFlight: receipt.inFlight, unknown: receipt.unknown, confirmed: receipt.confirmed, unresolvedAttempts: receipt.unresolvedAttempts },
    { target: batch.id, kind: 'batch', cancelled: 1, inFlight: 1, unknown: 1, confirmed: 1, unresolvedAttempts: 2 },
  );
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing new is sent, nothing is removed');
  // The in-flight request lands after the cancel: recorded, not followed up.
  outbox.recordOutcome(m3.attempts, 'confirmed');
  assert.equal(outbox.operationStatus(outbox.operations().find((op) => op.key.messageId === 'm3')!), 'confirmed');
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  // Durable across a restart.
  const restarted = h.reopen();
  restarted.recoverAtStartup();
  assert.ok(restarted.batches().find((b) => b.id === batch.id)?.cancelled);
  assert.equal(restarted.pendingDispatches('discord').length, 0);
}));

test('the cancel receipt keeps an earlier unresolved request after a later answer', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2')]);
  answer(outbox, 'm1', 'unknown', { error: 'timed out' });
  answer(outbox, 'm1', 'confirmed'); // the retry confirms
  answer(outbox, 'm2', 'unknown', { error: 'timed out' });
  answer(outbox, 'm2', 'failed', { permanent: true, error: 'Unknown Message' });
  const receipt = outbox.cancel(batch.id);
  assert.equal(receipt.confirmed, 1);
  assert.equal(receipt.unknown, 0);
  assert.equal(receipt.unresolvedAttempts, 2, 'both first attempts may still land');
}));

test('a repeated cancel writes nothing, and its receipt is still the truthful history', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2')]);
  const onWire = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm1')!;
  const first = outbox.cancel(batch.id);
  assert.deepEqual({ cancelled: first.cancelled, inFlight: first.inFlight, confirmed: first.confirmed }, { cancelled: 1, inFlight: 1, confirmed: 0 });
  outbox.recordOutcome(onWire.attempts, 'confirmed');
  const records = h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length;
  const again = outbox.cancel(batch.id);
  assert.deepEqual(
    { cancelled: again.cancelled, inFlight: again.inFlight, unknown: again.unknown, confirmed: again.confirmed, unresolvedAttempts: again.unresolvedAttempts },
    { cancelled: 0, inFlight: 0, unknown: 0, confirmed: 1, unresolvedAttempts: 0 },
  );
  assert.equal(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length, records, 'nothing new written');

  // The same for a retract request.
  const other = activeBatch(outbox, [ref('m3'), ref('m4')]);
  answer(outbox, 'm3', 'confirmed');
  answer(outbox, 'm4', 'confirmed');
  const { requestId } = outbox.retract(other.id);
  const removal = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!;
  const stopped = outbox.cancel(requestId);
  assert.deepEqual({ cancelled: stopped.cancelled, inFlight: stopped.inFlight }, { cancelled: 1, inFlight: 1 });
  outbox.recordOutcome(removal.attempts, 'confirmed');
  const repeated = outbox.cancel(requestId);
  assert.deepEqual({ cancelled: repeated.cancelled, inFlight: repeated.inFlight, confirmed: repeated.confirmed }, { cancelled: 0, inFlight: 0, confirmed: 1 });
}));

test('cancelling a batch its surgery has not activated stops every mark; a suppression\'s body is still finished', withJournal((outbox) => {
  const rollback = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all' })!;
  assert.equal(outbox.cancel(rollback.id, 'operator').cancelled, 2);
  assert.throws(() => outbox.activate(rollback.id), /cancelled before activation/);
  // A start retires it, with no marks to report: the operator cancelled them.
  assert.deepEqual(outbox.recoverAtStartup().retired.map((r) => [r.batchId, r.marks]), [[rollback.id, 0]]);

  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'suppress/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  outbox.cancel(suppression.id);
  assert.deepEqual(outbox.pendingSuppressionsFor('suppress/cairn/1').map((b) => b.id), [suppression.id],
    'a cancel stops its marks, not its body');
  assert.deepEqual(outbox.completeSuppression(suppression.id), { retired: true });
  assert.deepEqual(outbox.pendingSuppressionsFor('suppress/cairn/1'), []);
  const settled = outbox.batches().find((b) => b.id === suppression.id)!;
  assert.equal(settled.status, 'discarded');
  assert.equal(settled.suppressionComplete, true);
  assert.equal(outbox.pendingDispatches('discord').length, 0);
}));

test('releasing an imported held suppression\'s marks never certifies or forgets its unfinished body', withJournal((_outbox, h) => {
  const outbox = importHeld(h, 'legacy-sup', [ref('m1')], {
    targetBranch: 'partial', activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }],
  });
  assert.deepEqual(outbox.pendingSuppressionsFor('partial').map((b) => b.id), ['legacy-sup']);
  const released = outbox.release('legacy-sup', 'operator');
  assert.equal(released.addsQueued, 1);
  assert.equal(outbox.batches()[0].status, 'active');
  assert.equal(outbox.batches()[0].suppressionComplete, undefined);
  // Body recovery still owes the redactions on `partial`.
  assert.deepEqual(outbox.pendingSuppressionsFor('partial').map((b) => b.id), ['legacy-sup']);
  // An active batch isn't retired when its body is finished: its marks are the operator's.
  assert.deepEqual(outbox.completeSuppression('legacy-sup'), { retired: false });
  assert.equal(outbox.batches()[0].status, 'active');
  assert.deepEqual(outbox.pendingSuppressionsFor('partial'), []);
}));

test('retract queues a removal for every selected key, whatever history says, and discloses unresolved requests', withJournal((outbox) => {
  const a = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  const b = activeBatch(outbox, [ref('m1')]); // another batch asked for the same reaction
  const m1 = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm1')!;
  assert.equal(m1.attempts.length, 2, "both batches' adds ride one request");
  outbox.recordOutcome(m1.attempts, 'unknown', { error: 'did not respond within 75ms' });
  answer(outbox, 'm2', 'not-sent');
  answer(outbox, 'm3', 'confirmed');

  const receipt = outbox.retract(a.id, 'operator');
  assert.equal(receipt.removalsQueued, 3, 'm2 too: history does not decide whether the act is carried out');
  assert.equal(receipt.addsSuperseded, 3, "m2's due add stops, and m1's unknown ones are no longer retried");
  assert.equal(receipt.keysWithUnresolvedAdds, 1);
  assert.equal(receipt.unresolvedAddAttempts, 1, 'one physical request carried both adds');
  assert.equal(receipt.keysWithLegacyUncertainty, 0);
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`).sort(),
    ['remove:m1', 'remove:m2', 'remove:m3']);
  for (const id of ['m1', 'm2', 'm3']) answer(outbox, id, 'confirmed');
  const views = new Map(batches(outbox).map((v) => [v.id, v]));
  assert.equal(views.get(a.id)!.removals.confirmed, 3);
  assert.equal(views.get(b.id)!.unresolvedAttempts, 1, 'the unknown add stays unresolved history');
  const [retractView] = retracts(outbox);
  assert.equal(retractView.target, a.id);
  assert.equal(retractView.removals.confirmed, 3);
}));

test('a newer opposite request stops the retries of a retryably failed one, in both directions', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1')]);
  answer(outbox, 'm1', 'failed', { error: 'Discord 503' }); // retryable
  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.addsSuperseded, 1);
  // Retried while refused, within the bound of three unconfirmed attempts.
  for (let i = 0; i < 2; i++) {
    const claimed = outbox.claimDispatch('discord')!;
    assert.equal(claimed.dispatch.action, 'remove');
    outbox.recordOutcome(claimed.attempts, 'failed', { error: 'Discord 503' });
  }
  const add = outbox.operations().find((op) => op.action === 'add')!;
  assert.equal(add.attempts.length, 1, 'its history stays');
  assert.equal(add.cancelled?.reason, 'superseded');
  // Mirror: a new add supersedes the retryably failing remove.
  activeBatch(outbox, [ref('m1')]);
  const next = outbox.claimDispatch('discord')!;
  assert.equal(next.dispatch.action, 'add');
  assert.equal(outbox.operations().find((op) => op.action === 'remove')!.cancelled?.reason, 'superseded');
}));

test('a newer opposite intent retires the old request\'s retries even when it was on the wire or unknown', withJournal((outbox, h) => {
  // In flight when the retract arrives, then a retryable failure: remove next.
  const a = activeBatch(outbox, [ref('m1')]);
  const onWire = outbox.claimDispatch('discord')!;
  const retract = outbox.retract(a.id);
  assert.equal(retract.addsSuperseded, 1);
  assert.equal(retract.keysWithUnresolvedAdds, 1, 'the request on the wire is disclosed');
  assert.equal(outbox.claimDispatch('discord'), null, 'the key waits for the request on the wire');
  outbox.recordOutcome(onWire.attempts, 'failed', { error: 'Discord 503' });
  assert.equal(outbox.claimDispatch('discord', () => false)!.dispatch.action, 'remove');
  // Unknown, then retract, then the retract cancelled: nothing is revived.
  const b = activeBatch(outbox, [ref('m2')]);
  answer(outbox, 'm2', 'unknown');
  const { requestId } = outbox.retract(b.id);
  outbox.cancel(requestId);
  assert.ok(!outbox.pendingDispatches('discord').some((d) => d.key.messageId === 'm2'));
  // Mirror: a remove in flight when a new add arrives, then a retryable failure.
  const c = activeBatch(outbox, [ref('m3')]);
  answer(outbox, 'm3', 'confirmed');
  outbox.retract(c.id);
  const removeOnWire = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!;
  activeBatch(outbox, [ref('m3')]);
  outbox.recordOutcome(removeOnWire.attempts, 'failed', { error: 'Discord 503' });
  const next = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!;
  assert.equal(next.dispatch.action, 'add');
  outbox.recordOutcome(next.attempts, 'confirmed');
  // All of it holds across a restart.
  const restarted = h.reopen();
  restarted.recoverAtStartup();
  const due = restarted.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`);
  assert.ok(!due.includes('add:m1') && !due.includes('add:m2') && !due.includes('remove:m3'), due.join(','));
}));

test('authorization order: a retract after a surgery\'s choice wins over that choice\'s later activation', withJournal((outbox, h) => {
  const due = (o: DiscordAwarenessOutbox) => o.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`).sort();
  const prepare = (target: string, refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) => outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: target, refs, scope: 'all', ...extra,
  })!;

  // prepare -> retract -> activate: the remove goes, the add never does.
  const a = prepare('t/a', [ref('m1')]);
  outbox.retract(a.id);
  assert.equal(outbox.activate(a.id), 0, 'nothing queued');
  assert.deepEqual(outbox.settleActivation(a.id), { status: 'queued', queued: 0 });
  assert.deepEqual(due(outbox), ['remove:m1']);

  // Overlapping prepared batches: a retract of one decides the shared key
  // for the other, which was chosen earlier; its other key is unaffected.
  const b = prepare('t/b', [ref('m2')]);
  const c = prepare('t/c', [ref('m2'), ref('m3')]);
  outbox.retract(b.id);
  assert.equal(outbox.activate(c.id), 1);
  assert.equal(outbox.activate(b.id), 0);
  assert.deepEqual(due(outbox), ['add:m3', 'remove:m1', 'remove:m2']);

  // retract('all') covers batches not yet activated.
  const d = prepare('t/d', [ref('m4')]);
  const all = outbox.retract('all');
  assert.ok(all.removalsQueued >= 4);
  assert.equal(outbox.activate(d.id), 0);
  assert.ok(!due(outbox).includes('add:m4'));

  // Cancelling the retract stops it without reviving the choice it overrode.
  const e = prepare('t/e', [ref('m5')]);
  const { requestId } = outbox.retract(e.id);
  outbox.cancel(requestId);
  assert.equal(outbox.activate(e.id), 0);
  assert.ok(!due(outbox).some((d) => d.endsWith(':m5')), 'neither the add nor the cancelled remove');

  // A later choice wins over an earlier retract.
  const f = prepare('t/f', [ref('m1')]);
  assert.equal(outbox.activate(f.id), 1);
  assert.ok(due(outbox).includes('add:m1') && !due(outbox).includes('remove:m1'));

  // A release is a new act: it wins over a retract made while the batch was
  // held. Only an imported batch is held.
  const held = importHeld(h, 'g', [ref('m6')]);
  held.retract('g');
  assert.equal(held.release('g').addsQueued, 1);
  assert.ok(due(held).includes('add:m6') && !due(held).includes('remove:m6'));

  // The body's obligation is not the marks': a suppression whose marks were
  // retracted before activation still records its body complete.
  const sup = held.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 't/s', refs: [ref('m7')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  held.retract(sup.id);
  assert.equal(held.activate(sup.id), 0);
  const settled = held.batches().find((x) => x.id === sup.id)!;
  assert.equal(settled.status, 'active');
  assert.equal(settled.suppressionComplete, true);
  assert.deepEqual(held.pendingSuppressionsFor('t/s'), []);

  // Everything above holds across a restart.
  assert.deepEqual(due(h.reopen()), due(held));
}));

test('startup records a retirement only after syncing the store, and nothing when the sync fails', withJournal((outbox, h) => {
  // R1-7: a retirement relies on the store's state, such as a branch
  // deletion a caller-supplied store hasn't synced yet.
  const batch = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all' })!;
  const restarted = h.reopen();
  const sync = h.store.sync.bind(h.store);
  const calls: string[] = [];
  const append = h.store.appendJson.bind(h.store);
  (h.store as any).appendJson = (type: string, payload: unknown) => { calls.push('append'); return append(type, payload); };
  (h.store as any).sync = () => { calls.push('sync'); throw new Error('injected sync failure'); };
  try {
    assert.throws(() => restarted.recoverAtStartup(() => false), /injected sync failure/);
  } finally {
    (h.store as any).sync = sync;
    (h.store as any).appendJson = append;
  }
  assert.deepEqual(calls, ['sync'], 'the sync came first, and nothing was appended');
  assert.equal(h.reopen().batches().find((b) => b.id === batch.id)?.status, 'prepared');
  // With a working store, the next startup retires it.
  assert.deepEqual(h.reopen().recoverAtStartup(() => false).retired.map((r) => r.batchId), [batch.id]);
}));

test('startup gives up a pending suppression whose branch doesn\'t exist, and keeps one whose branch does', withJournal((outbox, h) => {
  const prepare = (targetBranch: string, messageId: string, suppression = false) => outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch, refs: [ref(messageId)], scope: 'all',
    ...(suppression ? { activationPolicy: 'explicit' as const, suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }] } : {}),
  })!;
  // A rollback that never forked, and two suppressions: one that never made
  // its fork (or whose fork was deleted), one whose fork exists.
  const neverForked = prepare('rollback/cairn/never', 'm1');
  const gone = prepare('suppress/cairn/gone', 'm2', true);
  const pending = prepare('suppress/cairn/pending', 'm3', true);
  const exists = new Set(['main', 'suppress/cairn/pending']);
  const recovered = h.reopen().recoverAtStartup((name) => exists.has(name));
  assert.deepEqual(
    recovered.retired.map((r) => [r.batchId, r.reason, r.marks, r.suppression]),
    [[neverForked.id, 'interrupted', 1, false], [gone.id, 'branch-gone', 1, true]],
  );

  const after = h.reopen();
  const batch = (id: string) => after.batches().find((candidate) => candidate.id === id)!;
  assert.equal(batch(neverForked.id).status, 'discarded');
  assert.equal(batch(gone.id).status, 'discarded');
  assert.equal(batch(pending.id).status, 'prepared');
  assert.deepEqual(after.pendingSuppressionsFor('suppress/cairn/gone'), [], 'the name it claimed is free');
  assert.deepEqual(after.pendingSuppressionsFor('suppress/cairn/pending').map((b) => b.id), [pending.id]);
  assert.deepEqual(batches(after).map((view) => view.id), [pending.id], 'a retired batch leaves the view');
  assert.throws(() => after.release(neverForked.id), /is discarded, not held/);
  assert.deepEqual(after.pendingDispatches('discord'), []);
}));

test('settling a batch already retired, or one whose retirement landed before its barrier failed, reports it not scheduled', withJournal((outbox, h) => {
  const prepare = (targetBranch: string, messageId: string) => outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch, refs: [ref(messageId)], scope: 'all',
  })!;
  const retired = prepare('rollback/cairn/2', 'm1');
  assert.equal(outbox.discard(retired.id), true);
  const again = outbox.settleActivation(retired.id);
  assert.equal(again.status, 'not-scheduled');
  assert.match((again as { error: string }).error, /is discarded, not prepared/);

  // The activation's first barrier fails before anything lands; the
  // retirement lands, and then its durability barrier fails.
  const landed = prepare('rollback/cairn/3', 'm2');
  const sync = h.store.sync.bind(h.store);
  let syncs = 0;
  (h.store as any).sync = () => {
    syncs++;
    if (syncs === 1 || syncs === 3) throw new Error(`injected sync failure ${syncs}`);
    return sync();
  };
  let settled: ReturnType<DiscordAwarenessOutbox['settleActivation']>;
  try {
    settled = outbox.settleActivation(landed.id);
  } finally {
    (h.store as any).sync = sync;
  }
  assert.equal(syncs, 3, 'one barrier for the activation, two for the retirement');
  assert.equal(settled.status, 'not-scheduled', JSON.stringify(settled));
  assert.equal(h.reopen().batches().find((b) => b.id === landed.id)?.status, 'discarded');
  assert.deepEqual(h.reopen().pendingDispatches('discord'), []);
}));

test('a retract request can be cancelled by the id its receipt returned, even after a restart', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  for (const id of ['m1', 'm2', 'm3']) answer(outbox, id, 'confirmed');
  const { requestId } = outbox.retract(batch.id);
  const onWire = outbox.claimDispatch('discord')!;
  const restarted = h.reopen();
  // The retract is listed, so its id survives the original receipt, and the
  // restarted process cancels by it. The earlier process's attempt has no
  // outcome, and this one didn't send it, so it is unknown here.
  assert.equal(retracts(restarted)[0].id, requestId);
  const receipt = restarted.cancel(requestId, 'operator');
  assert.deepEqual(
    { kind: receipt.kind, cancelled: receipt.cancelled, inFlight: receipt.inFlight, unknown: receipt.unknown },
    { kind: 'retract', cancelled: 2, inFlight: 0, unknown: 1 },
  );
  outbox.recordOutcome(onWire.attempts, 'confirmed');
  const after = h.reopen();
  assert.equal(after.claimDispatch('discord'), null);
  assert.ok(retracts(after)[0].cancelled);
}));

test('a retry confirming an unknown add never erases the unresolved first attempt', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1')]);
  const first = answer(outbox, 'm1', 'unknown');
  const retry = outbox.claimDispatch('discord')!;
  assert.deepEqual(retry.dispatch.opIds, first.dispatch.opIds);
  assert.equal(retry.attempts[0].attempt, 2);
  outbox.recordOutcome(retry.attempts, 'confirmed');
  // The operation's status is its latest answer; the first request stays
  // unknown in its history and is counted as unresolved.
  const [op] = outbox.operations();
  assert.equal(outbox.operationStatus(op), 'confirmed');
  assert.deepEqual(op.attempts.map((attempt) => attempt.outcome), ['unknown', 'confirmed']);
  assert.equal(batches(outbox)[0].adds.confirmed, 1);
  assert.equal(batches(outbox)[0].adds.unknown, 0);
  assert.equal(batches(outbox)[0].unresolvedAttempts, 1);
  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.unresolvedAddAttempts, 1);
}));

test('release queues a held batch\'s recorded operations, explicitly', withJournal((_outbox, h) => {
  const outbox = importHeld(h, 'held-1', [ref('m1'), ref('m2')]);
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  const receipt = outbox.release('held-1', 'operator');
  assert.deepEqual({ adds: receipt.addsQueued, removals: receipt.removalsQueued }, { adds: 2, removals: 0 });
  assert.equal(outbox.pendingDispatches('discord').length, 2);
  // A repeated release changes nothing, and its refusal says what settled
  // the batch, so a replay reads as one.
  assert.throws(
    () => outbox.release('held-1'),
    (error) => error instanceof DiscordAwarenessRefusal
      && /^Discord awareness batch \S+ is active, not held; it was released at \S+Z by operator$/.test(error.message),
  );
  assert.equal(outbox.pendingDispatches('discord').length, 2);
  // A held batch an operator cancels is settled too: nothing waits for a
  // release, and it requested nothing.
  const other = importHeld(h, 'held-2', [ref('m3')]);
  other.cancel('held-2', 'operator');
  assert.equal(other.batches().find((b) => b.id === 'held-2')?.status, 'active');
  assert.throws(
    () => other.release('held-2'),
    (error) => error instanceof DiscordAwarenessRefusal
      && /^Discord awareness batch \S+ is active, not held; it was cancelled at \S+Z by operator$/.test(error.message),
  );
  assert.ok(!other.operations().some((op) => op.key.messageId === 'm3'));
  // A start never holds a surgery's batch, and leaves an imported held one as it is.
  const third = importHeld(h, 'held-3', [ref('m4')]);
  third.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/9', refs: [ref('m5')], scope: 'all' });
  assert.deepEqual(third.recoverAtStartup(() => true).retired.map((r) => r.reason), ['interrupted']);
  assert.deepEqual(third.batches().filter((b) => b.status === 'held').map((b) => b.id), ['held-3']);
}));

test('the framework\'s release, retract and cancel each record their act in the operator log, done or refused', withJournal(async (_outbox, h) => {
  const outbox = importHeld(h, 'held-log', [ref('m1')]);
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.discordAwarenessOutbox = outbox;
  framework.deliverDiscordAwarenessInBackground = () => {};
  const logged: Array<Record<string, any>> = [];
  framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
  const requester = { via: 'test', name: 'op' };
  let released: unknown;
  let retracted: unknown;
  let cancelled: unknown;
  await muted(async () => {
    released = framework.releaseDiscordAwareness('held-log', { requester });
    retracted = framework.retractDiscordAwareness('held-log', { requester });
    cancelled = framework.cancelDiscordAwareness('held-log', { requester });
    assert.throws(() => framework.releaseDiscordAwareness('held-log', { requester }),
      (error) => error instanceof Error && (error as { code?: string }).code === 'invalid' && /is active, not held/.test(error.message));
  });
  assert.deepEqual(logged.map((entry) => [entry.kind, entry.agent, entry.requester, entry.params]), [
    ['awareness-release', '*', requester, { batchId: 'held-log' }],
    ['awareness-retract', '*', requester, { target: 'held-log' }],
    ['awareness-cancel', '*', requester, { target: 'held-log' }],
    ['awareness-release', '*', requester, { batchId: 'held-log' }],
  ]);
  assert.deepEqual(logged.slice(0, 3).map((entry) => entry.result), [released, retracted, cancelled].map((receipt) => ({ ...(receipt as object) })));
  assert.match(logged[3].error, /is active, not held/, 'a refused act is recorded with its refusal');
}));

test('settleActivation says what the journal will do when activation cannot be recorded', withJournal((outbox) => {
  const ok = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'b1', refs: [ref('m1')], scope: 'all' })!;
  assert.deepEqual(outbox.settleActivation(ok.id), { status: 'queued', queued: 1 });
  const cancelled = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'b2', refs: [ref('m2')], scope: 'all' })!;
  outbox.cancel(cancelled.id);
  const settled = outbox.settleActivation(cancelled.id);
  assert.equal(settled.status, 'not-scheduled');
  assert.equal(outbox.batches().find((b) => b.id === cancelled.id)?.status, 'discarded');
}));

test('outside error text is bounded before it is journaled', withJournal((outbox) => {
  assert.equal(boundDiscordAwarenessText('short'), 'short');
  const huge = `${'x'.repeat(300)}${'界'.repeat(500_000)}😀tail`;
  const bounded = boundDiscordAwarenessText(huge);
  assert.ok(bounded.length <= 500, `bounded to ${bounded.length}`);
  assert.match(bounded, /chars omitted/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bounded), 'no lone surrogate');
  activeBatch(outbox, [ref('m1')]);
  answer(outbox, 'm1', 'failed', { error: huge });
  const [op] = outbox.operations();
  assert.ok((op.attempts[0].error ?? '').length <= 500);
}));

test('a bounded text never splits a surrogate pair at either cut', () => {
  // At the default bound of 500 the head is cut at 360 code units and the
  // tail starts 100 from the end: each cut lands inside an emoji here.
  const text = `${'a'.repeat(359)}😀${'x'.repeat(1000)}😀${'b'.repeat(99)}`;
  assert.equal(boundDiscordAwarenessText(text), `${'a'.repeat(359)} … [1004 chars omitted] … ${'b'.repeat(99)}`);
});

test('a corrupt journal entry stops the reader rather than being skipped', withJournal((_outbox, h) => {
  h.store.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { records: 'nope' });
  assert.throws(() => h.reopen().batches(), /Corrupt Discord awareness journal entry/);
}));

test('the journal writes no checkpoints: a long history is replayed whole', withJournal((_outbox, h) => {
  // Every reduction needs the whole history, so a checkpoint would copy all
  // of it, and copying it every N entries grows the store quadratically.
  // (Durability is not under test here: skip the per-entry fsync.)
  const unsynced = new Proxy(h.store, {
    get(target, prop) {
      if (prop === 'sync') return () => {};
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const outbox = new DiscordAwarenessOutbox(unsynced);
  const batch = activeBatch(outbox, Array.from({ length: 150 }, (_, i) => ref(`m${i}`)));
  for (let claimed = outbox.claimDispatch('discord'); claimed; claimed = outbox.claimDispatch('discord')) {
    outbox.recordOutcome(claimed.attempts, 'confirmed');
  }
  outbox.retract(batch.id);
  const entries = h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length;
  assert.ok(entries > 256, `${entries} entries: more than an earlier build wrote between checkpoints`);
  assert.equal(h.store.getRecordIdsByType(`${DISCORD_AWARENESS_RECORD_TYPE}/checkpoint`).length, 0);
  const reread = h.reopen();
  assert.deepEqual(reread.view(), outbox.view());
  assert.deepEqual(reread.operations(), outbox.operations());
}));

test('a checkpoint an earlier build wrote is never read: the journal is replayed from its first entry', withJournal((outbox, h) => {
  // R1-3: only pre-release builds of this journal wrote checkpoints, and
  // restoring one lost the order of the acts it held. Chronicle never
  // removes a record, so every entry a checkpoint covered is still there.
  const first = activeBatch(outbox, [ref('m1'), ref('m2')]);
  answer(outbox, 'm1', 'confirmed');
  // An earlier build checkpointed here; this snapshot holds nothing at all,
  // so a reader that started from it would lose everything before it.
  const earlier = new RecordJournal<{ records: unknown[] }, unknown>(h.store, { type: DISCORD_AWARENESS_RECORD_TYPE });
  earlier.load();
  earlier.checkpoint({ batches: [], ops: [], legacy: [], retracts: [], importedSources: [], position: 0 });
  outbox.retract(first.id);
  const second = activeBatch(outbox, [ref('m3')]);
  const reread = h.reopen();
  assert.deepEqual(reread.batches().map((b) => b.id), [first.id, second.id]);
  assert.deepEqual(reread.view(), outbox.view());
  assert.deepEqual(reread.operations(), outbox.operations());
}));

test('an entry in a format this build can\'t read stops the reader; one written before the format field reads as format 1', withJournal((outbox, h) => {
  // R1-2: a later format that changes what a record means can't be misread.
  const batch = activeBatch(outbox, [ref('m1')]);
  const payloads = () => h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE)
    .map((id) => JSON.parse(Buffer.from(h.store.getRecord(id)!.payload).toString('utf-8')) as { v?: unknown });
  assert.ok(payloads().every((entry) => entry.v === 1), 'every entry written carries its format');
  // A pre-release build wrote entries without it, in the same format.
  h.store.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { records: [{ t: 'retract', at: 1, requestId: 'r-old', target: batch.id }] });
  assert.deepEqual(retracts(h.reopen()).map((view) => view.id), ['r-old']);
  h.store.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { v: 2, records: [] });
  assert.throws(() => h.reopen().batches(), /is in format 2, which this build can't read \(it reads format 1\)/);
}));

test('v2 import keeps what the old ledger recorded as evidence, holds pending work, and happens once', withJournal((_outbox, h) => {
  const entry = (messageId: string, fields: Record<string, unknown>) => ({ ...ref(messageId), lastAction: 'add', ...fields });
  const legacy = {
    version: 2,
    batches: [
      {
        // The household's shape: an active target-branch batch, some marks
        // applied, the rest marked permanent-failure by hand after shutdown,
        // one request interrupted on the wire.
        id: 'dd34b043', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/1791358473307', emoji: '💤', createdAt: 1791358473400,
        activationPolicy: 'target-branch',
        refs: [
          entry('a1', { desired: true, markerPresent: true, deliveryStatus: 'applied', attempts: 1 }),
          entry('n1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Cannot send request: connection to "discord" is closed' }),
          entry('u1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Connection to MCPL server "discord" closed while awaiting response for tools/call (id=4)' }),
          entry('g1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Unknown Message' }),
          entry('g3', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 3, lastError: 'Unknown Message' }),
        ],
      },
      {
        // June's probe: a pending entry whose one attempt's outcome is unknown.
        id: 'pending-batch', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/2', emoji: '💤', createdAt: 1791358473500,
        refs: [entry('p1', { desired: true, markerPresent: false, deliveryStatus: 'pending', attempts: 1, lastError: 'did not respond within 10000ms' })],
      },
    ],
  };
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify(legacy));

  const outbox = h.reopen();
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing imported is dispatched');
  assert.equal(outbox.operations().length, 0, 'no synthesized attempts');
  assert.equal(existsSync(h.legacyPath), false);
  assert.equal(existsSync(`${h.legacyPath}.migrated-v2`), true);
  const views = new Map(batches(outbox).map((v) => [v.id, v]));
  assert.deepEqual(views.get('dd34b043')!.legacy, {
    entries: 5,
    lastAddConfirmed: 1,
    lastRemoveConfirmed: 0,
    // u1: its one outcome unrecorded; g3: two earlier attempts unrecorded.
    outcomesUnrecorded: 3,
  });
  assert.equal(views.get('pending-batch')!.status, 'held');
  assert.equal(views.get('pending-batch')!.held!.releaseActions, 1);

  // Retract carries out the act for every ref and discloses what history leaves open.
  const receipt = outbox.retract('dd34b043', 'operator');
  assert.equal(receipt.removalsQueued, 5);
  assert.equal(receipt.unresolvedAddAttempts, 0, 'no physical request of this journal');
  assert.equal(receipt.keysWithLegacyUncertainty, 2, 'u1 and g3');
  const probe = outbox.retract('pending-batch');
  assert.equal(probe.removalsQueued, 1);
  assert.equal(probe.keysWithLegacyUncertainty, 1);
  assert.equal(outbox.cancel('pending-batch').legacyOutcomesUnrecorded, 1);

  // A crash between the import and the rename: the hash is recorded, so the
  // file is only renamed, never imported twice.
  writeFileSync(h.legacyPath, JSON.stringify(legacy));
  const again = h.reopen();
  assert.equal(again.batches().filter((b) => b.id === 'dd34b043').length, 1);
  assert.equal(batches(again).find((v) => v.id === 'dd34b043')!.legacy!.entries, 5);
  assert.equal(existsSync(h.legacyPath), false);
}));

test('a restored copy of an imported ledger changes nothing: import is once per batch, not once per file', withJournal((_outbox, h) => {
  const pending = (id: string, messageId: string) => ({
    id, status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: `rollback/resident/${id}`,
    emoji: '💤', createdAt: 1,
    refs: [{ ...ref(messageId), desired: true, markerPresent: false, deliveryStatus: 'pending', attempts: 1, lastAction: 'add',
      lastError: 'MCPL server "discord" did not respond within 10000ms' }],
  });
  const legacy = { version: 2, batches: [pending('restored', 'm1')] };
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify(legacy));
  const outbox = h.reopen();
  // The operator releases the held add, it lands, and then they retract it.
  outbox.release('restored', 'operator');
  answer(outbox, 'm1', 'confirmed');
  outbox.retract('restored', 'operator');
  const view = outbox.view();
  const operations = outbox.operations();

  // A byte-different copy of the same ledger (pretty-printed, as a backup
  // may be) is put back at the old path: it is moved aside and changes
  // nothing. Before, the batch read as held again, with its evidence
  // doubled, and a second release would have re-added the retracted mark.
  writeFileSync(h.legacyPath, JSON.stringify(legacy, null, 2));
  const restored = h.reopen();
  assert.deepEqual(restored.view(), view);
  assert.deepEqual(restored.operations(), operations);
  assert.throws(() => restored.release('restored'), /is active, not held/);
  assert.equal(existsSync(h.legacyPath), false);
  // Each copy is retired where it can be read again: the first keeps its
  // name, and the later one is kept beside it rather than over it.
  const retired = () => readdirSync(join(h.dir, 'recovery')).filter((name) => name.includes('.migrated-v2')).sort();
  assert.equal(readFileSync(`${h.legacyPath}.migrated-v2`, 'utf8'), JSON.stringify(legacy));
  assert.equal(retired().length, 2);
  assert.equal(readFileSync(join(h.dir, 'recovery', retired()[1]), 'utf8'), JSON.stringify(legacy, null, 2));

  // A file that also holds a batch the journal has never seen imports that
  // batch alone, once even if the file lists it twice, held like any import.
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 2,
    batches: [pending('restored', 'm1'), pending('later', 'm2'), pending('later', 'm2')],
  }));
  const widened = h.reopen();
  const later = batches(widened).find((v) => v.id === 'later')!;
  assert.equal(later.status, 'held');
  assert.equal(later.held!.releaseActions, 1);
  assert.deepEqual(later.legacy, { entries: 1, lastAddConfirmed: 0, lastRemoveConfirmed: 0, outcomesUnrecorded: 1 });
  assert.deepEqual(widened.view().filter((v) => v.id !== 'later'), view);
  assert.deepEqual(widened.operations(), operations);
  assert.equal(existsSync(h.legacyPath), false);
}));

test('a legacy ledger that cannot be imported refuses every read until it can be, rather than answering without it', withJournal((_outbox, h) => {
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, '{ "version": 2, "batches": [');
  const outbox = h.reopen();
  assert.throws(() => outbox.batches(), /Invalid Discord awareness ledger/);
  assert.throws(() => outbox.batches(), /Invalid Discord awareness ledger/, 'a later read tries the import again');
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 2,
    batches: [{
      id: 'late', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/late',
      emoji: '💤', createdAt: 1, refs: [{ ...ref('m1'), desired: true, markerPresent: false, deliveryStatus: 'pending' }],
    }],
  }));
  assert.deepEqual(outbox.batches().map((batch) => batch.id), ['late'], 'imported once it can be read');
  assert.equal(existsSync(h.legacyPath), false);
}));

test('legacy evidence reads outcomes from the old writer\'s lastError, never from its reconciliation state', withJournal((_outbox, h) => {
  // Entries exactly as the 64c480b writer leaves them (recordSuccess clears
  // lastError, recordFailure sets it; setDesired rewrites deliveryStatus
  // from the cached markerPresent without any request).
  const legacy = {
    version: 2,
    batches: [{
      id: 'reconciled', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/9',
      emoji: '💤', createdAt: 1,
      refs: [
        // An unknown add, then a switch to the source: "applied" only because
        // the cache (false) matched desired (false). The add may have landed.
        { ...ref('u1'), desired: false, markerPresent: false, deliveryStatus: 'applied', attempts: 1, lastAction: 'add',
          lastError: 'MCPL server "discord" did not respond within 10000ms' },
        // A confirmed add, then a switch to the source: "pending" is the
        // removal the old writer wanted; the add really succeeded.
        { ...ref('c1'), desired: false, markerPresent: true, deliveryStatus: 'pending', attempts: 1, lastAction: 'add' },
      ],
    }],
  };
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify(legacy));
  const outbox = h.reopen();
  const [view] = batches(outbox);
  assert.deepEqual(view.legacy, { entries: 2, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 1 });
  assert.equal(view.status, 'held', "the old writer's pending removal is held for release");

  // The released removal's own requests are disclosed by cancel, like adds.
  assert.equal(outbox.release('reconciled').removalsQueued, 1);
  answer(outbox, 'c1', 'unknown');
  answer(outbox, 'c1', 'confirmed');
  const receipt = outbox.cancel('reconciled');
  assert.equal(receipt.unresolvedAttempts, 1, 'the unknown removal attempt may still land');
  assert.equal(receipt.confirmed, 1);
  assert.equal(receipt.legacyOutcomesUnrecorded, 1);
}));

test('an imported active suppression is not proof its body completed: startup still verifies its intervals', withJournal((_outbox, h) => {
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 2,
    batches: [{
      id: 'legacy-sup', status: 'active', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'partial',
      emoji: '💤', createdAt: 1, activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
      refs: [{ ...ref('m1'), desired: true, markerPresent: true, deliveryStatus: 'applied', attempts: 1, lastAction: 'add' }],
    }],
  }));
  const outbox = h.reopen();
  const [batch] = outbox.batches();
  assert.equal(batch.status, 'active', 'its marks were active: history');
  assert.equal(batch.suppressionComplete, undefined, 'its body is not certified by the old ledger');
  assert.deepEqual(outbox.pendingSuppressionsFor('partial').map((b) => b.id), ['legacy-sup']);
  assert.equal(outbox.pendingDispatches('discord').length, 0);

  // A start that finds no branch named `partial` gives up its body, which
  // is in effect nowhere, and leaves its marks as they were.
  assert.deepEqual(
    outbox.recoverAtStartup((name) => name !== 'partial').retired.map((r) => [r.batchId, r.reason, r.marks]),
    [['legacy-sup', 'branch-gone', 0]],
  );
  const after = h.reopen().batches()[0];
  assert.equal(after.status, 'active');
  assert.equal(after.suppressionAbandoned, true);
  assert.deepEqual(h.reopen().pendingSuppressionsFor('partial'), [], 'the name it claimed is free');
}));

// ---------------------------------------------------------------------------
// Framework seams, with stubbed collaborators
// ---------------------------------------------------------------------------

function storeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-fw-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  return {
    dir,
    store,
    outbox: new DiscordAwarenessOutbox(store),
    cleanup: () => { if (!store.isClosed()) store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function muted<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('framework drain classifies outcomes from what reached the server', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4'), ref('m5'), ref('m6'), ref('m7')]);
    const calls: string[] = [];
    let connected = true;
    const connection = {
      get isConnected() { return connected; },
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.messageId}`);
        if (args.messageId === 'm2') return { isError: true, content: [{ type: 'text', text: 'Unknown Message' }] };
        if (args.messageId === 'm3') throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent');
        if (args.messageId === 'm4') throw new McplRequestError('did not respond', 'no-response');
        if (args.messageId === 'm6') throw new McplRequestError('Internal error', 'error-response', -32603);
        if (args.messageId === 'm7') throw new TypeError('transport went away');
        return { content: [{ type: 'text', text: 'Reaction applied' }] };
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    const alerts: Array<{ kind: string; message: string }> = [];
    framework.opsAlert = (kind: string, _agent: string, message: string) => { alerts.push({ kind, message }); };
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls.sort(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((m) => `add_reaction:${m}`));
    const status = new Map(h.outbox.operations().map((op) => [op.key.messageId, h.outbox.operationStatus(op)]));
    assert.equal(status.get('m1'), 'confirmed');
    assert.equal(status.get('m2'), 'failed', 'Discord said the message is gone: final');
    assert.equal(status.get('m3'), 'requested', 'never written: still queued');
    assert.equal(status.get('m4'), 'unknown', 'written, no answer: unknown');
    assert.equal(status.get('m6'), 'unknown', 'a JSON-RPC error may come after the server acted');
    assert.equal(status.get('m7'), 'unknown', 'an error the connection did not classify may follow a write');
    assert.equal(alerts.length, 1, 'one alert for the pass');
    assert.equal(alerts[0].kind, 'discord-awareness-delivery');
    assert.match(alerts[0].message, /^1 awareness mark operation\(s\) on discord won't be sent again.*add discord:g1:c1\/m2: failed: Unknown Message/);

    // A disconnected route leaves its work queued without writing anything.
    connected = false;
    const records = h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length;
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.equal(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length, records);

    // Back online: the unsent and the unknown (newest for their keys) go again.
    connected = true;
    calls.length = 0;
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls.sort(), ['add_reaction:m3', 'add_reaction:m4', 'add_reaction:m6', 'add_reaction:m7']);
  } finally {
    h.cleanup();
  }
});

test('a drain whose route goes away stops claiming: the rest stays queued, with no attempts written', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1'), ref('m2'), ref('m3')]);
    let connected = true;
    const calls: string[] = [];
    const connection = {
      get isConnected() { return connected; },
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        calls.push(String(args.messageId));
        connected = false; // the host is shutting down
        throw new McplRequestError('Connection to MCPL server "discord" closed while awaiting response', 'no-response');
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.equal(calls.length, 1);
    const attempts = h.outbox.operations().reduce((sum, op) => sum + op.attempts.length, 0);
    assert.equal(attempts, 1, 'only the request that was on the wire');
    assert.equal(h.outbox.pendingDispatches('discord').length, 3, 'its unknown and the two unsent stay due');
  } finally {
    h.cleanup();
  }
});

test('a retract made just after a drain finds nothing due is delivered on its own trigger', async () => {
  // A drain that had made its final claim but not yet left the registry was
  // handed the retract's trigger, and never looked again: the removal stayed
  // due until some unrelated trigger. Each depth puts the retract one
  // microtask further from that final claim.
  const sent: Record<number, string[]> = {};
  const due: Record<number, number> = {};
  for (const depth of [0, 1, 2, 3]) {
    const h = storeHarness();
    try {
      const batch = activeBatch(h.outbox, [ref('m1')]);
      const calls: string[] = [];
      const connection = {
        isConnected: true,
        sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
          calls.push(`${name}:${args.messageId}`);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      };
      const framework = Object.create(AgentFramework.prototype) as any;
      framework.discordAwarenessOutbox = h.outbox;
      framework.discordAwarenessDrains = new Map();
      framework.discordAwarenessDeadlineMs = 1000;
      framework.mcplServerRegistry = { getServer: () => connection };
      framework.operatorLog = new OperatorLog(undefined);
      framework.opsAlert = () => {};
      const claim = h.outbox.claimDispatch.bind(h.outbox);
      let retracted: Promise<void> | undefined;
      h.outbox.claimDispatch = (serverId, skip) => {
        const claimed = claim(serverId, skip);
        if (!claimed && !retracted) {
          retracted = Promise.resolve().then(async () => {
            for (let i = 0; i < depth; i++) await null;
            framework.retractDiscordAwareness(batch.id);
          });
        }
        return claimed;
      };
      await muted(async () => {
        await framework.drainDiscordAwarenessOutbox('discord');
        await retracted;
        while (framework.discordAwarenessDrains.size > 0) {
          await Promise.allSettled([...framework.discordAwarenessDrains.values()]);
        }
      });
      sent[depth] = calls;
      due[depth] = h.outbox.pendingDispatches('discord').length;
    } finally {
      h.cleanup();
    }
  }
  const delivered = ['add_reaction:m1', 'remove_reaction:m1'];
  assert.deepEqual(sent, { 0: delivered, 1: delivered, 2: delivered, 3: delivered });
  assert.deepEqual(due, { 0: 0, 1: 0, 2: 0, 3: 0 });
});

test('one drain pass per server: a request while its reply is out joins the pass, which sends the new work next', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1')]);
    const calls: string[] = [];
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });
    const connection = {
      isConnected: true,
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.messageId}`);
        if (calls.length === 1) await firstAnswered;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    await muted(async () => {
      const first = framework.drainDiscordAwarenessOutbox('discord');
      assert.deepEqual(calls, ['add_reaction:m1'], 'the first request leaves before the call returns');
      // Work for another message while m1's reply is out. Only the registry
      // holds it back: the per-key guard would let a second pass send it.
      activeBatch(h.outbox, [ref('m2')], { targetBranch: 'rollback/cairn/2' });
      const second = framework.drainDiscordAwarenessOutbox('discord');
      assert.equal(second, first, 'the running pass is joined');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ['add_reaction:m1'], 'nothing more leaves while the reply is out');
      answerFirst();
      assert.deepEqual(await first, { status: 'delivered', delivered: 2, failed: 0 });
      assert.deepEqual(calls, ['add_reaction:m1', 'add_reaction:m2'], 'the joined pass sent the new work');
      assert.equal(framework.discordAwarenessDrains.size, 0);
      // A pass with nothing due ends before its first await: never registered.
      void framework.drainDiscordAwarenessOutbox('discord');
      assert.equal(framework.discordAwarenessDrains.size, 0);
    });
  } finally {
    h.cleanup();
  }
});

test('framework finishes an interrupted suppression\'s removals and retires its marks, with an alert that names the redo', async () => {
  const h = storeHarness();
  try {
    const batch = h.outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'recovery/cairn/suppressed', activationPolicy: 'explicit',
      suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }, { fromId: 'i3', toId: 'i3' }], refs: [ref('m1')], scope: 'all',
    })!;
    const present = new Set(['i1', 'i2']); // i3 interval committed before crash.
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
    };
    // The body is recorded complete only once its removals are made.
    const complete = h.outbox.completeSuppression.bind(h.outbox);
    const presentAtCompletion: string[][] = [];
    h.outbox.completeSuppression = (batchId: string) => { presentAtCompletion.push([...present]); return complete(batchId); };
    const alerts: Array<{ kind: string; agent: string; message: string }> = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.store = { currentBranch: () => ({ name: 'recovery/cairn/suppressed' }) };
    framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);
    framework.opsAlert = (kind: string, agent: string, message: string) => { alerts.push({ kind, agent, message }); };
    await muted(() => framework.resumePreparedDiscordSuppressions());
    assert.deepEqual(presentAtCompletion, [[]], 'completed once, with the interval already removed');
    assert.deepEqual(removals, ['i1..i2']);
    const after = h.outbox.batches().find((candidate) => candidate.id === batch.id)!;
    assert.equal(after.status, 'discarded', 'a start never completes a surgery\'s marks');
    assert.equal(after.suppressionComplete, true);
    assert.deepEqual(h.outbox.pendingDispatches('discord'), []);
    assert.deepEqual(alerts.map((alert) => [alert.kind, alert.agent]), [['discord-awareness-not-scheduled', 'cairn']]);
    assert.equal(
      alerts[0]!.message,
      `The suppression of cairn from main onto recovery/cairn/suppressed (awareness batch ${batch.id}) was interrupted; ` +
        'this start finished its removals on recovery/cairn/suppressed. Its 1 awareness mark(s) weren\'t applied, ' +
        'since a start never completes a surgery\'s marks. To apply them, switch to main, which still has every message it ' +
        'removed, and redo the suppression there, onto a new branch name, with its marks',
    );
  } finally {
    h.cleanup();
  }
});

test('framework finishes the body of a suppression an operator cancelled, retires it, and raises no alert', async () => {
  const h = storeHarness();
  try {
    const batch = h.outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'recovery/cairn/suppressed', activationPolicy: 'explicit',
      suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }], refs: [ref('m1')], scope: 'all',
    })!;
    h.outbox.cancel(batch.id, 'operator');
    const present = new Set(['i1', 'i2']);
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
    };
    const alerts: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.store = { currentBranch: () => ({ name: 'recovery/cairn/suppressed' }) };
    framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);
    framework.opsAlert = (kind: string) => { alerts.push(kind); };
    await muted(() => framework.resumePreparedDiscordSuppressions());
    assert.deepEqual(removals, ['i1..i2'], 'the body is the store\'s integrity, whatever became of the marks');
    const after = new DiscordAwarenessOutbox(h.store).batches().find((candidate) => candidate.id === batch.id)!;
    assert.equal(after.suppressionComplete, true);
    assert.ok(after.cancelled);
    assert.equal(after.status, 'discarded', 'retired, never activated');
    assert.deepEqual(h.outbox.pendingDispatches('discord'), []);
    assert.deepEqual(alerts, [], 'its marks were cancelled, and its body is finished: nothing to redo');
  } finally {
    h.cleanup();
  }
});

test('a start retires a pre-release in-place batch with an alert that says the change stands and offers no redo', withJournal((outbox, h) => {
  // What a crash between a pre-release build's two appends for a hide or a
  // turn undo left: a batch for exactly its branch, with no intervals.
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'main', refs: [ref('m1'), ref('m2')], scope: 'all',
    activationPolicy: 'explicit',
  })!;
  const recovered = h.reopen().recoverAtStartup((name) => name === 'main');
  assert.deepEqual(recovered.retired.map((r) => [r.batchId, r.reason, r.marks, r.suppression]), [[batch.id, 'interrupted', 2, false]]);
  const alerts: Array<{ kind: string; message: string }> = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.opsAlert = (kind: string, _agent: string, message: string) => { alerts.push({ kind, message }); };
  framework.reportRetiredAwareness(recovered.retired[0]);
  assert.deepEqual(alerts, [{
    kind: 'discord-awareness-not-scheduled',
    message: `A hide or turn undo of cairn on main (awareness batch ${batch.id}) stands, but its 2 awareness mark(s) `
      + 'weren\'t applied: the process ended before they were activated, and a start never completes a surgery\'s marks. '
      + 'The change itself stands on that branch, so there is nothing to redo',
  }]);
}));

/** A framework stub whose agent context is a plain list (ids i0..), for host/command. */
function hostCommandFramework(h: ReturnType<typeof storeHarness>, messages: Array<{ id: string; metadata: Record<string, unknown> }>) {
  let currentBranch = 'main';
  const removed = new Set<string>();
  const live = () => messages.filter((m) => !removed.has(m.id));
  const contextManager = {
    getAllMessages: () => live(),
    getMessageCount: () => live().length,
    getMessageWindow: (offset: number, limit: number) => ({
      messages: live().slice(offset, offset + limit),
      startIndex: offset,
      totalCount: live().length,
    }),
    branchAt: (_id: string, name: string) => name,
    switchBranch: async (name: string) => { currentBranch = name; },
    removeMessage: (id: string) => { removed.add(id); },
    removeMessages: (from: string, to: string) => {
      const ids = messages.map((m) => m.id);
      for (const id of ids.slice(ids.indexOf(from), ids.indexOf(to) + 1)) removed.add(id);
    },
  };
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.agents = new Map([['cairn', { state: { status: 'idle' }, getContextManager: () => contextManager }]]);
  framework.store = { currentBranch: () => ({ name: currentBranch }), listBranches: () => [], sync: () => h.store.sync() };
  framework.discordAwarenessOutbox = h.outbox;
  framework.discordAwarenessEmoji = '🫥';
  framework.discordAwarenessDrains = new Map();
  framework.mcplServerRegistry = null;
  framework.moduleRegistry = { getModule: () => null };
  framework.lastVisiblePreview = async () => null;
  framework.activeTurnTokens = new Map();
  framework.nextTurnToken = 1;
  framework.deferredMessages = [];
  framework.pendingAssistantBlocks = new Map();
  // A host/command and a store surgery are operations stop() waits for.
  framework.operatorOperations = new Set();
  framework.operatorLog = new OperatorLog(undefined);
  framework.opsAlert = () => {};
  return { framework, removed, setBranch: (name: string) => { currentBranch = name; } };
}

test('message-granular host/command undo places no marks unless asked; the marks verb reaches the controls', async () => {
  const h = storeHarness();
  try {
    const { framework, setBranch, removed } = hostCommandFramework(h, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ]);
    const logged: Array<Record<string, any>> = [];
    framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
    await muted(async () => {
      // A mistyped choice is refused before anything is removed.
      const typo = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1, marks: 'adressed' });
      assert.equal(typo.ok, false);
      assert.match(typo.error, /marks must be none, addressed or all/);
      assert.equal(removed.size, 0, 'the refused undo removed nothing');
      // A verb that removes nothing takes no choice and ignores the field.
      const listedAnyway = await framework.handleHostCommand('discord', { command: 'marks', action: 'list', marks: null });
      assert.equal(listedAnyway.ok, true);

      const silent = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1 });
      assert.equal(silent.ok, true);
      assert.deepEqual(silent.markers, { scope: 'none', unmarked: 1, notRemoved: 0, status: 'none', queued: 0 });
      assert.equal(h.outbox.pendingDispatches('discord').length, 0);

      setBranch('main');
      const marked = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 3, marks: 'addressed' });
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      assert.equal(marked.markers.unmarked, 2);
      assert.deepEqual(h.outbox.pendingDispatches('discord').map((d) => `${d.key.messageId}${d.key.emoji}`), ['m1🫥']);

      const listed = await framework.handleHostCommand('discord', { command: 'marks', action: 'list' });
      assert.equal(listed.ok, true);
      const batch = listed.awareness.find((v: { kind: string }) => v.kind === 'batch');
      const cancelled = await framework.handleHostCommand('discord', { command: 'marks', action: 'cancel', target: batch.id, requesterName: 'op' });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.awareness.cancelled, 1);
      assert.equal(h.outbox.pendingDispatches('discord').length, 0);
      const missing = await framework.handleHostCommand('discord', { command: 'marks', action: 'retract' });
      assert.equal(missing.ok, false);
      // Each undo that removed messages records its marks choice and the
      // receipt it returned, and the verb's cancel records its act.
      const undos = logged.filter((entry) => entry.kind === 'rollback');
      assert.deepEqual(undos.map((entry) => [entry.params?.marks, entry.result?.markers]), [['none', silent.markers], [{ scope: 'addressed' }, marked.markers]]);
      const cancels = logged.filter((entry) => entry.kind === 'awareness-cancel');
      assert.deepEqual(cancels.map((entry) => [entry.params, entry.requester, entry.result]),
        [[{ target: batch.id }, { via: 'host-command:discord', name: 'op' }, cancelled.awareness]]);
    });
  } finally {
    h.cleanup();
  }
});

test('turn-based host/command undo honours the marks choice for the messages its turns removed', async () => {
  const h = storeHarness();
  try {
    const messages = [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } }, // arrived during the turn
      { id: 'i2', metadata: {} },                                          // the agent's reply
    ];
    const { framework, removed } = hostCommandFramework(h, messages);
    let turns = 1;
    framework.runUndoLastTurn = () => {
      if (turns === 0) return { undone: false };
      turns--;
      removed.add('i1');
      removed.add('i2');
      return { undone: true };
    };
    await muted(async () => {
      // Another agent sharing the store is mid-turn: refused, nothing undone.
      framework.activeTurnTokens.set('other', 99);
      const busy = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 2, marks: 'addressed' });
      assert.equal(busy.ok, false);
      assert.equal(busy.code, 'agent-busy');
      assert.equal(turns, 1);
      framework.activeTurnTokens.delete('other');

      const result = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 2, marks: 'addressed' });
      assert.equal(framework.surgeryHold, null, 'the reservation was released');
      assert.equal(result.ok, true);
      assert.equal(result.undone, 1);
      assert.equal(result.markers.status, 'queued');
      assert.equal(result.markers.queued, 1);
      assert.deepEqual(h.outbox.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
    });
  } finally {
    h.cleanup();
  }
});

test('a turn undo records its marks choice and what it scheduled in the operator log, also for marks none', async () => {
  const h = storeHarness();
  try {
    const messages = [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
      { id: 'i2', metadata: { ...ref('m2') } },
    ];
    const { framework, removed } = hostCommandFramework(h, messages);
    // Each stubbed turn undo removes the next of these from the context.
    let undoable = ['i1', 'i2'];
    framework.runUndoLastTurn = () => {
      const next = undoable[0];
      if (!next) return { undone: false };
      undoable = undoable.slice(1);
      removed.add(next);
      return { undone: true };
    };
    const logged: Array<Record<string, unknown>> = [];
    framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
    let marked: any;
    let local: any;
    await muted(async () => {
      marked = await framework.handleHostCommand('discord', {
        command: 'undo', agentName: 'cairn', turns: 1, marks: 'addressed', requesterName: 'op',
      });
      local = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 3 });
      const nothing = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 1, marks: 'all' });
      assert.equal(nothing.undone, 0);
    });
    assert.equal(marked.markers.status, 'queued');
    assert.equal(local.markers.status, 'none');
    assert.deepEqual(logged, [
      {
        kind: 'undo-turns',
        agent: 'cairn',
        requester: { via: 'host-command:discord', name: 'op' },
        params: { turns: 1, marks: { scope: 'addressed' } },
        result: { undone: 1, markers: marked.markers },
      },
      {
        kind: 'undo-turns',
        agent: 'cairn',
        requester: { via: 'host-command:discord' },
        params: { turns: 3, marks: 'none' },
        result: { undone: 1, markers: local.markers },
      },
    ], 'one entry per command that undid a turn, with the receipt it returned; none when nothing was undone');
  } finally {
    h.cleanup();
  }
});

test('host/command hide takes the store reservation and marks only on request, through the journal', async () => {
  const h = storeHarness();
  try {
    const { framework } = hostCommandFramework(h, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { channelId: 'discord:g1:c1', messageId: 'm1', tags: ['chat:addressed'] } }, // pre-serverId record
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ]);
    const logged: Array<Record<string, any>> = [];
    framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
    await muted(async () => {
      // Another agent sharing the store is mid-turn: hide refuses, removes nothing.
      framework.activeTurnTokens.set('other', 99);
      const busy = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm3' });
      assert.equal(busy.ok, false);
      assert.equal(busy.code, 'agent-busy');
      framework.activeTurnTokens.delete('other');

      const silent = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm3' });
      assert.equal(silent.ok, true);
      assert.equal(silent.markers.status, 'none');
      assert.equal(silent.markers.unmarked, 1);
      assert.equal(h.outbox.batches().length, 0);
      assert.equal(framework.surgeryHold, null, 'the reservation was released');

      const marked = await framework.handleHostCommand('discord', {
        command: 'hide', agentName: 'cairn', fromMessageId: 'm1', toMessageId: 'm2', marks: 'addressed',
      });
      assert.equal(marked.hidden, 2);
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      const [dispatch] = h.outbox.pendingDispatches('discord');
      assert.deepEqual(dispatch.key, { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1', emoji: '🫥' });
      assert.deepEqual(new DiscordAwarenessOutbox(h.store).recoverAtStartup(), { retired: [], unknownAttempts: 0, givenUp: 0 });
      // Each hide that removed messages records its marks choice and the
      // receipt it returned; the refused one records nothing.
      const hides = logged.filter((entry) => entry.kind === 'hide');
      assert.deepEqual(hides.map((entry) => [entry.params?.marks, entry.result?.markers]), [['none', silent.markers], [{ scope: 'addressed' }, marked.markers]]);
    });
  } finally {
    h.cleanup();
  }
});

const JOURNAL_APPEND = `append ${DISCORD_AWARENESS_RECORD_TYPE}`;
/** The call that just happened was a journal entry's append. */
const rightAfterAppend = (calls: string[]) => calls.at(-1) === JOURNAL_APPEND;
/** A journal entry has been appended (since the seams were made). */
const afterAnAppend = (calls: string[]) => calls.includes(JOURNAL_APPEND);

/**
 * The harness store with its journal seams observed and faultable. `fail`
 * makes calls at a seam throw while `matches` holds for the calls before
 * them (up to `times` of them): `before` the real call, so nothing reaches
 * the store, or `after` it, so it did. `unindexed` is an append as
 * Chronicle 0.4.0's can fail: the record is written to the log, the periodic
 * sync then throws, and the record stays out of this process's view of the
 * store (its lists and reads) until the store is reopened. A view of the
 * underlying store, as a restarted process has, sees it.
 */
function journalSeams(store: JsStore) {
  type Seam = 'sync' | 'append' | 'list';
  type When = 'before' | 'after' | 'unindexed';
  const calls: string[] = [];
  const hidden = new Set<string>();
  const faults: Array<{ seam: Seam; when: When; matches: (calls: string[]) => boolean; times: number }> = [];
  const through = <T>(seam: Seam, label: string, call: () => T, hide?: (result: T) => void): T => {
    const fault = faults.find((candidate) => candidate.seam === seam && candidate.times > 0 && candidate.matches(calls));
    calls.push(label);
    if (fault) fault.times--;
    if (fault?.when === 'before') throw new Error(`injected ${seam} failure`);
    const result = call();
    if (fault?.when === 'unindexed') {
      hide?.(result);
      throw new Error(`injected ${seam} failure after writing`);
    }
    if (fault?.when === 'after') throw new Error(`injected ${seam} failure`);
    return result;
  };
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === 'sync') return () => through('sync', 'sync', () => target.sync());
      if (prop === 'appendJson') {
        return (type: string, payload: unknown) => through(
          'append', `append ${type}`, () => target.appendJson(type, payload), (record) => hidden.add(record.id),
        );
      }
      if (prop === 'getRecordIdsByType') {
        return (type: string) => through('list', `list ${type}`, () => target.getRecordIdsByType(type).filter((id) => !hidden.has(id)));
      }
      if (prop === 'getRecord') return (id: string) => (hidden.has(id) ? null : target.getRecord(id));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    store: proxy as JsStore,
    calls,
    fail: (seam: Seam, when: When, matches: (calls: string[]) => boolean, times = 1) => {
      faults.push({ seam, when, matches, times });
    },
  };
}

/**
 * A hide with marks over a journal whose store faults as `arrange` says.
 * The removal shows in the calls as `remove`.
 */
async function hideOverFaultyJournal(arrange: (seams: ReturnType<typeof journalSeams>) => void) {
  const h = storeHarness();
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  outbox.batches(); // loaded before the hide, as a running framework's is
  const { framework, removed } = hostCommandFramework(h, [
    { id: 'i0', metadata: { ...ref('m0') } },
    { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
  ]);
  framework.discordAwarenessOutbox = outbox;
  framework.agents.get('cairn').getContextManager().removeMessage = (id: string) => {
    seams.calls.push('remove');
    removed.add(id);
  };
  const alerts: string[] = [];
  framework.opsAlert = (kind: string) => { alerts.push(kind); };
  arrange(seams);
  const result: any = await muted(() => framework.handleHostCommand('discord', {
    command: 'hide', agentName: 'cairn', fromMessageId: 'm1', marks: 'all',
  }));
  return { h, seams, outbox, result, alerts };
}

test('a hide records its batch only after the removal is synced: the batch can never outlive the change', async () => {
  const { h, seams, result } = await hideOverFaultyJournal(() => {});
  try {
    assert.equal(result.markers.status, 'queued');
    const removal = seams.calls.indexOf('remove');
    const batchAppend = seams.calls.indexOf(JOURNAL_APPEND, removal);
    assert.ok(removal >= 0 && batchAppend > removal, `calls: ${seams.calls.join(', ')}`);
    assert.ok(
      seams.calls.slice(removal, batchAppend).includes('sync'),
      `the removal is synced before the batch is appended: ${seams.calls.join(', ')}`,
    );
  } finally {
    h.cleanup();
  }
});

test('an applied change\'s batch that failed before reaching the store is not scheduled, and nothing delivers it', async () => {
  // The barrier sync between the removal and the batch's append fails:
  // nothing is written.
  const { h, result, alerts } = await hideOverFaultyJournal((seams) => {
    seams.fail('sync', 'before', (calls) => calls.includes('remove') && !afterAnAppend(calls));
  });
  try {
    assert.equal(result.ok, true, 'the hide stands');
    assert.equal(result.markers.status, 'not-scheduled');
    const fresh = new DiscordAwarenessOutbox(h.store);
    assert.equal(fresh.batches().length, 0, 'nothing was recorded');
    assert.deepEqual(fresh.recoverAtStartup(), { retired: [], unknownAttempts: 0, givenUp: 0 });
    assert.equal(fresh.pendingDispatches('discord').length, 0);
    assert.match(result.markers.error, /recording the batch failed: injected sync failure/);
    assert.deepEqual(alerts, ['discord-awareness-not-scheduled']);
  } finally {
    h.cleanup();
  }
});

test('an applied change\'s batch that reached the store before its barrier failed is queued, and the receipt follows it', async () => {
  // The append lands and its durability sync fails: the batch and its
  // activation are one entry, in the journal, so the operator's choice is
  // carried out rather than reported as never scheduled.
  const { h, result, alerts } = await hideOverFaultyJournal((seams) => {
    seams.fail('sync', 'before', rightAfterAppend);
  });
  try {
    assert.equal(result.markers.status, 'queued', 'not a not-scheduled receipt over a batch that would be delivered');
    assert.equal(result.markers.queued, 1);
    const fresh = new DiscordAwarenessOutbox(h.store);
    const [batch] = fresh.batches();
    assert.equal(batch.id, result.markers.batchId);
    assert.equal(batch.status, 'active');
    assert.deepEqual(fresh.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
    assert.deepEqual(fresh.recoverAtStartup(), { retired: [], unknownAttempts: 0, givenUp: 0 });
    assert.deepEqual(alerts, []);
  } finally {
    h.cleanup();
  }
});

test('an applied change\'s batch is one entry with its activation: once it lands, no later failure leaves it prepared', async () => {
  // The append lands, and every sync from its own on fails. The batch and
  // its activation landed together, so there is no prepared batch for a
  // start to retire: the marks are queued, and a start leaves them so.
  const { h, result, alerts } = await hideOverFaultyJournal((seams) => {
    seams.fail('sync', 'before', afterAnAppend, Number.POSITIVE_INFINITY);
  });
  try {
    assert.equal(result.markers.status, 'queued');
    const fresh = new DiscordAwarenessOutbox(h.store);
    const [batch] = fresh.batches();
    assert.equal(batch.id, result.markers.batchId);
    assert.equal(batch.status, 'active');
    assert.deepEqual(fresh.recoverAtStartup(), { retired: [], unknownAttempts: 0, givenUp: 0 });
    assert.deepEqual(fresh.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
    assert.deepEqual(alerts, []);
  } finally {
    h.cleanup();
  }
});

test('an applied change\'s batch whose journal cannot be read back after a failed write is unresolved, with its id', async () => {
  // The append lands, its durability sync fails, and the read-back fails.
  const { h, result, alerts } = await hideOverFaultyJournal((seams) => {
    seams.fail('sync', 'before', rightAfterAppend);
    seams.fail('list', 'before', afterAnAppend);
  });
  try {
    assert.equal(result.markers.status, 'unresolved');
    const [batch] = new DiscordAwarenessOutbox(h.store).batches();
    assert.equal(batch.id, result.markers.batchId, 'the receipt names the batch that may be delivered');
    assert.equal(batch.status, 'active', 'it landed, activation and all');
    assert.match(result.markers.error, /reading the journal back also failed: injected list failure/);
    assert.deepEqual(alerts, ['discord-awareness-unresolved']);
  } finally {
    h.cleanup();
  }
});

test('an applied change\'s batch written but out of this view of the store is unresolved, and the journal refuses until reopened', async () => {
  // The batch's append writes its record, then Chronicle's periodic sync
  // fails: the record is in the store's log, unindexed until a reopen. Read
  // back in this process, it would look like nothing was recorded.
  const { h, outbox, result, alerts } = await hideOverFaultyJournal((seams) => {
    seams.fail('append', 'unindexed', (calls) => calls.includes('remove'));
  });
  try {
    assert.equal(result.ok, true, 'the hide stands');
    assert.equal(result.markers.status, 'unresolved', 'not a not-scheduled receipt over a batch the next start may deliver');
    assert.match(result.markers.error, /recording the batch failed: injected append failure after writing.*until the store is reopened/);
    assert.deepEqual(alerts, ['discord-awareness-unresolved']);
    assert.throws(() => outbox.batches(), /can't be read in this process.*until the store is reopened/);
    assert.throws(() => outbox.claimDispatch('discord'), /until the store is reopened/);
    // The next start reads the entry and, as the receipt says it may,
    // delivers its marks: it holds the activation too.
    const fresh = new DiscordAwarenessOutbox(h.store);
    const [batch] = fresh.batches();
    assert.equal(batch.id, result.markers.batchId);
    assert.equal(batch.status, 'active');
    assert.deepEqual(fresh.recoverAtStartup(), { retired: [], unknownAttempts: 0, givenUp: 0 });
    assert.deepEqual(fresh.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
  } finally {
    h.cleanup();
  }
});

test('an activation written but out of this view is unresolved: nothing retires it, and the next start delivers it', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  const batch = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all' })!;
  seams.fail('append', 'unindexed', () => true);
  const settled = outbox.settleActivation(batch.id);
  assert.equal(settled.status, 'unresolved');
  assert.match((settled as { error: string }).error, /injected append failure after writing; retiring it also failed: .*until the store is reopened/);
  assert.throws(() => outbox.pendingDispatches('discord'), /until the store is reopened/);
  const fresh = new DiscordAwarenessOutbox(h.store);
  assert.equal(fresh.batches()[0].status, 'active', 'the activation reached the store, and no retirement follows it');
  assert.deepEqual(fresh.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
}));

test('a cancel written but out of this view: this process sends nothing more, and the next start reads the cancel', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  const batch = activeBatch(outbox, [ref('m1'), ref('m2')]);
  seams.fail('append', 'unindexed', () => true);
  assert.throws(() => outbox.cancel(batch.id), /injected append failure after writing/);
  assert.throws(() => outbox.claimDispatch('discord'), /until the store is reopened/, 'nothing is claimed from a view that may lack the cancel');
  assert.throws(() => outbox.view(), /until the store is reopened/);
  const fresh = new DiscordAwarenessOutbox(h.store);
  assert.ok(fresh.batches()[0].cancelled);
  assert.equal(fresh.pendingDispatches('discord').length, 0);
}));

test('a legacy import written but out of this view is not imported again in this process', withJournal((_outbox, h) => {
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 2,
    batches: [{
      id: 'old', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/1',
      emoji: '💤', createdAt: 1, refs: [{ ...ref('a1'), lastAction: 'add', desired: true, deliveryStatus: 'pending', attempts: 2, lastError: 'did not respond' }],
    }],
  }));
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store, { legacyPath: h.legacyPath });
  seams.fail('append', 'unindexed', () => true);
  assert.throws(() => outbox.batches(), /injected append failure after writing/);
  assert.throws(() => outbox.batches(), /until the store is reopened/, 'no second import is written');
  assert.equal(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length, 1);
  // The next start reads the one import, and the file it names isn't imported again.
  const fresh = h.reopen();
  const [view] = batches(fresh);
  assert.equal(view.id, 'old');
  assert.equal(view.legacy?.entries, 1);
  assert.equal(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length, 1);
}));

test('a prepare whose write failed says what the journal may hold, and retires a batch it can see', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  outbox.batches();
  const input = (n: number) => ({ agentName: 'cairn', sourceBranch: 'main', targetBranch: `rollback/cairn/${n}`, refs: [ref('m1')], scope: 'all' as const });
  // The record reached this view and its durability barrier failed: retired at once.
  seams.fail('sync', 'before', rightAfterAppend);
  assert.throws(() => outbox.prepare(input(1)), /recording awareness batch \S+ failed: injected sync failure; it reached the journal and is retired/);
  assert.deepEqual(new DiscordAwarenessOutbox(h.store).batches().map((b) => b.status), ['discarded']);
  // Written but out of this view: the next start retires it, and the error
  // says so. A rollback's batch claims no name: no start completes it.
  seams.fail('append', 'unindexed', () => true);
  assert.throws(() => outbox.prepare(input(2)), /may be in the store, unseen until the store is reopened, and if so the next start retires it, none of its marks sent\. Until a restart reopens the store, no branch can be made, since the journal can't be read$/);
  const fresh = new DiscordAwarenessOutbox(h.store);
  const recovered = fresh.recoverAtStartup((name) => name === 'main');
  assert.deepEqual(recovered.retired.map((r) => [r.targetBranch, r.reason]), [['rollback/cairn/2', 'interrupted']]);
}));

test('a suppression whose prepare was written out of this view: the error says no branch can be made until a restart', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  outbox.batches();
  seams.fail('append', 'unindexed', () => true);
  assert.throws(
    () => outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'fix-1', refs: [ref('m1')], scope: 'all',
      activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
    }),
    /if so the next start retires it, none of its marks sent\. Until a restart reopens the store, no branch can be made, since the journal can't be read$/,
  );
  const recovered = new DiscordAwarenessOutbox(h.store).recoverAtStartup((name) => name === 'main');
  assert.deepEqual(recovered.retired.map((r) => [r.targetBranch, r.reason]), [['fix-1', 'branch-gone']]);
}));

test('a suppression whose prepare and retirement both failed claims its branch name, cancelled or not, until a start retires it', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  outbox.batches();
  // The record reached this view and its durability barrier failed; the
  // retirement that follows fails at the sync before its write, which leaves
  // the journal readable here.
  seams.fail('sync', 'before', rightAfterAppend);
  seams.fail('sync', 'before', (calls) => calls.filter((call) => call === 'sync').length === 1);
  assert.throws(
    () => outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'fix-1', refs: [ref('m1')], scope: 'all',
      activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
    }),
    /recording awareness batch \S+ failed: injected sync failure; it reached the journal, and retiring it also failed \(injected sync failure\), so the next start retires it, none of its marks sent, and until then a branch named fix-1 is refused$/,
  );
  // This process reads the batch, so the framework's name check can refuse fix-1.
  const [claimed] = outbox.pendingSuppressionsFor('fix-1');
  assert.equal(claimed?.status, 'prepared');
  assert.deepEqual(outbox.pendingSuppressionsFor('fix-2'), []);
  // R1-1: a cancel stops its marks, not the removals a start on fix-1 would
  // apply, so the name stays claimed.
  outbox.cancel(claimed.id);
  assert.deepEqual(outbox.pendingSuppressionsFor('fix-1').map((b) => b.id), [claimed.id]);
  // A start that finds no branch named fix-1 gives the suppression up, and frees the name.
  const recovered = h.reopen().recoverAtStartup((name) => name === 'main');
  assert.deepEqual(recovered.retired.map((r) => [r.batchId, r.reason, r.marks]), [[claimed.id, 'branch-gone', 0]]);
  assert.deepEqual(h.reopen().pendingSuppressionsFor('fix-1'), []);
}));

test('an operation\'s status says first what Discord may have: an add on the wire that a retract superseded is dispatching, then unknown', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1')]);
  const claimed = outbox.claimDispatch('discord')!;
  outbox.retract(batch.id);
  const add = (journal: DiscordAwarenessOutbox) => journal.operations().find((op) => op.action === 'add')!;
  assert.ok(add(outbox).cancelled, 'the retract retired its later sends');
  assert.equal(outbox.operationStatus(add(outbox)), 'dispatching', 'its request is on the wire');
  outbox.recordOutcome(claimed.attempts, 'unknown');
  assert.equal(outbox.operationStatus(add(outbox)), 'unknown', 'never answered: it may have landed');
  assert.equal(batches(outbox)[0].adds.unknown, 1);
  assert.equal(batches(outbox)[0].adds.cancelled, 0);
  const restarted = h.reopen();
  assert.equal(restarted.operationStatus(add(restarted)), 'unknown');
  // An add retired before it was ever sent is just cancelled.
  const second = activeBatch(restarted, [ref('m2')]);
  restarted.cancel(second.id);
  const unsent = restarted.operations().find((op) => op.key.messageId === 'm2')!;
  assert.equal(restarted.operationStatus(unsent), 'cancelled');
}));

test('an operation is not sent again after three attempts that reached the server unconfirmed; one refused before it left does not count', withJournal((outbox) => {
  activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  const op = (messageId: string) => outbox.operations().find((o) => o.key.messageId === messageId)!;
  const due = () => outbox.pendingDispatches('discord').map((d) => d.key.messageId).sort();
  // m1: a refusal the pattern doesn't know, three times.
  assert.equal(answer(outbox, 'm1', 'failed', { error: 'Internal Server Error' }).ended, 0);
  assert.equal(outbox.operationStatus(op('m1')), 'requested');
  assert.equal(answer(outbox, 'm1', 'failed', { error: 'Internal Server Error' }).ended, 0);
  assert.equal(answer(outbox, 'm1', 'failed', { error: 'Internal Server Error' }).ended, 1, 'the third ends it');
  assert.equal(outbox.operationStatus(op('m1')), 'failed');
  // m2: twice refused before it left (the route was down), then three unanswered requests.
  answer(outbox, 'm2', 'not-sent');
  answer(outbox, 'm2', 'not-sent');
  assert.equal(answer(outbox, 'm2', 'unknown').ended, 0);
  assert.equal(answer(outbox, 'm2', 'unknown').ended, 0);
  assert.equal(answer(outbox, 'm2', 'unknown').ended, 1);
  assert.equal(outbox.operationStatus(op('m2')), 'unknown', 'it may have landed');
  // m3: refused for good at once.
  assert.equal(answer(outbox, 'm3', 'failed', { permanent: true, error: 'Unknown Message' }).ended, 1);
  assert.deepEqual(due(), [], 'none of them is sent again');
  assert.equal(op('m2').attempts.length, 5);
}));

test('an attempt the previous process left on the wire counts toward the bound, and the start that reaches it says so', withJournal((outbox, h) => {
  activeBatch(outbox, [ref('m1')]);
  assert.equal(answer(outbox, 'm1', 'unknown').ended, 0);
  assert.equal(answer(outbox, 'm1', 'unknown').ended, 0);
  // The third request goes out, and the process ends before its answer.
  assert.ok(outbox.claimDispatch('discord'));
  const recovered = h.reopen().recoverAtStartup();
  assert.equal(recovered.unknownAttempts, 1);
  assert.equal(recovered.givenUp, 1, 'its third unconfirmed attempt ends it');
  const restarted = h.reopen();
  assert.deepEqual(restarted.pendingDispatches('discord'), [], 'it is not sent again');
  assert.equal(restarted.recoverAtStartup().givenUp, 0, 'a later start reports nothing more');
}));

test('Discord refusals that no retry can change are permanent', () => {
  for (const text of ['Unknown Message', 'Unknown Channel', 'Unknown Emoji', 'Missing Access', 'Missing Permissions',
    'Missing Permission', 'Cannot access this channel', 'Channel 123456789012345678 not found',
    'Message 123456789012345678 not found', 'Maximum number of reactions reached (20)', 'Reaction was blocked']) {
    assert.equal(isPermanentDiscordReactionFailure(text), true, text);
  }
  for (const text of ['Internal Server Error', 'You are being rate limited.', 'did not respond within 10000ms']) {
    assert.equal(isPermanentDiscordReactionFailure(text), false, text);
  }
});

test('an operator\'s request the journal won\'t carry out is a refusal; a journal failure is not', withJournal((_outbox, h) => {
  const seams = journalSeams(h.store);
  const outbox = new DiscordAwarenessOutbox(seams.store);
  const batch = activeBatch(outbox, [ref('m1')]);
  assert.throws(() => outbox.cancel('no-such-batch'), DiscordAwarenessRefusal);
  assert.throws(() => outbox.retract('no-such-batch'), DiscordAwarenessRefusal);
  assert.throws(() => outbox.release(batch.id), (error) => error instanceof DiscordAwarenessRefusal && /is active, not held/.test(error.message));
  seams.fail('sync', 'before', () => true);
  assert.throws(() => outbox.cancel(batch.id), (error) => !(error instanceof DiscordAwarenessRefusal) && /injected sync failure/.test((error as Error).message));
}));

test('a version 1 ledger\'s import is recorded as v1', withJournal((_outbox, h) => {
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify({
    version: 1,
    batches: [{ id: 'v1-batch', status: 'pending', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/1', emoji: '💤', createdAt: 1, refs: [ref('a1')] }],
  }));
  h.reopen().batches();
  const records = h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE)
    .flatMap((id) => (JSON.parse(Buffer.from(h.store.getRecord(id)!.payload).toString('utf-8')) as { records: Array<{ t: string; source?: string }> }).records);
  assert.deepEqual(records.filter((record) => record.t === 'import-complete').map((record) => record.source), ['v1']);
}));

test('a sync for one server drains only that server', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1'), { serverId: 'discord-b', channelId: 'discord:g2:c1', messageId: 'n1' }]);
    const calls: string[] = [];
    const connection = (id: string) => ({
      isConnected: true,
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        calls.push(`${id}:${args.messageId}`);
        return { content: [{ type: 'text', text: 'Reaction added' }] };
      },
    });
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: (id: string) => connection(id) };
    // A sync is an operator's operation, which stop() waits for.
    framework.operatorOperations = new Set();
    await muted(() => framework.syncDiscordAwarenessMarkers('discord-b'));
    assert.deepEqual(calls, ['discord-b:n1']);
    await muted(() => framework.syncDiscordAwarenessMarkers());
    assert.deepEqual(calls, ['discord-b:n1', 'discord:m1']);
  } finally {
    h.cleanup();
  }
});
