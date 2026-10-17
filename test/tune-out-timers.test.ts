/**
 * A tune-out's timers hold any length the resident asks for, and enter()
 * refuses an option it can't use before anything changes (F76).
 *
 * Node fires a setTimeout longer than 2^31 - 1 ms (about 24.8 days) almost
 * at once, so a single timer ended a longer tune-out as soon as it began,
 * and re-armed a longer cadence every millisecond. node:test's mock timers
 * fire an overflowing timeout early too (Node 24), and the harness records
 * each delay asked of setTimeout, so the timer tests also check that no step
 * is longer than one timer holds, whatever the runtime's mock does.
 */
import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import type { ChannelRegistry, TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

/** The longest delay one setTimeout holds. */
const ONE_TIMER_MS = 2_147_483_647;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 17);

/**
 * A coordinator over an in-memory registry for one channel, `disc` `#a`,
 * with the clock and setTimeout mocked and each delay asked of setTimeout
 * recorded. `stored` is a tune-out the registry already holds, as after a
 * restart.
 */
function harness(t: TestContext, stored?: TuneOutParams) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const mocked = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    return mocked(fn, ms, ...rest);
  }) as unknown as typeof setTimeout;

  let state: { params: TuneOutParams; wakeCount: number } | null = stored ? { params: stored, wakeCount: 0 } : null;
  const entered: TuneOutParams[] = [];
  /** The source of each cancel that ended a tune-out: 'duration' for an end time. */
  const cancels: string[] = [];
  /** The reason of each inference requested, the subconscious's turns among them. */
  const inferences: string[] = [];
  const registry = {
    listChannelsRaw: () => (state ? [{ serverId: 'disc', descriptor: { id: '#a' } }] : []),
    getTuneOutState: () => state,
    enterTuneOut: (_s: string, _c: string, params: TuneOutParams) => {
      entered.push(params);
      state = { params, wakeCount: 0 };
    },
    cancelTuneOut: (_s: string, _c: string, _next: string, source: string) => {
      const ended = state;
      state = null;
      if (ended) cancels.push(source);
      return ended;
    },
    recordTuneOutWake: () => (state ? { params: state.params, wakeCount: ++state.wakeCount } : null),
  } as unknown as ChannelRegistry;
  const hooks = {
    addMessage: () => '',
    requestInference: (_agent: string, reason: string) => { inferences.push(reason); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    currentSequence: () => 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  const coordinator = new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
  t.after(() => {
    coordinator.stop();
    globalThis.setTimeout = mocked;
    t.mock.timers.reset();
  });
  const cadenceTurns = () => inferences.filter((r) => r.startsWith('tune-out cadence'));
  const noTimerPastOne = () => assert.ok(
    delays.every((ms) => ms <= ONE_TIMER_MS),
    `no timer longer than one holds (${delays.filter((ms) => !(ms <= ONE_TIMER_MS)).join(', ')})`,
  );
  return { coordinator, entered, cancels, cadenceTurns, delays, noTimerPastOne };
}

it('a duration past one timer ends at its end time and not before', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cancels, [], "still tuned out after one timer's worth");
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.deepEqual(h.cancels, [], 'still tuned out 1 ms before its end');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancels, ['duration'], 'ended once, at its end time');
  h.noTimerPastOne();
});

it('a restart with more than one timer left reads the stored end time at each step', (t) => {
  const h = harness(t, {
    epochId: 'e1', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 1,
    expiresAtMs: NOW + 30 * DAY_MS,
  });
  h.coordinator.resumeActiveEpochs();
  t.mock.timers.tick(DAY_MS);
  assert.deepEqual(h.cancels, [], 'still tuned out a day after the restart');
  // The wall clock reaches the stored end while a step waits, as after a
  // host's suspend or a clock correction: the step that runs next reads it.
  t.mock.timers.setTime(NOW + 30 * DAY_MS);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cancels, ['duration'], 'the next step found the stored end time passed and ended it');
  h.noTimerPastOne();
});

it("a cancel stops the end time's later steps, so a new tune-out on the channel isn't ended at the old one's end", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.equal(h.coordinator.cancel('disc', '#a', 'agent-tool', 'agent request').ok, true);
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true, 'a new tune-out, until cancelled');
  t.mock.timers.tick(30 * DAY_MS);
  assert.deepEqual(h.cancels, ['agent-tool'], 'only the cancel asked for: the new tune-out runs on');
});

it("stop clears both timers' pending steps: neither fires after it", (t) => {
  const h = harness(t);
  const opts = { durationSeconds: 30 * 86_400, cadenceSeconds: 30 * 86_400 };
  assert.equal(h.coordinator.enter('disc', '#a', opts, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  h.coordinator.stop();
  t.mock.timers.tick(60 * DAY_MS);
  assert.deepEqual(h.cancels, [], 'no end after stop');
  assert.deepEqual(h.cadenceTurns(), [], 'no cadence turn after stop');
});

it('a cadence past one timer gives the subconscious one turn at the cadence: none before it, none after a cancel', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(30 * DAY_MS - 1);
  assert.deepEqual(h.cadenceTurns(), [], 'no turn before the cadence');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'one turn at the cadence');
  h.coordinator.onIncoming('disc', '#a', 'm2', undefined);
  assert.equal(h.coordinator.cancel('disc', '#a', 'agent-tool', 'agent request').ok, true);
  t.mock.timers.tick(30 * DAY_MS);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'no turn after the cancel');
  h.noTimerPastOne();
});

it("enter refuses an option that gives no finite number, before anything changes", (t) => {
  const h = harness(t);
  const refusals: Array<[Record<string, unknown>, RegExp | string]> = [
    [{ durationSeconds: 'abc' },
      'Nothing was tuned out: durationSeconds must be a finite number of seconds, and it was the string "abc". '
        + 'Leave it out to stay tuned out until you cancel.'],
    [{ maxWakes: NaN },
      'Nothing was tuned out: maxWakes must be a finite number, and it was NaN. Leave it out for the default, 5.'],
    [{ durationSeconds: 1e306 },
      'Nothing was tuned out: durationSeconds 1e+306 is longer than an end time can be kept. '
        + 'Leave it out to stay tuned out until you cancel.'],
    [{ durationSeconds: Infinity }, /^Nothing was tuned out: durationSeconds must be a finite number of seconds, and it was Infinity\. /],
    [{ cadenceSeconds: 'every hour' }, /^Nothing was tuned out: cadenceSeconds must be a finite number of seconds, and it was the string "every hour"\. Leave it out for the default, 1800\.$/],
    [{ cadenceSeconds: Infinity }, /^Nothing was tuned out: cadenceSeconds must be a finite number of seconds, and it was Infinity\. /],
    [{ backlogCap: 'all' }, /^Nothing was tuned out: backlogCap must be a finite number, and it was the string "all"\. Leave it out for the default, 200\.$/],
    [{ maxWakes: [1, 2] }, /^Nothing was tuned out: maxWakes must be a finite number, and it was the value \[1,2\]\. /],
  ];
  for (const [opts, expected] of refusals) {
    const r = h.coordinator.enter('disc', '#a', opts as never, 'agent-tool');
    assert.equal(r.ok, false, `${JSON.stringify(opts)} refused`);
    if (!r.ok) {
      if (typeof expected === 'string') assert.equal(r.error, expected);
      else assert.match(r.error, expected);
    }
  }
  assert.deepEqual(h.entered, [], 'nothing entered');
  assert.deepEqual(h.delays, [], 'no timer armed');
});

it('a null option counts as left out: a null duration has no end time', (t) => {
  const h = harness(t);
  const nulls = { durationSeconds: null, cadenceSeconds: null, backlogCap: null, maxWakes: null };
  assert.equal(h.coordinator.enter('disc', '#a', nulls as never, 'agent-tool').ok, true);
  assert.equal(h.entered[0].expiresAtMs, undefined, 'until cancelled, not 60 s');
  assert.deepEqual(
    [h.entered[0].cadenceSeconds, h.entered[0].backlogCap, h.entered[0].maxWakes],
    [1800, 200, 5],
    'the defaults',
  );
});

it('a numeric string is read as its number, as it was before the refusals', (t) => {
  const h = harness(t);
  const strings = { durationSeconds: '3600', cadenceSeconds: '600', backlogCap: '50', maxWakes: '3' };
  assert.equal(h.coordinator.enter('disc', '#a', strings as never, 'agent-tool').ok, true);
  assert.deepEqual(
    [h.entered[0].expiresAtMs, h.entered[0].cadenceSeconds, h.entered[0].backlogCap, h.entered[0].maxWakes],
    [NOW + 3_600_000, 600, 50, 3],
  );
});
