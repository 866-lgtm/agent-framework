/**
 * Sleep across a stop: EventGate.dispose() and resumeSleep().
 *
 * Contract:
 *   - dispose() keeps the sleep (until, note, agent) and clears its timer, so
 *     nothing fires into a stopped framework and nothing holds the process.
 *   - resumeSleep(), which the framework's start() calls, arms the wake again
 *     for a sleep still ahead, and wakes at once for one that ended while
 *     stopped: that wake is the one the agent asked for.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { EventGate } from '../src/gate/event-gate.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-sleep');

function makeGate() {
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];
  const traces: string[] = [];
  const gate = new EventGate({
    configPath: join(TMP_DIR, 'gate.json'),
    initialConfig: { policies: [], default: 'always' },
    emitTrace: (e) => { if (typeof e.eventType === 'string') traces.push(e.eventType); },
    addMessage: () => '',
    requestInference: (a, r, s) => inferenceRequests.push({ agentName: a, reason: r, source: s }),
    getAgentNames: () => ['agent'],
  });
  return { gate, inferenceRequests, traces };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EventGate sleep across a stop', () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  it('dispose() keeps the sleep and lets nothing fire', async () => {
    const { gate, inferenceRequests, traces } = makeGate();
    gate.setSleep(0.2, 'resting', 'agent');
    gate.dispose();
    await wait(400);
    assert.deepStrictEqual(inferenceRequests, [], 'no wake after dispose()');
    assert.ok(!traces.includes('sleep:expired'), 'no expiry after dispose()');
    assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, 'the sleep is kept for the next start');
  });

  it('resumeSleep() wakes once at the end of a sleep still ahead', async () => {
    const { gate, inferenceRequests } = makeGate();
    gate.setSleep(0.4, 'resting', 'agent');
    gate.dispose();
    gate.resumeSleep();
    await wait(150);
    assert.strictEqual(inferenceRequests.length, 0, 'not before the sleep ends');
    await wait(450);
    assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }]);
    gate.resumeSleep();
    await wait(50);
    assert.strictEqual(inferenceRequests.length, 1, 'with the sleep over, resumeSleep() does nothing');
    gate.dispose();
  });

  it('resumeSleep() wakes at once for a sleep that ended while disposed', async () => {
    const { gate, inferenceRequests } = makeGate();
    gate.setSleep(0.1, 'resting', 'agent');
    gate.dispose();
    await wait(250);
    assert.strictEqual(inferenceRequests.length, 0);
    gate.resumeSleep();
    assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }]);
    assert.strictEqual(gate.inferenceDiagnostics().sleepUntil, 0);
    gate.dispose();
  });

  it("a framework stopped while its agent sleeps wakes nothing until it's started again, then wakes the agent", async () => {
    // A store the caller owns: an owned store closes at stop(), and a start()
    // after that is refused.
    const store = JsStore.openOrCreate({ path: join(TMP_DIR, 'store') });
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'awake' }]));
    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: { config: { policies: [], default: 'always' } },
      modules: [],
    });
    const internals = framework as unknown as {
      eventGate: EventGate;
      pendingRequests: Array<{ source: string }>;
    };
    const expiries: string[] = [];
    framework.onTrace((e) => {
      if ((e as { eventType?: unknown }).eventType === 'sleep:expired') expiries.push('sleep:expired');
    });
    try {
      framework.start();
      internals.eventGate.setSleep(0.2, 'resting', 'agent');
      await framework.stop();
      await wait(400);
      assert.deepStrictEqual(expiries, [], 'nothing expires while stopped');
      assert.ok(!internals.pendingRequests.some((r) => r.source === 'sleep'), 'no wake is queued while stopped');
      framework.start();
      const deadline = Date.now() + 3_000;
      while (membrane.calls.length === 0 && Date.now() < deadline) await wait(25);
      assert.strictEqual(membrane.calls.length, 1, 'the start wakes the agent once');
      assert.deepStrictEqual(expiries, ['sleep:expired']);
    } finally {
      await framework.stop();
      store.close();
    }
  });
});
