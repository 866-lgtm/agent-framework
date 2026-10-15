import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { AgentFramework } from '../src/framework.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport, StdioTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { McplResponseSerializationError } from '../src/mcpl/errors.js';

function harness(connection = Object.assign(new EventEmitter(), { id: 'srv' })) {
  const traces: any[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  // Main's trace listeners are registrations (#318), which onTrace makes.
  framework.traceListeners = [];
  framework.onTrace((event: unknown) => traces.push(event));
  framework.wireMcplEvents(connection);
  return { framework, connection, traces };
}

function responder() {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  return {
    results,
    errors,
    id: 17,
    respond(result: unknown) { results.push(result); },
    respondError(code: number, message: string, data?: unknown) {
      errors.push({ code, message, data });
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const failureTraces = (traces: any[]) => traces.filter((t) => t.type === 'mcpl:request-handler-error');

for (const [event, field] of [['channels-register', 'channels'], ['channels-changed', 'added']] as const) {
  test(event + ': lifecycle persistence failure after ACK is traced without another response', async () => {
    const { framework, connection, traces } = harness();
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      async sendChannelsOpen() { return {}; },
      async sendChannelsClose() { return {}; },
    };
    const registry = new ChannelRegistry(
      { getServer: () => server } as never,
      {} as never,
      () => {},
      () => {},
    );
    // Inject the reported failure at the real Chronicle append boundary.
    // A descriptor without a label avoids the unrelated label-history write.
    (registry as any).store = {
      appendToStateJson() { throw new Error('injected lifecycle-store failure'); },
    };
    registry.setSubscriptionPolicy('srv', 'auto');
    framework.channelRegistry = registry;
    const reply = responder();
    connection.emit(event, { [field]: [{ id: 'room', type: 'test', direction: 'bidirectional' }] }, reply);
    // Synchronously, before reconciliation's first await settles.
    assert.equal(reply.results.length, 1, 'ACK precedes reconciliation');
    await settle();

    assert.equal(reply.results.length, 1, 'and nothing else is answered');
    assert.equal(reply.errors.length, 0, 'an accepted registration must not get a second response');
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].serverId, 'srv');
    assert.equal(failures[0].event, event);
    assert.equal(failures[0].requestId, 17);
    assert.equal(failures[0].responseAttempted, true);
    assert.match(failures[0].error, /injected lifecycle-store failure/);
  });
}

for (const [event, component, method] of [
  ['channels-register', 'channelRegistry', 'handleRegister'],
  ['channels-changed', 'channelRegistry', 'handleChanged'],
  ['channels-incoming', 'channelRegistry', 'handleIncoming'],
  ['push-event', 'pushHandler', 'handlePushEvent'],
  ['inference-request', 'inferenceRouter', 'handleInferenceRequest'],
] as const) {
  test(event + ': rejection before a response gets one JSON-RPC internal error', async () => {
    const { framework, connection, traces } = harness();
    framework[component] = {
      async [method]() {
        await Promise.resolve();
        throw new Error('handler failed before response');
      },
    };
    const reply = responder();
    connection.emit(event, {}, reply);
    await settle();

    assert.equal(reply.results.length, 0);
    // The server gets the standard message; the handler's own text stays home.
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].event, event);
    assert.equal(failures[0].responseAttempted, false);
    assert.match(failures[0].error, /handler failed before response/);
  });
}

test('notification rejection is traced without inventing a response', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { async handleChanged() { throw new Error('notification failed'); } };
  connection.emit('channels-changed', {});
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].requestId, undefined);
  assert.match(failures[0].error, /notification failed/);
});

test('a synchronous handler throw is contained and answered', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { descriptorsForServer() { throw new Error('list failed'); } };
  const reply = responder();
  assert.doesNotThrow(() => connection.emit('channels-list', {}, reply));
  await settle();
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /list failed/);
});

test('a throwing success response is not retried as an error response', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { descriptorsForServer() { return []; } };
  const reply = responder();
  let writes = 0;
  reply.respond = () => { writes++; throw new Error('response transport failed'); };
  assert.doesNotThrow(() => connection.emit('channels-list', {}, reply));
  await settle();
  assert.equal(writes, 1);
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
});

test('a failed error response is traced without an escaping rejection', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = { async handleRegister() { throw new Error('original failure'); } };
  const reply = responder();
  let writes = 0;
  reply.respondError = () => { writes++; throw new Error('error response transport failed'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(writes, 1);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /original failure/);
  assert.match(failures[0].responseError, /error response transport failed/);
});

test('inference responders retain request IDs and successful handling stays synchronous', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = {
    handleInferenceRequest(_server: string, _params: unknown, reply: any) {
      assert.equal(reply.requestId, 17);
      reply.respond({ accepted: true });
    },
  };
  const reply = responder();
  connection.emit('inference-request', {}, reply);
  assert.deepEqual(reply.results, [{ accepted: true }]);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces).length, 0);
});

test('real inference handler cannot turn a failed result write into a second response', async () => {
  const { framework, connection, traces } = harness();
  framework.inferenceRouter = new InferenceRouter(
    {
      async complete() {
        return {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as never,
    { isInHook: false } as never,
    { validateInbound() {} } as never,
    null,
    (event) => traces.push(event),
  );
  const reply = responder();
  let resultWrites = 0;
  reply.respond = () => { resultWrites++; throw new Error('partially written result'); };
  connection.emit('inference-request', {
    featureSet: 'test', messages: [{ role: 'user', content: 'hello' }],
  }, reply);
  await settle();
  assert.equal(resultWrites, 1);
  assert.equal(reply.errors.length, 0, 'the inner inference catch must not send another reply');
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /partially written result/);
  assert.equal(failures[0].responseAttempted, true);
});

test('a swallowed response-write failure still produces a diagnostic', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({}); } catch { /* Simulate a handler swallowing a transport error. */ }
    },
  };
  const reply = responder();
  reply.respond = () => { throw new Error('swallowed write failure'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /swallowed write failure/);
});

test('an error response followed by a handler rejection is not answered again', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respondError(-32602, 'bad params');
      throw new Error('after error response');
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 1);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /after error response/);
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
});

test('host command response-write failure is traced without a second reply', async () => {
  const { framework, connection, traces } = harness();
  framework.handleHostCommand = async () => ({ done: true });
  const reply = responder();
  reply.respond = () => { throw new Error('host response failed'); };
  connection.emit('host-command', {}, reply);
  await settle();
  assert.equal(reply.errors.length, 0);
  assert.match(failureTraces(traces)[0].error, /host response failed/);
});

class ResponseTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  failWrite = false;
  writeLine(line: string): void {
    this.lines.push(line);
    if (this.failWrite) throw new TypeError('transport failed after a partial write');
  }
  async close(): Promise<void> {}
}

function wireHarness() {
  const transport = new ResponseTransport();
  // Use real connection routing and response encoding without launching a server.
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  (connection as any).allowHostCommands = true;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const h = harness(connection);
  connection.ready();
  const request = (method = 'host/command') => transport.emit('line', JSON.stringify({
    jsonrpc: '2.0', id: 17, method, params: { command: 'maintain' },
  }));
  return { ...h, transport, request };
}

for (const kind of ['bigint', 'circular', 'throwing toJSON'] as const) {
  test('host-command ' + kind + ' serialization failure receives one internal-error response', async () => {
    const { framework, traces, transport, request } = wireHarness();
    let calls = 0;
    const circular: any = {};
    circular.self = circular;
    const progress = kind === 'bigint' ? { count: 1n } : kind === 'circular' ? circular : {
      toJSON() { calls++; throw new Error('snapshot serialization failed'); },
    };
    framework.handleHostCommand = async () => ({ progress });
    request();
    await settle();
    assert.equal(transport.lines.length, 1, 'encoding failed before any result bytes were written');
    const reply = JSON.parse(transport.lines[0]!);
    assert.equal(reply.id, 17);
    assert.equal(reply.error.code, -32603);
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.message, 'Internal error');
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].responseAttempted, false);
    // The encoding failure says why.
    assert.match(failures[0].error, kind === 'bigint' ? /could not be serialized: .*BigInt/i
      : kind === 'circular' ? /could not be serialized: .*circular/i
        : /could not be serialized: snapshot serialization failed/);
    if (kind === 'throwing toJSON') assert.equal(calls, 1, 'results are encoded only once');
  });
}

test('unserializable error data also permits one encodable error response', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respondError(-32602, 'bad input', { count: 1n });
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1);
  assert.equal(JSON.parse(transport.lines[0]!).error.code, -32603);
  assert.equal(failureTraces(traces)[0].responseAttempted, false);
});

test('a swallowed pre-write encoding failure still receives a fallback response', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({ count: 1n }); } catch { /* handler swallowed the error */ }
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1);
  assert.equal(JSON.parse(transport.lines[0]!).error.code, -32603);
  assert.equal(failureTraces(traces)[0].responseAttempted, false);
});

test('a real transport write failure remains single-attempt after serialization', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.handleHostCommand = async () => ({ maintained: true });
  transport.failWrite = true;
  request();
  await settle();
  assert.equal(transport.lines.length, 1, 'a possibly partial write must not get a second reply');
  assert.deepEqual(JSON.parse(transport.lines[0]!).result, { maintained: true });
  assert.equal(failureTraces(traces)[0].responseAttempted, true);
});

test('post-response failures reach stderr when no trace subscriber is attached', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      throw new Error('headless reconciliation failed');
    },
  };
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0);
  assert.equal(errors.length, 1);
  // One line, its text through log-value.
  assert.equal(errors[0]?.length, 1);
  assert.match(String(errors[0]?.[0]), /^\[mcpl\] srv channels-register handler failed: "headless reconciliation failed"$/);
});

for (const mode of ['handshake', 'connected', 'throwing-listener']) {
  test('separate stdio host survives inbound ' + mode + ' faults and processes later messages', () => {
    const probe = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./fixtures/mcpl-inbound-host-probe.mjs', import.meta.url)), mode,
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /continued/);
  });
}

for (const value of [null, 42, 'hi', true, []]) {
  test('non-object inbound ' + JSON.stringify(value) + ' leaves the next notification deliverable', () => {
    const { connection, transport } = wireHarness();
    let received = false;
    connection.removeAllListeners('tools-list-changed');
    connection.on('tools-list-changed', () => { received = true; });
    assert.doesNotThrow(() => transport.emit('line', JSON.stringify(value)));
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
    assert.equal(received, true);
  });
}

for (const release of ['live', 'ready', 'readyControlPlane'] as const) {
  test('synchronous notification failure is contained during ' + release + ' dispatch and traced', (t) => {
    const transport = new ResponseTransport();
    const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
    const { traces } = harness(connection);
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const seen: number[] = [];
    connection.removeAllListeners('tools-list-changed');
    connection.on('tools-list-changed', (params: { sequence: number }) => {
      if (params.sequence === 1) throw new Error('raw notification failed');
      seen.push(params.sequence);
    });
    if (release === 'live') connection.ready();
    const send = (sequence: number) => transport.emit('line', JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { sequence },
    }));
    assert.doesNotThrow(() => { send(1); send(2); });
    if (release !== 'live') assert.doesNotThrow(() => connection[release]());
    assert.deepEqual(seen, [2]);
    assert.equal(traces.filter((e) => e.type === 'mcpl:server-error').length, 1);
    assert.equal(errors.length, 1);
  });
}

for (const value of [null, 42, 'hi', true]) {
  test('non-object inbound ' + JSON.stringify(value) + ' is ignored like a non-JSON line, with no failure report', (t) => {
    const { connection, transport } = wireHarness();
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const reported: unknown[] = [];
    connection.on('error', (error: unknown) => { reported.push(error); });
    transport.emit('line', JSON.stringify(value));
    assert.deepEqual(errors, []);
    assert.deepEqual(reported, []);
  });
}

test('a throwing orphaned-response listener is contained, and later messages still arrive', (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('orphaned-response', () => { throw new Error('orphan listener failed'); });
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  // A response to no pending request, carrying state, is surfaced as orphaned.
  assert.doesNotThrow(() => transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 999, result: { state: {} } })));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
  assert.equal(traces.filter((e) => e.type === 'mcpl:server-error').length, 1);
});

test('a method that is not a string is not dispatched, even if it stringifies to a known method', () => {
  const { connection, transport } = wireHarness();
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: ['notifications/tools/list_changed'] }));
  assert.equal(received, false);
  // The control: the same method as a string is dispatched in this setup.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
});

test('tools-observe: a synchronous failure is answered with one internal error', async () => {
  const { connection, traces } = harness();
  Object.defineProperty(connection, 'toolObserveFilter', { set() { throw new Error('filter store failed'); } });
  const reply = responder();
  assert.doesNotThrow(() => connection.emit('tools-observe', { rules: [] }, reply));
  await settle();
  assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
  assert.equal(failureTraces(traces).length, 1);
  assert.match(failureTraces(traces)[0].error, /filter store failed/);
});

test('model-info: a throwing error write is traced without escaping or a second write', async () => {
  const { connection, traces } = harness();
  const reply = responder();
  const writes: Array<{ code: number; message: string }> = [];
  reply.respondError = (code: number, message: string) => { writes.push({ code, message }); throw new Error('response transport failed'); };
  assert.doesNotThrow(() => connection.emit('model-info', {}, reply));
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.code, -32601);
  assert.match(writes[0]!.message, /model\/info unavailable/);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].responseAttempted, true);
  assert.match(failures[0].error, /response transport failed/);
  assert.equal(failures[0].responseFailure, undefined, 'the write failure is the error itself, not repeated');
});

test('a method named after an Object.prototype member is not buffered while the planes are paused', () => {
  const transport = new ResponseTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  // Before ready(), inbound events wait in the buffer; an unknown method must not take a slot.
  for (const method of ['constructor', '__proto__', 'toString', 'no/such-method']) {
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method }));
  }
  assert.equal((connection as any).bufferedEvents.length, 0);
  // The control: a known notification does wait in the buffer here.
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal((connection as any).bufferedEvents.length, 1);
});

test('a handler that swallows an encoding failure and then fails reports its own error, and the failed write beside it', async () => {
  const { framework, traces, transport, request } = wireHarness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      try { reply.respond({ count: 1n }); } catch { /* swallowed */ }
      throw new Error('db down');
    },
  };
  request('channels/register');
  await settle();
  assert.equal(transport.lines.length, 1, 'no bytes of the result went out, so one internal-error reply does');
  assert.deepEqual(JSON.parse(transport.lines[0]!).error, { code: -32603, message: 'Internal error' });
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /db down/);
  assert.match(failures[0].responseFailure, /could not be serialized: .*BigInt/i);
  assert.equal(failures[0].responseAttempted, false);
});

test('an answer tried after the reply is refused without throwing, so the handler reports its own error', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      try {
        await Promise.resolve();
        throw new Error('store append failed');
      } catch (error) {
        reply.respondError(-32603, 'could not record the registration');
        throw error;
      }
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0, 'the second answer is never written');
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /store append failed/);
  assert.deepEqual(failures[0].refusedResponse, { kind: 'error', code: -32603, message: 'could not record the registration' });
  assert.equal(failures[0].responseAttempted, true);
});

test('a handler that answers twice and resolves is still reported', async () => {
  const { framework, connection, traces } = harness();
  framework.channelRegistry = {
    async handleRegister(_server: string, _params: unknown, reply: any) {
      reply.respond({ registered: [] });
      reply.respondError(-32602, 'second thoughts');
    },
  };
  const reply = responder();
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(reply.results.length, 1);
  assert.equal(reply.errors.length, 0);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /second time/);
  assert.deepEqual(failures[0].refusedResponse, { kind: 'error', code: -32602, message: 'second thoughts' });
});

test('a rejection whose reason cannot be printed is reported and answered, with no unhandled rejection', async () => {
  const { framework, connection, traces } = harness();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    framework.channelRegistry = {
      async handleRegister() { throw Object.create(null); },
    };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0].error, 'string');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a request for a method nothing handles is answered -32601; such a notification is ignored', (t) => {
  const { transport } = wireHarness();
  t.mock.method(console, 'error', () => {});
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'no/such-method' }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 32, method: ['host/command'] }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 33, method: 7 }));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'no/such-notification' }));
  const replies = transport.lines.map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message]), [
    [31, -32601, 'Method not found'],
    [32, -32601, 'Method not found'],
    [33, -32601, 'Method not found'],
  ]);
});

test('a dispatch failure names the event, the request and what failed', (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('channels-list', () => { throw new Error('listener exploded'); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'channels/list' }));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /inbound dispatch failed for channels-list \(request 41\): listener exploded/);
});

test('a manifest refresh that fails is reported as a handler failure', async (t) => {
  const { framework, connection, traces } = harness();
  t.mock.method(console, 'error', () => {});
  framework.handleManifestChanged = async () => { throw new Error('manifest fetch failed'); };
  connection.emit('manifest-changed', { revision: 'r2' });
  await settle();
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'manifest-changed');
  assert.equal(failures[0].requestId, undefined);
  assert.match(failures[0].error, /manifest fetch failed/);
});

test('a failed internal-error reply reaches stderr too', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  framework.channelRegistry = { async handleRegister() { throw new Error('register failed'); } };
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const reply = responder();
  reply.respondError = () => { throw new Error('internal-error reply could not be written'); };
  connection.emit('channels-register', {}, reply);
  await settle();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /channels-register handler failed: "register failed"/);
  assert.match(lines[0]!, /the internal-error reply failed too: "internal-error reply could not be written"/);
});

test("an 'error' listener that throws is caught and logged, and the next message still arrives", (t) => {
  const { connection, transport } = wireHarness();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(String(args[0])); });
  connection.removeAllListeners('error');
  connection.on('error', () => { throw new Error('error listener exploded'); });
  connection.prependListener('channels-list', () => { throw new Error('listener exploded'); });
  let received = false;
  connection.removeAllListeners('tools-list-changed');
  connection.on('tools-list-changed', () => { received = true; });
  assert.doesNotThrow(() => transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'channels/list' })));
  assert.ok(logged.some((line) => line.includes(`an 'error' listener failed: "error listener exploded"`)), logged.join('\n'));
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  assert.equal(received, true);
});

test("a failed write to a stdio server's stdin is reported, never thrown", (t) => {
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stderr: new EventEmitter(), killed: false, exitCode: null });
  const rl = new EventEmitter();
  const transport = new (StdioTransport as any)(child, rl) as StdioTransport;
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(String(args[0])); });
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  // With nobody listening on the transport, it's logged.
  assert.doesNotThrow(() => child.stdin.emit('error', epipe));
  assert.match(logged[0] ?? '', /stdin failed: "write EPIPE"/);
  // With a listener, it's the transport's error.
  const reported: unknown[] = [];
  transport.on('error', (error) => reported.push(error));
  child.stdin.emit('error', epipe);
  assert.deepEqual(reported, [epipe]);
});

test('a synchronous handler that swallows an encoding failure is reported and answered once', async () => {
  const { framework, traces } = harness();
  const listener = framework.containedInboundHandler('srv', 'test-sync', (_params: unknown, reply: any) => {
    try { reply.respond({ count: 1n }); } catch { /* swallowed, synchronously */ }
  });
  const writes: unknown[] = [];
  listener({}, {
    id: 61,
    // Encode as the connection does: an encoding failure is typed, and
    // proves no bytes went out.
    respond(result: unknown) {
      try { JSON.stringify(result); } catch (cause) { throw new McplResponseSerializationError(cause); }
      writes.push(result);
    },
    respondError(code: number, message: string) { writes.push({ code, message }); },
  });
  await settle();
  assert.deepEqual(writes, [{ code: -32603, message: 'Internal error' }]);
  const failures = failureTraces(traces);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, 'test-sync');
  assert.match(failures[0].error, /BigInt/);
});

test("a stderr line whose listener throws is contained like any inbound event", (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('stderr', () => { throw new Error('stderr listener exploded'); });
  assert.doesNotThrow(() => transport.emit('stderr', 'a line from the server'));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /inbound dispatch failed for stderr: stderr listener exploded/);
});

test('a rejection no printer can inspect still reaches the trace first', async (t) => {
  const { framework, connection, traces } = harness();
  // Print as console.error does: every argument goes through util.inspect.
  t.mock.method(console, 'error', (...args: unknown[]) => { for (const arg of args) inspect(arg); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // String() throws on it, and so does printing it.
    const hostile = {
      [inspect.custom]() { throw new Error('inspect refused'); },
      [Symbol.toPrimitive]() { throw new Error('toPrimitive refused'); },
    };
    framework.channelRegistry = { async handleRegister() { throw hostile; } };
    const reply = responder();
    connection.emit('channels-register', {}, reply);
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reply.errors, [{ code: -32603, message: 'Internal error', data: undefined }]);
    const failures = failureTraces(traces);
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0].error, 'string');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a request for an event nothing on the host listens for is answered -32601', (t) => {
  const { connection, transport } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.removeAllListeners('channels-list');
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'channels/list' }));
  const replies = transport.lines.map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code, r.error?.message]), [[71, -32601, 'Method not found']]);
});

test('a value printing cannot handle still leaves a stderr line naming the failure', async (t) => {
  const { framework, connection } = harness();
  framework.traceListeners = [];
  const lines: string[] = [];
  // Print as console.error does, and keep what it printed.
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map((a) => typeof a === 'string' ? a : inspect(a)).join(' ')); });
  const hostile = {
    [inspect.custom]() { throw new Error('inspect refused'); },
    toString() { return 'the hostile failure'; },
  };
  framework.channelRegistry = { async handleRegister() { throw hostile; } };
  connection.emit('channels-register', {}, responder());
  await settle();
  assert.equal(lines.length, 1);
  // The line is built from strings through log-value, so nothing inspects the value.
  assert.match(lines[0]!, /channels-register handler failed: "the hostile failure"$/);
});

test('log text from a server has control, format and separator characters replaced', (t) => {
  const { connection, transport, traces } = wireHarness();
  t.mock.method(console, 'error', () => {});
  connection.prependListener('channels-list', () => { throw new Error('a\u2028b\u202ec\u0007d'); });
  transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'channels/list' }));
  const errors = traces.filter((e) => e.type === 'mcpl:server-error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /: a\?b\?c\?d$/);
});
