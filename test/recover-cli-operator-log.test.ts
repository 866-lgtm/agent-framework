/**
 * `agent-framework-recover` records its acts in the store's operator log.
 *
 * The live surfaces record every operator mutation (who asked, from where,
 * what it did) in `<store>/operator-actions.jsonl`. The CLI acts on the same
 * store while the host is stopped: an offline recovery, which can choose to
 * publish awareness marks, and the awareness controls (cancel, retract,
 * release). Each is recorded the same way, done or refused, so the history
 * says who chose to publish or stop marks whichever surface they used. A dry
 * run and a list change nothing and record nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import type { OperatorLogEntry } from '../src/operator-log.js';

const CLI = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));

function recover(storePath: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, '--store', storePath, ...args], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function operatorLog(storePath: string): OperatorLogEntry[] {
  const path = join(storePath, 'operator-actions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as OperatorLogEntry);
}

const ref = (messageId: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId });

test('the offline awareness controls record each act in the operator log, done or refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const outbox = new DiscordAwarenessOutbox(store);
    const batch = outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
    })!;
    outbox.activate(batch.id);
    store.close();

    const listed = recover(storePath, '--awareness', 'list');
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(operatorLog(storePath), [], 'a list changes nothing and records nothing');

    const cancelled = recover(storePath, '--awareness', 'cancel', batch.id);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const receipt = JSON.parse(cancelled.stdout) as Record<string, unknown>;
    assert.equal(receipt.cancelled, 2);
    // What the CLI says it did is what the journal now holds.
    const journal = () => {
      const reopened = JsStore.open({ path: storePath });
      try {
        const reader = new DiscordAwarenessOutbox(reopened);
        return { batches: reader.batches(), operations: reader.operations() };
      } finally {
        reopened.close();
      }
    };
    assert.ok(journal().batches[0].cancelled, 'the cancel is in the journal');
    assert.ok(journal().operations.every((op) => op.cancelled?.reason === 'batch-cancelled'));

    const retracted = recover(storePath, '--awareness', 'retract', 'all');
    assert.equal(retracted.status, 0, retracted.stderr);
    assert.deepEqual(
      journal().operations.filter((op) => op.action === 'remove' && !op.cancelled).map((op) => op.key.messageId).sort(),
      ['m1', 'm2'],
      'the retract\'s removals are in the journal',
    );

    const refused = recover(storePath, '--awareness', 'release', batch.id);
    assert.equal(refused.status, 1, 'releasing a batch that is not held is refused');

    const entries = operatorLog(storePath);
    assert.deepEqual(entries.map((entry) => entry.kind), ['awareness-cancel', 'awareness-retract', 'awareness-release']);
    for (const entry of entries) {
      assert.equal(entry.agent, '*');
      assert.equal(entry.requester?.via, 'cli');
      assert.equal(entry.requester?.name, userInfo().username, 'the OS account that ran it');
      assert.ok(entry.at);
    }
    assert.deepEqual(entries[0].params, { target: batch.id });
    assert.deepEqual(entries[0].result, receipt);
    assert.deepEqual(entries[1].params, { target: 'all' });
    assert.equal(entries[1].result?.removalsQueued, 2);
    assert.deepEqual(entries[2].params, { batchId: batch.id });
    assert.equal(entries[2].result, undefined);
    assert.match(entries[2].error ?? '', /is active, not held/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run with an awareness control is refused before the store opens: nothing is done or recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  const journal = () => {
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const outbox = new DiscordAwarenessOutbox(store);
      return { view: outbox.view(), operations: outbox.operations() };
    } finally {
      store.close();
    }
  };
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const outbox = new DiscordAwarenessOutbox(store);
    const active = outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all',
    })!;
    outbox.activate(active.id);
    // Only an import holds a batch: a pre-journal ledger's undelivered work.
    const legacyPath = join(storePath, 'recovery', 'discord-awareness-outbox.json');
    mkdirSync(join(storePath, 'recovery'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 2,
      batches: [{
        id: 'held-1', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/interrupted',
        emoji: '💤', createdAt: 1, refs: [{ ...ref('m2'), desired: false, markerPresent: false, deliveryStatus: 'applied' }],
      }],
    }));
    new DiscordAwarenessOutbox(store, { legacyPath }).batches();
    const held = { id: 'held-1' };
    store.close();
    const before = journal();
    const heldView = before.view.find((v) => v.id === held.id);
    assert.equal(heldView?.kind === 'batch' ? heldView.status : undefined, 'held');

    for (const control of [['cancel', active.id], ['retract', 'all'], ['release', held.id]]) {
      const run = recover(storePath, '--awareness', ...control, '--dry-run');
      assert.equal(run.status, 1, `${control[0]} --dry-run is refused`);
      assert.match(run.stderr, /--dry-run previews a recovery; it does not apply to --awareness/);
    }
    assert.deepEqual(journal(), before, 'nothing was cancelled, retracted or released');
    assert.deepEqual(operatorLog(storePath), [], 'and nothing was recorded');

    const missing = join(dir, 'no-such-store');
    const refusedFirst = recover(missing, '--awareness', 'cancel', active.id, '--dry-run');
    assert.equal(refusedFirst.status, 1);
    assert.match(refusedFirst.stderr, /--dry-run previews a recovery; it does not apply to --awareness/,
      'the dry-run refusal answers, not the missing store');
    assert.equal(existsSync(missing), false, 'refused before any store is opened or created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline recovery records its marks choice and receipt in the operator log; a dry run records nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { ...ref('m-safe') });
    cm.addMessage('user', [{ type: 'text', text: 'one' }], { ...ref('m-1'), tags: ['chat:addressed'] });
    cm.addMessage('user', [{ type: 'text', text: 'two' }], { ...ref('m-2'), tags: ['chat:ambient'] });
    cm.close();
    store.close();

    const dry = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--marks', 'addressed', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(operatorLog(storePath), [], 'a dry run changes nothing and records nothing');
    const failedDry = recover(storePath, '--agent', 'cairn', '--message-id', 'no-such-message', '--marks', 'addressed', '--dry-run');
    assert.equal(failedDry.status, 1, failedDry.stdout);
    assert.deepEqual(operatorLog(storePath), [], 'nor does one that fails');

    const done = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--marks', 'addressed', '--branch', 'recovery/cairn/1');
    assert.equal(done.status, 0, done.stderr);
    const output = JSON.parse(done.stdout) as { markers: Record<string, unknown> };

    const again = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--branch', 'main');
    assert.equal(again.status, 1, 'a recovery onto an existing branch is refused');

    const [recorded, refused, ...rest] = operatorLog(storePath);
    assert.equal(rest.length, 0);
    assert.equal(recorded.kind, 'recovery');
    assert.equal(recorded.agent, 'cairn');
    assert.equal(recorded.requester?.via, 'cli');
    assert.equal(recorded.requester?.name, userInfo().username, 'the OS account that ran it');
    assert.deepEqual(recorded.params, { messageId: 'm-safe', marks: { scope: 'addressed' } });
    assert.deepEqual(recorded.result, {
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/1',
      messagesRemoved: 2,
      messagesSuppressed: 0,
      discordRefs: 2,
      markers: output.markers,
    });
    assert.equal((recorded.result?.markers as { status: string; queued: number }).status, 'queued');
    assert.equal((recorded.result?.markers as { status: string; queued: number }).queued, 1);

    assert.equal(refused.kind, 'recovery');
    assert.deepEqual(refused.params, { messageId: 'm-safe', marks: 'none' });
    assert.match(refused.error ?? '', /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path that holds no store is refused, never created, for a list, a control or a recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  try {
    const missing = join(dir, 'no-such-store');
    for (const args of [['--awareness', 'list'], ['--awareness', 'cancel', 'b1'], ['--agent', 'cairn', '--message-id', 'm1']]) {
      const run = recover(missing, ...args);
      assert.equal(run.status, 1, args.join(' '));
      assert.match(run.stderr, /No Chronicle store could be opened at/);
      assert.equal(existsSync(missing), false, `${args.join(' ')} created nothing there`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovery\'s options with an awareness verb are refused, not ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const outbox = new DiscordAwarenessOutbox(store);
    const batch = outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all',
    })!;
    outbox.activate(batch.id);
    store.close();
    const run = recover(storePath, '--awareness', 'retract', 'all', '--marks', 'all', '--branch', 'x');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--awareness takes only --store and --outbox; --marks, --branch belong to a recovery/);
    const reopened = JsStore.open({ path: storePath });
    try {
      assert.equal(new DiscordAwarenessOutbox(reopened).operations().filter((op) => op.action === 'remove').length, 0, 'nothing was retracted');
    } finally {
      reopened.close();
    }
    assert.deepEqual(operatorLog(storePath), [], 'and nothing was recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mistyped marks choice, an awareness verb it doesn\'t know, and --awareness without --store are refused, recording nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    JsStore.openOrCreate({ path: storePath }).close();
    const typo = recover(storePath, '--agent', 'cairn', '--message-id', 'm-1', '--marks', 'adressed');
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /--marks must be none, addressed or all/);
    const unknownVerb = recover(storePath, '--awareness', 'purge');
    assert.equal(unknownVerb.status, 1);
    assert.match(unknownVerb.stderr, /--awareness must be list, cancel <ID>, retract <ID\|all> or release <ID>/);
    const storeless = spawnSync(process.execPath, [CLI, '--awareness', 'list'], { encoding: 'utf8' });
    assert.equal(storeless.status, 1);
    assert.match(storeless.stderr, /--awareness needs --store/);
    assert.deepEqual(operatorLog(storePath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a control still acts when the operator log can\'t be written, and says the log failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const outbox = new DiscordAwarenessOutbox(store);
    const batch = outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
    })!;
    outbox.activate(batch.id);
    store.close();
    // A directory where the log file goes: every append to it fails.
    mkdirSync(join(storePath, 'operator-actions.jsonl'));
    const cancelled = recover(storePath, '--awareness', 'cancel', batch.id);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal((JSON.parse(cancelled.stdout) as { cancelled: number }).cancelled, 2);
    assert.match(cancelled.stderr, /\[operator-log\] failed to write \S*operator-actions\.jsonl/);
    const reopened = JsStore.open({ path: storePath });
    try {
      assert.ok(new DiscordAwarenessOutbox(reopened).batches()[0].cancelled, 'the cancel is in the journal');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
