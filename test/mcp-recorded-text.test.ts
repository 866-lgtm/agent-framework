import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Transport } from '@modelcontextprotocol/client';
import { EventEmitter } from 'node:events';
import type { ModuleContext } from '../src/index.js';
import { AgentFramework } from '../src/framework.js';
import { McplServerConnection, McplUnreapedLaunchError } from '../src/mcpl/server-connection.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** Discovery succeeds; the inventory request gets a normal echoed-path 404. */
function echo404Server() {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (message.method === 'server/discover') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 60000, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'echo', version: '1' } } },
      }));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`Cannot POST ${req.url}`);
    }
  });
}

/** The SDK's pin-mode discovery rewrites an HTTP 404 into a version error.
 * Send tools/list through the real transport at the connect seam so this test
 * isolates how connection recordings handle an SDK error with the real body. */
function failConnectWithHttpBody(t: import('node:test').TestContext): void {
  t.mock.method(Client.prototype, 'connect', async (transport: Transport) => {
    await transport.start();
    try { await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); }
    finally { await transport.close(); }
  });
}

const secret = 'pathSecret0123456789';
const config = { id: 'remote', url: `https://h/api/mcp/s/${secret}/mcp`, token: 'staticToken012345' };

test('both framework engines scrub failure, error and stderr records before tracing and alerting', () => {
  for (const method of ['wireMcplEvents', 'wireModernEvents']) {
    const traces: unknown[] = [];
    const alerts: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.mcplServerConfigs = new Map([[config.id, config]]);
    framework.emitTrace = (event: unknown) => traces.push(event);
    framework.opsAlert = (_kind: string, _id: string, text: string) => alerts.push(text);
    const connection = Object.assign(new EventEmitter(), { id: config.id, willReconnect: true });
    framework[method](connection);
    connection.emit('connect-failed', { error: `Cannot POST ${secret}`, attempt: 0, permanent: true });
    connection.emit('reconnect-failed', { error: `Cannot POST ${secret}`, attempt: 5 });
    connection.emit('error', new Error(`transport ${secret}`));
    connection.emit('stderr', { line: `server ${config.token}` });
    assert.equal(traces.length, 4);
    assert.equal(alerts.length, 2);
    assert.ok(!JSON.stringify(traces).includes(secret), method);
    assert.ok(!JSON.stringify(traces).includes(config.token), method);
    assert.ok(alerts.every(text => text.includes('Cannot POST redacted')), method);
  }
});

test('an SDK HTTP 404 error keeps its path but hides the secret in connection console, traces and ops alerts', async (t) => {
  failConnectWithHttpBody(t);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-recorded-text-'));
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  const traces: Array<{ type: string; error?: string; message?: string; attempt?: number }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url: `http://127.0.0.1:${port}/api/mcp/s/${secret}/mcp`, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 }],
    });
    const deadline = Date.now() + 5000;
    while (!traces.some(e => e.type === 'ops:alert') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const failed = traces.filter(e => e.type === 'mcpl:server-connect-failed');
    assert.ok(failed.some(e => e.attempt === 0));
    assert.ok(failed.some(e => (e.attempt ?? 0) >= 5));
    assert.ok(failed.every(e => e.error?.includes('Cannot POST /api/mcp/s/redacted/mcp')), JSON.stringify(failed));
    assert.ok(traces.some(e => e.type === 'ops:alert' && e.message?.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(consoleLines.some(line => line.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(!JSON.stringify(traces).includes(secret));
    assert.ok(!consoleLines.join('\n').includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test('startup records redact an echoed path while the direct host connect error stays as raised', async (t) => {
  failConnectWithHttpBody(t);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-startup-text-'));
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  const traces: Array<{ type: string; error?: string }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/s/${secret}/mcp`;
  let framework: AgentFramework | undefined;
  try {
    await assert.rejects(ModernMcpConnection.connect({ id: 'raw', url }), error => {
      assert.ok(error instanceof Error && error.message.includes(secret));
      return true;
    });
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url }],
    });
    assert.ok(traces.some(e => e.type === 'mcpl:server-connect-failed' && e.error?.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(consoleLines.some(line => line.includes('Failed to connect MCPL server') && line.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(!JSON.stringify(traces).includes(secret));
    assert.ok(!consoleLines.join('\n').includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test('legacy initial and reconnect console records redact known credentials', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  t.mock.method(McplServerConnection as any, 'handshake', async () => { throw new Error(`transport ${secret}`); });
  const legacyConfig = { id: 'legacy', url: `ws://127.0.0.1/s/${secret}`, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 };
  const capabilities = { version: '0.5', pushEvents: true };
  const connection = await McplServerConnection.connectWithReconnect(legacyConfig, capabilities);
  try {
    const deadline = Date.now() + 5000;
    while (!lines.some(line => line.includes('reconnect failed:')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(lines.some(line => line.includes('initial connect failed, will retry: transport redacted')));
    assert.ok(lines.some(line => line.includes('reconnect failed: transport redacted')));
    assert.ok(!lines.join('\n').includes(secret));
  } finally { await connection.close(); }
  const halted = Object.assign(new EventEmitter(), { unreapedFailure: () => `cleanup ${secret}` });
  t.mock.method(McplServerConnection as any, 'connectChecked', async () => {
    throw new McplUnreapedLaunchError(halted as unknown as McplServerConnection, new Error(`transport ${secret}`), new Error(`cleanup ${secret}`));
  });
  await McplServerConnection.connectWithReconnect(legacyConfig, capabilities);
  assert.ok(lines.some(line => line.includes('initial connect failed, not retrying: transport redacted; its cleanup also failed: cleanup redacted')));
  assert.ok(!lines.join('\n').includes(secret));
});

test('a real discover-then-tools/list 404 is redacted in the framework error trace', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'mcp-list-text-'));
  const traces: Array<{ type: string; error?: string }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/s/${secret}/mcp` }],
    });
    assert.ok(traces.some(e => e.type === 'mcpl:server-error' && e.error?.includes('Cannot POST /api/mcp/s/redacted/mcp')), JSON.stringify(traces));
    assert.ok(!JSON.stringify(traces).includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
