/**
 * The boolean settings of an MCPL server's config (#379): `inheritEnv`,
 * `reconnect` and `allowHostCommands` each take true or false, or are left
 * out, and null counts as left out. The framework's entry points refuse any
 * other value (test/mcpl-runtime-lifecycle.test.ts), and every reader takes
 * only `true` as on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { assertServerConfigBooleans } from '../src/mcpl/transport.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

const WHAT_TRUE_DOES = {
  inheritEnv: "true passes the server the host's whole environment, and false or leaving it out passes only the allowlisted and LC_* host variables",
  reconnect: "true retries in the background when the server can't be reached or its connection drops, and false or leaving it out doesn't",
  allowHostCommands: 'true lets the server send host/command requests, and false or leaving it out refuses them',
};

const STDIO = { id: 'discord', command: 'discord-mcpl' };
const WEBSOCKET = { id: 'remote', url: 'ws://127.0.0.1:1' };

const check = (config: Record<string, unknown>) => assertServerConfigBooleans(config as unknown as McplServerConfig);

test('each boolean setting takes true, false, null or nothing, on either transport', () => {
  for (const setting of Object.keys(WHAT_TRUE_DOES)) {
    for (const value of [undefined, null, true, false]) {
      check({ ...STDIO, [setting]: value });
      check({ ...WEBSOCKET, [setting]: value });
    }
  }
});

test('any other value is refused, naming the server, the setting and the kind of value but not the value', () => {
  const refused: Array<[unknown, string]> = [
    ['true', 'true or false, unquoted, not a string'],
    ['false', 'true or false, unquoted, not a string'],
    ['', 'true or false, unquoted, not a string'],
    ['xoxb-pasted-token', 'true or false, unquoted, not a string'],
    [0, 'true or false, not a number'],
    [1, 'true or false, not a number'],
    [[], 'true or false, not an array'],
    [{}, 'true or false, not an object'],
    [new Map(), 'true or false, not a Map'],
  ];
  for (const [setting, whatTrueDoes] of Object.entries(WHAT_TRUE_DOES)) {
    for (const [value, wanted] of refused) {
      assert.throws(() => check({ ...STDIO, [setting]: value }), (err: Error) => {
        assert.equal(err.message, `MCPL server "discord" ${setting} must be ${wanted}: ${whatTrueDoes}`);
        return true;
      }, `${setting}: ${JSON.stringify(value)}`);
    }
  }
});

test('inheritEnv is checked only for a stdio server, since a WebSocket server never reads it', () => {
  // A url alone or transport: 'websocket' dials, as openTransport chooses.
  check({ ...WEBSOCKET, inheritEnv: 'false' });
  check({ id: 'remote', url: 'ws://127.0.0.1:1', command: 'unused', transport: 'websocket', inheritEnv: 'no' });
  // A url beside a command, with no transport, spawns the command.
  assert.throws(() => check({ id: 'both', url: 'ws://127.0.0.1:1', command: 'discord-mcpl', inheritEnv: 'false' }),
    /MCPL server "both" inheritEnv must be true or false, unquoted, not a string: /);
  // The other two apply to both transports.
  assert.throws(() => check({ ...WEBSOCKET, reconnect: 'false' }),
    /MCPL server "remote" reconnect must be true or false, unquoted, not a string: /);
  assert.throws(() => check({ ...WEBSOCKET, allowHostCommands: 'true' }),
    /MCPL server "remote" allowHostCommands must be true or false, unquoted, not a string: /);
});

// The .mjs fixture is not compiled/copied by tsc, so when this test runs from
// dist/test it must reach back into the source tree for it.
const FIXTURE = [
  join(import.meta.dirname, 'fixtures/flaky-mcpl-server.mjs'),
  join(import.meta.dirname, '../../test/fixtures/flaky-mcpl-server.mjs'),
].find((p) => existsSync(p))!;

const HOST_CAPS: McplHostCapabilities = {
  version: '0.5',
  pushEvents: true,
  contextHooks: { beforeInference: true },
  featureSets: true,
};

/** The flaky fixture exits before its handshake unless `flagFile` exists,
 *  and exits on tools/list once up. */
function flaky(flagFile: string, reconnect: unknown): McplServerConfig {
  return {
    id: 'flaky',
    command: process.execPath,
    args: [FIXTURE, flagFile],
    reconnect: reconnect as boolean,
    reconnectIntervalMs: 50,
  };
}

test('a reconnect that is not true never retries a failed first connect: the failure is thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-booleans-'));
  const flag = join(dir, 'up'); // never written: the server exits before its handshake
  const registry = new McplServerRegistry();
  try {
    for (const reconnect of ['false', 'true', 1]) {
      // A connection returned anyway is closed, so the failure is this
      // assertion rather than a stub retrying in the background.
      await assert.rejects(
        McplServerConnection.connectWithReconnect(flaky(flag, reconnect), HOST_CAPS)
          .then(async (connection) => { await connection.close(); return connection; }),
        /before handshake/,
        `connectWithReconnect, reconnect ${JSON.stringify(reconnect)}`,
      );
      await assert.rejects(registry.addServer(flaky(flag, reconnect), HOST_CAPS), /before handshake/,
        `addServer, reconnect ${JSON.stringify(reconnect)}`);
    }
  } finally {
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reconnect that is not true leaves a dropped server down: nothing retries, and the registry lets it go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-booleans-'));
  const flag = join(dir, 'up');
  writeFileSync(flag, '');
  const registry = new McplServerRegistry();
  try {
    const connection = await registry.addServer(flaky(flag, 'false'), HOST_CAPS);
    assert.equal(connection.willReconnect, false, 'no retry is armed');
    const closed = new Promise<void>((resolve) => connection.on('close', () => resolve()));
    connection.ready();
    connection.sendToolsList().catch(() => {}); // the fixture exits on tools/list
    await closed;
    assert.equal(registry.getServer('flaky'), null, 'the registry dropped the closed server');
    assert.equal(connection.willReconnect, false);
  } finally {
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
