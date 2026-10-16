/**
 * A transport error on a connection nothing listens to for 'error' (#391).
 * EventEmitter throws an 'error' with no listener, and a transport reports its
 * errors from I/O callbacks, where nothing catches the throw: it ended the
 * process. McplServerConnection is exported, and a probe, a playtest or a
 * harness holding one often attaches no 'error' listener (the framework
 * always does). The error is logged instead, and given to listeners when
 * there are any, a throwing one caught as #208's inbound failures are.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'websocket' as const;
  writeLine(): void {}
  async close(): Promise<void> {}
}

function bareConnection(t: TestContext) {
  const transport = new LineTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.ready();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return { connection, transport, logged, reset };
}

test("a transport error on a connection with no 'error' listener is logged, never thrown", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  assert.equal(connection.listenerCount('error'), 0);
  assert.doesNotThrow(() => transport.emit('error', reset));
  assert.deepEqual(logged, ['[mcpl] srv: transport error: "read ECONNRESET"']);
});

test("with an 'error' listener, a transport error is the listener's, and nothing is logged", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  const reported: Error[] = [];
  connection.on('error', (error: Error) => reported.push(error));
  transport.emit('error', reset);
  assert.deepEqual(reported.map((error) => error.message), ['MCPL server "srv" transport error: read ECONNRESET']);
  assert.deepEqual(logged, []);
});

test("an 'error' listener that throws on a transport error is caught and logged", (t) => {
  const { connection, transport, logged, reset } = bareConnection(t);
  connection.on('error', () => { throw new Error('listener exploded'); });
  assert.doesNotThrow(() => transport.emit('error', reset));
  assert.deepEqual(logged, [`[mcpl] srv: an 'error' listener failed: "listener exploded"`]);
});

test('a separate process holding a bare WebSocket connection survives a malformed frame, and sees the close', () => {
  const probe = spawnSync(process.execPath, [
    fileURLToPath(new URL('./fixtures/mcpl-bare-ws-error-probe.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(probe.stdout.trim().split('\n'), ['connected', 'closed', 'survived']);
  assert.match(probe.stderr, /\[mcpl\] probe: transport error: "Invalid WebSocket frame: invalid opcode 3"/);
});
