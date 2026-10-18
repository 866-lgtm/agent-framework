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
import { fitted } from '../src/modules/workspace/edit-text.js';
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
    'The edit did nothing: oldString occurs 2 times in work/c.txt (on lines 1 and 3). '
    + 'Add the text around it to make it unique, or set replaceAll to replace every one.\n     1\tone x\n     3\tthree x');
  const all = dataOf(await call('edit', { path: 'work/c.txt', oldString: 'x', newString: 'y', replaceAll: true }));
  assert.equal(all.replacements, 2);
  assert.equal(all.note, 'The other replacements are on line 3.');
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

test("an oldString carrying the file's BOM or a line's CR, as a character page shows them, matches without them, and the receipt says so", async (t) => {
  const { call, disk, file } = setup(t, { autoMaterialize: true });
  await file('cr.txt', 'alpha\r\nbeta\r\n');
  const receipt = dataOf(await call('edit', { path: 'work/cr.txt', oldString: 'alpha\r', newString: 'gamma\r' }));
  assert.equal(receipt.note, "The text matched without the BOM or the line end's CR it carried, which the file keeps. The file's CRLF line ends are kept.");
  assert.deepEqual(disk('cr.txt'), Buffer.from('gamma\r\nbeta\r\n'));
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await file('bom.txt', Buffer.concat([bom, Buffer.from('alpha\nbeta\n')]));
  const many = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/bom.txt', oldString: '\uFEFFalpha', newString: '\uFEFFgamma' },
      { path: 'work/bom.txt', oldString: 'beta', newString: 'delta' },
    ],
  }));
  assert.equal((many.files as Array<{ note?: string }>)[0]!.note, "Edit 1 matched without the BOM or the line end's CR its old text carried, which the file keeps.");
  assert.deepEqual(disk('bom.txt'), Buffer.concat([bom, Buffer.from('gamma\ndelta\n')]));
  // An edit whose only change is the CR the file keeps has nothing to change.
  assert.equal(errorOf(await call('edit', { path: 'work/cr.txt', oldString: 'gamma\r', newString: 'gamma' })),
    "The edit did nothing: oldString and newString are the same once the BOM or the line end's CR that oldString carries is read as work/cr.txt's own, which the file keeps, so there's nothing to change.");
  assert.deepEqual(disk('cr.txt'), Buffer.from('gamma\r\nbeta\r\n'));
});

test('a receipt shows a long line from shortly before the change on it, and its start where the change is there', async (t) => {
  const { call, file } = setup(t);
  await file('long.txt', `${'a'.repeat(2500)}target${'z'.repeat(10)}\nnext\n`);
  const late = dataOf(await call('edit', { path: 'work/long.txt', oldString: 'target', newString: 'DONE' }));
  assert.equal(late.changed, `     1\t[… 2420 chars before] ${'a'.repeat(80)}DONE${'z'.repeat(10)}\n     2\tnext`);
  await file('early.txt', `ab${'c'.repeat(2500)}\n`);
  const early = dataOf(await call('edit', { path: 'work/early.txt', oldString: 'ab', newString: 'AB' }));
  assert.equal(early.changed, `     1\tAB${'c'.repeat(1998)} [… 502 more chars]`);
  // Several edits' first changes on one long line: a stretch from shortly
  // before each, run together where they meet.
  await file('many.txt', `${'a'.repeat(3000)}one${'b'.repeat(100)}two${'c'.repeat(3000)}three${'d'.repeat(500)}\n`);
  const many = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/many.txt', oldString: 'three', newString: '3' },
      { path: 'work/many.txt', oldString: 'one', newString: '1' },
      { path: 'work/many.txt', oldString: 'two', newString: '2' },
    ],
  }));
  // Each stretch runs from 80 characters before its change for 2,000: the
  // first two meet and run together, and the third is apart.
  assert.equal(many.changed, `work/many.txt\n     1\t[… 2920 chars before] ${'a'.repeat(80)}1${'b'.repeat(100)}2${'c'.repeat(1919)}`
    + ` [… 1001 chars] ${'c'.repeat(80)}3${'d'.repeat(500)}`);
});

test("a receipt names the lines of an edit's other replacements, the first 20 and how many more", async (t) => {
  const { call, file } = setup(t);
  await file('lines.txt', 'x\n'.repeat(25));
  const all = dataOf(await call('edit', { path: 'work/lines.txt', oldString: 'x', newString: 'y', replaceAll: true }));
  assert.equal(all.replacements, 25);
  assert.equal(all.note, `The other replacements are on lines ${Array.from({ length: 20 }, (_, i) => i + 2).join(', ')} and 4 more.`);
});

test('identical strings are refused before the path is touched, as an empty oldString is', async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'same', newString: 'same' })),
    "The edit did nothing: oldString and newString are the same, so there's nothing to change.");
  // An edit keeps the file's line ends, so one that changes only those names write.
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'a\r\nb', newString: 'a\nb' })),
    "The edit did nothing: oldString and newString are the same once their CRLF line ends are read as LF, so there's nothing to change: "
    + "an edit keeps the file's line ends, and write replaces the whole file, line ends included.");
});

test("an edit that would take a file past its mount's maxFileSize is refused", async (t) => {
  const { call, stored, file } = setup(t, { maxFileSize: 20 });
  await file('s.txt', 'small\n');
  // Exactly at the limit applies.
  assert.equal(dataOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'x'.repeat(19) })).size, 20);
  assert.equal((await call('edit', { path: 'work/s.txt', oldString: 'x'.repeat(19), newString: 'small' })).success, true);
  // An edit whose counts take the file past the limit is refused before its
  // text is built, from the least its bytes can be: a byte or more for each
  // UTF-16 code unit.
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'much, much, much larger' })),
    "The edit did nothing: work/s.txt would be at least 24 bytes with this edit, past the 20-byte limit this mount sets on a file, so the workspace couldn't keep it. "
    + "An edit that leaves the file within the limit applies. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
  // One whose code units fit but whose UTF-8 doesn't is built, and refused by its bytes.
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'é'.repeat(10) })),
    "The edit did nothing: work/s.txt would be 21 bytes with this edit, past the 20-byte limit this mount sets on a file, so the workspace couldn't keep it. "
    + "An edit that leaves the file within the limit applies. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
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
  assert.equal(refusal, 'The edit_many call stored none of its edits: 4 problems.\n\n'
    + 'edit 2: oldString occurs 2 times in work/b.txt (on line 1), not 1. '
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
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'edits 1 and 2 overlap in work/o.txt (from line 1); give each its own stretch of text, or make them one edit.');
  dataOf(await call('edit_many', {
    edits: [
      { path: 'work/o.txt', oldString: 'abc', newString: 'X' },
      { path: 'work/o.txt', oldString: 'def', newString: 'Y' },
    ],
  }));
  assert.equal(await stored('o.txt'), 'XY\n');
});

test('occurrences that overlap are counted until the refusal has those it shows, and it says "at least"', async (t) => {
  const { call, file } = setup(t);
  await file('run.txt', `${' '.repeat(5000)}\n`);
  assert.match(errorOf(await call('edit', { path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', replaceAll: true })),
    /^The edit did nothing: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), and they overlap, so they can't each be replaced\./);
  // A count the scan stopped at is a floor: it differs from one asked for only where it passes it.
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', occurrences: 30 }] })),
    /\n\nedit 1: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), and they overlap/);
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', occurrences: 5 }] })),
    /\n\nedit 1: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), not 5, and they overlap/);
});

test('a refusal at its cap counts the notes it leaves out apart from its problems', async (t) => {
  const { dir, call, file } = setup(t);
  const names = ['p', 'q', 'r'];
  for (const name of names) await file(`${name}.txt`, `${name} one\n`);
  for (const name of names) writeFileSync(join(dir, `${name}.txt`), `${name} two\n`);
  const refusal = errorOf(await call('edit_many', {
    edits: names.map((name) => ({ path: `work/${name}.txt`, oldString: 'absent', newString: 'x' })),
  }, 700));
  assert.ok(refusal.length <= 700, `${refusal.length} characters`);
  assert.match(refusal, /\n\nedit 3: oldString isn't in work\/r\.txt\./);
  assert.match(refusal, /\[To keep this answer within 700 characters, it leaves out [^\]]*\d notes? on the files' copies on disk\.\]$/);
  assert.doesNotMatch(refusal, /more problems?/);
});

test('occurrences sets the count each edit must find, and replaces every one', async (t) => {
  const { call, stored, file } = setup(t);
  await file('n.txt', 'x x x\n');
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 2 }] })),
    /^The edit_many call stored none of its edits: 1 problem\.\n\nedit 1: oldString occurs 3 times in work\/n\.txt \(on line 1\), not 2\. Include more of the text around it to single out the ones you mean, or set occurrences to 3 if every one should change\./);
  const receipt = dataOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 3 }] }));
  assert.equal((receipt.files as Array<{ note?: string }>)[0]!.note, "Edit 1's other replacements are on line 1.");
  assert.equal(await stored('n.txt'), 'y y y\n');
});

test("one call edits one mount's files: other mounts, a read-only mount, an empty list and a malformed edit are refused", async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'a', newString: 'b' },
      { path: 'other/b.txt', oldString: 'a', newString: 'b' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'the edits name files in more than one mount (work, other); one call edits the files of one mount, so send the edits for each mount in a call of its own.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'shelf/a.txt', oldString: 'a', newString: 'b' }] })),
    'The edit_many call stored none of its edits: 1 problem.\n\nedit 1: Mount "shelf" is read-only');
  assert.equal(errorOf(await call('edit_many', { edits: [] })), 'The edit_many call did nothing: "edits" is empty. Give at least one edit.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b' }, { path: 'work/a.txt', oldString: 'a' }] })),
    'The edit_many call did nothing: "edits" item 2: "newString" is required.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b', occurrences: 0 }] })),
    'The edit_many call did nothing: "edits" item 1: "occurrences" must be a whole number of at least 1, not 0.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b', occurrences: 1.5 }] })),
    'The edit_many call did nothing: "edits" item 1: "occurrences" must be a whole number of at least 1, not 1.5.');
  assert.equal(errorOf(await call('edit_many', { edits: 'work/a.txt' })),
    'The edit_many call did nothing: "edits" must be an array, not a string.');
});

test('a generated file is refused by the rule edit refuses it by: the agent\'s own is read-only, another\'s belongs to that agent', async (t) => {
  const { workspace } = setup(t);
  workspace.registerGeneratedTextFile('work/tools.md', () => 'generated\n', 'agent');
  const as = (callerAgentName: string, name: string, input: unknown) =>
    workspace.handleToolCall({ id: name, name, input, callerAgentName } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const edit = { path: 'work/tools.md', oldString: 'generated', newString: 'x' };
  const readOnly = 'Generated file is read-only; change the tool presentation it shows with set_tool_visibility or set_tool_description instead';
  assert.equal(errorOf(await as('agent', 'edit', edit)), readOnly);
  assert.equal(errorOf(await as('agent', 'edit_many', { edits: [edit] })),
    `The edit_many call stored none of its edits: 1 problem.\n\nedit 1: work/tools.md: ${readOnly}.`);
  assert.equal(errorOf(await as('another', 'edit', edit)), 'Generated file belongs to another agent');
  assert.equal(errorOf(await as('another', 'edit_many', { edits: [edit] })),
    'The edit_many call stored none of its edits: 1 problem.\n\nedit 1: work/tools.md: Generated file belongs to another agent.');
  // write and delete meet the same refusal, by the same rule.
  assert.equal(errorOf(await as('agent', 'write', { path: 'work/tools.md', content: 'x' })), readOnly);
  assert.equal(errorOf(await as('agent', 'delete', { path: 'work/tools.md' })), readOnly);
  assert.equal(errorOf(await as('another', 'write', { path: 'work/tools.md', content: 'x' })), 'Generated file belongs to another agent');
});

test("a file that isn't valid UTF-8 is refused, and nothing is stored", async (t) => {
  const { call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('latin1.txt', Buffer.from('caf\xe9\n', 'latin1'));
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'a', newString: 'A' },
      { path: 'work/latin1.txt', oldString: 'caf', newString: 'tea' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + "edit 2: work/latin1.txt isn't valid UTF-8, so editing it would change bytes outside the text it replaces. "
    + 'Read shows each invalid byte sequence as U+FFFD, and a write replaces the whole file as UTF-8, so writing back what read shows puts U+FFFD in their place.');
  assert.equal(await stored('a.txt'), 'a\n');
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
  assert.match(refusal, /^Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice\.\n\nDisk took 1 of the call's 2 files\. This file's push didn't complete:\n\nwork\/linked\.txt: not written: a file with other hard links/);
  assert.equal(await stored('free.txt'), 'FREE\n');
  assert.equal(await stored('linked.txt'), 'SHARED\n');
  assert.equal(disk('free.txt')!.toString(), 'FREE\n');
  assert.equal(disk('linked-too.txt')!.toString(), 'shared\n');

  // The one file of a call, and two files of three.
  for (const name of ['solo', 'left', 'right']) {
    await file(`${name}.txt`, `${name}\n`);
    linkSync(join(dir, `${name}.txt`), join(dir, `${name}-too.txt`));
  }
  await file('open.txt', 'open\n');
  const one = errorOf(await call('edit_many', { edits: [{ path: 'work/solo.txt', oldString: 'solo', newString: 'SOLO' }] }));
  assert.match(one, /\n\nDisk didn't take the call's one file\. Its push didn't complete:\n\nwork\/solo\.txt: not written: a file with other hard links/);
  const two = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/open.txt', oldString: 'open', newString: 'OPEN' },
      { path: 'work/left.txt', oldString: 'left', newString: 'LEFT' },
      { path: 'work/right.txt', oldString: 'right', newString: 'RIGHT' },
    ],
  }));
  assert.match(two, /\n\nDisk took 1 of the call's 3 files\. These files' pushes didn't complete, each with its reason:\n\nwork\/left\.txt: not written: a file with other hard links[^\n]*\n\nwork\/right\.txt: not written: a file with other hard links/);
});

test('every entry is set in one record: a call that fails after it says every edit is stored, and one that fails in it stores none', async (t) => {
  const { workspace, store, call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('b.txt', 'b\n');
  const edits = (from: string, to: string) => ({
    edits: [
      { path: 'work/a.txt', oldString: from, newString: to },
      { path: 'work/b.txt', oldString: from === 'a' ? 'b' : 'B', newString: to === 'A' ? 'B' : 'b' },
    ],
  });
  const intents = (workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> }).intents.get('work')!;
  const update = intents.update;
  // Both entries are set, then the first file's intent fails.
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    assert.equal(errorOf(await call('edit_many', edits('a', 'A'))),
      "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
      + "The rest of the call failed: injected intent exception. ls shows each path's state.");
    // What failed stands for the whole call, so a cap too short for it keeps
    // it, cut as a problem's first line is.
    intents.update = () => { throw new Error(`injected ${'long '.repeat(200)}exception`); };
    const short = errorOf(await call('edit_many', edits('A', 'a'), 200));
    assert.match(short, /^Every edit of this call is stored[^\n]*\n\nThe rest of the call failed: injected [long ]+…\. ls shows each path's state\.$/);
    assert.ok(short.length < 600, `${short.length} characters`);
  } finally {
    intents.update = update;
  }
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');

  // A store that fails as it sets them, recording nothing, sets neither, as
  // reading them back shows, and the answer says so, with what the store
  // said, cut as a problem's first line is.
  let message = 'injected batch failure';
  (store as unknown as { treeBatch: () => never }).treeBatch = () => { throw new Error(message); };
  try {
    assert.equal(errorOf(await call('edit_many', edits('a', 'A'))), 'The edit_many call stored none of its edits: injected batch failure');
    message = `injected ${'long '.repeat(200)}failure`;
    const long = errorOf(await call('edit_many', edits('a', 'A')));
    assert.match(long, /^The edit_many call stored none of its edits: injected [long ]+…$/);
    assert.ok(long.length < 500, `${long.length} characters`);
  } finally {
    delete (store as unknown as Record<string, unknown>).treeBatch;
  }
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');
});

test('a store that throws after recording the edits is read back: the answer says they are stored, and one it can\'t read back says it can\'t tell', async (t) => {
  const { store, call, stored, file } = setup(t);
  await file('a.txt', 'alpha\n');
  await file('b.txt', 'beta\n');
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = { treeBatch: store.treeBatch, treeSet: store.treeSet, treeGet: store.treeGet };
  const both = (from: [string, string], to: [string, string]) => ({
    edits: [
      { path: 'work/a.txt', oldString: from[0], newString: to[0] },
      { path: 'work/b.txt', oldString: from[1], newString: to[1] },
    ],
  });
  const storedAll = "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
    + "The rest of the call failed: No space left on device (os error 28). ls shows each path's state.";
  // The record lands, then the store throws, as Chronicle 0.4 does when the
  // auto-snapshot it writes after recording fails (anima-research/chronicle#39).
  s.treeBatch = (...args) => { real.treeBatch.apply(store, args as never); throw new Error('No space left on device (os error 28)'); };
  s.treeSet = (...args) => { real.treeSet.apply(store, args as never); throw new Error('No space left on device (os error 28)'); };
  try {
    assert.equal(errorOf(await call('edit_many', both(['alpha', 'beta'], ['ALPHA', 'BETA']))), storedAll);
    // One file's edits are set on their own, as edit's are.
    assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/b.txt', oldString: 'BETA', newString: 'beta' }] })), storedAll);
    assert.equal(errorOf(await call('edit', { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' })),
      'The edit of "work/b.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
      + "The rest of the call failed: No space left on device (os error 28). ls shows the path's state.");
  } finally {
    delete s.treeBatch;
    delete s.treeSet;
  }
  assert.equal(await stored('a.txt'), 'ALPHA\n');
  assert.equal(await stored('b.txt'), 'BETA\n');

  // A set that throws, and then the entries can't be read back either.
  let failed = false;
  s.treeBatch = () => { failed = true; throw new Error('injected batch failure'); };
  s.treeGet = (...args) => {
    if (failed) throw new Error('injected read failure');
    return real.treeGet.apply(store, args as never);
  };
  try {
    assert.equal(errorOf(await call('edit_many', both(['ALPHA', 'BETA'], ['alpha', 'beta']))),
      "The edit_many call can't tell whether it stored its edits: injected batch failure; reading its entries back failed too (injected read failure), "
      + "so whether the change is stored isn't known. Read its files before sending it again: a second call can apply its edits twice.");
  } finally {
    delete s.treeBatch;
    delete s.treeGet;
  }
  assert.equal(await stored('a.txt'), 'ALPHA\n');
});

test('an edit names its path plainly: a path with an empty, "." or ".." segment is refused, naming the plain spelling', async (t) => {
  const { dir, store, workspace, call, stored } = setup(t, { autoMaterialize: true });
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'one\ntwo\n');
  assert.equal((await call('ls', { path: 'work/sub' })).success, true);
  const refusal = (path: string) =>
    `${path} isn't the plain spelling of its path, and the workspace would keep it as an entry apart from work/sub/b.txt, the same file on disk; name it work/sub/b.txt.`;
  for (const path of ['work/sub//b.txt', 'work/./sub/b.txt', 'work/sub/../sub/b.txt', 'work/sub/b.txt/']) {
    assert.equal(errorOf(await call('edit', { path, oldString: 'one', newString: 'ONE' })), refusal(path));
  }
  // Named two ways in one call, one file would be two plans of one text.
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/sub/b.txt', oldString: 'one', newString: 'ONE' },
      { path: 'work/sub//b.txt', oldString: 'two', newString: 'TWO' },
    ],
  })), `The edit_many call stored none of its edits: 1 problem.\n\nedit 2: ${refusal('work/sub//b.txt')}`);
  assert.equal(await stored('sub/b.txt'), 'one\ntwo\n');
  const treeStateId = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;
  assert.deepEqual(store.treeList(treeStateId, null).map((entry) => entry.path), ['sub/b.txt']);
});

test("edits that find more occurrences between them than the file has characters are refused as crowded", async (t) => {
  const { call, stored, file } = setup(t);
  await file('x.txt', `${'x'.repeat(100)}\n`);
  assert.equal(errorOf(await call('edit_many', {
    edits: ['a', 'b', 'c'].map((newString) => ({ path: 'work/x.txt', oldString: 'x', newString, occurrences: 100 })),
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'edits 1–3: they find 300 occurrences between them in work/x.txt, which has 101 characters, so some of their matches overlap; give each its own stretch of text.');
  assert.equal(await stored('x.txt'), `${'x'.repeat(100)}\n`);
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
    })), 'The edit_many call stored none of its edits: injected barrier failure');
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

test("a conflict says what a sync does from what disk holds now, whatever kind was recorded, and the sync does it", async (t) => {
  const { dir, call, disk } = setup(t);
  for (const name of ['gone.txt', 'changed-then-gone.txt', 'gone-then-back.txt', 'turned-binary.txt']) {
    writeFileSync(join(dir, name), 'base\n');
    assert.equal((await call('read', { path: `work/${name}` })).success, true);
    assert.equal((await call('write', { path: `work/${name}`, content: 'agent draft\n' })).success, true);
  }
  // Disk deletes a file the workspace holds a draft of.
  rmSync(join(dir, 'gone.txt'));
  // A listing records each file's conflict as disk then has it, and a
  // recorded conflict keeps its kind: both-changed while disk deletes the
  // file, and deleted-on-disk while disk writes it again.
  writeFileSync(join(dir, 'changed-then-gone.txt'), 'another writer\n');
  rmSync(join(dir, 'gone-then-back.txt'));
  assert.equal((await call('ls', { path: 'work' })).success, true);
  rmSync(join(dir, 'changed-then-gone.txt'));
  writeFileSync(join(dir, 'gone-then-back.txt'), 'another writer\n');
  // A disk copy the workspace can't hold.
  const binary = [0, 1, 2, 0, 255, 0];
  writeFileSync(join(dir, 'turned-binary.txt'), Buffer.from(binary));

  const deletion = "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk.";
  const copy = "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.";
  const one = await call('edit', { path: 'work/gone.txt', oldString: 'agent draft', newString: 'agent edit' });
  assert.equal(one.success, true, one.error);
  assert.equal((one.data as { note?: string }).note,
    `The path is in conflict with disk (deleted-on-disk): the edit is in the workspace's copy. ${deletion}`);
  // A refusal over the same file says the same.
  assert.ok(errorOf(await call('edit', { path: 'work/gone.txt', oldString: 'absent', newString: 'x' })).endsWith(deletion));
  const many = await call('edit_many', {
    edits: [
      { path: 'work/changed-then-gone.txt', oldString: 'agent draft', newString: 'agent edit' },
      { path: 'work/gone-then-back.txt', oldString: 'agent draft', newString: 'agent edit' },
      { path: 'work/turned-binary.txt', oldString: 'agent draft', newString: 'agent edit' },
    ],
  });
  assert.equal(many.success, true, many.error);
  assert.deepEqual((many.data as { files: Array<{ note?: string }> }).files.map((file) => file.note), [
    `work/changed-then-gone.txt is in conflict with disk (both-changed): edit 1 is in the workspace's copy. ${deletion}`,
    `work/gone-then-back.txt is in conflict with disk (deleted-on-disk): edit 2 is in the workspace's copy. ${copy}`,
    `work/turned-binary.txt is in conflict with disk (both-changed): edit 3 is in the workspace's copy. ${copy}`,
  ]);
  // Each sync does what its note says: it takes the deletion, or keeps disk's
  // copy and gives up the workspace's, taking in none it can't hold.
  for (const name of ['gone.txt', 'gone-then-back.txt', 'turned-binary.txt']) {
    assert.equal((await call('sync', { path: `work/${name}` })).success, true, name);
  }
  assert.equal(errorOf(await call('read', { path: 'work/gone.txt' })), 'File not found: work/gone.txt');
  assert.equal(disk('gone-then-back.txt')!.toString(), 'another writer\n');
  assert.match(JSON.stringify((await call('read', { path: 'work/gone-then-back.txt' })).data), /another writer/);
  assert.equal(errorOf(await call('read', { path: 'work/turned-binary.txt' })),
    'work/turned-binary.txt is on disk but not stored in the workspace (binary or over the size limit).');
  assert.deepEqual([...disk('turned-binary.txt')!], binary);
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
    + "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.";

  // A miss in the conflicted file says which copy it looked in.
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/k.txt', oldString: 'another', newString: 'x' }] })),
    "The edit_many call stored none of its edits: 1 problem.\n\nedit 1: oldString isn't in work/k.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + conflict.replace('%s', 'looked in'));

  const receipt = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' },
      { path: 'work/l.txt', oldString: 'legacy', newString: 'edited' },
    ],
  }));
  const both = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/k.txt', oldString: 'agent', newString: 'the agent' },
      { path: 'work/k.txt', oldString: 'edited', newString: 'edited twice' },
    ],
  }));
  assert.equal((both.files as Array<{ note?: string }>)[0]!.note, conflict.replace('edit 1 %s', 'edits 1 and 2 are in'));
  assert.deepEqual((receipt.files as Array<{ note?: string }>).map((file) => file.note), [
    conflict.replace('%s', 'is in'),
    "Disk has no copy of work/l.txt, and nothing records whether it was deleted there, so edit 2 applied to the workspace's copy. "
      + 'A materialize of work/l.txt puts it back on disk; if it was deleted there on purpose, delete it here too.',
  ]);
});

test("edit_many says when a file disk lacks went back with its push, and when a path couldn't be checked", async (t) => {
  const { store, call, disk } = setup(t, { autoMaterialize: true });
  // An entry from before the evidence, so nothing says whether disk deleted it.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  const pushed = dataOf(await call('edit_many', { edits: [{ path: 'work/l.txt', oldString: 'legacy', newString: 'edited' }] }));
  assert.equal((pushed.files as Array<{ note?: string }>)[0]!.note,
    "Disk has no copy of work/l.txt, and nothing records whether it was deleted there, so edit 1 applied to the workspace's copy. "
    + "This call's push put work/l.txt back on disk; if it was deleted there on purpose, delete it here too.");
  assert.equal(disk('l.txt')!.toString(), 'edited line\n');

  // A path disk made a directory can't be checked; on a mount that doesn't push, the edit applies to the workspace's copy.
  const quiet = setup(t);
  await quiet.file('u.txt', 'held\n');
  rmSync(join(quiet.dir, 'u.txt'));
  mkdirSync(join(quiet.dir, 'u.txt'));
  const held = dataOf(await quiet.call('edit_many', { edits: [{ path: 'work/u.txt', oldString: 'held', newString: 'held, edited' }] }));
  assert.equal((held.files as Array<{ note?: string }>)[0]!.note,
    "work/u.txt couldn't be checked against disk (a directory), so edit 1 applied to the workspace's copy.");
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
  const left = Number(/\[To keep this answer within 2,000 characters, it leaves out the details of (\d+) of these\.\]$/.exec(cut)?.[1]);
  assert.ok(left > 0 && left < 12, `${left} left out their details`);
  assert.equal(explained(cut), 12 - left);

  // Room for some first lines only: the rest are counted, and the call is to be sent again for them.
  const dropped = errorOf(await call('edit_many', { edits }, 500));
  assert.ok(dropped.length <= 500, `${dropped.length} characters, within 500`);
  const shown = named(dropped);
  const counts = /\[To keep this answer within 500 characters, it leaves out the details of (\d+) of these and (\d+) more problems?\. Answer the problems shown and send the call again to see the rest\.\]$/.exec(dropped);
  assert.ok(counts, dropped);
  assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => i + 1));
  assert.equal(Number(counts[1]), shown.length);
  assert.equal(shown.length + Number(counts[2]), 12);

  const whole = errorOf(await call('edit_many', { edits }));
  assert.equal(explained(whole), 12, 'the default leaves room for every closest region');

  // Below the least a residence or an agent can set, no problem may fit, and the last line asks nothing of the agent.
  const none = errorOf(await call('edit_many', { edits }, 200));
  assert.equal(named(none).length, 0);
  assert.match(none, /\[To keep this answer within 200 characters, it leaves out 12 more problems\.\]$/);
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
  assert.match(longer.changed as string, /\[To keep this answer within 2,800 characters, it leaves out the changed regions of \d+ more files\.\]$/);
});

test('at the least cap a residence or an agent can set, a refusal still names its problems, however long their labels or paths', async (t) => {
  const { dir, call, file } = setup(t);
  // Three hundred edits of one file that can't be edited are one problem, labelled as a range.
  await file('latin1.txt', Buffer.from('caf\xe9\n', 'latin1'));
  const many = errorOf(await call('edit_many', {
    edits: Array.from({ length: 300 }, (_, i) => ({ path: 'work/latin1.txt', oldString: `caf${i}`, newString: 'tea' })),
  }, 1000));
  assert.ok(many.length <= 1000, `${many.length} characters, within 1,000`);
  assert.match(many, /^The edit_many call stored none of its edits: 1 problem\.\n\nedits 1–300: work\/latin1\.txt isn't valid UTF-8/);
  // Edits that alternate with another file's are named ten at a time, and the rest counted.
  await file('plain.txt', 'plain\n');
  const scattered = errorOf(await call('edit_many', {
    edits: Array.from({ length: 60 }, (_, i) => (i % 2
      ? { path: 'work/plain.txt', oldString: `absent ${i}`, newString: 'x' }
      : { path: 'work/latin1.txt', oldString: `caf${i}`, newString: 'tea' })),
  }, 1000));
  assert.ok(scattered.length <= 1000, `${scattered.length} characters, within 1,000`);
  assert.match(scattered, /\n\nedits 1, 3, 5, 7, 9, 11, 13, 15, 17, 19 and 20 more: work\/latin1\.txt isn't valid UTF-8/);

  // A path so long its problem's first line is cut, beside a second problem
  // that still fits; the first's closest region, a long line, doesn't.
  const deep = `${'d'.repeat(200)}/${'e'.repeat(200)}.txt`;
  mkdirSync(join(dir, 'd'.repeat(200)));
  await file(deep, `${'text '.repeat(400)}\n`);
  const long = errorOf(await call('edit_many', {
    edits: [
      { path: `work/${deep}`, oldString: 'texts', newString: 'x' },
      { path: `work/${deep}`, oldString: 'text', newString: 'text' },
    ],
  }, 1000));
  assert.ok(long.length <= 1000, `${long.length} characters, within 1,000`);
  assert.match(long, /\n\nedit 1: oldString isn't in work\/d+\/e+…\n\nedit 2: oldString and newString are the same/);
});

test('the answer to edits stored, within the cap, lists the files disk refused and never says to send the call again', async (t) => {
  const { dir, call, file } = setup(t, { autoMaterialize: true });
  const edits = [];
  for (let i = 0; i < 12; i++) {
    await file(`h${i}.txt`, `held ${i}\n`);
    linkSync(join(dir, `h${i}.txt`), join(dir, `h${i}-too.txt`));
    edits.push({ path: `work/h${i}.txt`, oldString: `held ${i}`, newString: `HELD ${i}` });
  }
  const answer = errorOf(await call('edit_many', { edits }, 1000));
  assert.ok(answer.length <= 1000, `${answer.length} characters, within 1,000`);
  assert.match(answer, /^Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice\.\n\nDisk took 0 of the call's 12 files\. These files' pushes didn't complete, each with its reason:/);
  assert.match(answer, /\n\nwork\/h0\.txt: not written: a file with other hard links/);
  const listed = [...answer.matchAll(/^work\/h\d+\.txt: /gm)].length;
  const left = Number(/\[To keep this answer within 1,000 characters, it leaves out (\d+) more files? disk refused\. ls shows each path's state\.\]$/.exec(answer)?.[1]);
  assert.equal(listed + left, 12, `${listed} listed and ${left} counted`);
  assert.doesNotMatch(answer, /send the call again to see/);
});

test("the answer to edits stored points to ls once: in its last line only when that leaves out files disk refused", () => {
  const stored = 'Every edit of this call is stored.';
  const notes = ['note one '.repeat(30), 'note two '.repeat(30)];
  const notesLeft = fitted(`${stored}\n\nThe rest of the call failed: boom. ls shows each path's state.`, [], notes, 300, 'stored');
  assert.match(notesLeft, /\[To keep this answer within 300 characters, it leaves out 2 notes on the files' copies on disk\.\]$/);
  assert.equal([...notesLeft.matchAll(/ls shows/g)].length, 1);
  const filesLeft = fitted(stored, ['work/a.txt: not written '.repeat(12), 'work/b.txt: not written '.repeat(12)], notes, 300, 'stored');
  assert.match(filesLeft, /it leaves out 2 more files disk refused and 2 notes on the files' copies on disk\. ls shows each path's state\.\]$/);
});

test("a receipt's notes are bounded, and a file whose notes don't fit is listed without them", async (t) => {
  const { call, file } = setup(t);
  const key = (i: number) => `t${String(i).padStart(2, '0')}`;
  await file('n.txt', Array.from({ length: 30 }, (_, i) => `${key(i)} ${key(i)}`).join('\n'));
  const edits = Array.from({ length: 30 }, (_, i) => ({ path: 'work/n.txt', oldString: key(i), newString: key(i).toUpperCase(), occurrences: 2 }));
  const whole = dataOf(await call('edit_many', { edits }));
  const notes = ((whole.files as Array<{ note: string }>)[0]!.note).split(/(?<=\.) /);
  assert.equal(notes.length, 21, 'twenty edits named, and a count of the rest');
  assert.equal(notes[0], "Edit 1's other replacements are on line 1.");
  assert.equal(notes[20], '10 more edits made other replacements too.');

  const short = dataOf(await call('edit_many', { edits: edits.map((edit) => ({ ...edit, oldString: edit.newString, newString: edit.oldString })) }, 1300));
  assert.ok(JSON.stringify(short).length <= 1300, `${JSON.stringify(short).length} characters`);
  assert.deepEqual(short.files, [{ path: 'work/n.txt', size: 239, replacements: 60, edits: Array.from({ length: 30 }, (_, i) => i + 1) }]);
  assert.match(short.changed as string, /the notes of 1 file\.\]$/);

  // A file of 300 edits is named, without its edits' numbers, rather than left out.
  const words = Array.from({ length: 300 }, (_, i) => `w${String(i).padStart(3, '0')}`);
  await file('w.txt', `${words.join(' ')}\n`);
  const many = dataOf(await call('edit_many', { edits: words.map((word) => ({ path: 'work/w.txt', oldString: word, newString: word.toUpperCase() })) }, 1000));
  assert.ok(JSON.stringify(many).length <= 1000, `${JSON.stringify(many).length} characters`);
  assert.deepEqual(many.files, [{ path: 'work/w.txt', size: 1500, replacements: 300 }]);
  assert.match(many.changed as string, /the edit numbers of 1 file\.\]$/);
});
