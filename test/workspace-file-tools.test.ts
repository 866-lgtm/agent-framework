// The workspace's file tools write exactly what they're given or refuse,
// say when a change is stored but not on disk, number a file's lines as it
// has them, and edit the text disk holds now.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { ToolResult } from '../src/types/events.js';

function setup(t: TestContext, opts: { autoMaterialize?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-file-tools-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never', autoMaterialize: opts.autoMaterialize ?? false }],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name: string, input: unknown): Promise<ToolResult> =>
    workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const disk = (rel: string): Buffer | null => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null);
  const stored = async (rel: string): Promise<string> => {
    const result = await call('read', { path: `work/${rel}`, offsetChars: 0, limitChars: 100_000 });
    assert.equal(result.success, true, result.error);
    return (result.data as { content: string }).content;
  };
  return { workspace, dir, call, disk, stored };
}

const errorOf = (result: ToolResult): string => {
  assert.equal(result.success, false, 'the call was refused');
  assert.equal(result.isError, true);
  return result.error ?? '';
};

// ---------------------------------------------------------------------------
// Part 1: exactly what was given, or a refusal
// ---------------------------------------------------------------------------

test('an edit writes its replacement as given, $ patterns and all', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'price.txt'), 'price: 10\n');
  const one = await call('edit', { path: 'work/price.txt', oldString: '10', newString: "$$5, $&, $', $`, $1" });
  assert.equal(one.success, true, one.error);
  assert.equal(disk('price.txt')!.toString(), "price: $$5, $&, $', $`, $1\n");

  writeFileSync(join(dir, 'pair.txt'), 'a-a\n');
  const all = await call('edit', { path: 'work/pair.txt', oldString: 'a', newString: '$&$&', replaceAll: true });
  assert.equal(all.success, true, all.error);
  assert.equal(disk('pair.txt')!.toString(), '$&$&-$&$&\n');
});

test("an edit of a file that isn't valid UTF-8 is refused and changes nothing, and a write still replaces it", async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  const latin1 = Buffer.from('caf\xe9 au lait\n', 'latin1');
  writeFileSync(join(dir, 'latin1.txt'), latin1);
  const refused = errorOf(await call('edit', { path: 'work/latin1.txt', oldString: 'au', newString: 'with' }));
  assert.match(refused, /^The edit did nothing: work\/latin1\.txt isn't valid UTF-8, so editing it would change bytes outside the text it replaces\./);
  assert.deepEqual(disk('latin1.txt'), latin1, 'disk keeps every byte');

  const written = await call('write', { path: 'work/latin1.txt', content: 'café with milk\n' });
  assert.equal(written.success, true, written.error);
  assert.equal(disk('latin1.txt')!.toString('utf8'), 'café with milk\n');
});

test('a lone surrogate is refused in a write and in either of an edit\'s strings, and nothing changes', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  assert.match(errorOf(await call('write', { path: 'work/s.txt', content: 'a\ud800b' })),
    /^The write did nothing: "content" holds a lone UTF-16 surrogate/);
  assert.equal(disk('s.txt'), null);

  writeFileSync(join(dir, 'e.txt'), 'pair \ud83d\ude00 here\n');
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: 'here', newString: 'x\udc00' })),
    /^The edit did nothing: "newString" holds a lone UTF-16 surrogate/);
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '\ud83d', newString: 'x' })),
    /^The edit did nothing: "oldString" holds a lone UTF-16 surrogate/);
  assert.equal(disk('e.txt')!.toString(), 'pair \ud83d\ude00 here\n');
  // A pair is one character, not a lone half.
  const paired = await call('edit', { path: 'work/e.txt', oldString: 'here', newString: '\ud83c\udf89' });
  assert.equal(paired.success, true, paired.error);
});

test('an empty oldString is refused, with replaceAll or without', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'e.txt'), 'abc\n');
  for (const replaceAll of [false, true]) {
    assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '', newString: 'X', replaceAll })),
      /^The edit did nothing: "oldString" is empty/);
  }
  assert.equal(disk('e.txt')!.toString(), 'abc\n');
});

test("a call whose input doesn't fit its tool's schema does nothing", async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'u.txt'), 'keep a\n');
  const cases: Array<[string, unknown, RegExp]> = [
    ['edit', { path: 'work/u.txt', oldString: 'a' }, /^The edit call did nothing: "newString" is required\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: 5 }, /"newString" must be a string, not 5\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: null }, /"newString" must be a string, not null\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: 'b', replaceAll: 'false' }, /"replaceAll" must be true or false, not a string\.$/],
    ['write', { path: 'work/u.txt', content: ['x'] }, /^The write call did nothing: "content" must be a string, not an array\.$/],
    ['write', { path: 3, content: 'x' }, /"path" must be a string, not 3\.$/],
    ['read', { path: 'work/u.txt', offset: '1' }, /"offset" must be a whole number of at least 1, not a string\.$/],
    ['grep', { pattern: 'a', contextBefore: -1 }, /"contextBefore" must be a whole number of at least 0, not -1\.$/],
    ['delete', null, /^The delete call did nothing: its input must be an object/],
  ];
  for (const [name, input, expected] of cases) {
    assert.match(errorOf(await call(name, input)), expected, `${name} ${JSON.stringify(input)}`);
  }
  assert.equal(disk('u.txt')!.toString(), 'keep a\n');
});

test('a write, edit or delete that is stored but refused by disk says so, with inChronicle', async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });

  // A write over a disk change the workspace hasn't seen.
  writeFileSync(join(dir, 'w.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/w.txt' })).success, true);
  writeFileSync(join(dir, 'w.txt'), 'v2 from another writer\n');
  const write = await call('write', { path: 'work/w.txt', content: 'v3 agent\n' });
  assert.match(errorOf(write), /^The write of "work\/w\.txt" is stored in the workspace, so don't send it again\. Its push to disk was refused: stale copy: .*Until materialize puts it there, disk doesn't have it\.$/);
  assert.deepEqual(write.data, { inChronicle: true, path: 'work/w.txt' });
  assert.equal(await stored('w.txt'), 'v3 agent\n');
  assert.equal(disk('w.txt')!.toString(), 'v2 from another writer\n');

  // An edit of a file with another name: the push writes in place, which
  // would change the other name's file too.
  writeFileSync(join(dir, 'h.txt'), 'shared\n');
  linkSync(join(dir, 'h.txt'), join(dir, 'h2.txt'));
  const edit = await call('edit', { path: 'work/h.txt', oldString: 'shared', newString: 'shared, edited' });
  assert.match(errorOf(edit), /^The edit of "work\/h\.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice\. Its push to disk was refused: not written: a file with other hard links/);
  assert.deepEqual(edit.data, { inChronicle: true, path: 'work/h.txt' });
  assert.equal(await stored('h.txt'), 'shared, edited\n');
  assert.equal(disk('h2.txt')!.toString(), 'shared\n');
  // Why the answer says not to send it again: the edit's text is still there
  // to match, so a second one applies the change twice.
  await call('edit', { path: 'work/h.txt', oldString: 'shared', newString: 'shared, edited' });
  assert.equal(await stored('h.txt'), 'shared, edited, edited\n');

  // A deletion whose disk copy changed since the workspace read it.
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  writeFileSync(join(dir, 'd.txt'), 'changed on disk\n');
  const del = await call('delete', { path: 'work/d.txt' });
  assert.match(errorOf(del), /^The deletion of "work\/d\.txt" is stored in the workspace, so don't send it again\. Its push to disk was refused: .*Until materialize with applyDeletions removes it, disk keeps its copy \(ls shows its state\)\.$/);
  assert.deepEqual(del.data, { inChronicle: true, path: 'work/d.txt' });
  assert.equal(disk('d.txt')!.toString(), 'changed on disk\n');
});

test('a write, edit or delete that throws after its tree entry is set says the change is stored', async (t) => {
  const { workspace, dir, call, stored } = setup(t);
  const ws = workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> };
  const intents = ws.intents.get('work')!;
  const update = intents.update;
  writeFileSync(join(dir, 'e.txt'), 'line\n');
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    const write = await call('write', { path: 'work/w.txt', content: 'new\n' });
    assert.equal(errorOf(write), 'The write of "work/w.txt" is stored in the workspace, so don\'t send it again. The rest of the call failed: injected intent exception.');
    assert.deepEqual(write.data, { inChronicle: true, path: 'work/w.txt' });
    const edit = await call('edit', { path: 'work/e.txt', oldString: 'line', newString: 'line, edited' });
    assert.match(errorOf(edit), /^The edit of "work\/e\.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice\. The rest of the call failed: injected intent exception\.$/);
    assert.deepEqual(edit.data, { inChronicle: true, path: 'work/e.txt' });
    const del = await call('delete', { path: 'work/d.txt' });
    assert.match(errorOf(del), /^The deletion of "work\/d\.txt" is stored in the workspace, so don't send it again\. The rest of the call failed: injected intent exception\.$/);
    assert.deepEqual(del.data, { inChronicle: true, path: 'work/d.txt' });
  } finally {
    intents.update = update;
  }
  assert.equal(await stored('w.txt'), 'new\n');
  assert.equal(await stored('e.txt'), 'line, edited\n');
});

// ---------------------------------------------------------------------------
// Part 2: a read numbers the lines the file has
// ---------------------------------------------------------------------------

test('a final line end ends the last line, and an empty file reads as empty', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  assert.deepEqual((await call('read', { path: 'work/nl.txt' })).data, {
    path: 'work/nl.txt', totalLines: 2, fromLine: 1, toLine: 2, content: '     1\ta\n     2\tb',
  });
  writeFileSync(join(dir, 'blank.txt'), 'a\n\n');
  assert.equal(((await call('read', { path: 'work/blank.txt' })).data as { totalLines: number }).totalLines, 2,
    'an empty line before the final line end is a line');
  writeFileSync(join(dir, 'empty.txt'), '');
  assert.deepEqual((await call('read', { path: 'work/empty.txt' })).data, { path: 'work/empty.txt', totalLines: 0, content: '' });
});

test('grep numbers lines as read does: no match on an empty line after the last', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'g.txt'), 'x\n');
  const result = await call('grep', { pattern: '^$' });
  assert.equal(result.success, true, result.error);
  assert.deepEqual((result.data as { results: unknown[] }).results, []);
});

test('an offset or limit that is not a whole number of at least 1 is refused', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  for (const input of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: null }, { limit: 0 }, { limit: 2.5 }]) {
    assert.match(errorOf(await call('read', { path: 'work/nl.txt', ...input })),
      /^The read call did nothing: "(offset|limit)" must be a whole number of at least 1, not /, JSON.stringify(input));
  }
});

test('an offset past the last line answers empty, with the line count and no range', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  for (const offset of [3, 10]) {
    assert.deepEqual((await call('read', { path: 'work/nl.txt', offset })).data, {
      path: 'work/nl.txt', totalLines: 2, note: `Line ${offset} is past the end: the file has 2 lines.`, content: '',
    });
  }
});

// ---------------------------------------------------------------------------
// Part 2: an edit applies to the text disk holds now
// ---------------------------------------------------------------------------

test("an edit applies to disk's text when disk changed and the store didn't, and says so", async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 's.txt'), 'v1 line\n');
  assert.equal((await call('read', { path: 'work/s.txt' })).success, true);
  writeFileSync(join(dir, 's.txt'), 'v2 line from another writer\n');

  const edit = await call('edit', { path: 'work/s.txt', oldString: 'line', newString: 'LINE' });
  assert.equal(edit.success, true, edit.error);
  assert.match((edit.data as { note: string }).note, /^Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit applied to that text\.$/);
  assert.equal(disk('s.txt')!.toString(), 'v2 LINE from another writer\n');
  assert.equal(await stored('s.txt'), 'v2 LINE from another writer\n');

  // Text only the older copy held isn't there to replace, and the refusal says why.
  writeFileSync(join(dir, 's.txt'), 'v3 from another writer\n');
  assert.match(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'LINE', newString: 'x' })),
    /^String not found in work\/s\.txt\. Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit looked in that text\.$/);
});

test('an edit of a draft whose disk copy also changed applies to the draft and names the conflict', async (t) => {
  const { dir, call, disk, stored } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');

  const edit = await call('edit', { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' });
  assert.equal(edit.success, true, edit.error);
  assert.equal((edit.data as { note: string }).note,
    "The path is in conflict with disk (both-changed): the edit is in the workspace's copy. Sync the path to take disk's copy instead, or materialize it with force to write the workspace's over disk's.");
  assert.equal(await stored('k.txt'), 'agent draft, edited\n');
  assert.equal(disk('k.txt')!.toString(), 'another writer\n');
});

// ---------------------------------------------------------------------------
// Part 5: smaller texts
// ---------------------------------------------------------------------------

test("grep's refusal of an invalid pattern gives the parser's reason", async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'g.txt'), 'x\n');
  assert.match(errorOf(await call('grep', { pattern: '(' })), /^The grep did nothing: Invalid regular expression: \/\(\/: Unterminated group\.$/);
});

test('a refusal raised inside a tool reads without an "Error: " prefix', async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('read', { path: 'zzz/a.txt' })), 'Unknown mount: "zzz". Available: work');
});

test("a push that disk's shape refuses names what's in the way and the way out", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  mkdirSync(join(dir, 'sub'));
  assert.match(errorOf(await call('write', { path: 'work/sub', content: 'x\n' })),
    /Its push to disk was refused: disk has a directory at this path, and no push writes a file over one, forced or not — move or remove that directory on disk and materialize again, or write the file under another path\./);
  const forced = await call('materialize', { path: 'work/sub', force: true });
  assert.match(JSON.stringify(forced.data), /not written: disk has a directory at this path, and no push writes a file over one, forced or not/);

  writeFileSync(join(dir, 'f.txt'), 'file\n');
  assert.match(errorOf(await call('write', { path: 'work/f.txt/x.txt', content: 'x\n' })),
    /Its push to disk was refused: not written: disk has a file where this path needs a directory, and no push writes below one, forced or not — move or remove that file on disk and materialize again, or write the file under another path\./);
});

test('a deletion whose path disk has made a directory is not told to write the file elsewhere', async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'gone.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/gone.txt' })).success, true);
  rmSync(join(dir, 'gone.txt'));
  mkdirSync(join(dir, 'gone.txt'));
  const refused = errorOf(await call('delete', { path: 'work/gone.txt' }));
  assert.match(refused, /^The deletion of "work\/gone\.txt" is stored in the workspace/);
  assert.doesNotMatch(refused, /write the file under another path/, 'nothing is being written');
});
