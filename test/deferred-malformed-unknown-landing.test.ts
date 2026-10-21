import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MalformedContentError } from '@animalabs/context-manager';
import { AgentFramework } from '../src/framework.js';

// Focused merge regression: no store, provider, or network is opened.
function harness() {
  const f = Object.create(AgentFramework.prototype) as any;
  const agent = {};
  let readback: any[] | undefined = [];
  let lookup: any[] | undefined = undefined;
  let count: number | undefined = 0;
  const queued: any[] = [];
  const outcomes: any[] = [];
  f.primaryAgentName = 'a';
  f.deliveryAgent = () => agent;
  f.storedCountOf = () => count;
  f.storedCopiesOf = () => readback;
  f.landedCopiesById = () => lookup;
  f.requeueDrained = (entries: any[]) => queued.push(...entries);
  f.logDeferredWriteError = (_m: any, _w: any, _e: any, outcome: any) => outcomes.push(outcome);
  const msg = (id: string, seq: number, forAgent = 'a') => ({
    id, seq, forAgent, participant: 'user', content: [{ type: 'text', text: id }],
  });
  return { f, queued, outcomes, msg,
    setReadback: (v: any[] | undefined) => { readback = v; },
    setLookup: (v: any[] | undefined) => { lookup = v; },
    setCount: (v: number | undefined) => { count = v; },
  };
}
const malformed = () => new MalformedContentError('fixture', ['content[0]']);

test('malformed refusal with confirmed empty landing drops and unblocks its successor', () => {
  const h = harness(); const a = h.msg('a', 1), b = h.msg('b', 2); const calls: string[] = [];
  let landed = 0;
  const result = h.f.writeDrainedInOrder([a, b], 'test', (m: any) => {
    calls.push(m.id); if (m === a) throw malformed(); return 'b-stored';
  }, () => landed++);
  assert.deepEqual(calls, ['a', 'b']); assert.equal(result.has(a), false);
  assert.equal(result.get(b).id, 'b-stored'); assert.deepEqual(h.queued, []);
  assert.equal(landed, 0); assert.deepEqual(h.outcomes, ['dropped']);
});

for (const unknown of ['count', 'readback']) {
  test(`malformed refusal with unknown ${unknown} retains ordering and does not block another agent`, () => {
    const h = harness(); if (unknown === 'count') h.setCount(undefined); else h.setReadback(undefined);
    const a = h.msg('a', 1), b = h.msg('b', 2), c = h.msg('c', 3, 'other');
    const calls: string[] = [];
    h.f.writeDrainedInOrder([c, b, a], 'test', (m: any) => {
      calls.push(m.id); if (m === a) throw malformed(); return 'c-stored';
    });
    assert.deepEqual(calls, ['a', 'c']); assert.deepEqual(h.queued, [a, b]);
    assert.equal((a as any).landing, 'unknown'); assert.deepEqual(h.outcomes, ['unknown']);
    h.queued.length = 0;
    h.f.writeDrainedInOrder([a, b], 'retry', () => { throw new Error('must not rewrite before lookup'); });
    assert.deepEqual(h.queued, [a, b]); assert.equal(h.outcomes.at(-1), 'still-unknown');
  });
}

test('unknown landing found by ID counts as written without rewriting, then unblocks successor', () => {
  const h = harness(); const a = Object.assign(h.msg('a', 1), { landing: 'unknown' });
  const b = h.msg('b', 2); const stored = { id: 'stored-a', participant: 'user', content: a.content };
  h.setLookup([stored]); const calls: string[] = [], callbacks: string[] = [];
  const result = h.f.writeDrainedInOrder([a, b], 'retry', (m: any) => {
    calls.push(m.id); return 'stored-b';
  }, (_m: any, id: string) => callbacks.push(id));
  assert.deepEqual(calls, ['b']); assert.deepEqual(callbacks, ['stored-a']);
  assert.equal(result.get(a).id, 'stored-a'); assert.deepEqual(result.get(a).content, a.content);
  assert.deepEqual(h.queued, []); assert.equal(h.outcomes[0].foundLater, true);
});

for (const outcome of ['success', 'malformed-empty', 'malformed-unknown']) {
  test(`unknown landing confirmed absent retries once: ${outcome}`, () => {
    const h = harness(); const a = Object.assign(h.msg('a', 1), { landing: 'unknown' });
    h.setLookup([]); if (outcome === 'malformed-unknown') h.setReadback(undefined);
    let calls = 0;
    const result = h.f.writeDrainedInOrder([a], 'retry', () => {
      calls++; if (outcome !== 'success') throw malformed(); return 'stored-a';
    });
    assert.equal(calls, 1);
    if (outcome === 'success') { assert.equal(result.get(a).id, 'stored-a'); assert.deepEqual(h.queued, []); }
    if (outcome === 'malformed-empty') { assert.deepEqual(h.outcomes, ['dropped']); assert.deepEqual(h.queued, []); }
    if (outcome === 'malformed-unknown') { assert.equal(a.landing, 'unknown'); assert.deepEqual(h.queued, [a]); }
  });
}

test('ordinary error with empty landing remains queued with its successor', () => {
  const h = harness(); const a = h.msg('a', 1), b = h.msg('b', 2);
  let calls = 0;
  h.f.writeDrainedInOrder([a, b], 'test', () => { calls++; throw new Error('I/O failure'); });
  assert.equal(calls, 1); assert.deepEqual(h.queued, [a, b]); assert.deepEqual(h.outcomes, [undefined]);
});

test('malformed error after confirmed landing counts existing record instead of dropping it', () => {
  const h = harness(); const a = h.msg('a', 1);
  h.setReadback([{ id: 'stored-a', participant: 'user', content: a.content }]);
  let callbacks = 0;
  const result = h.f.writeDrainedInOrder([a], 'test', () => { throw malformed(); }, () => callbacks++);
  assert.equal(result.get(a).id, 'stored-a'); assert.equal(callbacks, 1); assert.deepEqual(h.queued, []);
  assert.equal(h.outcomes[0].count, 1);
});
