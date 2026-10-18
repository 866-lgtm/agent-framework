/**
 * A reconnected MCPL server's control traffic waits for its new grant.
 *
 * A transport boundary resets the server's grant: a fresh initialize is a
 * fresh §5.3 policy epoch. A chat bridge registers its channels right after
 * initialize, before the host's policy Request has been answered. If that
 * registration reaches admission while the grant is still empty, it is
 * refused (-32002) and never replayed, and the route's incoming messages are
 * then unknown channels until the server happens to register again. Initial
 * connect holds both planes until the grant is established; a reconnect must
 * hold them too, both for a connection that was already open (an ordinary
 * disconnect) and for a stub that had never opened (a first reconnect while
 * startup is still staging other servers).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentFramework } from '../src/index.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));

interface ServerEvent {
  event: string;
  role: string;
  pid: number;
  error?: { code: number; message: string } | null;
}

function serverEvents(path: string): ServerEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ServerEvent);
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

describe('MCPL reconnect and channel registration', () => {
  let dir: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcpl-reconnect-registration-'));
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a server that registers right after initialize is registered again after an ordinary reconnect', async () => {
    const eventsPath = join(dir, 'events.jsonl');
    const crashPath = join(dir, 'crash');
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [{
        id: 'chat',
        command: process.execPath,
        args: [FIXTURE],
        env: { EVENTS_PATH: eventsPath, CRASH_PATH: crashPath },
        enabledFeatureSets: ['chat'],
        reconnect: true,
        reconnectIntervalMs: 50,
      }],
    });
    const answers = () => serverEvents(eventsPath).filter((e) => e.event === 'register-answered');

    await waitFor('the first registration answer', () => answers().length === 1);
    assert.equal(answers()[0].error, null, 'initial connect admits the registration against the established grant');

    // The server process dies; the host reconnects to a fresh one, which
    // registers again before the host's new policy Request is answered.
    writeFileSync(crashPath, '');
    await waitFor('the registration answer after the reconnect', () => answers().length === 2);
    const [first, second] = answers();
    assert.notEqual(second.pid, first.pid, 'a fresh server process registered');
    assert.equal(
      second.error,
      null,
      `the reconnected server's registration waits for its new grant instead of being refused: ${JSON.stringify(second.error)}`,
    );
  });

  it('a first reconnect during staged startup keeps its registration held through startup\'s open of every plane', async () => {
    // The race as it was reproduced: `retry` fails its first connect;
    // its retry reconnects while `stager` is still staging, and holds its
    // policy answer; `stager` answers initialize only once that policy is
    // pending, so startup's final open of every connection's planes runs
    // while the retry's exchange is still in flight.
    const eventsPath = join(dir, 'events.jsonl');
    const pending = join(dir, 'policy-pending');
    const release = join(dir, 'policy-release');
    const server = (id: string, env: Record<string, string>) => ({
      id,
      command: process.execPath,
      args: [FIXTURE],
      env: { EVENTS_PATH: eventsPath, ROLE: id, ...env },
      enabledFeatureSets: ['chat'],
      ...(id === 'retry' ? { reconnect: true, reconnectIntervalMs: 20 } : {}),
    });
    // Record each open of every connection's planes (startup's staged open,
    // or a resume), and whether the retry's exchange was in flight then.
    const opensOfEvery: boolean[] = [];
    const proto = AgentFramework.prototype as unknown as { readyMcplPlanes: (connections?: unknown[]) => void };
    const readyMcplPlanes = proto.readyMcplPlanes;
    proto.readyMcplPlanes = function (this: any, connections?: unknown[]) {
      if (!connections) {
        const retryConnection = this.mcplServerRegistry?.getServer('retry');
        opensOfEvery.push(!!retryConnection && this.mcplPolicyExchanges.get(retryConnection) === retryConnection.transportEpoch);
      }
      return readyMcplPlanes.call(this, connections);
    };
    try {
      framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
        modules: [],
        maintenanceIntervalMs: 0,
        mcplServers: [
          server('retry', { FAIL_FIRST_PATH: join(dir, 'failed-once'), POLICY_PENDING_PATH: pending, POLICY_RELEASE_PATH: release }),
          server('stager', { INITIALIZE_AFTER_PATH: pending }),
        ],
      });
    } finally {
      proto.readyMcplPlanes = readyMcplPlanes;
    }
    const retry = () => serverEvents(eventsPath).filter((e) => e.role === 'retry');
    await waitFor('the retry\'s policy answer held', () => retry().some((e) => e.event === 'policy-held'));
    assert.ok(opensOfEvery.includes(true), `startup opened every connection's planes while the retry's exchange was in flight: ${JSON.stringify(opensOfEvery)}`);
    assert.equal(
      retry().find((e) => e.event === 'register-answered'),
      undefined,
      `its registration is not answered while its policy exchange is in flight: ${JSON.stringify(retry())}`,
    );

    writeFileSync(release, '1');
    await waitFor('the retry\'s registration answer', () => retry().some((e) => e.event === 'register-answered'));
    const steps = retry().map((e) => e.event);
    const answer = retry().find((e) => e.event === 'register-answered')!;
    assert.equal(answer.error, null, `admitted against the new grant: ${JSON.stringify(answer.error)}`);
    assert.ok(steps.indexOf('policy-answered') < steps.indexOf('register-answered'), `steps: ${steps.join(', ')}`);
  });
});

describe('MCPL reconnect: a pending policy exchange holds its planes', () => {
  /** A framework stub with one connection whose policy answers are deferred. */
  function harness() {
    const answers: Array<(receipt: { accepted: true }) => void> = [];
    let opened = 0;
    let controlOnly = 0;
    let granted = 0;
    const connection = Object.assign(new EventEmitter(), {
      id: 'srv',
      transportEpoch: 0,
      isConnected: true,
      capabilities: { version: '0.5', pushEvents: true, featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } } },
      mcpToolsAdvertised: false,
      establishGrant: () => { granted++; },
      sendFeatureSetsUpdateRequest: () => new Promise<{ accepted: true }>((resolve) => { answers.push(resolve); }),
      ready: () => { opened++; },
      readyControlPlane: () => { controlOnly++; },
    });
    const fw = Object.create(AgentFramework.prototype) as any;
    fw.traceListeners = [];
    fw.mcplPolicyExchanges = new WeakMap();
    fw.mcplServerConfigs = new Map([['srv', { id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] }]]);
    // A runtime connect of this stdio server derives the protective reaction
    // default; with an empty journal here, it covers the configured marker
    // alone.
    fw.discordAwarenessEmoji = '💤';
    fw.discordAwarenessOutbox = { batches: () => [] };
    fw.featureSetManager = new FeatureSetManager();
    fw.checkpointManager = null;
    fw.mcplServerRegistry = { getAllServers: () => [connection], getServer: () => connection };
    fw.handleToolsListChanged = () => {};
    fw.wireMcplEvents(connection);
    return {
      fw,
      connection,
      answers,
      opened: () => opened,
      controlOnly: () => controlOnly,
      granted: () => granted,
      reconnect: () => { connection.transportEpoch++; connection.isConnected = true; connection.emit('reconnect', { attempts: 1 }); },
      /** The transport closes, as its close handler leaves the connection. */
      drop: () => { connection.transportEpoch++; connection.isConnected = false; },
    };
  }

  it('no other opener (startup\'s staged open, resume) releases a reconnect\'s traffic before its exchange settles', async () => {
    const h = harness();
    h.reconnect();
    h.fw.readyMcplPlanes(); // startup's open of every connection, or resume()
    assert.equal(h.opened(), 0, 'held while the policy exchange is in flight');
    h.answers[0]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.opened(), 1, 'opened by the reconnect once its exchange settled');
    h.fw.readyMcplPlanes();
    assert.equal(h.opened(), 2, 'and no longer held');
  });

  it('a superseded exchange never opens the planes of the transport that replaced it', async () => {
    const h = harness();
    h.reconnect();
    h.reconnect(); // the first fresh transport died; a newer one is exchanging
    h.answers[0]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    h.fw.readyMcplPlanes();
    assert.equal(h.opened(), 0, 'the newer exchange is still in flight');
    h.answers[1]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.opened(), 1);
  });
});

describe('MCPL policy exchanges: a transport that drops, a quiesced host, a runtime connect', () => {
  function harness() {
    const answers: Array<(receipt: { accepted: true }) => void> = [];
    const counts = { opened: 0, controlOnly: 0, granted: 0 };
    const connection = Object.assign(new EventEmitter(), {
      id: 'srv',
      transportEpoch: 0,
      isConnected: true,
      capabilities: { version: '0.5', pushEvents: true, featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } } },
      mcpToolsAdvertised: false,
      establishGrant: () => { counts.granted++; },
      sendFeatureSetsUpdateRequest: () => new Promise<{ accepted: true }>((resolve) => { answers.push(resolve); }),
      ready: () => { counts.opened++; },
      readyControlPlane: () => { counts.controlOnly++; },
    });
    const fw = Object.create(AgentFramework.prototype) as any;
    fw.traceListeners = [];
    fw.mcplPolicyExchanges = new WeakMap();
    fw.mcplServerConfigs = new Map([['srv', { id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] }]]);
    // A runtime connect of this stdio server derives the protective reaction
    // default; with an empty journal here, it covers the configured marker
    // alone.
    fw.discordAwarenessEmoji = '💤';
    fw.discordAwarenessOutbox = { batches: () => [] };
    fw.mcplPrefixMap = new Map();
    fw.featureSetManager = new FeatureSetManager();
    fw.checkpointManager = null;
    fw.mcplHostCapabilities = { version: '0.5' };
    fw.mcplServerRegistry = { getAllServers: () => [connection], getServer: () => connection, addServer: async () => connection };
    fw.handleToolsListChanged = () => {};
    fw.deliverDiscordAwarenessInBackground = () => {};
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return {
      fw,
      connection,
      answers,
      counts,
      settle,
      reconnect: () => { connection.transportEpoch++; connection.isConnected = true; connection.emit('reconnect', { attempts: 1 }); },
      drop: () => { connection.transportEpoch++; connection.isConnected = false; },
    };
  }

  it('a transport that drops during its exchange leaves the planes closed, and its late answer grants nothing', async () => {
    const h = harness();
    const traces: string[] = [];
    h.fw.onTrace((event: { type: string }) => traces.push(event.type));
    h.fw.wireMcplEvents(h.connection);
    h.reconnect();
    h.drop();
    h.fw.readyMcplPlanes(); // a resume while the connection is down
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'a closed connection is not opened');
    h.answers[0]({ accepted: true }); // answered just as the transport went
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'the dead transport\'s exchange opens and grants nothing');
    assert.deepEqual(traces.filter((type) => type === 'mcpl:server-reconnected' || type === 'module:added'), [], 'and announces nothing');
    // The next transport's exchange grants, opens and announces.
    h.reconnect();
    h.answers[1]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 });
    assert.deepEqual(traces.filter((type) => type === 'mcpl:server-reconnected' || type === 'module:added'), ['mcpl:server-reconnected', 'module:added']);
  });

  it('a reconnect on a quiesced host opens only the control plane; resume opens the data plane', async () => {
    const h = harness();
    h.fw.wireMcplEvents(h.connection);
    h.fw.quiesced = true;
    h.reconnect();
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 1, granted: 1 }, 'data stays held for the maintenance window');
    h.fw.quiesced = false;
    h.fw.readyMcplPlanes(); // resume()
    assert.equal(h.counts.opened, 1);
  });

  it('a runtime connect whose transport drops during its exchange is neither opened nor announced', async () => {
    const h = harness();
    const traces: string[] = [];
    h.fw.onTrace((event: { type: string }) => traces.push(event.type));
    const connecting = h.fw.connectMcplServerInternal({ id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] });
    await h.settle();
    h.drop();
    h.answers[0]({ accepted: true });
    await connecting;
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 });
    assert.equal(traces.includes('module:added'), false, 'its close reported it gone; its reconnect announces it');
  });

  it('a runtime connect\'s exchange holds its planes against a resume until it settles', async () => {
    const h = harness();
    const connecting = h.fw.connectMcplServerInternal({ id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] });
    await h.settle();
    assert.equal(h.answers.length, 1, 'its policy Request is in flight');
    h.fw.readyMcplPlanes(); // a resume during the connect
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held while the exchange is in flight');
    h.answers[0]({ accepted: true });
    await connecting;
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 }, 'opened by the connect once the grant exists');
  });
});

describe('MCPL runtime connect: a policy registration that throws', () => {
  let dir: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcpl-runtime-connect-failure-'));
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serverConfig(id: string) {
    return {
      id,
      command: process.execPath,
      args: [FIXTURE],
      env: { EVENTS_PATH: join(dir, `${id}-events.jsonl`), ROLE: id },
      enabledFeatureSets: ['chat'],
      requestTimeoutMs: 1_000,
    };
  }

  /**
   * A framework serving `running`, then a runtime connect of `chat` whose §5.3
   * policy registration throws (initializeServer made to throw for it). With
   * `closeFails`, the close that follows fails once in its transport close,
   * after close() has marked the connection closed for good, as a real one
   * fails. Every patch is undone before it returns.
   */
  async function failPolicyRegistration(closeFails: boolean) {
    const chat = serverConfig('chat');
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [serverConfig('running')],
    });
    const features = FeatureSetManager.prototype as any;
    const initializeServer = features.initializeServer;
    features.initializeServer = function (this: unknown, serverId: string, ...rest: unknown[]) {
      if (serverId === chat.id) throw new Error('injected policy registration failure');
      return initializeServer.call(this, serverId, ...rest);
    };
    // Whether its exchange's marker still held the failing connection's
    // planes when its close began, which marks it closed for good.
    const exchanges = (framework as unknown as { mcplPolicyExchanges: WeakMap<object, number> }).mcplPolicyExchanges;
    const markedAtClose: boolean[] = [];
    const connections = McplServerConnection.prototype as any;
    const close = connections.close;
    let closeFailed = false;
    connections.close = function (this: any) {
      if (this.id === chat.id) markedAtClose.push(exchanges.get(this) === this.transportEpoch);
      if (closeFails && this.id === chat.id && !closeFailed && this.transport) {
        closeFailed = true;
        const transport = this.transport;
        const transportClose = transport.close;
        transport.close = () => {
          transport.close = transportClose;
          return Promise.reject(new Error('injected close failure'));
        };
      }
      return close.call(this);
    };
    try {
      // The connect reports its own failure, not the close's.
      await assert.rejects(framework.connectMcplServer(chat), /injected policy registration failure/);
    } finally {
      features.initializeServer = initializeServer;
      connections.close = close;
    }
    assert.equal(closeFailed, closeFails, 'the close failed only when asked to');
    // So no opener, such as a resume finishing meanwhile, could ready it
    // between its exchange's end and its close.
    assert.deepEqual(markedAtClose, [true], 'it was closed once, while its exchange still held its planes');
    const registry = (framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry;
    const running = registry.getServer('running') as { isConnected: boolean; dataPlaneReady: boolean };
    assert.equal(running.isConnected, true, 'the running server stays connected');
    assert.equal(running.dataPlaneReady, true, 'the running server\'s data flows');
    return { chat, registry };
  }

  it('closes its connection for good, so a later connect of its id reaches the server', async () => {
    const { chat, registry } = await failPolicyRegistration(false);
    assert.equal(registry.getServer(chat.id), null, 'the half-registered connection was closed for good');
    await framework!.connectMcplServer(chat);
    assert.equal(framework!.listMcplServers().find((server) => server.id === chat.id)?.connected, true);
  });

  it('keeps a connection whose close then fails registered and paused through a resume, and logs the close', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const { chat, registry } = await failPolicyRegistration(true);
    // A close that fails keeps the entry, so a later disconnect, restart or
    // shutdown can close it again.
    const refused = registry.getServer(chat.id) as { dataPlaneReady: boolean; willReconnect: boolean } | null;
    assert.ok(refused, 'the connection whose close failed is still registered');
    assert.equal(refused.willReconnect, false, 'its close had disarmed it before the transport close failed');
    assert.equal(refused.dataPlaneReady, false, 'the failed connect left it paused');
    // A resume opens every registered server's planes.
    await framework!.quiesce({ reason: 'test' });
    await framework!.resume();
    assert.equal(refused.dataPlaneReady, false, 'a resume leaves it paused');
    assert.ok(
      logged.some((line) => line.includes(`could not close MCPL server "${chat.id}" after its policy registration failed`)
        && line.includes('injected close failure')),
      'the failed close was logged',
    );
  });
});

describe('MCPL: a connection closed for good', () => {
  it('readies nothing, so what it held stays held, while a running connection lets out what it held', async () => {
    const running = Reflect.construct(McplServerConnection, ['running', null, null]) as McplServerConnection;
    const closing = Reflect.construct(McplServerConnection, ['closing', null, null]) as McplServerConnection;
    const delivered: string[] = [];
    for (const connection of [running, closing]) {
      connection.on('stderr', () => delivered.push(`${connection.id} control`));
      connection.on('held-data', () => delivered.push(`${connection.id} data`));
      // Both planes start closed, so each holds a control event and a data event.
      connection.emit('stderr', 'a line');
      connection.emit('held-data', {});
    }
    assert.deepEqual(delivered, []);

    // close() closes the connection for good as it starts, so its close is
    // still under way here.
    const closed = closing.close();
    for (const connection of [running, closing]) connection.readyControlPlane();
    assert.deepEqual(delivered, ['running control'], 'only the running connection lets out its control traffic');
    for (const connection of [running, closing]) connection.ready();
    assert.deepEqual(delivered, ['running control', 'running data'], 'and only it lets out its data');
    await closed;
  });
});
