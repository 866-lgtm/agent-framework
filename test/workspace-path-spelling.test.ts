// On a disk that folds names (macOS's default folds case, and Unicode
// normalization), a path spelled otherwise than disk spells it reaches disk's
// file. The workspace's tools take such a path as disk spells it, so they
// name each file by one name and take nothing in twice. The tests of that run
// where the temp directory folds names, and skip, saying why, where it
// doesn't; the step's own rules are tested on any disk.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { diskSpelling } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';

/** What the temp directory folds: case, and NFC against NFD. */
const folds = ((): { case: boolean; normalization: boolean } => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-folds-'));
  try {
    writeFileSync(join(dir, 'Fold'), '');
    writeFileSync(join(dir, 'caf\u00e9'), '');
    return { case: existsSync(join(dir, 'FOLD')), normalization: existsSync(join(dir, 'cafe\u0301')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FOLDING_ONLY = folds.case ? false
  : "the temp directory tells case apart, so a path spelled in another case reaches nothing: these run on a disk that folds case, such as macOS's default";
const NORMALIZATION_FOLDING_ONLY = folds.normalization ? false
  : 'the temp directory tells NFC and NFD apart, so a name in the other form reaches nothing';
const CASE_SENSITIVE_ONLY = folds.case
  ? 'the temp directory folds case, so two names that differ only in case are one name here' : false;

async function setup(t: TestContext, mounts: (dir: string) => MountConfig[] = (dir) => [
  { name: 'work', path: dir, mode: 'read-write', watch: 'never', autoMaterialize: true },
]) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: mounts(dir) });
  workspace.initStore(store);
  const events: ProcessEvent[] = [];
  await workspace.start({
    isRestart: false, getState: () => null, setState: () => {}, pushEvent: (e: ProcessEvent) => events.push(e),
  } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, input: unknown): Promise<ToolResult> => {
    const result = await workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(result.success, true, `${name}: ${result.error}`);
    return result;
  };
  /** The created, modified and deleted events pushed since the last call, as `op path`. */
  const pushed = (): string[] => events.splice(0)
    .filter((e) => /^workspace:(created|modified|deleted)$/.test(e.type))
    .flatMap((e) => (e as unknown as { paths: string[] }).paths.map((p) => `${e.type.slice('workspace:'.length)} ${p}`));
  return { workspace, dir, call, pushed };
}

test('a search whose path is spelled in another case names what it finds as disk does, and takes nothing in twice',
  { skip: FOLDING_ONLY }, async (t) => {
    const { call, pushed } = await setup(t);
    await call('ls', { path: 'work', recursive: true });
    assert.deepEqual(pushed(), ['created work/src/a.ts']);

    const glob = await call('glob', { pattern: '*.ts', path: 'work/SRC' });
    assert.deepEqual((glob.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path), ['work/src/a.ts']);
    const grep = await call('grep', { pattern: 'const', path: 'work/Src' });
    assert.deepEqual((grep.data as { results: Array<{ file: string }> }).results.map((r) => r.file), ['work/src/a.ts']);
    const ls = await call('ls', { path: 'work/SRC' });
    assert.equal((ls.data as { path: string }).path, 'work/src');
    assert.deepEqual(pushed(), [], 'nothing was taken in under the spelling given');

    const all = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((all.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), [], 'and nothing was deleted when the whole mount was listed');
  });

test('a read, write, edit and delete spelled in another case act on disk\'s file, under its own name',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call, pushed } = await setup(t);
    await call('ls', { path: 'work', recursive: true });
    pushed();

    const read = await call('read', { path: 'work/SRC/A.TS', offsetChars: 0, limitChars: 100 });
    assert.deepEqual(read.data, {
      path: 'work/src/a.ts', totalChars: 20, offsetChars: 0, nextOffsetChars: null, content: 'export const a = 1;\n',
    });
    const write = await call('write', { path: 'work/SRC/b.ts', content: 'export const b = 2;\n' });
    assert.equal((write.data as { path: string }).path, 'work/src/b.ts');
    const edit = await call('edit', { path: 'work/Src/B.ts', oldString: '2', newString: '3' });
    assert.equal((edit.data as { path: string }).path, 'work/src/b.ts');
    assert.equal(readFileSync(join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = 3;\n');

    const listed = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(pushed(), [], 'the write is held under the name disk lists, so listing the mount moves nothing');

    const deleted = await call('delete', { path: 'work/SRC/B.TS' });
    assert.deepEqual(deleted.data, { path: 'work/src/b.ts', deleted: true });
    assert.equal(existsSync(join(dir, 'src', 'b.ts')), false);
    const after = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((after.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), []);
  });

test('beneath a directory disk has, a name disk doesn\'t have keeps the spelling given',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call } = await setup(t);
    const write = await call('write', { path: 'work/SRC/New/x.ts', content: 'x\n' });
    assert.equal((write.data as { path: string }).path, 'work/src/New/x.ts');
    assert.equal(readFileSync(join(dir, 'src', 'New', 'x.ts'), 'utf8'), 'x\n');
  });

test('a path into a nested mount\'s directory, spelled in another case, is refused as that mount\'s',
  { skip: FOLDING_ONLY }, async (t) => {
    const { workspace, dir } = await setup(t, (d) => [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
    ]);
    mkdirSync(join(dir, 'inner'), { recursive: true });
    writeFileSync(join(dir, 'inner', 'x.txt'), 'inner\n');
    const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/INNER/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(read.success, false);
    assert.equal(read.error, '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
    await assert.rejects(workspace.readFileFromDisk('outer/INNER/x.txt'),
      (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
    assert.deepEqual(await workspace.readBinary('outer/INNER/x.txt'), { error: read.error });
  });

test('the public readers and writer take a path as disk spells it too', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t);
  const fromDisk = await workspace.readBinaryFromDisk('work/SRC/a.ts');
  assert.ok('absolutePath' in fromDisk, JSON.stringify(fromDisk));
  assert.equal(fromDisk.absolutePath, join(dir, 'src', 'a.ts'));
  const written = await workspace.writeBinary('work/SRC/c.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
  assert.equal(written.success, true, written.error);
  assert.equal((written.data as { path: string }).path, 'work/src/c.bin');
});

test('a name in the other Unicode normalization form takes the form disk lists', { skip: NORMALIZATION_FOLDING_ONLY }, async (t) => {
  const { dir, call, pushed } = await setup(t);
  // が has no case, so only its normalization forms tell this name apart: NFD on disk, NFC in the path.
  mkdirSync(join(dir, '\u304b\u3099'));
  writeFileSync(join(dir, '\u304b\u3099', 'a.txt'), 'nfd\n');
  await call('ls', { path: 'work', recursive: true });
  pushed();
  const read = await call('read', { path: 'work/\u304c/a.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/\u304b\u3099/a.txt');
  await call('ls', { path: 'work', recursive: true });
  assert.deepEqual(pushed(), []);
});

test('the step reads no further than a symlink or a `..`, and keeps the rest as spelled', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real', 'sub'), { recursive: true });
  symlinkSync('real', join(root, 'lnk'));
  assert.equal(await diskSpelling(root, 'REAL/SUB'), 'real/sub');
  assert.equal(await diskSpelling(root, 'LNK/SUB'), 'lnk/SUB');
  assert.equal(await diskSpelling(root, 'REAL/../REAL'), 'real/../REAL');
});

test('on a disk that tells case apart, two hard links that differ only in case keep their own names',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-links-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // Each name's case flipped is the other, the same file, so the step lists
    // the directory for either, and each name, listed as given, keeps it.
    writeFileSync(join(root, 'a.txt'), 'one file\n');
    linkSync(join(root, 'a.txt'), join(root, 'A.TXT'));
    assert.equal(await diskSpelling(root, 'A.TXT'), 'A.TXT');
    assert.equal(await diskSpelling(root, 'a.txt'), 'a.txt');
    assert.equal(await diskSpelling(root, 'SRC/a.ts'), 'SRC/a.ts', 'a name disk lacks keeps its spelling');
  });
