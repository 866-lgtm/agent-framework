/**
 * Closing a transport whose child or connection has already gone a way the
 * transport didn't choose:
 *   - StdioTransport.close() for a child that a signal this process didn't
 *     send has ended (an OOM kill, a crash), whose `killed` stays false;
 *   - a transport McplServerConnection keeps for close() while a reconnect's
 *     handshake finishes, which reports an error before close() has closed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';

import { McplTransport, StdioTransport, type TransportCloseInfo } from '../src/mcpl/transport.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A transport whose close() waits on the test. */
class HeldTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  calls = 0;
  constructor(private readonly held: Promise<void>) { super(); }
  writeLine(): void {}
  async close(): Promise<void> { this.calls++; await this.held; }
}

test('close() resolves for a child that a signal this process did not send has already ended', async () => {
  const transport = StdioTransport.spawn({
    id: 'signalled',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1 << 30)'],
  });
  const child = (transport as unknown as { child: ChildProcess }).child;
  const closed = new Promise<TransportCloseInfo>((resolve) => { transport.once('close', resolve); });
  process.kill(child.pid!, 'SIGKILL');
  const info = await closed;
  assert.equal(info.signal, 'SIGKILL');
  assert.equal(child.exitCode, null);
  assert.equal(child.killed, false, 'this process sent no signal');
  // Bounded, so a close() that waits for an 'exit' already past fails the
  // test rather than hanging it.
  const outcome = await Promise.race([
    transport.close().then(() => 'closed'),
    new Promise<string>((resolve) => { setTimeout(() => resolve('still waiting after 2 s'), 2000).unref(); }),
  ]);
  assert.equal(outcome, 'closed');
});

test('a transport kept for close() during a reconnect logs an error it reports, rather than throwing it', async (t) => {
  const handshake = deferred();
  const closing = deferred();
  const transport = new HeldTransport(closing.promise);
  t.mock.method(McplServerConnection as unknown as { handshake: () => Promise<unknown> }, 'handshake', async () => {
    await handshake.promise;
    return { transport, capabilities: null, droppedCapabilities: new Set(), mcpToolsAdvertised: false };
  });
  const connection = Reflect.construct(McplServerConnection, ['kept', null, null]) as McplServerConnection;
  const internals = connection as unknown as {
    closed: boolean;
    reconnectEnabled: boolean;
    config: unknown;
    hostCapabilities: unknown;
    attemptReconnect(): Promise<void>;
  };
  internals.closed = true;
  internals.reconnectEnabled = true;
  internals.config = { id: 'kept', command: 'unused', reconnect: true };
  internals.hostCapabilities = { version: '0.5' };
  const reconnecting = internals.attemptReconnect();
  // close() disables reconnect, waits for the handshake in flight, and then
  // closes the transport it handed back.
  const closed = connection.close();
  handshake.resolve();
  await reconnecting;
  while (transport.calls === 0) await new Promise<void>((done) => setImmediate(done));

  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    assert.doesNotThrow(() => transport.emit('error', new Error('socket reset during the close handshake')));
  } finally {
    console.error = consoleError;
  }
  assert.ok(logged.some((line) => line.includes('socket reset during the close handshake')), logged.join('\n'));
  closing.resolve();
  await closed;
  assert.equal(connection.isConnected, false);
});
