// Runs as a separate process holding a bare McplServerConnection over
// WebSocket, with no 'error' listener, as a probe or a playtest would. The
// server completes the handshake, then sends a frame with a reserved opcode,
// which the ws client reports as an 'error' and answers by closing. An error
// thrown with nothing listening would end this process before it prints
// "survived".
import { WebSocketServer } from 'ws';
import { McplServerConnection } from '../../src/mcpl/server-connection.js';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => wss.once('listening', resolve));
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.method === 'initialize') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }));
    } else if (message.method === 'notifications/initialized') {
      // A frame header with opcode 3, which RFC 6455 reserves.
      ws._socket.write(Buffer.from([0x83, 0x00]));
    }
  });
});

const connection = await McplServerConnection.connect(
  { id: 'probe', url: `ws://127.0.0.1:${wss.address().port}` },
  { version: '0.5' },
);
const closed = new Promise((resolve) => connection.once('close', resolve));
connection.ready();
console.log('connected');
const timer = setTimeout(() => { console.log('no close within 30 s'); process.exit(1); }, 30_000);
await closed;
clearTimeout(timer);
console.log('closed');
console.log('survived');
await connection.close();
wss.close();
