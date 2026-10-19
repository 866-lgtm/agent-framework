// The text helpers the workspace's read, grep and edit share: a file's lines as
// read shows them, numbered lines with a long one cut, a BOM's check, and a
// string's length as JSON, which a page's budget is counted in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileText, hasBom, jsonLength, numberedLine, safeCut } from '../src/modules/workspace/text.js';

test('fileText gives the lines read shows, where each starts, and what the text is', () => {
  const lines = (text: string | Buffer) => fileText(Buffer.from(text)).lines;
  assert.deepEqual(lines(''), []);
  assert.deepEqual(lines('a'), ['a']);
  assert.deepEqual(lines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(lines('a\n\n'), ['a', '']);
  assert.deepEqual(lines('\n'), ['']);
  assert.deepEqual(lines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(lines('a\rb\r\n\r\n'), ['a\rb', '']);
  assert.deepEqual(lines('a\r'), ['a\r'], 'a CR that ends the text ends no line');
  // A line whose own text ends in a CR keeps its line end's CR too, so text
  // copied from it keeps the CR an edit would read as part of the line end.
  const crKept = fileText(Buffer.from('x\r\r\ny\r\nz\r\r\n'));
  assert.deepEqual(crKept.lines, ['x\r\r', 'y', 'z\r\r']);
  assert.deepEqual([crKept.crlfEnds, crKept.lfEnds, crKept.crKept], [3, 0, 2]);
  assert.equal(fileText(Buffer.from('\r\r\n')).crKept, 1);
  assert.equal(fileText(Buffer.from('a\r\n\r\n')).crKept, 0, 'an empty line after a CRLF end is no CR of its own');

  const crlf = fileText(Buffer.from('one\r\ntwo\nthree'));
  assert.deepEqual(crlf.starts, [0, 5, 9]);
  assert.equal(crlf.crlfEnds, 1);
  assert.equal(crlf.lfEnds, 1);
  assert.equal(crlf.bom, false);
  assert.equal(crlf.utf8, true);
  assert.equal(crlf.raw, 'one\r\ntwo\nthree');

  const bom = fileText(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x62]));
  assert.equal(bom.bom, true);
  assert.deepEqual(bom.lines, ['a', 'b']);
  assert.deepEqual(bom.starts, [1, 3], 'offsets count the BOM, as character paging does');
  assert.equal(bom.raw, '\ufeffa\nb');
  assert.deepEqual(fileText(Buffer.from([0xef, 0xbb, 0xbf])).lines, []);

  const latin1 = fileText(Buffer.from('caf\xe9', 'latin1'));
  assert.equal(latin1.utf8, false);
  assert.deepEqual(latin1.lines, ['caf\ufffd']);
});

test('numberedLine numbers a line as cat -n does, and cuts a long one without splitting a surrogate pair', () => {
  assert.equal(numberedLine('text', 7), '     7\ttext');
  assert.equal(numberedLine('x'.repeat(2000), 1), `     1\t${'x'.repeat(2000)}`);
  assert.equal(numberedLine('x'.repeat(2001), 1), `     1\t${'x'.repeat(2000)} [… 1 more chars]`);
  const emoji = 'x'.repeat(4) + '😀' + 'y';
  assert.equal(safeCut(emoji, 5), 4);
  assert.equal(numberedLine(emoji, 2, 5, (cut) => `from ${cut}`), `     2\txxxx [… 3 more chars; from 4]`);
  assert.equal(numberedLine('abc', 3, 0), '     3\t [… 3 more chars]');
});

test('hasBom finds a UTF-8 byte order mark at the start alone', () => {
  assert.equal(hasBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), true);
  assert.equal(hasBom(Buffer.from([0xef, 0xbb])), false);
  assert.equal(hasBom(Buffer.from([0x61, 0xef, 0xbb, 0xbf])), false);
  // A byte off the mark at any one of its three places is no mark.
  for (const at of [0, 1, 2]) {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    bytes[at] ^= 1;
    assert.equal(hasBom(bytes), false, `byte ${at} changed`);
  }
});

test('jsonLength counts a string as JSON.stringify writes it', () => {
  let mismatches = 0;
  const check = (value: string) => {
    if (jsonLength(value) !== JSON.stringify(value).length - 2) mismatches++;
  };
  for (let c = 0; c <= 0xffff; c++) check(String.fromCharCode(c));
  // Escapes and surrogates beside each other: a pair, each half alone, and both in the wrong order.
  const edges = [0x41, 0x22, 0x5c, 0x0a, 0x1f, 0x7f, 0x2028, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d, 0xde00];
  for (const a of edges) for (const b of edges) for (const c of edges) check(String.fromCharCode(a, b, c));
  assert.equal(mismatches, 0);
});
