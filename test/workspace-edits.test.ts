// edit and edit_many through one planner: a miss shows the closest region, a
// count that differs shows the lines that matched, CRLF and a BOM are kept,
// and edit_many stores every edit or none. Each answer keeps to the length
// its call's result may have (ToolCall.resultMaxChars).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { ToolResult } from '../src/types/events.js';

function setup(t: TestContext, opts: { autoMaterialize?: boolean; maxFileSize?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-edits-'));
  const dir = join(root, 'mount');
  const other = join(root, 'other');
  const shelf = join(root, 'shelf');
  for (const path of [dir, other, shelf]) mkdirSync(path);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: dir,
        mode: 'read-write',
        watch: 'never',
        autoMaterialize: opts.autoMaterialize ?? false,
        ...(opts.maxFileSize !== undefined ? { maxFileSize: opts.maxFileSize } : {}),
      },
      { name: 'other', path: other, mode: 'read-write', watch: 'never' },
      { name: 'shelf', path: shelf, mode: 'read-only', watch: 'never' },
    ],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name: string, input: unknown, resultMaxChars?: number): Promise<ToolResult> =>
    workspace.handleToolCall({ id: name, name, input, ...(resultMaxChars !== undefined ? { resultMaxChars } : {}) } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const disk = (rel: string): Buffer | null => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null);
  const stored = async (rel: string): Promise<string> => {
    const result = await call('read', { path: `work/${rel}`, offsetChars: 0, limitChars: 1_000_000 });
    assert.equal(result.success, true, result.error);
    return (result.data as { content: string }).content;
  };
  /** A file the workspace holds, as a listing takes it in. */
  const file = async (rel: string, content: string | Buffer): Promise<void> => {
    writeFileSync(join(dir, rel), content);
    assert.equal((await call('ls', { path: 'work' })).success, true);
  };
  return { workspace, store, dir, call, disk, stored, file };
}

const errorOf = (result: ToolResult): string => {
  assert.equal(result.success, false, 'the call was refused');
  assert.equal(result.isError, true);
  return result.error ?? '';
};

const dataOf = (result: ToolResult): Record<string, unknown> => {
  assert.equal(result.success, true, result.error);
  return result.data as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

test('a miss shows the closest region, numbered, and stores nothing', async (t) => {
  const { call, stored, file } = setup(t);
  await file('m.txt', 'alpha\nbeta gamma\ndelta\n');
  const refusal = errorOf(await call('edit', { path: 'work/m.txt', oldString: 'beta  gamma', newString: 'x' }));
  assert.equal(refusal, "The edit did nothing: oldString isn't in work/m.txt.\n"
    + 'Closest region (line 2, similarity 0.95):\n     1\talpha\n     2\tbeta gamma\n     3\tdelta\n'
    + 'Match exactly, including whitespace and indentation.');
  assert.equal(await stored('m.txt'), 'alpha\nbeta gamma\ndelta\n');
});

test('a count that differs names the lines that matched and shows them, unless replaceAll', async (t) => {
  const { call, stored, file } = setup(t);
  await file('c.txt', 'one x\ntwo\nthree x\n');
  assert.equal(errorOf(await call('edit', { path: 'work/c.txt', oldString: 'x', newString: 'y' })),
    'The edit did nothing: oldString occurs 2 times in work/c.txt (lines 1, 3). '
    + 'Add the text around it to make it unique, or set replaceAll to replace every one.\n     1\tone x\n     3\tthree x');
  const all = dataOf(await call('edit', { path: 'work/c.txt', oldString: 'x', newString: 'y', replaceAll: true }));
  assert.equal(all.replacements, 2);
  assert.equal(all.note, 'The other replacements are at line 3.');
  assert.equal(await stored('c.txt'), 'one y\ntwo\nthree y\n');
});

test('the receipt shows two lines around the change, numbered, and no line past the end', async (t) => {
  const { call, file } = setup(t);
  await file('r.txt', 'a\nb\nc\nd\ne\nf\ng\n');
  const middle = dataOf(await call('edit', { path: 'work/r.txt', oldString: 'd', newString: 'D1\nD2' }));
  assert.deepEqual(middle, {
    path: 'work/r.txt',
    size: 18,
    replacements: 1,
    changed: '     2\tb\n     3\tc\n     4\tD1\n     5\tD2\n     6\te\n     7\tf',
  });
  const last = dataOf(await call('edit', { path: 'work/r.txt', oldString: 'g\n', newString: 'G\n' }));
  assert.equal(last.changed, '     6\te\n     7\tf\n     8\tG');
});

test('a CRLF file matches LF text and keeps its line ends on disk, as it keeps a BOM', async (t) => {
  const { call, disk, file } = setup(t, { autoMaterialize: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await file('w.txt', Buffer.concat([bom, Buffer.from('first\r\nsecond\r\n')]));
  const receipt = dataOf(await call('edit', { path: 'work/w.txt', oldString: 'first\nsecond', newString: 'first\nnew\nsecond' }));
  assert.equal(receipt.note, "The file's CRLF line ends are kept.");
  assert.deepEqual(disk('w.txt'), Buffer.concat([bom, Buffer.from('first\r\nnew\r\nsecond\r\n')]));
});

test('straight and curly quotes match as a second chance, and the receipt says so', async (t) => {
  const { call, stored, file } = setup(t);
  await file('q.txt', 'it’s “quoted”\n');
  const receipt = dataOf(await call('edit', { path: 'work/q.txt', oldString: 'it\'s "quoted"', newString: 'plain' }));
  assert.equal(receipt.note, 'The text matched with straight and curly quotes treated as equal.');
  assert.equal(await stored('q.txt'), 'plain\n');
});

test('identical strings are refused before the path is touched, as an empty oldString is', async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'same', newString: 'same' })),
    "The edit did nothing: oldString and newString are the same, so there's nothing to change.");
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'a\r\nb', newString: 'a\nb' })),
    "The edit did nothing: oldString and newString are the same once their CRLF line ends are read as LF, so there's nothing to change.");
});

test("an edit that would take a file past its mount's maxFileSize is refused", async (t) => {
  const { call, stored, file } = setup(t, { maxFileSize: 20 });
  await file('s.txt', 'small\n');
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'much, much, much larger' })),
    "The edit did nothing: work/s.txt would be 24 bytes with this edit, past this mount's maxFileSize of 20 bytes, so the workspace couldn't keep it.");
  assert.equal(await stored('s.txt'), 'small\n');
});

// ---------------------------------------------------------------------------
// edit_many
// ---------------------------------------------------------------------------

test('edits in one file and across files are stored together, each matched in its file as read, in any order', async (t) => {
  const { call, disk, stored, file } = setup(t, { autoMaterialize: true });
  await file('a.txt', 'one\ntwo\n');
  await file('b.txt', 'three\n');
  const receipt = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/b.txt', oldString: 'three', newString: 'THREE' },
      { path: 'work/a.txt', oldString: 'two', newString: 'one' },
      { path: 'work/a.txt', oldString: 'one\n', newString: 'ONE\n' },
    ],
  }));
  assert.equal(await stored('a.txt'), 'ONE\none\n', "edit 3 didn't match edit 2's new text");
  assert.equal(disk('a.txt')!.toString(), 'ONE\none\n');
  assert.equal(disk('b.txt')!.toString(), 'THREE\n');
  assert.deepEqual(receipt, {
    edits: 3,
    replacements: 3,
    files: [
      { path: 'work/b.txt', size: 6, replacements: 1, edits: [1] },
      { path: 'work/a.txt', size: 8, replacements: 2, edits: [2, 3] },
    ],
    changed: 'work/b.txt\n     1\tTHREE\n\nwork/a.txt\n     1\tONE\n     2\tone',
  });
});

test('one miss stores nothing in any file, and every problem is named in edit order', async (t) => {
  const { call, stored, file } = setup(t);
  await file('a.txt', 'one\n');
  await file('b.txt', 'two two\n');
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'one', newString: 'ONE' },
      { path: 'work/b.txt', oldString: 'two', newString: '2' },
      { path: 'work/a.txt', oldString: 'zzz', newString: 'y' },
      { path: 'work/a.txt', oldString: 'same', newString: 'same' },
      { path: 'nowhere/c.txt', oldString: 'x', newString: 'y' },
    ],
  }));
  assert.equal(refusal, 'The edit_many call did nothing: 4 problems.\n\n'
    + 'edit 2: oldString occurs 2 times in work/b.txt (lines 1, 1), not 1. '
    + 'Include more of the text around it to single out the one you mean, or set occurrences to 2 if every one should change.\n     1\ttwo two\n\n'
    + "edit 3: oldString isn't in work/a.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + "edit 4: oldString and newString are the same, so there's nothing to change.\n\n"
    + 'edit 5: Unknown mount: "nowhere". Available: work, other, shelf');
  assert.equal(await stored('a.txt'), 'one\n');
  assert.equal(await stored('b.txt'), 'two two\n');
});

test('overlapping matches are refused, and touching ones apply', async (t) => {
  const { call, stored, file } = setup(t);
  await file('o.txt', 'abcdef\n');
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/o.txt', oldString: 'abc', newString: 'X' },
      { path: 'work/o.txt', oldString: 'cde', newString: 'Y' },
    ],
  })), 'The edit_many call did nothing: 1 problem.\n\n'
    + 'edits 1 and 2 overlap in work/o.txt (from line 1); give each its own stretch of text, or make them one edit.');
  dataOf(await call('edit_many', {
    edits: [
      { path: 'work/o.txt', oldString: 'abc', newString: 'X' },
      { path: 'work/o.txt', oldString: 'def', newString: 'Y' },
    ],
  }));
  assert.equal(await stored('o.txt'), 'XY\n');
});

test('occurrences sets the count each edit must find, and replaces every one', async (t) => {
  const { call, stored, file } = setup(t);
  await file('n.txt', 'x x x\n');
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 2 }] })),
    /^The edit_many call did nothing: 1 problem\.\n\nedit 1: oldString occurs 3 times in work\/n\.txt \(lines 1, 1, 1\), not 2\. Include more of the text around it to single out the ones you mean, or set occurrences to 3 if every one should change\./);
  const receipt = dataOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 3 }] }));
  assert.equal((receipt.files as Array<{ note?: string }>)[0]!.note, "Edit 1's other replacements are at lines 1, 1.");
  assert.equal(await stored('n.txt'), 'y y y\n');
});

test("one call edits one mount's files: other mounts, a read-only mount, an empty list and a malformed edit are refused", async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'a', newString: 'b' },
      { path: 'other/b.txt', oldString: 'a', newString: 'b' },
    ],
  })), 'The edit_many call did nothing: 1 problem.\n\n'
    + 'the edits name files in more than one mount (work, other); one call edits the files of one mount, so send the edits for each mount in a call of its own.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'shelf/a.txt', oldString: 'a', newString: 'b' }] })),
    'The edit_many call did nothing: 1 problem.\n\nedit 1: Mount "shelf" is read-only');
  assert.equal(errorOf(await call('edit_many', { edits: [] })), 'The edit_many call did nothing: "edits" is empty. Give at least one edit.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b' }, { path: 'work/a.txt', oldString: 'a' }] })),
    'The edit_many call did nothing: "edits" item 2: "newString" is required.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b', occurrences: 0 }] })),
    'The edit_many call did nothing: "edits" item 1: "occurrences" must be a whole number of at least 1, not 0.');
  assert.equal(errorOf(await call('edit_many', { edits: 'work/a.txt' })),
    'The edit_many call did nothing: "edits" must be an array, not a string.');
});

test('a generated file is refused, as edit refuses it', async (t) => {
  const { workspace, call } = setup(t);
  workspace.registerGeneratedTextFile('work/tools.md', () => 'generated\n', 'agent');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/tools.md', oldString: 'generated', newString: 'x' }] })),
    'The edit_many call did nothing: 1 problem.\n\nedit 1: work/tools.md is a generated file, which is read-only; edit the presentation configuration instead.');
});

test('edits disk takes in part are all stored, and the answer names each file disk refused', async (t) => {
  const { dir, call, disk, stored, file } = setup(t, { autoMaterialize: true });
  await file('free.txt', 'free\n');
  await file('linked.txt', 'shared\n');
  linkSync(join(dir, 'linked.txt'), join(dir, 'linked-too.txt'));
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/free.txt', oldString: 'free', newString: 'FREE' },
      { path: 'work/linked.txt', oldString: 'shared', newString: 'SHARED' },
    ],
  }));
  assert.match(refusal, /^Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice\.\n\nDisk took 1 of the 2 files\. These pushes didn't complete, each with the way to finish it:\n\nwork\/linked\.txt: not written: a file with other hard links/);
  assert.equal(await stored('free.txt'), 'FREE\n');
  assert.equal(await stored('linked.txt'), 'SHARED\n');
  assert.equal(disk('free.txt')!.toString(), 'FREE\n');
  assert.equal(disk('linked-too.txt')!.toString(), 'shared\n');
});

test('a call that fails after storing some files names those stored and those not', async (t) => {
  const { workspace, call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('b.txt', 'b\n');
  const intents = (workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> }).intents.get('work')!;
  const update = intents.update;
  // The first file's entry is set, then its intent fails, before the second's.
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    assert.equal(errorOf(await call('edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'a', newString: 'A' },
        { path: 'work/b.txt', oldString: 'b', newString: 'B' },
      ],
    })), "The edits of 1 of this call's 2 files are stored in the workspace, so don't send the call again: a second call can apply those edits twice. "
      + 'Send the edits of the files not stored in a call of their own.\n\n'
      + "The rest of the call failed: injected intent exception. ls shows each path's state.\n\nStored: work/a.txt.\n\nNot stored: work/b.txt.");
  } finally {
    intents.update = update;
  }
  assert.equal(await stored('a.txt'), 'A\n');
  assert.equal(await stored('b.txt'), 'b\n');
});

test('every path is checked before any entry is set: a check that fails at the second file stores neither', async (t) => {
  const { workspace, store, call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('b.txt', 'b\n');
  const agreement = (workspace as unknown as { agreement: { barrier: () => void } }).agreement;
  const barrier = agreement.barrier;
  const storeBlob = store.storeBlob;
  // The commit starts once the call has stored its new texts' blobs. From
  // then on each path's check makes the agreement durable first, and the
  // second check fails.
  let armed = false;
  let barriers = 0;
  (store as unknown as { storeBlob: (...args: unknown[]) => unknown }).storeBlob = (...args: unknown[]) => {
    armed = true;
    return (storeBlob as (...a: unknown[]) => unknown).apply(store, args);
  };
  const needsBarrier = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(agreement), 'needsBarrier')!.get!;
  Object.defineProperty(agreement, 'needsBarrier', { configurable: true, get: () => armed || needsBarrier.call(agreement) });
  agreement.barrier = () => {
    if (armed && ++barriers === 2) throw new Error('injected barrier failure');
    barrier.call(agreement);
  };
  try {
    assert.equal(errorOf(await call('edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'a', newString: 'A' },
        { path: 'work/b.txt', oldString: 'b', newString: 'B' },
      ],
    })), 'injected barrier failure');
  } finally {
    delete (store as unknown as Record<string, unknown>).storeBlob;
    delete (agreement as unknown as Record<string, unknown>).needsBarrier;
    delete (agreement as unknown as Record<string, unknown>).barrier;
  }
  assert.equal(barriers, 2);
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');
});

test("a file disk changed is taken in first, and the edits that use it say so", async (t) => {
  const { dir, call, stored, file } = setup(t);
  await file('d.txt', 'v1 line\n');
  writeFileSync(join(dir, 'd.txt'), 'v2 line\n');
  const receipt = dataOf(await call('edit_many', { edits: [{ path: 'work/d.txt', oldString: 'line', newString: 'LINE' }] }));
  assert.equal((receipt.files as Array<{ note?: string }>)[0]!.note,
    "Disk's copy of work/d.txt had changed since the workspace last agreed with it, so it was taken in first, and edit 1 applied to that text.");
  assert.equal(await stored('d.txt'), 'v2 LINE\n');
});

test('edit_many names a conflict with disk, and a file disk lacks, for each file it applies to or refuses', async (t) => {
  const { store, dir, call } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  // An entry from before the evidence, so nothing says whether disk deleted it.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  const conflict = "work/k.txt is in conflict with disk (both-changed): edit 1 %s the workspace's copy. "
    + "Sync the path to take disk's copy instead, or materialize it with force to write the workspace's over disk's.";

  // A miss in the conflicted file says which copy it looked in.
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/k.txt', oldString: 'another', newString: 'x' }] })),
    "The edit_many call did nothing: 1 problem.\n\nedit 1: oldString isn't in work/k.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + conflict.replace('%s', 'looked in'));

  const receipt = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' },
      { path: 'work/l.txt', oldString: 'legacy', newString: 'edited' },
    ],
  }));
  assert.deepEqual((receipt.files as Array<{ note?: string }>).map((file) => file.note), [
    conflict.replace('%s', 'is in'),
    "Disk has no copy of work/l.txt, and nothing records whether it was deleted there, so edit 2 applied to the workspace's copy. "
      + 'A materialize of work/l.txt puts it back on disk; if it was deleted there on purpose, delete it here too.',
  ]);
});

// ---------------------------------------------------------------------------
// Answers within the call's resultMaxChars
// ---------------------------------------------------------------------------

test("a refusal keeps to the call's resultMaxChars: every problem is named before any is explained, then counted", async (t) => {
  const { call, file } = setup(t);
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'words '.repeat(20)}`).join('\n');
  await file('l.txt', long);
  const edits = Array.from({ length: 12 }, (_, i) => ({ path: 'work/l.txt', oldString: `line ${i} words  words`, newString: 'x' }));
  const named = (refusal: string) => [...refusal.matchAll(/^edit (\d+): /gm)].map((match) => Number(match[1]));
  const explained = (refusal: string) => refusal.split('\n\n').filter((part) => /^edit \d+: [^\n]*\nClosest region/.test(part)).length;

  // Room for every problem's first line, and the details of only some.
  const cut = errorOf(await call('edit_many', { edits }, 2000));
  assert.ok(cut.length <= 2000, `${cut.length} characters, within 2,000`);
  assert.deepEqual(named(cut), Array.from({ length: 12 }, (_, i) => i + 1), 'every edit named, in order');
  const left = Number(/\[(\d+) of these left out their details to keep this answer within 2,000 characters\.\]$/.exec(cut)?.[1]);
  assert.ok(left > 0 && left < 12, `${left} left out their details`);
  assert.equal(explained(cut), 12 - left);

  // Room for some first lines only: the rest are counted.
  const dropped = errorOf(await call('edit_many', { edits }, 700));
  assert.ok(dropped.length <= 700, `${dropped.length} characters, within 700`);
  const shown = named(dropped);
  const counts = /\[(\d+) of these left out their details to keep this answer within 700 characters\. (\d+) more aren't shown, to keep this answer within 700 characters: answer these and send the call again to see them\.\]$/.exec(dropped);
  assert.ok(counts, dropped);
  assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => i + 1));
  assert.equal(Number(counts[1]), shown.length);
  assert.equal(shown.length + Number(counts[2]), 12);

  const whole = errorOf(await call('edit_many', { edits }));
  assert.equal(explained(whole), 12, 'the default leaves room for every closest region');
});

test("a receipt keeps to the call's resultMaxChars, naming the regions past it by their lines", async (t) => {
  const { call, file } = setup(t);
  await file('g.txt', Array.from({ length: 300 }, (_, i) => `row ${i} ${'pad '.repeat(30)}`).join('\n'));
  const edits = Array.from({ length: 30 }, (_, i) => ({ path: 'work/g.txt', oldString: `row ${i * 10} `, newString: `ROW ${i * 10} ` }));
  const max = 3000;
  const result = await call('edit_many', { edits }, max);
  const receipt = dataOf(result);
  assert.ok(JSON.stringify(receipt).length <= max, `${JSON.stringify(receipt).length} characters, within ${max}`);
  assert.match(receipt.changed as string, /\[not shown, to keep this answer within 3,000 characters: lines \d+–\d+, /);
  assert.match(receipt.changed as string, /^work\/g\.txt\n     1\tROW 0 /);
});

test("one call's misses share one search for closest regions across its files", async (t) => {
  const { call, file } = setup(t);
  // Each file is just over half of what one call may search.
  const big = 'filler text\n'.repeat(90_000);
  await file('big1.txt', big);
  await file('big2.txt', big);
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/big1.txt', oldString: 'absent', newString: 'x' },
      { path: 'work/big2.txt', oldString: 'absent', newString: 'x' },
    ],
  }));
  assert.match(refusal, /\n\nedit 1: oldString isn't in work\/big1\.txt\.\nMatch exactly/);
  assert.match(refusal, /\n\nedit 2: oldString isn't in work\/big2\.txt\.\n\(No closest region: this call's other misses used its 2,097,152 UTF-16 code units of search; find the text with grep\.\)/);
});

test('a receipt lists its files while they fit and counts the rest, and counts the files whose regions it leaves out', async (t) => {
  const { call, file } = setup(t);
  for (let i = 0; i < 30; i++) await file(`f${i}.txt`, `value ${i}\n`);
  const edits = (from: string, to: string) =>
    Array.from({ length: 30 }, (_, i) => ({ path: `work/f${i}.txt`, oldString: `${from} ${i}`, newString: `${to} ${i}` }));

  const short = dataOf(await call('edit_many', { edits: edits('value', 'VALUE') }, 1500));
  assert.ok(JSON.stringify(short).length <= 1500, `${JSON.stringify(short).length} characters`);
  const listed = (short.files as unknown[]).length;
  assert.ok(listed > 0 && listed < 30);
  assert.equal(short.filesNotListed, 30 - listed);

  const longer = dataOf(await call('edit_many', { edits: edits('VALUE', 'value') }, 2800));
  assert.ok(JSON.stringify(longer).length <= 2800, `${JSON.stringify(longer).length} characters`);
  assert.equal((longer.files as unknown[]).length, 30);
  assert.match(longer.changed as string, /^work\/f0\.txt\n     1\tvalue 0\n\n/);
  assert.match(longer.changed as string, /\[\d+ more files' changed regions aren't shown, to keep this answer within 2,800 characters\]$/);
});
