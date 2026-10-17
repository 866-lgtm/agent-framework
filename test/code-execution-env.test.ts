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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { PyRunner } from '../src/index.js';
import { validateCodeExecutionConfig } from '../src/code-execution/tool-definition.js';

test('a codeExecution.inheritEnv that is not a boolean is refused by its kind, so "false" never hands over the host env', () => {
  const kinds: Array<[unknown, string]> = [
    ['false', 'true or false, unquoted, not a string'], ['true', 'true or false, unquoted, not a string'],
    [0, 'true or false, not a number'], [1, 'true or false, not a number'],
    [[], 'true or false, not an array'], [{}, 'true or false, not an object'],
  ];
  for (const [inheritEnv, wanted] of kinds) {
    assert.throws(() => validateCodeExecutionConfig({ inheritEnv }), (err: Error) => {
      assert.ok(err.message.startsWith(`codeExecution.inheritEnv must be ${wanted}: `), err.message);
      return true;
    }, JSON.stringify(inheritEnv));
  }
  // null is how JSON writes "not set".
  for (const inheritEnv of [undefined, null, true, false]) validateCodeExecutionConfig({ inheritEnv });
});

test('a codeExecution.env that is not an object of strings is refused, naming the variable and its value\'s kind but not the value', () => {
  const envKinds: Array<[unknown, string]> = [[[], 'an array'], ['PYTHONPATH=/opt/lib', 'a string'], [7, 'a number'], [new Map(), 'a Map']];
  for (const [env, kind] of envKinds) {
    assert.throws(() => validateCodeExecutionConfig({ env }), (err: Error) => {
      assert.equal(err.message, `codeExecution.env must be an object of variable names and string values, not ${kind}`);
      return true;
    }, String(kind));
  }
  const valueKinds: Array<[unknown, string]> = [[8080, 'a number'], [true, 'a boolean'], [null, 'null'], [undefined, 'undefined'], [['x'], 'an array'], [{ nested: 'y' }, 'an object']];
  for (const [value, kind] of valueKinds) {
    assert.throws(() => validateCodeExecutionConfig({ env: { PYTHONPATH: '/opt/lib', BAD: value } }), (err: Error) => {
      assert.equal(err.message, `codeExecution.env.BAD must be a string, not ${kind}: give its value as a string, or leave BAD out`);
      return true;
    }, String(kind));
  }
  validateCodeExecutionConfig({ env: {} });
  validateCodeExecutionConfig({ env: null });
  validateCodeExecutionConfig({ env: { PYTHONPATH: '/opt/lib', EMPTY: '' } });
});

test('a codeExecution.env name spawn could not pass as written, or a value holding NUL, is refused at create', () => {
  for (const name of ['', 'PYTHONPATH=/opt/lib', 'NU\0L']) {
    assert.throws(() => validateCodeExecutionConfig({ env: { [name]: 'x' } }), (err: Error) => {
      assert.equal(err.message, `codeExecution.env has a variable name ${JSON.stringify(name)}, and a name can't be empty or hold '=' or NUL`);
      return true;
    }, JSON.stringify(name));
  }
  assert.throws(() => validateCodeExecutionConfig({ env: { SECRET: 'sk-\0live' } }), (err: Error) => {
    assert.equal(err.message, 'codeExecution.env.SECRET holds a NUL character, which no environment variable can carry');
    return true;
  });
});

test('model-authored python does not inherit a host variable outside the allowlist', async () => {
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

test("the interpreter runs in its own runtime directory, which goes at teardown, not the host's working directory", async () => {
  const runner = new PyRunner({ onToolCall: async () => '' });
  try {
    const r = await runner.exec(`import os; open('scratch.txt', 'w').write('x'); print(os.getcwd())`, []);
    assert.equal(r.returnCode, 0, r.stderr);
    const cwd = r.stdout.trim();
    assert.notEqual(cwd, process.cwd());
    assert.match(basename(cwd), /^af-pytc-/, cwd);
    assert.ok(existsSync(join(cwd, 'scratch.txt')), 'a relative path lands in the runtime directory');
    runner.dispose();
    // It goes once the killed interpreter has exited, which dispose() doesn't wait for.
    const deadline = Date.now() + 10_000;
    while (existsSync(cwd) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(!existsSync(cwd), 'the runtime directory goes at teardown, with what the script wrote there');
  } finally {
    runner.dispose();
  }
});

test("a relative pythonPath resolves from the host's working directory, not the interpreter's", async () => {
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  // bin/python under a host directory of its own: a relative path that
  // doesn't climb to the root, so it finds the interpreter from that
  // directory and from no other.
  const hostDir = mkdtempSync(join(tmpdir(), 'pytc-host-'));
  mkdirSync(join(hostDir, 'bin'));
  symlinkSync(python, join(hostDir, 'bin', 'python'));
  const previousCwd = process.cwd();
  process.chdir(hostDir);
  const runner = new PyRunner({ onToolCall: async () => '', pythonPath: join('bin', 'python') });
  try {
    const r = await runner.exec('print("started")', []);
    assert.equal(r.returnCode, 0, r.stderr);
    assert.match(r.stdout, /started/);
  } finally {
    runner.dispose();
    process.chdir(previousCwd);
    rmSync(hostDir, { recursive: true, force: true });
  }
});
