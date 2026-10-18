// On a disk that folds names (macOS's default folds case, and Unicode
// normalization), a path spelled otherwise than disk spells it reaches disk's
// file. The workspace's tools take such a path as disk spells it, so they
// name each file by one name and take nothing in twice. Most of these tests
// need a temp directory that folds case, and skip, saying why, where it
// doesn't, since a disk that tells spellings apart has nothing to respell;
// one needs it to fold normalization, and one to fold ß with ss. Two run only
// where the disk tells case apart, and the two about stopping run anywhere.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { diskSpelling } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';

/** What the temp directory folds: case, NFC against NFD, and ß with ss. */
const folds = ((): { case: boolean; normalization: boolean; sharpS: boolean } => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-folds-'));
  try {
    writeFileSync(join(dir, 'Fold'), '');
    writeFileSync(join(dir, 'caf\u00e9'), '');
    writeFileSync(join(dir, 'stra\u00dfe'), '');
    return {
      case: existsSync(join(dir, 'FOLD')),
      normalization: existsSync(join(dir, 'cafe\u0301')),
      sharpS: existsSync(join(dir, 'STRASSE')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FOLDING_ONLY = folds.case ? false
  : "the temp directory tells case apart, so a path spelled in another case reaches nothing: these run on a disk that folds case, such as macOS's default";
const NORMALIZATION_FOLDING_ONLY = folds.normalization ? false
  : 'the temp directory tells NFC and NFD apart, so a name in the other form reaches nothing';
const SHARP_S_FOLDING_ONLY = folds.sharpS ? false
  : 'the temp directory keeps \u00df apart from ss, so STRASSE reaches nothing where disk has stra\u00dfe';
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

test('a nested mount whose directory is configured as disk spells it is that mount\'s in another spelling too',
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

test('a nested mount whose directory is configured in another spelling than disk\'s is that mount\'s in either',
  { skip: FOLDING_ONLY }, async (t) => {
    const { workspace, dir, call, pushed } = await setup(t, (d) => {
      mkdirSync(join(d, 'inner'), { recursive: true });
      writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
        { name: 'inner', path: join(d, 'Inner'), mode: 'read-write', watch: 'never' },
      ];
    });
    const refusal = '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".';
    for (const path of ['outer/Inner/x.txt', 'outer/inner/x.txt']) {
      const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
      assert.equal(read.error, refusal, path);
      assert.equal(workspace.resolveAbsolutePath(path), null, path);
    }
    const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/Inner/y.txt', content: 'y\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(write.error, '"outer/inner/y.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/y.txt".');
    assert.equal(existsSync(join(dir, 'inner', 'y.txt')), false);
    const synced = await call('sync', { path: 'outer/Inner' });
    assert.equal((synced.data as { totalSynced: number }).totalSynced, 0);
    const listed = await call('ls', { path: 'outer', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), ['created outer/src/a.ts'], 'the outer mount takes nothing of the inner one\'s in');
  });

test('a sync and a materialize of a path spelled in another case act on disk\'s file, under its own name',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call, pushed } = await setup(t, (d) => [{ name: 'work', path: d, mode: 'read-write', watch: 'never' }]);
    await call('ls', { path: 'work', recursive: true });
    pushed();
    writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
    await call('sync', { path: 'work/SRC/B.TS' });
    assert.deepEqual(pushed(), ['created work/src/b.ts']);
    await call('write', { path: 'work/src/a.ts', content: 'export const a = 2;\n' });
    assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n', 'not on disk until materialized');
    await call('materialize', { path: 'work/SRC/A.TS' });
    assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
    const listed = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts', 'src/b.ts']);
    const announced = pushed();
    assert.deepEqual(announced, [...new Set(announced)], 'nothing announced twice');
    assert.ok(announced.every((e) => e === 'modified work/src/a.ts'), announced.join('; '));
  });

test('read_image of a path spelled in another case names the file as disk does', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // A 1x1 PNG.
  writeFileSync(join(dir, 'src', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const image = await call('read_image', { path: 'work/SRC/DOT.PNG' });
  const text = (image.data as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
  assert.match(text, /^Path: work\/src\/dot\.png\n/);
});

test('a name with ß, spelled in another case, takes disk\'s spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // ß's upper case is two letters, SS, which a disk whose folding is simple doesn't fold to ß.
  writeFileSync(join(dir, 'src', 'stra\u00dfe.txt'), 'sharp s\n');
  const read = await call('read', { path: 'work/src/Stra\u00dfe.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('where disk folds ß with ss, a name spelled with ss takes disk\'s ß', { skip: SHARP_S_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  writeFileSync(join(dir, 'src', 'stra\u00dfe.txt'), 'sharp s\n');
  const read = await call('read', { path: 'work/src/STRASSE.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('a name with dotless ı, spelled in another case, takes disk\'s spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // ı's upper case, I, lowers to i, which no folding disk folds with ı.
  writeFileSync(join(dir, 'src', 'k\u0131r.txt'), 'dotless i\n');
  const read = await call('read', { path: 'work/src/K\u0131r.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/k\u0131r.txt');
});

test('the public readers and writer take a path as disk spells it too', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir, call } = await setup(t);
  await call('ls', { path: 'work', recursive: true });
  assert.deepEqual(await workspace.readBinary('work/SRC/A.TS'), { data: Buffer.from('export const a = 1;\n') });
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

test('the step reads no further than a symlink or a `..` at the root, goes back up at any other `..`, and passes over `.` and empty segments', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real', 'sub'), { recursive: true });
  symlinkSync('real', join(root, 'lnk'));
  assert.equal(await diskSpelling(root, 'REAL/SUB'), 'real/sub');
  assert.equal(await diskSpelling(root, 'LNK/SUB'), 'lnk/SUB');
  assert.equal(await diskSpelling(root, 'REAL/../REAL'), 'real/../real');
  assert.equal(await diskSpelling(root, 'REAL/SUB/../SUB'), 'real/sub/../sub');
  assert.equal(await diskSpelling(root, `../${basename(root)}/REAL`), `../${basename(root)}/REAL`, 'a `..` at the root lists nothing above it');
  assert.equal(await diskSpelling(root, 'REAL/./SUB'), 'real/./sub');
  assert.equal(await diskSpelling(root, 'REAL//SUB'), 'real//sub');
});

test('on a disk that tells case apart, a directory spelled otherwise than a nested mount\'s is the outer mount\'s own',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const { workspace, call } = await setup(t, (d) => {
      mkdirSync(join(d, 'inner'), { recursive: true });
      mkdirSync(join(d, 'Inner'), { recursive: true });
      writeFileSync(join(d, 'Inner', 'x.txt'), 'outer\n');
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
        { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
      ];
    });
    const read = await call('read', { path: 'outer/Inner/x.txt', offsetChars: 0, limitChars: 100 });
    assert.equal((read.data as { content: string }).content, 'outer\n');
    assert.notEqual(workspace.resolveAbsolutePath('outer/Inner/x.txt'), null);
    const listed = await call('ls', { path: 'outer', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['Inner/x.txt', 'src/a.ts']);
  });

test('a stop made while start reads a nested mount\'s directory leaves the workspace stopped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-stop-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(dir, 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const started = workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  await workspace.stop();
  await started;
  const listed = await workspace.handleToolCall({ id: 'l', name: 'ls', input: { path: 'outer' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(listed.success, false);
  assert.match(String(listed.error), /The workspace has stopped/);
});

test('a write still reading disk for its path when stop begins finishes before stop does', async (t) => {
  const { workspace, dir } = await setup(t);
  const write = workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/src/late.ts', content: 'late\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  await workspace.stop();
  assert.equal(readFileSync(join(dir, 'src', 'late.ts'), 'utf8'), 'late\n', 'on disk when stop returns');
  assert.equal((await write).success, true);
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
