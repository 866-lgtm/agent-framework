/**
 * Runtime MCPL server lifecycle — connectMcplServer / disconnectMcplServer /
 * restartMcplServer on a live framework, including lazy MCPL subsystem
 * initialization when the framework started with zero configured servers.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A module with no tools: only a name, for a server's tool prefix to collide with. */
class NamedModule implements Module {
  constructor(readonly name: string) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
}

// A tiny stdio MCPL server (same shape as mcpl-ws-transport.test.ts): reads
// NDJSON on stdin, answers initialize / tools/list / tools/call on stdout.
const STDIO_SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] });
  }
});
`;

function serverConfig(id: string, extra?: Record<string, unknown>) {
  return { id, command: process.execPath, args: ['-e', STDIO_SERVER], ...extra };
}

async function withFramework(
  withServer: boolean,
  fn: (framework: AgentFramework) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mcpl-lifecycle-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    ...(withServer ? { mcplServers: [serverConfig('first')] } : {}),
  });
  try {
    await fn(framework);
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('connectMcplServer lazily initializes MCPL on a zero-server framework and exposes tools', async () => {
  await withFramework(false, async (framework) => {
    assert.deepEqual(framework.listMcplServers(), [], 'no servers configured at start');

    await framework.connectMcplServer(serverConfig('dyn'));

    const servers = framework.listMcplServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].id, 'dyn');
    assert.equal(servers[0].connected, true);
    assert.equal(servers[0].toolCount, 1);

    const toolNames = framework.getAllTools().map(t => t.name);
    assert.ok(toolNames.includes('mcpl--dyn--echo'), `expected mcpl--dyn--echo in ${toolNames}`);
  });
});

test('disconnectMcplServer removes the server and its tools', async () => {
  await withFramework(true, async (framework) => {
    assert.ok(
      framework.getAllTools().some(t => t.name === 'mcpl--first--echo'),
      'startup server tools present',
    );

    await framework.disconnectMcplServer('first');

    assert.deepEqual(framework.listMcplServers(), [], 'server gone from list');
    assert.ok(
      !framework.getAllTools().some(t => t.name.startsWith('mcpl--first--')),
      'tools removed after disconnect',
    );
  });
});

test('restartMcplServer respawns the server and keeps tools available', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first');

    const servers = framework.listMcplServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].connected, true);
    assert.equal(servers[0].toolCount, 1);
    assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--first--echo'));
  });
});

test('restartMcplServer accepts an updated config (new toolPrefix)', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'renamed' }) as never);

    const toolNames = framework.getAllTools().map(t => t.name);
    assert.ok(toolNames.includes('renamed--echo'), `expected renamed--echo in ${toolNames}`);
    assert.ok(!toolNames.some(n => n.startsWith('mcpl--first--')), 'old prefix gone');
  });
});

test("restartMcplServer refuses what the connect would refuse before tearing anything down: another server's prefix or id, or a module's name", async () => {
  await withFramework(true, async (framework) => {
    await framework.connectMcplServer(serverConfig('second') as never);
    await framework.addModule(new NamedModule('notes'));
    const untouched = () => {
      const live = framework.listMcplServers().filter(s => s.connected).map(s => s.id).sort();
      assert.deepEqual(live, ['first', 'second'], 'both servers still connected');
      const tools = framework.getAllTools().map(t => t.name);
      assert.ok(tools.includes('mcpl--first--echo') && tools.includes('mcpl--second--echo'), 'and their tools still listed');
    };
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'mcpl--second' }) as never),
      /collides with server "second"/,
    );
    untouched();
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'notes' }) as never),
      /collides with module "notes"/,
    );
    untouched();
    // Under another live server's id, whose prefix is that server's own, so
    // only the id is taken.
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('second') as never),
      /MCPL server "second" is already registered/,
    );
    untouched();
  });
});

test('restartMcplServer under a new id may keep the tool prefix the restarted server frees', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first', serverConfig('renamed', { toolPrefix: 'mcpl--first' }) as never);
    const servers = framework.listMcplServers();
    assert.deepEqual(servers.map(s => [s.id, s.connected]), [['renamed', true]], 'first was replaced');
    assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--first--echo'), 'and the prefix it freed serves the new id');
  });
});

test('restartMcplServer refuses once stop() has begun, before it disconnects anything', async (t) => {
  await withFramework(true, async (framework) => {
    const disconnect = t.mock.method(framework, 'disconnectMcplServer');
    const stopping = framework.stop();
    await assert.rejects(
      framework.restartMcplServer('first'),
      /MCP server "first" was not restarted: the framework is stopping or stopped/,
    );
    await stopping;
    assert.equal(disconnect.mock.callCount(), 0, 'the restart disconnected nothing');
  });
});

test('restartMcplServer of an id whose disconnect is in flight is refused before it tears anything down', async (t) => {
  await withFramework(true, async (framework) => {
    const disconnecting = framework.disconnectMcplServer('first');
    const disconnect = t.mock.method(framework, 'disconnectMcplServer');
    await assert.rejects(
      framework.restartMcplServer('first'),
      /MCP server "first" was not restarted: it is being disconnected; restart it once that has finished/,
    );
    assert.equal(disconnect.mock.callCount(), 0, 'the restart started no disconnect of its own');
    disconnect.mock.restore();
    await disconnecting;
  });
});

test("a disconnect removes its server's prefix claim, and leaves one another server holds", async () => {
  await withFramework(true, async (framework) => {
    const internals = framework as unknown as { mcplPrefixMap: Map<string, string> };
    // As after a restart under a new id: `second` holds the prefix `first` had.
    internals.mcplPrefixMap.set('mcpl--first', 'second');
    await framework.disconnectMcplServer('first');
    assert.equal(internals.mcplPrefixMap.get('mcpl--first'), 'second', "the other server's claim stands");
  });
});

test('connectMcplServer rejects a duplicate id and a colliding prefix', async () => {
  await withFramework(true, async (framework) => {
    await assert.rejects(
      framework.connectMcplServer(serverConfig('first')),
      /already registered/,
    );

    await assert.rejects(
      framework.connectMcplServer(serverConfig('second', { toolPrefix: 'mcpl--first' })),
      /collides with server "first"/,
    );
  });
});

test('connectMcplServer hot-connects a network-only (WebSocket) MCPL server', async () => {
  // Minimal in-process MCPL server over WebSocket (same shape as
  // mcpl-ws-transport.test.ts) — no child process involved.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg: { id?: unknown; method?: string; params?: { arguments?: Record<string, unknown> } };
      try { msg = JSON.parse(String(data)); } catch { return; }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
      else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    });
  });
  await new Promise<void>((resolve) => (wss.address() ? resolve() : wss.once('listening', () => resolve())));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`;

  try {
    await withFramework(false, async (framework) => {
      await framework.connectMcplServer({ id: 'netsrv', url } as never);

      const servers = framework.listMcplServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connected, true);
      assert.equal(servers[0].url, url);
      assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--netsrv--echo'));

      await framework.disconnectMcplServer('netsrv');
      assert.ok(!framework.getAllTools().some(t => t.name.startsWith('mcpl--netsrv--')));
    });
  } finally {
    wss.close();
  }
});

test('disconnecting an unknown server is a no-op (routing state cleared, no throw)', async () => {
  await withFramework(true, async (framework) => {
    await framework.disconnectMcplServer('nope');
    assert.equal(framework.listMcplServers().length, 1, 'existing server untouched');
  });
});
