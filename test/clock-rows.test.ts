/**
 * Clock rows (AgentConfig.clock, src/clock-rows.ts).
 *
 * A clock stands for the tick that fired at the latest boundary of the
 * agent's local wall clock, written lazily before what the window takes
 * next. It reads the boundary's time only where that tick would have stood;
 * after a tool round (nothing can stand between a tool's call and its
 * results) or a reply that spanned the boundary, it reads the time it was
 * written. It never reads earlier than a row before it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import type { AgentConfig, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import {
  formatClockText,
  latestBoundary,
  planClock,
  resolveClockConfig,
  type ResolvedClockConfig,
} from '../src/clock-rows.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const at = (iso: string): number => Date.parse(iso);
const TEN_MINUTES: ResolvedClockConfig = { intervalSeconds: 600, precision: 'minutes' };

describe('clock config', () => {
  it('takes minutes or seconds, and picks the precision the interval allows', () => {
    assert.deepEqual(resolveClockConfig('a', undefined), undefined);
    assert.deepEqual(resolveClockConfig('a', { intervalMinutes: 10 }), { intervalSeconds: 600, precision: 'minutes' });
    assert.deepEqual(resolveClockConfig('a', { intervalSeconds: 15 }), { intervalSeconds: 15, precision: 'seconds' });
    assert.deepEqual(resolveClockConfig('a', { intervalSeconds: 120 }), { intervalSeconds: 120, precision: 'minutes' });
    assert.deepEqual(
      resolveClockConfig('a', { intervalMinutes: 1, precision: 'seconds' }),
      { intervalSeconds: 60, precision: 'seconds' },
    );
  });

  it('refuses a setting it cannot read as a clock, naming the agent', () => {
    assert.throws(() => resolveClockConfig('Ada', {}), /Agent "Ada" clock takes exactly one of/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 10, intervalSeconds: 600 }), /exactly one/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 0 }), /positive whole number/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 2.5 }), /positive whole number/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 1441 }), /at most a day/);
    assert.throws(() => resolveClockConfig('a', { intervalSeconds: 90, precision: 'minutes' }), /precision 'seconds'/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 5, precision: 'hours' as never }), /'minutes' or 'seconds'/);
    assert.throws(() => resolveClockConfig('a', 10 as never), /must be an object/);
  });
});

describe('clock boundaries', () => {
  it('counts from local midnight in the zone, not from UTC', () => {
    // Kathmandu is UTC+05:45: an hourly boundary is :00 there, :15 in UTC.
    assert.equal(
      latestBoundary(at('2026-10-21T05:00:00Z'), 3600, 'Asia/Kathmandu'),
      at('2026-10-21T04:15:00Z'),
    );
    assert.equal(latestBoundary(at('2026-10-21T10:51:30Z'), 600, 'UTC'), at('2026-10-21T10:50:00Z'));
    assert.equal(latestBoundary(at('2026-10-21T10:50:00Z'), 600, 'UTC'), at('2026-10-21T10:50:00Z'),
      'a boundary is its own latest');
  });

  it('keeps wall-clock boundaries across a DST change', () => {
    // New York springs forward 2026-03-08 02:00 EST -> 03:00 EDT. Four-hour
    // boundaries from local midnight: 00:00 EST (05:00Z), 04:00 EDT (08:00Z).
    assert.equal(
      latestBoundary(at('2026-03-08T07:30:00Z'), 4 * 3600, 'America/New_York'),
      at('2026-03-08T05:00:00Z'),
      '03:30 EDT: the latest boundary is midnight EST, 2.5 hours back, not 3.5',
    );
    // Hourly: 02:00 never happens that day.
    assert.equal(
      latestBoundary(at('2026-03-08T06:59:00Z'), 3600, 'America/New_York'),
      at('2026-03-08T06:00:00Z'),
    );
    assert.equal(
      latestBoundary(at('2026-03-08T07:00:30Z'), 3600, 'America/New_York'),
      at('2026-03-08T07:00:00Z'),
    );
    // Falls back 2026-11-01 02:00 EDT -> 01:00 EST: 01:00 happens twice, and
    // the second one is the latest once it has passed.
    assert.equal(
      latestBoundary(at('2026-11-01T05:30:00Z'), 3600, 'America/New_York'),
      at('2026-11-01T05:00:00Z'),
    );
    assert.equal(
      latestBoundary(at('2026-11-01T06:30:00Z'), 3600, 'America/New_York'),
      at('2026-11-01T06:00:00Z'),
    );
  });
});

describe('clock text', () => {
  it('shows the time zone, the date when asked, and seconds when the precision is seconds', () => {
    const t = at('2026-07-15T08:50:00Z');
    assert.equal(formatClockText(t, 'Europe/Berlin', 'minutes', false), 'Clock: 10:50 Europe/Berlin (UTC+02:00)');
    assert.equal(
      formatClockText(t, 'Europe/Berlin', 'minutes', true),
      'Clock: Wednesday 2026-07-15, 10:50 Europe/Berlin (UTC+02:00)',
    );
    assert.equal(
      formatClockText(at('2026-07-15T08:50:07Z'), 'Europe/Berlin', 'seconds', false),
      'Clock: 10:50:07 Europe/Berlin (UTC+02:00)',
    );
    assert.equal(formatClockText(t, 'UTC', 'minutes', false), 'Clock: 08:50 UTC');
    assert.equal(formatClockText(t, 'America/St_Johns', 'minutes', false), 'Clock: 06:20 America/St_Johns (UTC-02:30)');
  });
});

describe('planning a clock', () => {
  const plan = (args: { now: string; newest?: string; lastClock?: string; config?: ResolvedClockConfig }) =>
    planClock({
      now: at(args.now),
      newestRowAt: args.newest ? at(args.newest) : undefined,
      lastClockAt: args.lastClock ? at(args.lastClock) : undefined,
      config: args.config ?? TEN_MINUTES,
      zone: 'UTC',
    });
  const text = (p: ReturnType<typeof plan>) => (p?.content[0] as { text: string } | undefined)?.text;

  it('reads the boundary where its tick would have stood', () => {
    const p = plan({ now: '2026-10-21T10:51:00Z', newest: '2026-10-21T10:45:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 10:50 UTC');
    assert.deepEqual(p?.stamp, { at: at('2026-10-21T10:50:00Z'), onBoundary: true, zone: 'UTC' });
  });

  it('writes only the latest of several boundaries', () => {
    const p = plan({ now: '2026-10-21T11:23:00Z', newest: '2026-10-21T10:45:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 11:20 UTC');
  });

  it('reads the time it is written when a row after the boundary comes first', () => {
    // A tool ran over 10:50; its results (10:52) must follow its call.
    const p = plan({ now: '2026-10-21T10:52:05Z', newest: '2026-10-21T10:52:04Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 10:52 UTC');
    assert.equal(p?.stamp.onBoundary, false);
    assert.equal(p?.stamp.at, at('2026-10-21T10:52:05Z'));
  });

  it('never reads earlier than the row it follows', () => {
    const p = plan({ now: '2026-10-21T10:52:05Z', newest: '2026-10-21T10:53:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(p?.stamp.at, at('2026-10-21T10:53:00Z'));
  });

  it('writes nothing until a boundary passes the last clock', () => {
    assert.equal(plan({ now: '2026-10-21T10:59:59Z', newest: '2026-10-21T10:55:00Z', lastClock: '2026-10-21T10:52:05Z' }), null);
    assert.equal(text(plan({ now: '2026-10-21T11:00:01Z', newest: '2026-10-21T10:55:00Z', lastClock: '2026-10-21T10:52:05Z' })),
      'Clock: 11:00 UTC');
  });

  it('shows the date when the day has changed since the last clock', () => {
    assert.equal(
      text(plan({ now: '2026-10-22T00:01:00Z', newest: '2026-10-21T23:55:00Z', lastClock: '2026-10-21T23:50:00Z' })),
      'Clock: Thursday 2026-10-22, 00:00 UTC',
    );
  });

  it('without a clock in the window: rows up to the newest count as told, and the first clock carries the date', () => {
    assert.equal(plan({ now: '2026-10-21T10:47:00Z', newest: '2026-10-21T10:45:00Z' }), null);
    assert.equal(
      text(plan({ now: '2026-10-21T10:51:00Z', newest: '2026-10-21T10:45:00Z' })),
      'Clock: Wednesday 2026-10-21, 10:50 UTC',
    );
    assert.equal(text(plan({ now: '2026-10-21T10:51:00Z' })), 'Clock: Wednesday 2026-10-21, 10:50 UTC',
      'an empty window');
  });

  it('reads seconds when the precision is seconds', () => {
    const p = plan({
      now: '2026-10-21T10:50:31Z', newest: '2026-10-21T10:50:29Z', lastClock: '2026-10-21T10:50:00Z',
      config: { intervalSeconds: 30, precision: 'seconds' },
    });
    assert.equal(text(p), 'Clock: 10:50:30 UTC');
  });
});

// ---------------------------------------------------------------------------
// In the framework
// ---------------------------------------------------------------------------

class ToolModule implements Module {
  readonly name = 'tools';
  /** Runs inside the next tool call: the round's time passes here. */
  during: (() => void) | null = null;
  async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); }
  async stop() {}
  async onProcess() { return {}; }
  async onAgentSpeech() {}
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    during?.();
    return { success: true, data: { ok: true } };
  }
}

let seq = 0;
function event(text: string) {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes',
    eventId: `ev-${n}`, content: [{ type: 'text', text }], timestamp: new Date().toISOString(),
    inferenceId: `inf-ev-${n}`, triggerInference: true,
  };
}
function silentTick() {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
    eventId: `hb-${n}`, content: [], timestamp: new Date().toISOString(),
    origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-21 10:51:00 UTC' },
    inferenceId: `inf-hb-${n}`, triggerInference: true,
  };
}

type Row = { participant: string; content: ContentBlock[]; metadata?: Record<string, any>; timestamp: Date };

describe('clock rows in the framework', () => {
  const realNow = Date.now;
  let offset = 0;
  /** Shift the clock so that it reads `iso` now; it keeps running from there. */
  const setClock = (iso: string) => { offset = at(iso) - realNow(); };
  let dirs: string[] = [];

  beforeEach(() => {
    offset = 0;
    Date.now = () => realNow() + offset;
  });
  afterEach(() => {
    Date.now = realNow;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  async function make(agent: Partial<AgentConfig> = { clock: { intervalMinutes: 10 } }) {
    const dir = mkdtempSync(join(tmpdir(), 'clock-rows-'));
    dirs.push(dir);
    const membrane = new MockMembrane();
    const mod = new ToolModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(), timeZone: 'UTC',
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'locus', maxTokens: 4_000, ...agent }],
      modules: [mod],
    });
    (framework as any).channelRegistry = new Proxy({
      resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
      routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
      startTyping: () => {}, stopTyping: () => {},
      getChannelTools: () => [], getDescriptor: () => undefined,
    }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
    return { membrane, mod, framework };
  }

  async function wake(x: { membrane: MockMembrane; framework: AgentFramework }, ev: unknown, ...responses: ContentBlock[][]) {
    for (const content of responses) {
      x.membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
    }
    (x.framework as any).handleMcplPushEvent(ev);
    await x.framework.runUntilIdle();
  }

  const rows = (framework: AgentFramework): Row[] =>
    framework.getAgent('assistant')!.getContextManager().getAllMessages() as unknown as Row[];
  const textOf = (row: Row) => row.content.map((b) => (b as { text?: string }).text ?? '').join('');
  const isClock = (row: Row) => row.metadata?.kind === 'clock';
  const indexOfText = (all: Row[], needle: string) => all.findIndex((r) => !isClock(r) && textOf(r).includes(needle));
  const requestText = (request: NormalizedRequest) =>
    request.messages.map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join('')).join('\n');

  it('writes the latest boundary ahead of an event after an idle gap, and only that one', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('first'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T11:23:10Z');
      await wake(x, event('second'), [{ type: 'text', text: 'ok again' }]);

      const all = rows(x.framework);
      const first = indexOfText(all, 'first');
      const second = indexOfText(all, 'second');
      assert.ok(first > 0 && second > first);
      assert.equal(textOf(all[first - 1]!), 'Clock: Wednesday 2026-10-21, 10:40 UTC', 'the window\'s first clock carries the date');
      const between = all.slice(first + 1, second).filter(isClock);
      assert.deepEqual(between.map(textOf), ['Clock: 11:20 UTC'], 'one clock for the gap: 10:50 to 11:20 coalesced');
      assert.ok(isClock(all[second - 1]!), 'it stands right before the event');
      assert.deepEqual(all[second - 1]!.metadata, {
        system: true, kind: 'clock', clock: { at: at('2026-10-21T11:20:00Z'), onBoundary: true, zone: 'UTC' },
      });
      assert.equal(all[second - 1]!.participant, 'user');
      assert.match(requestText(x.membrane.calls[1]!), /Clock: 11:20 UTC[\s\S]*second/, 'the turn\'s request holds it before the event');
    } finally { await x.framework.stop(); }
  });

  it('after a tool round that spans a boundary: the time it is written, after the results, in the live stream too', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(
        x, event('go'),
        [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
        [{ type: 'text', text: 'done' }],
      );

      const all = rows(x.framework);
      const results = all.findIndex((r) => r.content.some((b) => b.type === 'tool_result'));
      assert.ok(results > 0);
      const clock = all[results + 1]!;
      assert.ok(isClock(clock), 'the clock follows the tool results');
      assert.equal(textOf(clock), 'Clock: 10:52 UTC', 'not 10:50: the results (after 10:50) come before it');
      assert.equal(clock.metadata!.clock.onBoundary, false);
      assert.ok(clock.metadata!.clock.at >= clock.timestamp.getTime() - 1_000);
      assert.ok(all[results]!.timestamp.getTime() <= clock.metadata!.clock.at, 'never earlier than the row before it');

      const injected = x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [];
      assert.deepEqual(injected, [{ participant: 'user', content: clock.content }],
        'the stream got exactly the stored clock, so the window matches the live request');
      assert.equal(all.slice(results + 2).filter(isClock).length, 0, 'no second clock for the same boundary');
    } finally { await x.framework.stop(); }
  });

  it('a silent heartbeat tick starts with a current clock, outside its own rows', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('hello'), [{ type: 'text', text: 'hi' }]);
      setClock('2026-10-21T10:51:10Z');
      await wake(x, silentTick(), [{ type: 'text', text: 'all quiet' }]);

      const all = rows(x.framework);
      const reply = indexOfText(all, 'all quiet');
      const clock = all.slice(0, reply).reverse().find(isClock)!;
      assert.equal(textOf(clock), 'Clock: 10:50 UTC');
      assert.equal(clock.metadata!.silentHeartbeat, undefined, 'the clock is not one of the tick\'s rows');
      assert.match(requestText(x.membrane.calls[1]!), /Clock: 10:50 UTC/, 'the tick\'s request reads it');
    } finally { await x.framework.stop(); }
  });

  it('shows the date again when the day changes', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T23:55:10Z');
      await wake(x, event('late'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-22T00:01:10Z');
      await wake(x, event('early'), [{ type: 'text', text: 'ok' }]);
      const all = rows(x.framework);
      assert.equal(textOf(all[indexOfText(all, 'early') - 1]!), 'Clock: Thursday 2026-10-22, 00:00 UTC');
    } finally { await x.framework.stop(); }
  });

  it('an agent without a clock gets no clock rows', async () => {
    const x = await make({});
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('first'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T11:23:10Z');
      x.mod.during = () => setClock('2026-10-21T11:42:10Z');
      await wake(
        x, event('second'),
        [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
        [{ type: 'text', text: 'done' }],
      );
      assert.equal(rows(x.framework).filter(isClock).length, 0);
      assert.deepEqual(x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [], []);
    } finally { await x.framework.stop(); }
  });

  it('refuses a clock setting it cannot read when the framework is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clock-rows-'));
    dirs.push(dir);
    await assert.rejects(
      AgentFramework.create({
        storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', clock: { intervalSeconds: 90, precision: 'minutes' } }],
        modules: [],
      }),
      /Agent "assistant" clock: an interval of 90 seconds isn't whole minutes/,
    );
  });
});
