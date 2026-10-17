import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';

async function setup(t: TestContext, content: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-read-text-'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: root, mode: 'read-write', watch: 'never' }],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await workspace.writeBinary('work/text.txt', Buffer.from(content), 'text/plain')).success, true);
  // A call the framework dispatched carries the most of its result it stores
  // (resultMaxChars); one without it gets the framework's default, 24,000.
  const read = (input: Record<string, unknown> = {}, resultMaxChars?: number) => workspace.handleToolCall({
    id: 'read', name: 'read', input: { path: 'work/text.txt', ...input }, ...(resultMaxChars !== undefined ? { resultMaxChars } : {}),
  });
  return { workspace, read };
}

type LinePage = { totalLines: number; fromLine?: number; toLine?: number; note?: string; content: string };
type CharPage = { totalChars: number; offsetChars: number; nextOffsetChars: number | null; note?: string; content: string };
const stored = (result: { data?: unknown }): number => JSON.stringify(result.data).length;

test('line reads retain numbering, ranges, and the 2000-line default', async t => {
  const { read } = await setup(t, Array.from({ length: 2005 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await read({ offset: 2, limit: 2 });
  assert.deepEqual(result.data, {
    path: 'work/text.txt', totalLines: 2005, fromLine: 2, toLine: 3,
    note: 'Truncated at 2 lines (file has 2005). Use offset/limit to read more.',
    content: '     2\tline 2\n     3\tline 3',
  });
  // A script's call can take far more than a turn's, so its default page is the 2000 lines.
  const defaults = (await read({}, 5_000_000)).data as LinePage;
  assert.equal(defaults.toLine, 2000);
  assert.equal(defaults.content.split('\n').length, 2000);
});

test('a CRLF file reads as its lines without the CR, and says so', async t => {
  const { read } = await setup(t, 'one\r\ntwo\r\n');
  assert.deepEqual((await read()).data, {
    path: 'work/text.txt', totalLines: 2, fromLine: 1, toLine: 2,
    note: 'Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.',
    content: '     1\tone\n     2\ttwo',
  });
  const { read: readMixed } = await setup(t, 'a\r\nb\nc\r\nd');
  const page = (await readMixed()).data as LinePage;
  assert.equal(page.content, '     1\ta\n     2\tb\n     3\tc\n     4\td');
  assert.equal(page.note, 'Line ends are mixed, 2 CRLF and 1 LF, each line shown without a CR. An edit matches text as read shows it, and keeps each line\'s end.');
  // A CR that doesn't end a line is the line's own.
  const { read: readCr } = await setup(t, 'a\rb\n');
  assert.deepEqual((await readCr()).data, { path: 'work/text.txt', totalLines: 1, fromLine: 1, toLine: 1, content: '     1\ta\rb' });
});

test('a BOM is noted and not shown, and bytes that aren\'t UTF-8 are noted', async t => {
  const { read } = await setup(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond\n')]));
  assert.deepEqual((await read()).data, {
    path: 'work/text.txt', totalLines: 2, fromLine: 1, toLine: 2,
    note: 'The file starts with a UTF-8 BOM, which isn\'t shown. An edit keeps it.',
    content: '     1\tfirst\n     2\tsecond',
  });
  // Character paging reads the stored text as it is, the BOM included.
  assert.equal(((await read({ offsetChars: 0, limitChars: 3 })).data as CharPage).content, '\ufefffi');
  // A BOM alone is an empty file that has one.
  const { read: readBomOnly } = await setup(t, Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual((await readBomOnly()).data, {
    path: 'work/text.txt', totalLines: 0, note: 'The file starts with a UTF-8 BOM, which isn\'t shown. An edit keeps it.', content: '',
  });
  const notUtf8 = 'The file isn\'t valid UTF-8: each invalid byte sequence shows as U+FFFD. Edit refuses this file, and write replaces it whole.';
  const { read: readLatin1 } = await setup(t, Buffer.from('caf\xe9\n', 'latin1'));
  assert.deepEqual((await readLatin1()).data, {
    path: 'work/text.txt', totalLines: 1, fromLine: 1, toLine: 1, note: notUtf8, content: '     1\tcaf\ufffd',
  });
  assert.equal(((await readLatin1({ offsetChars: 0 })).data as CharPage).note, notUtf8);
});

test('a long line is cut at 2000 characters, with the offsetChars that reads the rest', async t => {
  // A BOM and a CRLF before the long line, so its offset counts both.
  const long = 'x'.repeat(1999) + '😀' + 'y'.repeat(1000);
  const { read } = await setup(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`short\r\n${long}\r\nlast\r\n`)]));
  const page = (await read()).data as LinePage;
  const lines = page.content.split('\n');
  assert.equal(lines.length, 3);
  // The cut doesn't split the emoji's surrogate pair: it falls before it.
  const rest = long.length - 1999;
  const at = 1 + 'short\r\n'.length + 1999;
  assert.equal(lines[1], `     2\t${'x'.repeat(1999)} [… ${rest} more chars; read them with offsetChars=${at}]`);
  const more = (await read({ offsetChars: at, limitChars: rest })).data as CharPage;
  assert.equal(more.content, '😀' + 'y'.repeat(1000));
  assert.equal(lines[2], '     3\tlast');
});

test('a line page stops before its result would pass the limit, and says where to continue', async t => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${'"'.repeat(i % 7)}`).join('\n');
  const { read } = await setup(t, text);
  for (const limit of [24_000, 5_000, 1_000]) {
    const result = await read({}, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.data as LinePage;
    assert.ok(page.toLine! < 2000);
    assert.equal(page.note, `Stopped at line ${page.toLine} to stay within the ${limit}-character result limit (file has 3000). Continue with offset=${page.toLine! + 1}.`);
    // One more line would have passed the limit.
    const more = await read({ limit: page.toLine! + 1 }, 5_000_000);
    const withNext = { ...(result.data as object), toLine: page.toLine! + 1, content: (more.data as LinePage).content };
    assert.ok(JSON.stringify(withNext).length > limit);
    // Continuing reads on from the next line.
    const next = (await read({ offset: page.toLine! + 1 }, limit)).data as LinePage;
    assert.equal(next.fromLine, page.toLine! + 1);
    assert.ok(next.content.startsWith(`${String(page.toLine! + 1).padStart(6)}\tline ${page.toLine! + 1}:`));
  }
});

test('a first line that alone would pass the limit is cut where it fits', async t => {
  // Each quote takes two characters as JSON.
  const { read } = await setup(t, '"'.repeat(1500) + '\nnext\n');
  const result = await read({}, 1_000);
  assert.ok(stored(result) <= 1_000, `${stored(result)}`);
  const page = result.data as LinePage;
  assert.equal(page.toLine, 1);
  const [, shown, rest, at] = /^ {5}1\t("*) \[… (\d+) more chars; read them with offsetChars=(\d+)\]$/.exec(page.content)!;
  assert.ok(shown.length > 0);
  assert.equal(Number(at), shown.length);
  assert.equal(shown.length + Number(rest), 1500);
  assert.match(page.note!, /^Stopped at line 1 to stay within the 1000-character result limit \(file has 2\)\. Continue with offset=2\.$/);
  // A limit with no room beside the page's own fields still shows where the line's text is.
  const tiny = (await read({}, 50)).data as LinePage;
  assert.equal(tiny.toLine, 1);
  assert.equal(tiny.content, '     1\t [… 1500 more chars; read them with offsetChars=0]');
});

test('a character page stops at the result limit too, with nextOffsetChars', async t => {
  // Control characters take six characters each as JSON.
  const text = 'abc\u0001'.repeat(20_000);
  const { read } = await setup(t, text);
  for (const limit of [24_000, 1_000]) {
    let offsetChars = 0;
    let recovered = '';
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 1_000, 'every page moves on');
      const result = await read({ offsetChars, limitChars: 100_000 }, limit);
      assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
      const page = result.data as CharPage;
      recovered += page.content;
      if (page.nextOffsetChars === null) break;
      assert.equal(page.note, `Stopped at character ${page.nextOffsetChars} to stay within the ${limit}-character result limit; continue with offsetChars=${page.nextOffsetChars}.`);
      offsetChars = page.nextOffsetChars;
    }
    assert.equal(recovered, text);
  }
  // A limit with no room beside the page's own fields still moves the page on.
  const tiny = (await read({ offsetChars: 5, limitChars: 100 }, 50)).data as CharPage;
  assert.equal(tiny.offsetChars, 5);
  assert.equal(tiny.nextOffsetChars, 6);
  assert.equal(tiny.content, text[5]);
  // A surrogate pair is never split at the stop, whatever the limit leaves room for.
  const { read: readEmoji } = await setup(t, '😀'.repeat(20_000));
  for (let limit = 1_000; limit < 1_004; limit++) {
    const page = (await readEmoji({ offsetChars: 0, limitChars: 100_000 }, limit)).data as CharPage;
    assert.equal(page.nextOffsetChars! % 2, 0, `at ${limit}`);
    assert.equal(page.content.length % 2, 0, `at ${limit}`);
  }
});

test('character mode can be selected by either parameter and reports EOF', async t => {
  const { read } = await setup(t, 'a'.repeat(3000));
  assert.deepEqual((await read({ offsetChars: 0 })).data, {
    path: 'work/text.txt', totalChars: 3000, offsetChars: 0, nextOffsetChars: 2000, content: 'a'.repeat(2000),
  });
  assert.equal(((await read({ limitChars: 3 })).data as { content: string }).content, 'aaa');
  assert.deepEqual((await read({ offsetChars: 2999, limitChars: 10 })).data, {
    path: 'work/text.txt', totalChars: 3000, offsetChars: 2999, nextOffsetChars: null, content: 'a',
  });
  for (const offsetChars of [3000, 4000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual((await read({ offsetChars })).data, {
      path: 'work/text.txt', totalChars: 3000, offsetChars: 3000, nextOffsetChars: null, content: '',
    });
  }
});

test('character pages preserve Unicode and raw newlines, even with limitChars 1', async t => {
  const body = '😀a\r\n𐐷e\u0301終';
  const { read } = await setup(t, body);
  let offsetChars = 0;
  let recovered = '';
  do {
    const result = await read({ offsetChars, limitChars: 1 });
    assert.equal(result.success, true);
    const page = result.data as { content: string; nextOffsetChars: number | null };
    assert.ok(page.content.length >= 1 && page.content.length <= 2);
    assert.equal(Buffer.from(page.content).toString(), page.content, 'UTF-8 transport cannot replace half a pair');
    recovered += page.content;
    if (page.nextOffsetChars === null) break;
    assert.ok(page.nextOffsetChars > offsetChars);
    offsetChars = page.nextOffsetChars;
  } while (true);
  assert.equal(recovered, body);
  const invalid = await read({ offsetChars: 1 });
  assert.equal(invalid.success, false);
  assert.match(invalid.error!, /surrogate pair/);
});

test('empty text returns an empty final character page', async t => {
  const { read } = await setup(t, '');
  assert.deepEqual((await read({ offsetChars: 0 })).data, {
    path: 'work/text.txt', totalChars: 0, offsetChars: 0, nextOffsetChars: null, content: '',
  });
});

test('character paging rejects invalid numbers and ambiguous line/character inputs', async t => {
  const { read } = await setup(t, 'hello');
  for (const input of [
    { offsetChars: -1 }, { offsetChars: 0.5 }, { offsetChars: NaN }, { offsetChars: Infinity },
    { offsetChars: Number.MAX_SAFE_INTEGER + 1 }, { offsetChars: '0' }, { offsetChars: null },
    { limitChars: 0 }, { limitChars: -1 }, { limitChars: 0.5 }, { limitChars: NaN },
    { limitChars: Infinity }, { limitChars: Number.MAX_SAFE_INTEGER + 1 },
    { limitChars: '2' }, { limitChars: null },
    { offset: 1, offsetChars: 0 }, { limit: 2, limitChars: 1 },
    { offset: 1, limitChars: 1 }, { limit: 2, offsetChars: 0 },
  ]) {
    const result = await read(input);
    assert.equal(result.success, false, JSON.stringify(input));
    assert.equal(result.isError, true);
  }
});

test('character reads use the same mount containment and missing-file checks', async t => {
  const { read } = await setup(t, 'hello');
  for (const path of ['work/../escape', 'unknown/file', 'work/missing']) {
    const result = await read({ path, offsetChars: 0 });
    assert.equal(result.success, false, path);
    assert.equal(result.isError, true);
  }
});
