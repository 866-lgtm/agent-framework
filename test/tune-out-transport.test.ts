/**
 * A tune-out keeps its channel's transport open, since the subconscious can
 * watch only the traffic that arrives (TuneOutParams). tune_out records the
 * tune-out, then opens a closed transport through the channel's lifecycle
 * queue (openForTuneOut), behind any work in flight, and writes no decision
 * of its own there, so the tune-out stands whatever becomes of the open.
 * Where the transport doesn't end open, tune_out's answer is still a success,
 * since the tune-out is recorded, and its openError says why none of the
 * channel's messages reach the subconscious yet and when they will. A decline
 * of a tuned-out channel is refused, whatever its transport, since a decline
 * recorded over the tune-out would end it without its cancel, and lose the
 * backlog the cancel delivers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { ScriptToolResult } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { TuneOutParams } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { ChannelDescriptor } from '../src/mcpl/types.js';
import { TUNE_OUT_DEFAULTS } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function descriptor(id: string): ChannelDescriptor {
  return { id, type: 'test', label: id, direction: 'bidirectional', address: { value: id } };
}

function grant(without: string[] = []): CapabilityGrant {
  return new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((path) => !without.includes(path))), []);
}

/** A server as the registry reads one, recording each lifecycle request it
 *  takes, in order, as `open <id>` or `close <id>`. */
interface Server {
  grant: CapabilityGrant;
  isConnected?: boolean;
  willReconnect?: boolean;
  sent: string[];
  sendChannelsOpen(params: { channelId: string }): Promise<unknown>;
  sendChannelsClose(params: { channelId: string }): Promise<unknown>;
  sendChannelsAcknowledge(params: { channelId: string }): Promise<{ acknowledged: boolean }>;
}

function up(without: string[] = []): Server {
  const sent: string[] = [];
  return {
    grant: grant(without),
    sent,
    sendChannelsOpen: async ({ channelId }) => { sent.push(`open ${channelId}`); return { channel: descriptor(channelId) }; },
    sendChannelsClose: async ({ channelId }) => { sent.push(`close ${channelId}`); return {}; },
    sendChannelsAcknowledge: async ({ channelId }) => { sent.push(`ack ${channelId}`); return { acknowledged: true }; },
  };
}

const PARAMS: TuneOutParams = { epochId: 'e1', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A registry with server "a" and its channel "y", which registration
 *  leaves closed and the agent's channel_close keeps so: its transport is
 *  confirmed closed. */
async function closedChannel() {
  const servers = new Map<string, Server>();
  const server = up();
  servers.set('a', server);
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
  );
  await registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  assert.equal((closed.data as { status?: string } | undefined)?.status, 'already closed');
  server.sent.length = 0;
  const isOpen = () => (registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get('a:y')?.open;
  assert.equal(isOpen(), false);
  return { registry, servers, server, isOpen };
}

test('a tune-out of a closed, registered channel opens its transport', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, ['open y']);
  assert.equal(f.isOpen(), true);
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out', 'the open wrote no decision of its own');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1');
});

test('a tune-out of an open channel with nothing pending sends nothing', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  assert.deepEqual(f.server.sent, []);
});

test('a tune-out recorded while a close is out waits for that work, which opens the channel, rather than send a second open', async () => {
  const f = await closedChannel();
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'y' });
  f.server.sent.length = 0;
  let release!: () => void;
  const close = f.server.sendChannelsClose;
  f.server.sendChannelsClose = async (params) => {
    f.server.sent.push(`close ${params.channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return {};
  };
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  for (let i = 0; i < 20 && !release; i++) await tick();
  assert.deepEqual(f.server.sent, ['close y'], 'the close is out');
  f.server.sendChannelsClose = close;
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  release();
  assert.equal(await opening, undefined);
  await closing;
  assert.deepEqual(f.server.sent, ['close y', 'open y'], 'one open, by the work already queued');
  assert.equal(f.isOpen(), true);
});

test('a tune-out on a server whose channels this host can\'t open says its messages come only as the server sends them', async () => {
  const f = await closedChannel();
  const without = up(['channels.lifecycle']);
  f.servers.set('a', without);
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but this host isn\'t permitted to open or close the "a" server\'s channels, so its ' +
    'messages reach the subconscious only as that server sends them.');
  assert.deepEqual(without.sent, []);
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
});

test('a tune-out while its server isn\'t up says when this host opens the channel', async () => {
  const f = await closedChannel();
  f.servers.set('a', { ...up(), grant: CapabilityGrant.empty(), isConnected: false, willReconnect: true });
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages don\'t reach the subconscious until this host opens the channel, which ' +
    'it does when the "a" server next registers this channel, if this host may open and close its channels then; it ' +
    'can\'t open it now: the "a" server isn\'t connected, and this host is reconnecting to it.');
});

test('a tune-out whose open fails says what failed, when this host opens the channel, and keeps the tune-out', async () => {
  const f = await closedChannel();
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    throw new McplRequestError(timedOut, 'no-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  assert.equal(await f.registry.openForTuneOut('a', 'y'),
    'The tune-out is recorded, but its messages don\'t reach the subconscious until this host opens the channel, which ' +
    'it does when the "a" server next registers this channel, if this host may open and close its channels then; ' +
    `opening it now didn't complete: ${timedOut}`);
  assert.deepEqual(f.server.sent, ['open y']);
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
});

test('a tune-out whose channel\'s registration goes while the open is out says so, and says when it came back', async () => {
  for (const back of [false, true]) {
    const f = await closedChannel();
    let release!: () => void;
    f.server.sendChannelsOpen = async ({ channelId }) => {
      f.server.sent.push(`open ${channelId}`);
      await new Promise<void>((resolve) => { release = resolve; });
      return { channel: descriptor(channelId) };
    };
    f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
    const opening = f.registry.openForTuneOut('a', 'y');
    for (let i = 0; i < 20 && !release; i++) await tick();
    f.registry.removeServer('a');
    // The registration that comes back queues its reconcile behind the open
    // that's out, so it settles only after that open does.
    let registering: Promise<void> | undefined;
    if (back) {
      f.server.sendChannelsOpen = async ({ channelId }) => ({ channel: descriptor(channelId) });
      registering = f.registry.handleRegister('a', { channels: [descriptor('y')] });
      for (let i = 0; i < 20 && f.registry.listChannelsRaw().length === 0; i++) await tick();
      assert.equal(f.registry.listChannelsRaw().length, 1, 'registered again');
    }
    release();
    await registering;
    assert.equal(await opening,
      'The tune-out is recorded, but its messages don\'t reach the subconscious until this host opens the channel, ' +
      'which it does when the "a" server next registers this channel, if this host may open and close its channels ' +
      'then; ' + (back ? 'its registration went and came back while the open was out.'
        : 'it isn\'t registered here any more: this host disconnected the "a" server while the change was being made.'),
      back ? 'came back' : 'gone');
  }
});

test('a tune-out that a later decision replaced while its open was out says that decision stands', async () => {
  const f = await closedChannel();
  let release!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { release = resolve; });
    return { channel: descriptor(channelId) };
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !release; i++) await tick();
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  release();
  assert.equal(await opening,
    'The tune-out was recorded, but a later decision about the channel replaced it while its transport was being ' +
    'opened, and that decision stands.');
  await closing;
  assert.equal(f.registry.getDesiredState('a', 'y'), 'closed');
});

test('a tune-out whose open fails after a later decision replaced it says that decision stands', async () => {
  const f = await closedChannel();
  let fail!: () => void;
  f.server.sendChannelsOpen = async ({ channelId }) => {
    f.server.sent.push(`open ${channelId}`);
    await new Promise<void>((resolve) => { fail = resolve; });
    throw new McplRequestError('The "a" server refused the request.', 'error-response');
  };
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = f.registry.openForTuneOut('a', 'y');
  for (let i = 0; i < 20 && !fail; i++) await tick();
  const closing = f.registry.handleChannelToolCall('channel_close', { channelId: 'y' });
  fail();
  assert.equal(await opening,
    'The tune-out was recorded, but a later decision about the channel replaced it while its transport was being ' +
    'opened, and that decision stands.');
  await closing;
});

test('a tune-out made while a decline\'s acknowledgment is out opens the channel once, by the tune-out', async () => {
  // A registration whose close timed out leaves the transport unconfirmed,
  // so the decline would queue work for it, but its decision is replaced
  // before then, and a decline acts only on its own decision.
  const timedOut = 'The "a" server didn\'t answer within 30 seconds, so whether the request took effect is unknown.';
  const servers = new Map<string, Server>();
  const server = up();
  servers.set('a', server);
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
  );
  server.sendChannelsClose = async () => { throw new McplRequestError(timedOut, 'no-response'); };
  await registry.handleRegister('a', { channels: [descriptor('y')] });
  for (let i = 0; i < 5; i++) await tick();
  server.sendChannelsClose = async ({ channelId }) => { server.sent.push(`close ${channelId}`); return {}; };
  server.sent.length = 0;
  const acks: Array<() => void> = [];
  server.sendChannelsAcknowledge = () => new Promise((resolve) => { acks.push(() => resolve({ acknowledged: true })); });
  const declining = registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' });
  for (let i = 0; i < 50 && acks.length === 0; i++) await tick();
  assert.equal(acks.length, 1, 'the acknowledgment is out');
  registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const opening = registry.openForTuneOut('a', 'y');
  acks.shift()!();
  const declined = await declining;
  assert.equal(await opening, undefined);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(server.sent, ['open y'], 'one open, the tune-out\'s');
  assert.equal((declined.data as { status?: string } | undefined)?.status, 'replaced');
  assert.equal((registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get('a:y')?.open, true);
});

test('a decline of a tuned-out channel is refused, open or not, and changes nothing', async () => {
  const f = await closedChannel();
  f.registry.enterTuneOut('a', 'y', PARAMS, 'agent-tool');
  const refusal = {
    success: false,
    isError: true,
    error: 'Channel "y" is tuned out: its messages go to the subconscious, and channel_decline doesn\'t change that. Call ' +
      'tune_out with channelId "y" and mode "cancel" for it to resume normal attention; cancelling delivers the diverted ' +
      'backlog.',
    data: { refusal: 'tuned-out', channelId: 'y' },
  };
  assert.equal(f.isOpen(), false, 'its transport isn\'t open');
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1', acknowledge: '👀' }), refusal);
  assert.deepEqual(f.server.sent, [], 'no acknowledgment, and nothing for the transport');
  assert.equal(f.registry.getDesiredState('a', 'y'), 'tuned-out');
  assert.equal(f.registry.getTuneOutState('a', 'y')?.params.epochId, 'e1', 'the tune-out stands');
  assert.equal(await f.registry.openForTuneOut('a', 'y'), undefined);
  f.server.sent.length = 0;
  assert.deepEqual(await f.registry.handleChannelToolCall('channel_decline', { channelId: 'y', messageId: 'm1' }), refusal, 'open');
  assert.deepEqual(f.server.sent, []);
});

// --- tune_out itself, through the framework ---------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

async function framework(t: { after(fn: () => Promise<void>): void }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-transport-'));
  const statusPath = join(tempDir, 'status.jsonl');
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const fw = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath } }],
    modules: [],
  });
  t.after(async () => { await fw.stop(); rmSync(tempDir, { recursive: true, force: true }); });
  const i = fw as unknown as {
    channelRegistry: ChannelRegistry & { handleChannelToolCall(name: string, input: unknown): Promise<{ data?: unknown }> };
    agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ text?: string }>; metadata?: Record<string, unknown> }> } }>;
    handleScriptToolCall(agent: string, tool: string, args: Record<string, unknown>): Promise<ScriptToolResult>;
  };
  await fw.start();
  const deadline = Date.now() + 10_000;
  while (i.channelRegistry.listChannelsRaw().length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for registration');
    await new Promise((r) => setTimeout(r, 20));
  }
  let emitted = 0;
  const events = () => existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string })
    : [];
  return {
    i,
    membrane,
    events,
    emit: (text: string) => appendFileSync(commandPath, `ambient m${++emitted} ${text}\n`),
    script: (tool: string, input: Record<string, unknown>) => i.handleScriptToolCall('scout', tool, input),
  };
}

test('tune_out of a channel this host closed opens it, so its traffic reaches the subconscious, and answers as before', async (t) => {
  const f = await framework(t);
  await f.i.channelRegistry.handleChannelToolCall('channel_close', { channelId: CHANNEL });
  const closedAt = f.events().length;
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }),
    { text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }), isError: false });
  assert.deepEqual(f.events().slice(closedAt).map((e) => e.event), ['channel-opened']);
  f.emit('release chatter');
  const scout = f.i.agents.get('scout')!.getContextManager();
  const deadline = Date.now() + 10_000;
  while (!scout.getAllMessages().some((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the diverted message');
    await new Promise((r) => setTimeout(r, 20));
  }
});

test('tune_out whose transport isn\'t open answers a success, with openError saying when its messages come', async (t) => {
  const f = await framework(t);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  registry.openForTuneOut = async () => 'The tune-out is recorded, but not yet.';
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }), {
    text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes, openError: 'The tune-out is recorded, but not yet.' }),
    isError: false,
  });
});

test('tune_out whose open throws answers a success that says opening its channel failed, never a rejection', async (t) => {
  const f = await framework(t);
  const registry = f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
  registry.openForTuneOut = async () => { throw new Error('the store went away'); };
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL }), {
    text: JSON.stringify({
      tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes,
      openError: 'The tune-out is recorded, but opening its channel failed: the store went away',
    }),
    isError: false,
  });
});

test('a decline of a tuned-out channel whose transport isn\'t open is refused, and the backlog survives to the cancel', async (t) => {
  const f = await framework(t);
  const scout = f.i.agents.get('scout')!.getContextManager();
  const diverted = () => scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length;
  assert.equal((await f.script('tune_out', { channelId: CHANNEL })).isError, false);
  f.emit('backlog one');
  f.emit('backlog two');
  const deadline = Date.now() + 10_000;
  while (diverted() < 2) {
    if (Date.now() > deadline) throw new Error('timed out waiting for two diverted messages');
    await new Promise((r) => setTimeout(r, 20));
  }
  // A transport that isn't confirmed open, as a failed open, a retarget or a
  // dropped connection leaves it, while the tune-out stands.
  (f.i.channelRegistry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(`disc:${CHANNEL}`)!.open = false;
  const declined = await f.script('channel_decline', { channelId: CHANNEL, messageId: 'backlog-one' });
  assert.equal(declined.isError, true);
  assert.match(declined.text, /is tuned out: its messages go to the subconscious, and channel_decline doesn't change that/);
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Read the backlog.' }]));
  assert.deepEqual(await f.script('tune_out', { channelId: CHANNEL, mode: 'cancel' }),
    { text: JSON.stringify({ cancelled: CHANNEL }), isError: false });
  const dumped = () => scout.getAllMessages().find((m) => m.content.some((b) => (b.text ?? '').includes('<tuned-out-backlog')));
  const until = Date.now() + 10_000;
  while (!dumped()) {
    if (Date.now() > until) throw new Error('timed out waiting for the backlog to reach scout');
    await new Promise((r) => setTimeout(r, 20));
  }
  const dump = dumped()!;
  const text = dump.content.map((b) => b.text ?? '').join('');
  assert.ok(text.includes('backlog one') && text.includes('backlog two'), text);
});
