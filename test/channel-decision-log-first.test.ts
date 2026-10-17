/**
 * A durable write that fails leaves memory as it was (the first part of
 * #417). Each writer of the channel registry's lifecycle and label logs
 * appends to the store before it changes memory. So an operation whose
 * append throws, as on a full disk, fails without its change, a retry
 * records it rather than taking a same-state return, and a registry rebuilt
 * from the store replays what memory held. Before, memory changed first: a retried `channel_close`
 * reported success without recording anything, and after a restart the
 * old record came back, so subscription policy could lift a close the
 * agent had been told succeeded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry, type TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const LIFECYCLE = 'mcpl/channel-lifecycle';
const LABELS = 'mcpl/channel-label-history';
const DISK_FULL = /ENOSPC: no space left on device/;

type Write = { id: string; item: unknown };

/**
 * The real store, made to throw on one chosen append as a full disk would.
 * It carries the calls the registry makes here.
 */
function failingStore(path: string) {
  const real = JsStore.openOrCreate({ path });
  let chosen: ((write: Write) => boolean) | undefined;
  const throwIfChosen = (write: Write) => {
    if (chosen?.(write)) {
      chosen = undefined;
      throw new Error('ENOSPC: no space left on device');
    }
  };
  const store = {
    registerState: (opts: Parameters<JsStore['registerState']>[0]) => real.registerState(opts),
    getStateJson: (id: string) => real.getStateJson(id),
    appendToStateJson: (id: string, item: unknown) => {
      throwIfChosen({ id, item });
      return real.appendToStateJson(id, item as never);
    },
  } as unknown as JsStore;
  return {
    store,
    failNext: (choose: (write: Write) => boolean) => {
      chosen = choose;
    },
  };
}

function withStore(
  name: string,
  body: (store: ReturnType<typeof failingStore>) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), `${name}-`));
    try {
      await body(failingStore(join(dir, 'store')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function makeRegistry(store: JsStore) {
  const closeCalls: string[] = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async (params: { channelId: string }) => {
      closeCalls.push(params.channelId);
      return {};
    },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { store },
  );
  return { registry, closeCalls };
}

/** The decision on record in memory, with its source. */
function decision(registry: ChannelRegistry, channelId: string) {
  const internals = registry as unknown as {
    desiredStates: Map<string, { state: string; source: string }>;
    lifecycleKey(serverId: string, channelId: string): string;
  };
  const record = internals.desiredStates.get(internals.lifecycleKey('discord', channelId));
  return record && { state: record.state, source: record.source };
}

const commons = { id: 'c1', type: 'discord', label: '#commons', direction: 'bidirectional' as const };
const ops = { id: 'c2', type: 'discord', label: '#ops', direction: 'bidirectional' as const };

const PARAMS: TuneOutParams = {
  epochId: 'epoch-1',
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
  startedAtSequence: 42,
};

const lifecycleWrite = ({ id }: Write) => id === LIFECYCLE;

test('a channel_close whose record fails to append fails and leaves the channel open; its retry records the close a restart replays', withStore('log-first-close', async ({ store, failNext }) => {
  const { registry, closeCalls } = makeRegistry(store);
  await registry.handleRegister('discord', { channels: [commons] });
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'c1' })).success, true);
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'agent-tool' });
  const closesBefore = closeCalls.length;

  failNext(lifecycleWrite);
  await assert.rejects(registry.handleChannelToolCall('channel_close', { channelId: 'c1' }), DISK_FULL);
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'agent-tool' });
  assert.equal(closeCalls.length, closesBefore, 'nothing went to the server');

  const retried = await registry.handleChannelToolCall('channel_close', { channelId: 'c1' });
  assert.deepEqual(retried.data, { channelId: 'c1', status: 'closed' });
  assert.deepEqual(decision(registry, 'c1'), { state: 'closed', source: 'agent-tool' });

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(decision(restarted, 'c1'), { state: 'closed', source: 'agent-tool' });
}));

test('a tune-out whose record fails to append fails and leaves the channel undecided; its retry is what a restart replays', withStore('log-first-tune-out', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  failNext(lifecycleWrite);
  assert.throws(() => registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool'), DISK_FULL);
  assert.equal(registry.getDesiredState('discord', 'c1'), undefined);
  assert.equal(registry.getTuneOutState('discord', 'c1'), null);

  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 0 });
}));

test('a tune-out wake whose record fails to append fails uncounted; its retry counts once, as a restart replays', withStore('log-first-wake', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');

  failNext(lifecycleWrite);
  assert.throws(() => registry.recordTuneOutWake('discord', 'c1'), DISK_FULL);
  assert.deepEqual(registry.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 0 });

  assert.deepEqual(registry.recordTuneOutWake('discord', 'c1'), { params: PARAMS, wakeCount: 1 });
  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.getTuneOutState('discord', 'c1'), { params: PARAMS, wakeCount: 1 });
}));

test('a tune-out cancel whose record fails to append fails and leaves the tune-out in place; its retry ends it, as a restart replays', withStore('log-first-cancel', ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.enterTuneOut('discord', 'c1', PARAMS, 'agent-tool');

  failNext(lifecycleWrite);
  assert.throws(() => registry.cancelTuneOut('discord', 'c1', 'open', 'agent-tool'), DISK_FULL);
  assert.equal(registry.getDesiredState('discord', 'c1'), 'tuned-out');

  assert.deepEqual(registry.cancelTuneOut('discord', 'c1', 'open', 'agent-tool'), { params: PARAMS, wakeCount: 0 });
  const restarted = makeRegistry(store).registry;
  assert.equal(restarted.getDesiredState('discord', 'c1'), 'open');
  assert.equal(restarted.getTuneOutState('discord', 'c1'), null);
}));

test('a recipe migration whose record fails to append runs again at the next registration, so after a restart a new channel is one nobody decided about', withStore('log-first-migration', async ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  registry.setSubscriptionPolicy('discord', ['c1']);
  failNext(({ id, item }) => id === LIFECYCLE && (item as { kind?: string }).kind === 'legacy-policy-migrated');
  await assert.rejects(registry.handleRegister('discord', { channels: [commons] }), DISK_FULL);
  await registry.handleRegister('discord', { channels: [commons] });
  assert.deepEqual(decision(registry, 'c1'), { state: 'open', source: 'legacy-recipe-migration' });

  // The recipe's allow-list doesn't name c2. Migrated again, it would
  // record c2 closed as the recipe's decision, which policy never lifts.
  const restarted = makeRegistry(store).registry;
  restarted.setSubscriptionPolicy('discord', ['c1']);
  await restarted.handleRegister('discord', { channels: [commons, ops] });
  assert.deepEqual(decision(restarted, 'c2'), { state: 'closed', source: 'default-closed' });
}));

test('a label sighting whose record fails to append is recorded at the next sighting, so a restart still finds the channel by its label', withStore('log-first-label', async ({ store, failNext }) => {
  const { registry } = makeRegistry(store);
  failNext(({ id }) => id === LABELS);
  await assert.rejects(registry.handleRegister('discord', { channels: [commons] }), DISK_FULL);
  await registry.handleRegister('discord', { channels: [commons] });

  const restarted = makeRegistry(store).registry;
  assert.deepEqual(restarted.resolveProseTargetDurable('#commons'), { channelId: 'c1', label: '#commons' });
}));
