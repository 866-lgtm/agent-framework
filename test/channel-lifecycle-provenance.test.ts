import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry, desiredStateInLog } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/**
 * Desired-state provenance: a server upgrading its descriptor to
 * initiallyOpen may lift a pure default ('default-closed' = nobody ever
 * decided), but must never override a real decision (agent-tool,
 * invitation-declined). Regression for the eidoverse-worlds case where a
 * resident's world channel stayed shadow-closed forever because the default
 * predated the server declaring its bootstrap preference.
 */

function makeRegistry(store?: JsStore) {
  const serverRegistry = {
    getServer: (_id: string) => ({ sendChannelsPublish: async () => ({ delivered: true }) }),
  } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    store ? { store } : undefined,
  );
  const r = registry as unknown as {
    ensureInitialDesiredState(serverId: string, ch: { id: string; type: string; label: string; direction: string; initiallyOpen?: boolean }): void;
    setDesiredState(serverId: string, channelId: string, desired: 'open' | 'closed', source: string): void;
    getDesiredState(serverId: string, channelId: string): 'open' | 'closed' | undefined;
  };
  return { registry, r };
}

const ch = (initiallyOpen?: boolean) => ({
  id: 'world:commons', type: 'world', label: 'eidoverse — commons', direction: 'bidirectional', initiallyOpen,
});

test('default-closed is lifted when the server later declares initiallyOpen', () => {
  const { r } = makeRegistry();
  // first registration: server said nothing → default-closed
  r.ensureInitialDesiredState('eidoverse', ch(undefined));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
  // server upgrades its descriptor: bootstrap preference lifts the pure default
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
});

test('an agent decision to close is never overridden by initiallyOpen', () => {
  const { r } = makeRegistry();
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
  // the agent deliberately closes their door
  r.setDesiredState('eidoverse', 'world:commons', 'closed', 'agent-tool');
  // server keeps declaring initiallyOpen — the decision sticks
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
});

test('initiallyOpen at first sight registers open with server-bootstrap provenance', () => {
  const { r } = makeRegistry();
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
});

test("desiredStateOf finds a channel's decision by its id alone: its registered server's, else the one server's on record", () => {
  const { registry, r } = makeRegistry();
  r.setDesiredState('a', 'c-1', 'open', 'opened-by-reply');
  assert.equal(registry.desiredStateOf('c-1'), 'open', 'the one decision on record');
  r.setDesiredState('b', 'c-1', 'closed', 'agent-tool');
  assert.equal(registry.desiredStateOf('c-1'), undefined, 'decisions on two servers, and neither registers it');
  (registry as unknown as { channels: Map<string, unknown> }).channels
    .set('a:c-1', { serverId: 'a', descriptor: { id: 'c-1', type: 'a', label: '#one' }, open: false });
  assert.equal(registry.desiredStateOf('c-1'), 'open', 'the registered server\'s');
  assert.equal(registry.desiredStateOf('c-2'), undefined, 'none on record');
});

test("desiredStateInLog reads a channel's last decision from a store's lifecycle log, as a registry replayed from it does", () => {
  const dir = mkdtempSync(join(tmpdir(), 'desired-state-in-log-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    assert.equal(desiredStateInLog(store, 'c-1'), undefined, 'a store no registry has written to');
    const { r } = makeRegistry(store);
    r.setDesiredState('a', 'c-1', 'open', 'opened-by-reply');
    r.setDesiredState('a', 'c-1', 'closed', 'agent-tool');
    r.setDesiredState('a', 'c-2', 'open', 'opened-by-reply');
    r.setDesiredState('a', 'c-3', 'open', 'opened-by-reply');
    r.setDesiredState('b', 'c-3', 'closed', 'agent-tool');
    assert.equal(desiredStateInLog(store, 'c-1'), 'closed', 'the last decision wins');
    assert.equal(desiredStateInLog(store, 'c-2'), 'open');
    assert.equal(desiredStateInLog(store, 'c-3'), undefined, 'decisions on two servers');
    assert.equal(desiredStateInLog(store, 'c-4'), undefined, 'none on record');
    const replayed = makeRegistry(store).registry;
    for (const id of ['c-1', 'c-2', 'c-3', 'c-4']) assert.equal(replayed.desiredStateOf(id), desiredStateInLog(store, id), id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
