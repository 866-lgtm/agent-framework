/**
 * `npm test` loads test/helpers/force-exit-blocking-stdout into each test
 * file's process, so --test-force-exit can't drop the results still queued
 * on the pipe to the runner (agent-framework #294). These tests write more
 * than a pipe holds and exit at once, as a forced exit does, and count what
 * reached the other end.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const helper = new URL('./helpers/force-exit-blocking-stdout.js', import.meta.url).href;
const BYTES = 10_000_000;

/**
 * Bytes that reach a pipe from a process that writes BYTES to stdout and
 * exits at once, run with `env` added to this process's own, less its
 * NODE_TEST_CONTEXT.
 */
function deliveredBy(env: Record<string, string>, imports: string[]): number {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [...imports, '-e', `process.stdout.write('x'.repeat(${BYTES})); process.exit();`], {
    env: { ...base, ...env },
    maxBuffer: 2 * BYTES,
  });
  assert.equal(run.status, 0, String(run.stderr));
  return run.stdout.length;
}

test("a test file's process exits with everything it wrote to the runner delivered", () => {
  assert.equal(deliveredBy({ NODE_TEST_CONTEXT: 'child-v8' }, ['--import', helper]), BYTES);
});

test('the helper leaves a process that isn\'t a test file\'s alone', { skip: process.platform === 'win32' ? "Windows pipes don't drop a write at exit" : false }, () => {
  // Without the helper, or outside a test file's process, the exit drops
  // what the pipe hasn't taken: the loss the helper is there to prevent.
  assert.ok(deliveredBy({ NODE_TEST_CONTEXT: 'child-v8' }, []) < BYTES, 'without the helper, the exit drops the rest');
  assert.ok(deliveredBy({}, ['--import', helper]) < BYTES, 'the runner itself, or a plain process, keeps its own stdout');
});

test('npm test loads the helper into the runner, which passes it to each test file\'s process', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: { test: string } };
  assert.match(pkg.scripts.test, /^node --import \.\/dist\/test\/helpers\/force-exit-blocking-stdout\.js --test --test-force-exit /);
});
