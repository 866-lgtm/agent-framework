/** The isolate's output bound: the child's batches, and the parent's head and tail of each return's stretch. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MAX_BATCH_CHARS, OutputBatch, WindowOutput } from '../src/code-execution/isolate/output.js';

const bounds = { headChars: 10, tailChars: 10 };

test('a batch says when it is full, and flushes in pieces of at most a batch', () => {
  const batch = new OutputBatch();
  assert.equal(batch.write('x'.repeat(MAX_BATCH_CHARS - 1)), false);
  assert.equal(batch.write('yy'), true);
  const pieces = batch.flush();
  assert.deepEqual(pieces.map((p) => p.length), [MAX_BATCH_CHARS, 1]);
  assert.equal(batch.unflushed, 0);
  assert.deepEqual(batch.flush(), []);
});

test("a batch's pieces never split a surrogate pair", () => {
  const batch = new OutputBatch();
  // The pair straddles where the first piece would end.
  batch.write('x'.repeat(MAX_BATCH_CHARS - 1) + '\u{1F600}' + 'z');
  const pieces = batch.flush();
  assert.equal(pieces.join(''), 'x'.repeat(MAX_BATCH_CHARS - 1) + '\u{1F600}' + 'z');
  for (const piece of pieces) assert.equal(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(piece), false, 'no piece ends or starts inside a pair');
});

test('a stretch within the head comes through whole', () => {
  const w = new WindowOutput(bounds);
  w.apply('abc');
  w.apply('def');
  assert.equal(w.render(), 'abcdef');
});

test('past the head and tail, the middle is dropped and counted', () => {
  const w = new WindowOutput(bounds);
  for (const piece of ['0123456789', 'abcdefghij', 'ABCDEFGHIJ']) w.apply(piece);
  assert.equal(w.render(), '0123456789\n[… 10 characters of output dropped here …]\nABCDEFGHIJ');
  assert.equal(w.droppedChars, 10);
});

test('each return starts a fresh stretch, with its own head and tail', () => {
  const w = new WindowOutput(bounds);
  w.apply('first stretch, long enough to drop some');
  assert.match(w.take(), /^first stre\n\[… \d+ characters of output dropped here …\]\n drop some$/);
  w.apply('0123456789abcdefghijABCDEFGHIJ');
  assert.equal(w.take(), '0123456789\n[… 10 characters of output dropped here …]\nABCDEFGHIJ');
  assert.equal(w.take(), '');
});

test('a surrogate pair is never split where the head ends or where the tail begins', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const w = new WindowOutput(bounds);
  // The head's 10th unit and the tail's first both fall inside a pair.
  for (const piece of ['123456789\u{1F600}', 'abcdefghijklmn', '\u{1F600}123456789']) w.apply(piece);
  assert.equal(lone.test(w.render()), false, w.render());
  assert.ok(w.render().startsWith('123456789\n'), 'the head stops before the pair rather than splitting it');
});
