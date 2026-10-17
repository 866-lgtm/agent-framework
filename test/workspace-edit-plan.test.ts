// The edit planner: where each edit's old text occurs in a file's text as
// read, what stops an edit applying, and the file's new bytes once every edit
// applies, with every byte the edits don't name kept as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type EditSpec,
  type FilePlan,
  type MatchProblem,
  HINT_MAX_CHARS,
  decodeForEdit,
  hintBudget,
  lineNumbersAt,
  planFile,
} from '../src/modules/workspace/edit-plan.js';

const spec = (index: number, oldText: string, newText: string, expected: number | 'all' = 1): EditSpec =>
  ({ index, oldText, newText, expected });

/** The plan for `text` (as UTF-8 bytes), or a failure naming its problems. */
function plan(text: string | Buffer, specs: EditSpec[]): FilePlan {
  const bytes = typeof text === 'string' ? Buffer.from(text) : text;
  const planned = planFile(decodeForEdit(bytes)!, bytes, specs);
  if ('problems' in planned) assert.fail(`refused: ${JSON.stringify(planned.problems)}`);
  return planned.plan;
}

function problems(text: string, specs: EditSpec[], hints = hintBudget()): MatchProblem[] {
  const bytes = Buffer.from(text);
  const planned = planFile(decodeForEdit(bytes)!, bytes, specs, hints);
  if ('plan' in planned) assert.fail('applied');
  return planned.problems;
}

test('every edit is matched in the text as read, in any order, never in another edit\'s result', () => {
  const text = 'alpha beta\ngamma\n';
  // Edit 1's new text holds edit 2's old text, which still matches only where the file had it.
  const forward = plan(text, [spec(0, 'alpha', 'gamma gamma'), spec(1, 'gamma\n', 'delta\n')]);
  const backward = plan(text, [spec(1, 'gamma\n', 'delta\n'), spec(0, 'alpha', 'gamma gamma')]);
  assert.equal(forward.bytes.toString(), 'gamma gamma beta\ndelta\n');
  assert.deepEqual(backward.bytes, forward.bytes);
  assert.deepEqual(forward.changes.map(({ edit, line, lines }) => ({ edit, line, lines })), [
    { edit: 0, line: 1, lines: 1 },
    { edit: 1, line: 2, lines: 1 },
  ]);
});

test('an occurrence is a position: overlapping occurrences count, and they can\'t each be replaced', () => {
  const [once] = problems('aaa\n', [spec(0, 'aa', 'b')]);
  assert.equal(once!.kind, 'count');
  assert.deepEqual(once, { ...once, found: 2, atLeast: false, expected: 1, overlapping: true, lines: [1, 1] });
  const [all] = problems('aaa\n', [spec(0, 'aa', 'b', 'all')]);
  assert.deepEqual(all, { ...all, kind: 'count', found: 2, atLeast: false, expected: 'all', overlapping: true });
  // Apart, every one is replaced when asked for.
  assert.equal(plan('aa-aa\n', [spec(0, 'aa', 'b', 2)]).bytes.toString(), 'b-b\n');
  assert.equal(plan('aa-aa\n', [spec(0, 'aa', 'b', 'all')]).bytes.toString(), 'b-b\n');
});

test('occurrences that overlap stop the count once a refusal has more than it shows, however long the run', () => {
  // Compared in full at every position, this is 1,000 times 200,000 comparisons.
  const [run] = problems(`${' '.repeat(200_000)}\n`, [spec(0, ' '.repeat(1000), 'x', 'all')]);
  assert.equal(run!.kind, 'count');
  if (run!.kind !== 'count') return;
  assert.deepEqual([run.found, run.atLeast, run.overlapping, run.lines.length], [21, true, true, 20]);
  // Exactly as many as a refusal shows are counted exactly.
  const [twenty] = problems(`${' '.repeat(119)}\n`, [spec(0, ' '.repeat(100), 'x', 'all')]);
  assert.deepEqual(twenty, { ...twenty, found: 20, atLeast: false, overlapping: true });
  // Apart, every occurrence is counted, however many.
  const [apart] = problems('ab '.repeat(30), [spec(0, 'ab', 'x')]);
  assert.deepEqual(apart, { ...apart, found: 30, atLeast: false, overlapping: false });
});

test('line numbers are found in one pass over the text, past its last line end too', () => {
  // A text that counts what each search for a line end reads: searching again
  // from each index would read the million code units after the last line
  // end once for each of the 20,000 indices.
  const text = `${'x'.repeat(20_000)}${'y'.repeat(1_000_000)}`;
  let read = 0;
  const counted = {
    indexOf: (search: string, from = 0) => {
      const at = text.indexOf(search, from);
      read += (at === -1 ? text.length : at + 1) - from;
      return at;
    },
  };
  const indices = Array.from({ length: 20_000 }, (_, i) => i);
  assert.deepEqual(lineNumbersAt(counted as unknown as string, indices), indices.map(() => 1));
  assert.ok(read <= text.length, `read ${read} code units of a ${text.length}-unit text`);
});

test('a count that differs names each matched line once, and a long line as an excerpt around its match', () => {
  const long = `${'x'.repeat(500)} target ${'y'.repeat(500)}`;
  const [count] = problems(`target\nnone\ntarget target\n${long}\n`, [spec(0, 'target', 'z')]);
  assert.equal(count!.kind, 'count');
  if (count!.kind !== 'count') return;
  assert.equal(count.found, 4);
  assert.deepEqual(count.lines, [1, 3, 3, 4]);
  const shown = count.shown.split('\n');
  assert.deepEqual(shown.slice(0, 2), ['     1\ttarget', '     3\ttarget target']);
  assert.match(shown[2]!, /^     4\t…x+ target y+…$/);
  assert.ok(shown[2]!.length < 260, 'an excerpt, not the whole line');
});

test("two edits' matches may touch but not overlap, and the same text twice is named as such", () => {
  assert.equal(plan('abcd\n', [spec(0, 'ab', 'AB'), spec(1, 'cd', 'CD')]).bytes.toString(), 'ABCD\n');
  const [overlap] = problems('abcd\n', [spec(0, 'abc', 'X'), spec(1, 'bcd', 'Y')]);
  assert.deepEqual(overlap, { kind: 'clash', edits: [0, 1], line: 1, same: false });
  const [same] = problems('abcd\n', [spec(1, 'bc', 'Y'), spec(0, 'bc', 'X')]);
  assert.deepEqual(same, { kind: 'clash', edits: [0, 1], line: 1, same: true });
});

test('a thousand edits of one stretch are named as at most a thousand clashes', () => {
  const specs = Array.from({ length: 1000 }, (_, i) => spec(i, 'shared', `s${i}`));
  assert.equal(problems('shared\n', specs).length, 999);
});

test('each clash names its own line', () => {
  const text = 'one two\nthree four\nfive six\n';
  const clashes = problems(text, [spec(0, 'three four', 'X'), spec(1, 'four', 'Y'), spec(2, 'one two', 'Z'), spec(3, 'two', 'W')]);
  assert.deepEqual(clashes.map((clash) => clash.kind === 'clash' && [clash.edits, clash.line]), [[[2, 3], 1], [[0, 1], 2]]);
});

test('a miss shows the closest region, numbered, and says how to match', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of the file`).join('\n');
  const [miss] = problems(text, [spec(0, '  line 12 of the fyle', 'x')]);
  assert.equal(miss!.kind, 'miss');
  if (miss!.kind !== 'miss') return;
  assert.match(miss.hint, /^Closest region \(line 12, similarity 0\.\d\d\):\n     9\tline 9 of the file\n/);
  assert.match(miss.hint, /    15\tline 15 of the file$/);
  assert.equal(miss.crlf, false);
  // A first line of one character, such as a closing brace, has nothing to score; the next line does.
  const [brace] = problems(text, [spec(0, '}\nline 12 of the fyle', 'x')]);
  assert.match((brace as { hint: string }).hint, /^Closest region \(line 12, similarity 0\.\d\d\):/);
});

test("one call's misses search at most HINT_MAX_CHARS for closest regions, and a file over it gets none", () => {
  const half = `${'word '.repeat(HINT_MAX_CHARS / 10)}\n`.repeat(2).slice(0, HINT_MAX_CHARS / 2 + 1);
  const hints = hintBudget();
  const first = problems(half, [spec(0, 'absent', 'x')], hints);
  const second = problems(half, [spec(0, 'absent', 'x')], hints);
  assert.doesNotMatch((first[0] as { hint: string }).hint, /^\(No closest region/);
  assert.match((second[0] as { hint: string }).hint, /^\(No closest region: this call's other misses used its 2,097,152 UTF-16 code units of search/);
  const big = 'x'.repeat(HINT_MAX_CHARS + 1);
  assert.match((problems(big, [spec(0, 'absent', 'y')])[0] as { hint: string }).hint, /^\(No closest region for a file over 2,097,152 UTF-16 code units/);
});

test('straight and curly quotes match as a second chance, and the plan names the edit', () => {
  const planned = plan('She said “hello” and it’s fine\n', [spec(0, 'said "hello" and it\'s', 'said "bye" and it is'), spec(1, 'fine', 'good')]);
  assert.equal(planned.bytes.toString(), 'She said "bye" and it is good\n');
  assert.deepEqual(planned.quoteNormalized, [0]);
});

test('CRLF text matches LF old text, and the new text takes the line ends of the text it replaces, a BOM kept', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bytes = Buffer.concat([bom, Buffer.from('one\r\ntwo\r\nthree\r\n')]);
  const planned = plan(bytes, [spec(0, 'one\ntwo', 'uno\ndos\ntres')]);
  assert.deepEqual(planned.bytes, Buffer.concat([bom, Buffer.from('uno\r\ndos\r\ntres\r\nthree\r\n')]));
  assert.deepEqual([planned.crlf, planned.mixed, planned.bom], [true, false, true]);
  assert.equal(planned.updated, 'uno\ndos\ntres\nthree\n', 'the receipt reads LF');
});

test('a mixed file keeps its mixture: each line end of a replaced span by position, any beyond them the last', () => {
  const bytes = Buffer.from('a\r\nb\nc\r\nd\n');
  assert.equal(plan(bytes, [spec(0, 'a\nb\nc', 'A\nB\nC\nD')]).bytes.toString(), 'A\r\nB\nC\nD\r\nd\n');
  const planned = plan(bytes, [spec(0, 'b', 'b1\nb2', 'all')]);
  assert.equal(planned.bytes.toString(), 'a\r\nb1\nb2\nc\r\nd\n', 'a span with no line end takes its own line\'s');
  assert.deepEqual([planned.crlf, planned.mixed], [true, true]);
});

test("a match at a CRLF's line end takes its CR along, and an unterminated last line takes the line end before it", () => {
  assert.equal(plan(Buffer.from('a\r\nb\r\n'), [spec(0, 'a\n', 'x\n')]).bytes.toString(), 'x\r\nb\r\n');
  assert.equal(plan(Buffer.from('a\r\nb'), [spec(0, 'b', 'b\nc')]).bytes.toString(), 'a\r\nb\r\nc');
  assert.equal(plan(Buffer.from('b'), [spec(0, 'b', 'b\nc')]).bytes.toString(), 'b\nc', 'a file with no CRLF takes the new text as given');
});

test("only the replaced text changes: a lone CR, and bytes the edits don't name, stay as they were", () => {
  const bytes = Buffer.from('keep\rthis\r\nchange me\r\n');
  assert.equal(plan(bytes, [spec(0, 'change', 'changed')]).bytes.toString(), 'keep\rthis\r\nchanged me\r\n');
});

test("a file that isn't valid UTF-8 isn't decoded, and the empty old text is found nowhere rather than looping", () => {
  assert.equal(decodeForEdit(Buffer.from([0x61, 0xe9, 0x62])), undefined);
  const [miss] = problems('abc\n', [spec(0, '', 'x')]);
  assert.equal(miss!.kind, 'miss');
});
