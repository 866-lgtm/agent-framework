/**
 * MCP's ping (#392): either side may send one, and the receiver answers
 * promptly with an empty result. A server's ping is answered on a connected
 * transport, whether or not its planes are paused, and during the initialize
 * handshake, where it must never be taken for the initialize response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

function bareConnection() {
  const transport = new LineTransport();
  // Real routing and response encoding, without launching a server.
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  const receive = (message: unknown) => transport.emit('line', JSON.stringify(message));
  const written = () => transport.lines.map((line) => JSON.parse(line));
  return { connection, receive, written };
}

test('a ping on a connected transport is answered with an empty result; a ping notification is not', () => {
  const { connection, receive, written } = bareConnection();
  connection.ready();
  receive({ jsonrpc: '2.0', method: 'ping' });
  receive({ jsonrpc: '2.0', id: 1, method: 'ping' });
  receive({ jsonrpc: '2.0', id: 'p-2', method: 'ping' });
  assert.deepEqual(written(), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 'p-2', result: {} },
  ]);
});

test('a ping is answered at once while the planes are paused, and nothing is held for it', () => {
  const { connection, receive, written } = bareConnection();
  // Before ready() both planes are closed, as at startup; a quiesce or the
  // awareness barrier holds the data plane the same way.
  receive({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(written(), [{ jsonrpc: '2.0', id: 3, result: {} }]);
  assert.equal((connection as any).bufferedEvents.length, 0);
});

// A stdio server that pings as soon as initialize arrives, with id 0 (an SDK
// whose request ids start at 0 sends that), and answers initialize once its
// pong arrives, or after 2 s without one. Before answering, it writes to
// stderr whether the pong came.
const PINGING_SERVER = String.raw`
let buf = '';
let init = null;
let answered = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const answer = (pong) => {
  if (answered) return;
  answered = true;
  process.stderr.write('pong:' + (pong ? 'yes' : 'no') + '\n');
  send({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } } });
};
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') {
      init = m;
      send({ jsonrpc: '2.0', id: 0, method: 'ping' });
      setTimeout(() => answer(false), 2000);
    } else if (m.id === 0 && m.method === undefined && init && !answered) {
      answer(m.result !== undefined && Object.keys(m.result).length === 0 && m.error === undefined);
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

test('a ping sent before the initialize response is answered, and is not taken for that response', async () => {
  const connection = await McplServerConnection.connect(
    { id: 'pinger', command: process.execPath, args: ['-e', PINGING_SERVER], requestTimeoutMs: 5_000 },
    { version: '0.5' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // stderr is its own pipe, so its line may arrive after the response.
    const said = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the server wrote nothing to stderr within 10 s')), 10_000);
      connection.once('stderr', ({ line }: { line: string }) => resolve(line));
    });
    said.catch(() => {});
    connection.ready();
    // The initialize response, not the ping, set the capabilities.
    assert.equal(connection.capabilities?.pushEvents, true);
    assert.equal(await said, 'pong:yes');
  } finally {
    clearTimeout(timer);
    await connection.close();
  }
});
