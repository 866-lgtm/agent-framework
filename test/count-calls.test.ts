// The test helper that counts a method's calls for one synchronous call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countingCalls } from './helpers/count-calls.js';

test('countingCalls counts the calls it picks, throws past its ceiling, and restores the method either way', () => {
  const original = String.prototype.indexOf;
  const counted = countingCalls(String.prototype, 'indexOf', (_self, args) => args[0] === 'b', 10, () => ['abc'.indexOf('b'), 'abc'.indexOf('c'), 'abc'.indexOf('b')]);
  assert.deepEqual(counted, { result: [1, 2, 1], calls: 2 });
  assert.throws(() => countingCalls(String.prototype, 'indexOf', () => true, 1, () => 'abc'.indexOf('a') + 'abc'.indexOf('b')), /indexOf was called more than 1 times where counted/);
  assert.equal(String.prototype.indexOf, original);
});

test('countingCalls refuses a run that returns a promise, and restores the method', () => {
  const original = Set.prototype.has;
  assert.throws(() => countingCalls(Set.prototype, 'has', () => true, 10, async () => new Set([1]).has(1)), /run returned a promise/);
  assert.equal(Set.prototype.has, original);
});
