/**
 * A push/render answered after its timeout (#398, RFC-006 §5.3–§5.4). The host
 * has materialized the batch's fallback by then, and the late result is
 * discarded, which RFC-006 §11 asks a host that keeps an audit record to
 * record, linked by eventId. The connection reports it as an orphaned
 * response naming the render's featureSet, key and eventId, and the
 * framework's wiring records it beside the coalescer's other records, as a
 * mcpl:coalescing late-render. orphaned-response is a control-plane event, so
 * a paused data plane neither holds it nor spends a slot of its bound on it.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { PushRenderParams } from '../src/mcpl/push-coalescer.js';

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

const RENDER: PushRenderParams = { featureSet: 'fs', key: 'k1', eventId: 'e7', notices: [], dropped: 0 };

/** A real connection, wired by the framework, whose push/render has timed out. */
async function timedOutRender(t: TestContext) {
  const transport = new LineTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.traceListeners = [];
  framework.onTrace((event: never) => traces.push(event));
  framework.wireMcplEvents(connection);
  const orphans: unknown[] = [];
  connection.on('orphaned-response', (info: unknown) => orphans.push(info));
  connection.ready();
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const render = connection.sendPushRender(RENDER);
  const { id } = JSON.parse(transport.lines[0]!) as { id: number };
  t.mock.timers.tick(5_000);
  await assert.rejects(render, /did not respond to push\/render/);
  const answerLate = () => transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'late' }] } }));
  return { connection, traces, orphans, id, answerLate };
}

const lateRender = { type: 'mcpl:coalescing', kind: 'late-render', serverId: 'srv', eventId: 'e7', featureSet: 'fs', key: 'k1', discarded: true };

test('a push/render answered after its timeout is recorded as a discarded late-render, linked by its eventId', async (t) => {
  const { traces, orphans, id, answerLate } = await timedOutRender(t);
  answerLate();
  // The connection's one event for a response whose request timed out.
  assert.deepEqual(orphans, [{ id, method: 'push/render', hadState: false, hadCheckpoint: false, featureSet: 'fs', key: 'k1', eventId: 'e7' }]);
  const recorded = traces.filter((e) => e.type === 'mcpl:coalescing' || e.type === 'mcpl:orphaned-response');
  assert.deepEqual(recorded.map(({ timestamp: _timestamp, ...rest }) => rest), [lateRender]);
});

test('while the data plane is paused, a late push/render answer is recorded at once and takes no slot', async (t) => {
  const { connection, traces, answerLate } = await timedOutRender(t);
  // A quiesce or an awareness drain: control traffic flows, data is held.
  connection.pauseDataPlane();
  answerLate();
  assert.equal((connection as any).bufferedEvents.length, 0);
  const recorded = traces.filter((e) => e.type === 'mcpl:coalescing');
  assert.deepEqual(recorded.map(({ timestamp: _timestamp, ...rest }) => rest), [lateRender]);
});
