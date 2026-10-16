/**
 * glob and grep's glob filter take a mount-prefixed pattern, like every other
 * workspace path. Before, the pattern was matched only against paths relative
 * to the search root while results came back mount-prefixed, so
 * `notes/diary/2026-10-13.md` answered "no matches" for a file that was there.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';

/** Two mounts; `project` has a subdirectory named like the other mount. Files
 *  are written straight to disk, as another process would. */
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-glob-prefix-'));
  const dirs = { notes: join(root, 'notes'), project: join(root, 'project') };
  const files: Record<string, string> = {
    'notes/README.md': 'notes readme',
    'notes/diary/2026-10-12.md': 'entry twelve',
    'notes/diary/2026-10-13.md': 'entry thirteen',
    'project/README.md': 'project readme',
    'project/docs/guide.md': 'guide entry',
    'project/notes/todo.md': 'todo entry',
    'project/src/main.ts': 'export const entry = 1;',
  };
  for (const [path, content] of Object.entries(files)) {
    const [mount, ...rest] = path.split('/');
    const full = join(dirs[mount as keyof typeof dirs], ...rest);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [
      { name: 'notes', path: dirs.notes, mode: 'read-write', watch: 'never' },
      { name: 'project', path: dirs.project, mode: 'read-write', watch: 'never' },
    ],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const glob = async (input: Record<string, unknown>) => {
    const r = await workspace.handleToolCall({ id: 'g', name: 'glob', input });
    assert.equal(r.success, true, JSON.stringify(r));
    return ((r.data as { matches: Array<{ path: string }> }).matches).map((m) => m.path).sort();
  };
  const grepFiles = async (input: Record<string, unknown>) => {
    const r = await workspace.handleToolCall({ id: 'r', name: 'grep', input });
    assert.equal(r.success, true, JSON.stringify(r));
    return ((r.data as { results: Array<{ file: string }> }).results).map((x) => x.file).sort();
  };
  return { glob, grepFiles };
}

test('a mount-prefixed pattern naming one file finds it', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: 'notes/diary/2026-10-13.md' }), ['notes/diary/2026-10-13.md']);
});

test('a mount-prefixed wildcard matches within that mount only', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: 'notes/diary/*.md' }), ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ pattern: 'project/**/*.md' }), ['project/docs/guide.md', 'project/notes/todo.md']);
  assert.deepEqual(await glob({ pattern: 'project/*.md' }), ['project/README.md']);
});

test('relative patterns match as before, in every mount', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: '**/*.md' }), [
    'notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md', 'project/docs/guide.md', 'project/notes/todo.md',
  ]);
  assert.deepEqual(await glob({ pattern: '*.md' }), ['notes/README.md', 'project/README.md']);
  // A pattern whose first segment is a mount's name keeps its relative
  // reading too: project/notes/ still matches, beside the notes mount's root.
  assert.deepEqual(await glob({ pattern: 'notes/*.md' }), ['notes/README.md', 'project/notes/todo.md']);
});

test('with a path, the pattern may be relative to it or mount-prefixed', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: '*-13.md' }), ['notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/diary/*-13.md' }), ['notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'project/**' }), []);
});

test("grep's glob filter takes a mount-prefixed pattern", async (t) => {
  const { grepFiles } = setup(t);
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: 'notes/diary/*.md' }), ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md']);
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: 'project/src/*.ts' }), ['project/src/main.ts']);
  // Relative filters are unchanged.
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: '**/*.md' }), [
    'notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md', 'project/docs/guide.md', 'project/notes/todo.md',
  ]);
});
