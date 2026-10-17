/**
 * The code-execution child runs MODEL-AUTHORED code. It must not inherit the
 * host's secrets any more than an MCPL connector child does (#175): on a
 * multi-resident host the .env carries provider keys and every bot's token,
 * and `os.environ` would hand all of them to any agent with code_execution.
 * Same operating allowlist as stdio MCPL children, plus the runner's own
 * declared env; `inheritEnv: true` restores full inheritance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PyRunner } from '../src/index.js';
import { validateCodeExecutionConfig } from '../src/code-execution/tool-definition.js';

test('a codeExecution.inheritEnv that is not a boolean is refused, so "false" never hands over the host env', () => {
  for (const inheritEnv of ['false', 'true', null, 0, 1, [], {}]) {
    assert.throws(() => validateCodeExecutionConfig({ inheritEnv }), /codeExecution\.inheritEnv must be true or false/,
      JSON.stringify(inheritEnv));
  }
  assert.throws(() => validateCodeExecutionConfig({ inheritEnv: 'false' }), /not "false" \(a string\)/);
  for (const inheritEnv of [undefined, true, false]) validateCodeExecutionConfig({ inheritEnv });
});

test('a codeExecution.env that is not an object of strings is refused, naming the variable but not its value', () => {
  for (const env of [null, [], 'PYTHONPATH=/opt/lib', 7]) {
    assert.throws(() => validateCodeExecutionConfig({ env }), /codeExecution\.env must be an object of variable names and string values/,
      JSON.stringify(env));
  }
  for (const value of [8080, true, null, ['x'], { nested: 'y' }]) {
    assert.throws(() => validateCodeExecutionConfig({ env: { PYTHONPATH: '/opt/lib', BAD: value } }), (err: Error) => {
      assert.match(err.message, /^codeExecution\.env\.BAD must be a string/);
      assert.ok(!err.message.includes('8080'), err.message);
      return true;
    }, JSON.stringify(value));
  }
  validateCodeExecutionConfig({ env: {} });
  validateCodeExecutionConfig({ env: { PYTHONPATH: '/opt/lib', EMPTY: '' } });
});

test('model-authored python does not see a host secret', async () => {
  const key = 'AF_CODE_EXEC_TEST_HOST_SECRET';
  process.env[key] = 'must-not-leak';
  const runner = new PyRunner({ onToolCall: async () => '' });
  try {
    const r = await runner.exec(`import os; print(repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.equal(r.returnCode, 0, r.stderr);
    assert.match(r.stdout, /None/, `the code-execution child inherited a host secret: ${r.stdout.trim()}`);
  } finally {
    runner.dispose();
    delete process.env[key];
  }
});

test('declared env reaches the interpreter; inheritEnv restores the host env', async () => {
  const key = 'AF_CODE_EXEC_TEST_HOST_SECRET';
  process.env[key] = 'must-not-leak';
  const declared = new PyRunner({ onToolCall: async () => '', env: { AF_CODE_EXEC_DECLARED: 'yes' } });
  const inheriting = new PyRunner({ onToolCall: async () => '', inheritEnv: true });
  try {
    const d = await declared.exec(`import os; print(os.environ.get('AF_CODE_EXEC_DECLARED'), repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.match(d.stdout, /^yes None/m, d.stdout + d.stderr);
    const i = await inheriting.exec(`import os; print(repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.match(i.stdout, /must-not-leak/, i.stdout + i.stderr);
  } finally {
    declared.dispose(); inheriting.dispose();
    delete process.env[key];
  }
});

test('the child env is built at each spawn: a respawn after idle reclaim sees a value changed since', async () => {
  const key = 'AF_CODE_EXEC_TEST_LATE_VAR';
  const read = `import os; print(repr(os.environ.get(${JSON.stringify(key)})))`;
  process.env[key] = 'first';
  const runner = new PyRunner({ onToolCall: async () => '', inheritEnv: true, idleReclaimMs: 20, label: 'respawn' });
  // The runner reports its idle reclaim on stderr; wait for that line rather than a guessed delay.
  const error = console.error;
  let reclaimed = false;
  console.error = (...args: unknown[]) => {
    if (args.map(String).join(' ').includes('[pytc:respawn] reclaiming python interpreter (idle)')) reclaimed = true;
    else error(...args);
  };
  try {
    const before = await runner.exec(read, []);
    assert.equal(before.returnCode, 0, before.stderr);
    assert.match(before.stdout, /'first'/, before.stdout);
    const deadline = Date.now() + 10_000;
    while (!reclaimed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(reclaimed, 'the idle interpreter should have been reclaimed');
    process.env[key] = 'second';
    const after = await runner.exec(read, []);
    assert.equal(after.returnCode, 0, after.stderr);
    assert.match(after.stdout, /'second'/, `the respawned interpreter must see the value set since the first spawn: ${after.stdout.trim()}`);
  } finally {
    console.error = error;
    runner.dispose();
    delete process.env[key];
  }
});

test('PYTHONUNBUFFERED and PYTHONIOENCODING are set last, over a declared env, since the protocol needs both', async () => {
  const runner = new PyRunner({ onToolCall: async () => '', env: { PYTHONUNBUFFERED: '0', PYTHONIOENCODING: 'latin-1' } });
  try {
    const r = await runner.exec(`import os; print(os.environ.get('PYTHONUNBUFFERED'), os.environ.get('PYTHONIOENCODING'))`, []);
    assert.equal(r.returnCode, 0, r.stderr);
    assert.match(r.stdout, /^1 utf-8$/m, r.stdout);
  } finally {
    runner.dispose();
  }
});
