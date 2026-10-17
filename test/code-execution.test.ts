/**
 * Client-side programmatic tool calling (code_execution) tests.
 *
 * PyRunner tests spawn a REAL python3 subprocess — the protocol, top-level
 * await, tool-function injection, timeout, and deadline behavior are all
 * exercised end-to-end. Framework tests drive a full agent turn through the
 * MockMembrane and assert the load-bearing invariant: inner tool results
 * reach the running script but never the model-facing tool_result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ChildProcess, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, PYTHON_RUNTIME_SOURCE, PyRunner, buildInjectedTools } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { PYTC_STOP_ROWS_DRIVER } from './helpers/pytc-stop-rows.js';

const ECHO_TOOLS: { pyName: string; toolName: string }[] = [
  { pyName: 'test__echo', toolName: 'test--echo' },
];

/** Wait for a condition, failing after 10 s rather than hanging the run. */
const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Wait for a promise, failing after 10 s rather than hanging the run. */
const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/** Whether a process is still there to signal. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('buildInjectedTools', () => {
  it('sanitizes -- to __ and keeps valid identifiers', () => {
    const injected = buildInjectedTools(['mcpl--discord--send_message', 'think']);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl__discord__send_message', toolName: 'mcpl--discord--send_message' },
      { pyName: 'think', toolName: 'think' },
    ]);
  });

  it('sanitizes single hyphens inside segments (live fleet names)', () => {
    // Found on the first Mica canary run: module/server ids with single
    // hyphens were skipped entirely. They must inject.
    const injected = buildInjectedTools([
      'mcpl-admin--mcpl_deploy',
      'mcpl--dog-events--dog_events_status',
      'channel-mode--set_channel_mode',
    ]);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl_admin__mcpl_deploy', toolName: 'mcpl-admin--mcpl_deploy' },
      { pyName: 'mcpl__dog_events__dog_events_status', toolName: 'mcpl--dog-events--dog_events_status' },
      { pyName: 'channel_mode__set_channel_mode', toolName: 'channel-mode--set_channel_mode' },
    ]);
  });

  it('prefixes a leading digit', () => {
    const injected = buildInjectedTools(['3d-tools--render']);
    assert.deepStrictEqual(injected, [{ pyName: '_3d_tools__render', toolName: '3d-tools--render' }]);
  });

  it('skips colliding sanitized names loudly (first wins)', () => {
    const logs: string[] = [];
    const injected = buildInjectedTools(['a--b', 'a__b'], (m) => logs.push(m));
    assert.deepStrictEqual(injected, [{ pyName: 'a__b', toolName: 'a--b' }]);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /collides/);
  });
});

describe('PyRunner (real python3)', () => {
  it('runs a script and returns stdout', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("hello from python")', []);
      assert.strictEqual(result.returnCode, 0);
      assert.match(result.stdout, /hello from python/);
      assert.strictEqual(result.stderr, '');
    } finally {
      runner.dispose();
    }
  });

  it('round-trips a tool call as an awaited async function', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const runner = new PyRunner({
      onToolCall: async (name, args) => {
        calls.push({ name, args });
        return JSON.stringify({ echoed: args });
      },
    });
    try {
      const result = await runner.exec(
        [
          'import json',
          'r = json.loads(await test__echo({"message": "alpha"}))',
          'print("echoed:", r["echoed"]["message"])',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /echoed: alpha/);
      assert.deepStrictEqual(calls, [{ name: 'test--echo', args: { message: 'alpha' } }]);
    } finally {
      runner.dispose();
    }
  });

  it('supports the exact-name tools[...] escape hatch', async () => {
    const runner = new PyRunner({
      onToolCall: async (_name, args) => `got:${String(args.v)}`,
    });
    try {
      const result = await runner.exec(
        'print(await tools["test--echo"]({"v": 7}))',
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /got:7/);
    } finally {
      runner.dispose();
    }
  });

  it('runs parallel tool calls via asyncio.gather', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = new PyRunner({
      onToolCall: async (_name, args) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 150));
        inFlight--;
        return String(args.i);
      },
    });
    try {
      const result = await runner.exec(
        [
          'import asyncio',
          'results = await asyncio.gather(*(test__echo({"i": i}) for i in range(3)))',
          'print(",".join(results))',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /0,1,2/);
      assert.ok(maxInFlight >= 2, `expected parallel dispatch, max in flight was ${maxInFlight}`);
    } finally {
      runner.dispose();
    }
  });

  it('persists interpreter state across execs (container-reuse semantics)', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('x = 41', []);
      assert.strictEqual(first.returnCode, 0, first.stderr);
      const second = await runner.exec('print(x + 1)', []);
      assert.strictEqual(second.returnCode, 0, second.stderr);
      assert.match(second.stdout, /42/);
    } finally {
      runner.dispose();
    }
  });

  it('reports script exceptions as a traceback with return_code 1', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('raise ValueError("boom")', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /ValueError: boom/);
      assert.match(result.stderr, /Traceback/);
    } finally {
      runner.dispose();
    }
  });

  it('delivers tool errors as plain strings the script can handle', async () => {
    const runner = new PyRunner({
      onToolCall: async () => 'Error: Query timeout - table lock exceeded',
    });
    try {
      const result = await runner.exec(
        [
          'r = await test__echo({})',
          'if r.startswith("Error:"):',
          '    print("handled:", r)',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /handled: Error: Query timeout/);
    } finally {
      runner.dispose();
    }
  });

  it('raises TimeoutError inside the script when a tool call gets no response', async () => {
    const runner = new PyRunner({
      toolCallTimeoutMs: 1000,
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const result = await runner.exec('await test__echo({})', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /TimeoutError: Calling tool \['test--echo'\] timed out/);
    } finally {
      runner.dispose();
    }
  });

  it('cancels a script that exceeds the deadline', async () => {
    const runner = new PyRunner({
      scriptTimeoutMs: 1000,
      onToolCall: async () => '',
    });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /cancelled by host/);
      assert.ok(Date.now() - started < 15_000, 'deadline cancel took too long');
    } finally {
      runner.dispose();
    }
  });

  it('abort() settles a running script and reclaims the interpreter', async () => {
    let called!: () => void;
    const running = new Promise<void>((resolve) => {
      called = resolve;
    });
    const runner = new PyRunner({
      onToolCall: async () => {
        called();
        return 'echo';
      },
    });
    try {
      const pending = runner.exec('marker = 1\nawait test__echo({})\nimport asyncio\nawait asyncio.sleep(60)', ECHO_TOOLS);
      // The script's tool call says it's running. An exec that settles first,
      // or a call that never comes, fails the test rather than leaving it waiting.
      await within(
        Promise.race([
          running,
          pending.then((r) => assert.fail(`the exec settled before its script called its tool: ${r.stderr}`)),
        ]),
        'the script to call its tool',
      );
      assert.strictEqual(runner.busy, true);
      runner.abort('test abort');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /aborted by host: test abort/);
      // Runner remains usable after reclaim, in a fresh interpreter: the
      // aborted script's state is gone.
      const after = await runner.exec('try:\n    marker\n    print("kept")\nexcept NameError:\n    print("fresh")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, 'fresh\n');
    } finally {
      runner.dispose();
    }
  });

  it('rejects concurrent execs on one runner', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      await new Promise((r) => setTimeout(r, 300));
      const second = await runner.exec('print("nope")', []);
      assert.strictEqual(second.returnCode, 1);
      assert.match(second.stderr, /already running/);
      runner.abort('cleanup');
      await first;
    } finally {
      runner.dispose();
    }
  });

  it('rejects a second exec issued before the first has started (same tick)', async () => {
    // exec() awaits the interpreter, so a claim made only after that await
    // would let two execs in at once.
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (const warm of [false, true]) {
        const first = runner.exec('import asyncio\nawait asyncio.sleep(0.2)\nprint("first ran")', []);
        const second = runner.exec('print("second ran")', []);
        const [a, b] = await Promise.race([
          Promise.all([first, second]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`warm=${warm}: an exec never settled`)), 10_000)),
        ]);
        assert.strictEqual(b.returnCode, 1, `warm=${warm}`);
        assert.match(b.stderr, /already running/);
        assert.strictEqual(a.returnCode, 0, `warm=${warm}: ${a.stderr}`);
        assert.match(a.stdout, /first ran/);
        assert.ok(!a.stdout.includes('second ran') && !b.stdout.includes('second ran'));
      }
    } finally {
      runner.dispose();
    }
  });

  it('fails gracefully when the python binary is missing', async () => {
    const runner = new PyRunner({
      pythonPath: '/definitely/not/a/python',
      onToolCall: async () => '',
    });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /Failed to start python runtime|exited before becoming ready/);
    } finally {
      runner.dispose();
    }
  });
});

// While the interpreter starts, the exec has claimed the runner but its
// script hasn't been sent. An abort or a dispose then settles the exec, and
// the script never runs.
describe('PyRunner: an abort or dispose while the interpreter starts (real python3)', () => {
  /** An executable standing in for python3: a shell script with the given body. */
  const standIn = (body: string): { path: string; dir: string; done: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), 'af-pytc-standin-'));
    const path = join(dir, 'python3');
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { path, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  // The stand-ins are shell scripts.
  const posix = { skip: process.platform === 'win32' ? 'the stand-ins need /bin/sh' : false };
  // A write's failure comes back through the event loop: two turns of it.
  const turns = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

  it('an abort settles the exec at once, and its script never runs', async () => {
    const calls: string[] = [];
    const runner = new PyRunner({
      onToolCall: async (name) => {
        calls.push(name);
        return 'echo';
      },
    });
    try {
      const started = Date.now();
      const pending = runner.exec('await test__echo({})\nimport asyncio\nawait asyncio.sleep(2)', ECHO_TOOLS);
      assert.strictEqual(runner.busy, true);
      runner.abort('turn abandoned');
      assert.strictEqual(runner.busy, false, 'the next turn can run a script');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /aborted by host: turn abandoned/);
      // Waiting on the killed interpreter's readiness would take its 15 s start timeout.
      const took = Date.now() - started;
      assert.ok(took < 10_000, `settled after ${took} ms`);
      const after = await runner.exec('print("alive")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, 'alive\n');
      assert.deepStrictEqual(calls, [], 'the aborted script never ran');
    } finally {
      runner.dispose();
    }
  });

  it('an abort while the interpreter is still starting settles the exec and kills the interpreter', posix, async () => {
    // The flaky abort test's case, an abort that lands while the interpreter
    // starts. The stand-in writes its pid and never says it's ready, so the
    // abort lands while it starts, however late it comes.
    const never = standIn('echo $$ > "$(dirname "$0")/pid"\nexec sleep 30');
    const runner = new PyRunner({ pythonPath: never.path, onToolCall: async () => '' });
    try {
      const pending = runner.exec('print("ran")', []);
      const pidFile = join(never.dir, 'pid');
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 'the interpreter to start');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.strictEqual(runner.busy, true);
      runner.abort('test abort');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, 'script aborted by host: test abort');
      assert.strictEqual(result.stdout, '');
      // Left running, the stand-in would sleep on for 30 s.
      await until(() => !alive(pid), 'the starting interpreter to be killed');
    } finally {
      runner.dispose();
      never.done();
    }
  });

  it('a second exec, issued on the tick an abort settles the first, runs whole in a fresh interpreter', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      runner.abort('turn abandoned');
      const second = runner.exec('print("second")', []);
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(a.aborted, true);
      assert.match(a.stderr, /aborted by host: turn abandoned/);
      assert.strictEqual(b.returnCode, 0, b.stderr);
      assert.strictEqual(b.stdout, 'second\n');
    } finally {
      runner.dispose();
    }
  });

  it('an abort on a warm interpreter, on the tick exec is called, settles it before its script is sent', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await runner.exec('print("warm")', []);
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', [], undefined, { deadlineMs: 300 });
      runner.abort('turn abandoned');
      const stopped = await first;
      assert.strictEqual(stopped.aborted, true);
      assert.match(stopped.stderr, /aborted by host: turn abandoned/);
      // Had the aborted exec gone on to arm its deadline, that would interrupt
      // this next script at 300 ms.
      const next = await runner.exec('import asyncio\nawait asyncio.sleep(1)\nprint("whole")', []);
      assert.strictEqual(next.returnCode, 0, next.stderr);
      assert.strictEqual(next.stdout, 'whole\n');
    } finally {
      runner.dispose();
    }
  });

  const stops: [string, (runner: PyRunner) => void, RegExp][] = [
    ['a dispose', (runner) => runner.dispose(), /^code_execution runner disposed$/],
    [
      'an abort then a dispose (a background cancel)',
      (runner) => {
        runner.abort('cancelled by agent');
        runner.dispose();
      },
      /^script aborted by host: cancelled by agent$/,
    ],
  ];
  for (const [how, stop, says] of stops) {
    it(`${how} settles the exec at once`, async () => {
      const runner = new PyRunner({ onToolCall: async () => '' });
      const started = Date.now();
      const pending = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      stop(runner);
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, says);
      // Waiting on the killed interpreter's readiness would take its 15 s start timeout.
      const took = Date.now() - started;
      assert.ok(took < 10_000, `settled after ${took} ms`);
    });
  }

  it('an abort while an interpreter that has stopped reading its input starts throws nothing', posix, async () => {
    // The stand-in closes fd 3, where the host's messages arrive, says so, and
    // never gets ready, so the abort's write meets a pipe nobody reads.
    const closed = standIn('exec 3<&-\ntouch "$(dirname "$0")/closed"\nexec sleep 30');
    const runner = new PyRunner({ pythonPath: closed.path, onToolCall: async () => '' });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const pending = runner.exec('print(1)', []);
      await until(() => existsSync(join(closed.dir, 'closed')), 'the stand-in to close its input');
      runner.abort('turn abandoned');
      const result = await pending;
      assert.strictEqual(result.stderr, 'script aborted by host: turn abandoned');
      // An unheard write error would fail this test as an uncaught exception.
      await turns();
      // The abort tore the interpreter down, so its failed write isn't news.
      assert.deepStrictEqual(logged.filter((l) => l.includes('messages to the python runtime failed')), []);
    } finally {
      console.error = consoleError;
      runner.dispose();
      closed.done();
    }
  });

  it("an exec whose interpreter has stopped reading its input but runs on is settled at the failed write", posix, async () => {
    // As after a script closes file descriptor 3, where the host's messages
    // arrive: the interpreter is alive, and the exec's own writes, the init
    // and the exec, meet a pipe nobody reads. Left running, the exec would
    // wait out its 10-minute time limit.
    const closes = standIn(`exec 3<&-\necho '{"op":"ready"}' >&4\nexec sleep 30`);
    const runner = new PyRunner({ pythonPath: closes.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exec to settle');
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /^python runtime stopped reading the host's messages, so it was killed/);
      assert.strictEqual(runner.busy, false);
      await turns();
    } finally {
      runner.dispose();
      closes.done();
    }
  });

  it("an abort or a dispose on the tick exec is called, with an interpreter that can't be spawned, kills no child without a pid", async () => {
    // A failed spawn's child has no pid, and its exitCode stays null until
    // Node's 'error' for it, a tick later. A kill() in that tick signals
    // whatever pid Node's handle held: in a fresh Node 20 process that was 0,
    // the caller's own process group. So the stub records such a kill
    // instead, and passes on only a child's with a pid.
    const kill = ChildProcess.prototype.kill;
    const pidless: (NodeJS.Signals | number | undefined)[] = [];
    ChildProcess.prototype.kill = function (this: ChildProcess, signal?: NodeJS.Signals | number) {
      if (this.pid === undefined) {
        pidless.push(signal);
        return false;
      }
      return kill.call(this, signal);
    };
    try {
      for (const stop of ['abort', 'dispose'] as const) {
        const runner = new PyRunner({ pythonPath: '/definitely/not/a/python', onToolCall: async () => '' });
        try {
          const pending = runner.exec('print(1)', []);
          if (stop === 'abort') runner.abort('stopped on the spawn tick');
          else runner.dispose();
          const result = await within(pending, `the exec stopped by ${stop}`);
          assert.strictEqual(result.aborted, true, stop);
          assert.strictEqual(
            result.stderr,
            stop === 'abort' ? 'script aborted by host: stopped on the spawn tick' : 'code_execution runner disposed',
          );
          assert.deepStrictEqual(pidless, [], `${stop}: a kill reached a child with no pid`);
        } finally {
          runner.dispose();
        }
      }
    } finally {
      ChildProcess.prototype.kill = kill;
    }
  });

  it('an interpreter that exits before it is ready still reads as a failed start', posix, async () => {
    const exits = standIn('exit 3');
    const runner = new PyRunner({ pythonPath: exits.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stderr,
        `Failed to start python runtime (${exits.path}): python runtime exited before becoming ready`,
      );
    } finally {
      runner.dispose();
      exits.done();
    }
  });

  it("an interpreter whose wrapper doesn't pass fds 3 and 4 on says so as its start fails", posix, async () => {
    for (const drops of ['3<&- 4<&-', '3<&-', '4<&-']) {
      const wraps = standIn(`exec ${drops}\nexec python3 "$@"`);
      const runner = new PyRunner({ pythonPath: wraps.path, onToolCall: async () => '' });
      try {
        const result = await within(runner.exec('print(1)', []), `the failed start (${drops})`);
        assert.strictEqual(result.aborted, true, drops);
        assert.strictEqual(
          result.stderr,
          `Failed to start python runtime (${wraps.path}): python runtime exited before becoming ready, saying: ` +
            "The host's channel didn't reach this Python interpreter: its file descriptors 3 and 4 aren't open, as " +
            "when the host's pythonPath starts Python through a wrapper that doesn't pass them on, such as a " +
            "container, or sudo with its default settings. code_execution can't run scripts here until whoever " +
            'runs this host changes that, so calling it again fails the same way.',
          drops,
        );
      } finally {
        runner.dispose();
        wraps.done();
      }
    }
  });

  it('an interpreter that exits before it is ready says why, from what it wrote to stderr', posix, async () => {
    const says = standIn('echo "no runtime here" >&2\nexit 3');
    const runner = new PyRunner({ pythonPath: says.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stderr,
        `Failed to start python runtime (${says.path}): python runtime exited before becoming ready, saying: no runtime here`,
      );
    } finally {
      runner.dispose();
      says.done();
    }
  });

  // A stand-in that takes the exec, then exits leaving a child that does one
  // thing once the stand-in has been reaped, which is when Node reports the
  // exit: what the child sends arrives after the exit, every time.
  const exitsThenChild = (child: string, childFds: string) =>
    standIn([
      `echo '{"op":"ready"}' >&4`,
      'read -r init <&3',
      'read -r exec <&3',
      'parent=$$',
      `(while kill -0 "$parent" 2>/dev/null; do :; done; ${child}) ${childFds} &`,
      'exit 3',
    ].join('\n'));

  it("what an interpreter's output pipes carry after its exit is still in the result", posix, async () => {
    const late = exitsThenChild('echo "last words" >&2', '>/dev/null 3<&- 4<&-');
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, 'last words\npython runtime exited unexpectedly (code=3, signal=none)');
    } finally {
      runner.dispose();
      late.done();
    }
  });

  it("what an exited interpreter wrote is read before its exec settles, even when the host was busy past the grace", posix, async () => {
    const late = exitsThenChild('echo "last words" >&2', '>/dev/null 3<&- 4<&-');
    // The host's event loop is busy for 400 ms from the exit, longer than the
    // 200 ms grace, while the child writes; then the expired grace timer runs
    // before the loop reads the pipes.
    const proto = ChildProcess.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
    const own = Object.prototype.hasOwnProperty.call(proto, 'emit');
    const emit = proto.emit;
    proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
      const handled = emit.call(this, event, ...args);
      if (event === 'exit') {
        const busyUntil = Date.now() + 400;
        while (Date.now() < busyUntil) {
          // busy
        }
      }
      return handled;
    };
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.stderr, 'last words\npython runtime exited unexpectedly (code=3, signal=none)');
    } finally {
      if (own) proto.emit = emit;
      else delete (proto as { emit?: unknown }).emit;
      runner.dispose();
      late.done();
    }
  });

  it('an interpreter that dies just after its messages stop reaching it reads as its own exit, not as one the host killed', posix, async () => {
    // It reads the init, closes fd 3 with the exec unread, which breaks the
    // host's end of it, and kills itself 20 ms later: within the host's grace
    // for its own exit, so the host doesn't take it for a deaf interpreter.
    const dies = standIn([`echo '{"op":"ready"}' >&4`, 'read -r init <&3', 'exec 3<&-', 'sleep 0.02', 'kill -9 $$'].join('\n'));
    const runner = new PyRunner({ pythonPath: dies.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, 'python runtime exited unexpectedly (code=null, signal=SIGKILL)');
    } finally {
      runner.dispose();
      dies.done();
    }
  });

  it("an exec's result that arrives after its interpreter's exit keeps the script's own return code", posix, async () => {
    const late = exitsThenChild(`echo '{"op":"exec_result","id":"e1","return_code":5}' >&4`, '>/dev/null 2>&1 3<&-');
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.returnCode, 5);
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, 'python runtime exited unexpectedly (code=3, signal=none)');
    } finally {
      runner.dispose();
      late.done();
    }
  });

  it('an end mark, or a character, split across two reads is still found whole', posix, async () => {
    // A Python stand-in that writes "é" in two pieces, then the end mark in
    // two, each landing in a read of its own.
    const split = standIn('exec python3 "$(dirname "$0")/split.py"');
    writeFileSync(
      join(split.dir, 'split.py'),
      [
        'import json, os, time',
        'out = open(4, "w", encoding="utf-8")',
        'out.write(\'{"op": "ready"}\\n\')',
        'out.flush()',
        'for line in open(3, encoding="utf-8"):',
        '    msg = json.loads(line)',
        '    if msg.get("op") != "exec":',
        '        continue',
        '    mark = msg["mark"].encode("utf-8")',
        '    for piece in (b"caf\\xc3", b"\\xa9\\n" + mark[:5], mark[5:]):',
        '        os.write(1, piece)',
        '        time.sleep(0.2)',
        '    os.write(2, mark)',
        '    out.write(json.dumps({"op": "exec_result", "id": msg["id"], "return_code": 0}) + "\\n")',
        '    out.flush()',
      ].join('\n'),
    );
    const runner = new PyRunner({ pythonPath: split.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exec to settle');
      assert.deepStrictEqual(result, { stdout: 'café\n', stderr: '', returnCode: 0 });
    } finally {
      runner.dispose();
      split.done();
    }
  });
});

// The protocol has fds of its own, 3 and 4; fd 0 is /dev/null, and the host
// reads fds 1 and 2 itself. So what a script's commands write lands where its
// prints do, reaches the host whatever then happens to the interpreter, and
// nothing a script or a command does with fds 0 to 2 reaches the protocol.
describe("PyRunner: a script's output, read by the host (real python3)", { skip: process.platform === 'win32' ? 'the scripts run POSIX commands' : false }, () => {
  /** Lines the runner logs, while fn runs. */
  const logging = async (fn: (logged: string[]) => Promise<void>) => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await fn(logged);
    } finally {
      console.error = consoleError;
    }
  };

  it("a command's output reaches the result, in order with the script's own on each stream", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec(
        'import os, sys\nprint("p1")\nos.system("echo child-out; echo child-err 1>&2")\nprint("p2")\nprint("e1", file=sys.stderr)\nsys.stdout.write("no newline")',
        [],
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, 'p1\nchild-out\np2\nno newline');
      assert.strictEqual(result.stderr, 'child-err\ne1\n');
    } finally {
      runner.dispose();
    }
  });

  it("a command reading its input gets its end at once, and no command holds the protocol's fds", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // /dev/fd/N is there only while the process looking holds fd N.
      const held = `import os; print("held:", [fd for fd in (3, 4) if os.path.exists("/dev/fd/%d" % fd)])`;
      const result = await within(
        runner.exec(
          [
            'import os, subprocess, sys',
            'print("cat", subprocess.run(["cat"], timeout=5).returncode)',
            `subprocess.run([sys.executable, "-c", ${JSON.stringify(held)}], close_fds=False)`,
            `os.system(sys.executable + " -c '" + ${JSON.stringify(held)} + "'")`,
            `subprocess.run([sys.executable, "-c", "import os; print('null:', os.path.samestat(os.fstat(0), os.stat(os.devnull)))"])`,
          ].join('\n'),
          [],
        ),
        'the script to finish',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, 'cat 0\nheld: []\nheld: []\nnull: True\n');
    } finally {
      runner.dispose();
    }
  });

  it('a script that closes or redirects fds 0, 1 and 2 leaves the next script its output', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const closes = await within(runner.exec('import os\nos.close(0)\nos.close(1)\nos.close(2)', []), 'the closing script');
      assert.strictEqual(closes.returnCode, 0, closes.stderr);
      const after = await runner.exec('import os, sys\nprint("out")\nprint("err", file=sys.stderr)\nos.system("echo cmd")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, 'out\ncmd\n');
      assert.strictEqual(after.stderr, 'err\n');
      const redirects = await runner.exec('import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 1)\nprint("lost")', []);
      assert.strictEqual(redirects.stdout, '');
      const back = await runner.exec('print("back")', []);
      assert.strictEqual(back.stdout, 'back\n');
    } finally {
      runner.dispose();
    }
  });

  it('what the script wrote just before it ended is all in its result, and none in the next', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const big = await runner.exec('import os\nos.write(1, b"x" * 1_500_000)', []);
      assert.strictEqual(big.returnCode, 0, big.stderr);
      assert.strictEqual(big.stdout.length, 1_500_000);
      const next = await runner.exec('print("next")', []);
      assert.strictEqual(next.stdout, 'next\n');
    } finally {
      runner.dispose();
    }
  });

  it('each stream is cut at 2,000,000 characters, and says so', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import sys\nsys.stdout.write("x" * 2_000_100)\nsys.stderr.write("y" * 10)', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `${'x'.repeat(2_000_000)}\n[stdout truncated at 2000000 chars]`);
      assert.strictEqual(result.stderr, 'y'.repeat(10));
    } finally {
      runner.dispose();
    }
  });

  it("C code writing under the GIL more than a pipe holds doesn't stop the script", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // ctypes.PyDLL keeps the GIL through the call: a reader inside the
      // interpreter could never drain the pipe, and the write would never return.
      const result = await within(
        runner.exec('import ctypes\nbuf = b"x" * 1048576\nn = ctypes.PyDLL(None).write(1, buf, len(buf))\nprint()\nprint("wrote", n)', []),
        'the write to return',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `${'x'.repeat(1048576)}\nwrote 1048576\n`);
    } finally {
      runner.dispose();
    }
  });

  it('a script killed at its time limit keeps in its result what it and its commands wrote', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      const code = [
        'import os, signal, sys, time',
        'signal.signal(signal.SIGINT, signal.SIG_IGN)',
        'print("before")',
        'os.system("echo from-a-command")',
        'sys.stderr.write("partial")',
        'sys.stderr.flush()',
        'time.sleep(60)',
      ].join('\n');
      const killed = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(killed.stdout, 'before\nfrom-a-command\n');
      assert.match(killed.stderr, /^partial\nscript stopped: it reached its 1s time limit and did not respond, so it was killed/);
    } finally {
      runner.dispose();
    }
  });

  it("a crash's own text reaches the result and the host's log: a fatal error's, and a segfault's traceback", async () => {
    const crashes: [string, string, RegExp][] = [
      ['a fatal error', 'import ctypes\nprint("before")\nctypes.pythonapi.Py_FatalError(b"probe reason")', /^Fatal Python error: probe reason\n/],
      ['a segfault', 'import ctypes\nprint("before")\nctypes.string_at(0)', /^Fatal Python error: Segmentation fault\n[\s\S]*File "<script>", line 3/],
    ];
    for (const [what, code, says] of crashes) {
      await logging(async (logged) => {
        const runner = new PyRunner({ onToolCall: async () => '' });
        try {
          const result = await within(runner.exec(code, []), what);
          assert.strictEqual(result.aborted, true, what);
          assert.strictEqual(result.stdout, 'before\n', what);
          assert.match(result.stderr, says, what);
          assert.match(result.stderr, /\npython runtime exited unexpectedly \(code=null, signal=SIG[A-Z]+\)$/, what);
          assert.ok(
            logged.some((l) => /exited unexpectedly .*; the last it wrote to stderr: Fatal Python error/.test(l)),
            `${what}: logged ${JSON.stringify(logged)}`,
          );
        } finally {
          runner.dispose();
        }
      });
    }
  });

  it('an interpreter that ends under its script leaves in the result all it wrote', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('import os\nos.write(1, b"x" * 1_000_000)\nos._exit(3)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stdout.length, 1_000_000);
      assert.strictEqual(result.stderr, 'python runtime exited unexpectedly (code=3, signal=none)');
    } finally {
      runner.dispose();
    }
  });

  it('a crash settles without waiting for a command it started that still holds its output', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    let command = 0;
    try {
      const result = await within(
        runner.exec('import ctypes, subprocess\nprint(subprocess.Popen(["sleep", "30"]).pid, flush=True)\nctypes.pythonapi.Py_FatalError(b"probe reason")', []),
        'the crash to settle',
      );
      command = Number(result.stdout.trim());
      assert.match(result.stderr, /^Fatal Python error: probe reason\n/);
      // Settled while the command still holds the pipes.
      assert.ok(alive(command), 'the command had ended, so the exec could have waited for it');
    } finally {
      if (command && alive(command)) process.kill(command, 'SIGKILL');
      runner.dispose();
    }
  });

  it("a command left running writes to the host's log, each piece cut at 2,000 characters, not to the next script's result", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-left-'));
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        // The command writes when the test makes each file, after its script
        // has returned: a long line, then half of "é".
        const command = [
          'import os, sys, time',
          'def wait(name):',
          '    while not os.path.exists(os.path.join(sys.argv[1], name)): time.sleep(0.05)',
          'wait("line")',
          "sys.stdout.write('left-running ' + 'x' * 3000 + '\\n')",
          'wait("half")',
          'os.write(1, b"caf\\xc3")',
        ].join('\n');
        const first = await runner.exec(
          `import subprocess, sys\nsubprocess.Popen([sys.executable, "-c", ${JSON.stringify(command)}, ${JSON.stringify(dir)}])\nprint("started")`,
          [],
        );
        assert.strictEqual(first.stdout, 'started\n');
        writeFileSync(join(dir, 'line'), '');
        await until(() => logged.some((l) => l.includes('stdout while no script runs: left-running')), 'its line in the log');
        const line = logged.find((l) => l.includes('stdout while no script runs: left-running'));
        assert.match(line ?? '', /stdout while no script runs: left-running x{1987} \[… 1013 more characters\]$/);
        writeFileSync(join(dir, 'half'), '');
        await until(() => logged.some((l) => l.endsWith('stdout while no script runs: caf')), 'its half character in the log');
        // The half character it left is the log's, not the next script's.
        const next = await runner.exec('print("next")', []);
        assert.strictEqual(next.stdout, 'next\n');
      } finally {
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('a writer a script kept from an earlier exec sends its partial line in the exec that wrote it', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      assert.strictEqual((await runner.exec('import sys\nkept = sys.stdout\nprint("one")', [])).stdout, 'one\n');
      assert.strictEqual((await runner.exec('kept.write("partial")', [])).stdout, 'partial');
      assert.strictEqual((await runner.exec('print("three")', [])).stdout, 'three\n');
    } finally {
      runner.dispose();
    }
  });

  it('an interpreter ended by a signal gets no signal from the host once it has been reaped', async () => {
    const kill = process.kill;
    // A pid that kill(pid, 0) no longer finds was reaped, and could be reused.
    const toReaped: number[] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 'SIGINT') {
        try {
          kill.call(process, pid, 0);
        } catch {
          toReaped.push(pid);
        }
      }
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // At its time limit the script ends its interpreter with SIGKILL while a
      // command it started holds the output pipes, so the exec waits out the
      // grace, during which the time limit's repeated SIGINT falls due.
      const code = [
        'import os, signal, subprocess, time',
        'subprocess.Popen(["sleep", "3"])',
        'signal.signal(signal.SIGINT, lambda *_: os.kill(os.getpid(), signal.SIGKILL))',
        'time.sleep(30)',
      ].join('\n');
      const result = await within(runner.exec(code, [], undefined, { deadlineMs: 1000 }), 'the exec to settle');
      assert.match(result.stderr, /^python runtime exited unexpectedly \(code=null, signal=SIGKILL\)\n/);
      assert.deepStrictEqual(toReaped, []);
    } finally {
      process.kill = kill;
      runner.dispose();
    }
  });

  it("a script whose stderr is gone still reports, and the next one's traceback arrives", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const gone = await within(runner.exec('import os\nos.close(2)\nraise ValueError("unheard")', []), 'the script to report');
      assert.strictEqual(gone.returnCode, 1);
      // Its traceback can't reach the host, and the runtime says so.
      assert.strictEqual(gone.stderr, "[pytc-runtime] some of what the script wrote couldn't be sent ([Errno 9] Bad file descriptor)\n");
      const next = await runner.exec('raise ValueError("heard")', []);
      assert.match(next.stderr, /ValueError: heard/);
    } finally {
      runner.dispose();
    }
  });

  it("a script that closes or replaces one of the runtime's own fds ends the interpreter by the end of that script at the latest, saying which", async () => {
    const rows: [string, string, string, RegExp][] = [
      ["fd 3, the host's messages", 'import os\nprint("closing")\nos.close(3)', 'closing\n', /cannot read the host's messages any more/],
      ["fd 4, the runtime's messages", 'import os\nos.close(4)\nprint("closed")', 'closed\n', /cannot send the host a message any more/],
      [
        'fd 4, replaced',
        'import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 4)\nprint("replaced")',
        'replaced\n',
        /cannot send the host a message any more: a script closed or replaced fd 4, where they go/,
      ],
      [
        'fd 4, replaced by a socket',
        'import os, socket\na, b = socket.socketpair()\nos.dup2(a.fileno(), 4)\nprint("replaced")',
        'replaced\n',
        /cannot send the host a message any more: a script closed or replaced fd 4, where they go/,
      ],
      [
        'fd 4, replaced before a tool call',
        'import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 4)\nprint("replaced")\nawait test__echo({})\nprint("called")',
        'replaced\n',
        /cannot send the host a message any more: a script closed or replaced fd 4, where they go/,
      ],
      [
        "the runtime's copy of fd 0",
        'import __main__, os\nos.close(__main__._STD_IN)\nprint("closed")',
        'closed\n',
        /cannot give scripts their stdin any more: a script closed or replaced the runtime's copy of fd 0/,
      ],
      [
        "the runtime's copy of fd 1",
        'import __main__, os\nos.close(__main__._STD_OUT)\nprint("closed")',
        'closed\n',
        /cannot reach the output pipes any more: a script closed or replaced the runtime's copy of fd 1/,
      ],
      [
        "the runtime's copy of fd 2",
        'import __main__, os\nos.close(__main__._STD_ERR)\nprint("closed")',
        'closed\n',
        /cannot reach the output pipes any more: a script closed or replaced the runtime's copy of fd 2/,
      ],
    ];
    for (const [what, code, stdout, says] of rows) {
      const runner = new PyRunner({ onToolCall: async () => 'echoed' });
      try {
        // A tool call that waited for its reply would take 270 s, past within's 10 s.
        const result = await within(runner.exec(code, ECHO_TOOLS), what);
        assert.strictEqual(result.aborted, true, what);
        assert.strictEqual(result.stdout, stdout, what);
        assert.match(result.stderr, says, what);
        assert.match(result.stderr, /; exiting\npython runtime exited unexpectedly \(code=70, signal=none\)$/, what);
        const next = await within(runner.exec('print("fresh")', []), `the next script (${what})`);
        assert.strictEqual(next.stdout, 'fresh\n', what);
      } finally {
        runner.dispose();
      }
    }
  });

  it("a script that closes fd 3 while it still waits on the host ends the interpreter when the runtime's reader fails", async () => {
    const runner = new PyRunner({ onToolCall: async () => 'echoed' });
    try {
      // The tool's result can still reach a read already waiting on fd 3; the
      // read after it fails, while the script sleeps.
      const result = await within(runner.exec('import os, time\nos.close(3)\nawait test__echo({})\ntime.sleep(5)', ECHO_TOOLS), 'the reader to fail');
      assert.strictEqual(result.aborted, true);
      assert.match(
        result.stderr,
        /cannot read the host's messages any more \(\[Errno 9\] Bad file descriptor\); exiting\npython runtime exited unexpectedly \(code=70, signal=none\)$/,
      );
    } finally {
      runner.dispose();
    }
  });

  it("a thread a script left running that replaces fd 4 ends the interpreter as the next script starts, before it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-thread-'));
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The thread waits for a file the test makes once the script has returned.
      const first = await runner.exec(
        [
          'import os, threading, time',
          'def later():',
          `    while not os.path.exists(${JSON.stringify(join(dir, 'go'))}): time.sleep(0.05)`,
          '    os.dup2(os.open(os.devnull, os.O_WRONLY), 4)',
          `    open(${JSON.stringify(join(dir, 'done'))}, "w").close()`,
          'threading.Thread(target=later, daemon=True).start()',
          'print("started")',
        ].join('\n'),
        [],
      );
      assert.strictEqual(first.stdout, 'started\n');
      writeFileSync(join(dir, 'go'), '');
      await until(() => existsSync(join(dir, 'done')), 'the thread to replace fd 4');
      const next = await within(runner.exec('print("ran")', []), 'the next script');
      assert.strictEqual(next.aborted, true);
      assert.strictEqual(next.stdout, '');
      assert.match(next.stderr, /cannot send the host a message any more: a script closed or replaced fd 4, where they go; exiting\n/);
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a process the script forks that runs off the script's end leaves without ending the exec", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // Python 3.12 on warns that the runtime's reader thread makes fork() risky.
      const result = await within(
        runner.exec(
          'import os, warnings\nwarnings.simplefilter("ignore", DeprecationWarning)\npid = os.fork()\nif pid == 0:\n    print("child")\nelse:\n    os.waitpid(pid, 0)\n    print("parent")',
          [],
        ),
        'the exec to settle',
      );
      assert.deepStrictEqual(result, { stdout: 'child\nparent\n', stderr: '', returnCode: 0 });
      assert.strictEqual((await runner.exec('print("next")', [])).stdout, 'next\n');
    } finally {
      runner.dispose();
    }
  });

  it("a script's ordinary use of fds, its own files, pipes, commands and forks, keeps the interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const busy = await within(
        runner.exec(
          [
            'import os, subprocess, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)  # fork() beside the runtime\'s reader thread',
            'r, w = os.pipe()',
            'os.write(w, b"x")',
            'os.close(r)',
            'os.close(w)',
            'with open(os.devnull) as f:',
            '    f.read()',
            'subprocess.run(["true"], pass_fds=())',
            'pid = os.fork()',
            'if pid == 0:',
            '    os.closerange(3, 64)',
            '    os._exit(0)',
            'os.waitpid(pid, 0)',
            'kept = 42',
          ].join('\n'),
          [],
        ),
        'the busy script',
      );
      assert.deepStrictEqual(busy, { stdout: '', stderr: '', returnCode: 0 });
      // The same interpreter, with its variables.
      assert.strictEqual((await runner.exec('print(kept)', [])).stdout, '42\n');
    } finally {
      runner.dispose();
    }
  });

  it('an interpreter that exits while no script runs says so in the host log', async () => {
    await logging(async (logged) => {
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        const first = await runner.exec('import os, threading\nthreading.Timer(0.3, os._exit, (5,)).start()\nprint("armed")', []);
        assert.strictEqual(first.stdout, 'armed\n');
        await until(
          () => logged.some((l) => l.endsWith('python runtime exited while no script ran (code=5, signal=none); the next script starts a new one')),
          'the exit in the log',
        );
        assert.strictEqual((await runner.exec('print("fresh")', [])).stdout, 'fresh\n');
      } finally {
        runner.dispose();
      }
    });
  });

  it('a script whose output pipe a command left non-blocking still writes all of it', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // fds 1 and 2 are one open file with the runtime's copies, so the flag
      // reaches the runtime's own writes too, its end marks among them.
      const result = await within(
        runner.exec('import os\nos.set_blocking(1, False)\nfor i in range(20000):\n    print("x" * 70)\nprint("end")', []),
        'the script to finish',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `${`${'x'.repeat(70)}\n`.repeat(20000)}end\n`);
    } finally {
      runner.dispose();
    }
  });
});

// Inner-call ids restart in every interpreter: a result that outlives its
// interpreter must not resolve a call of the one that replaced it.
describe('code_execution inner-call results after the interpreter is replaced (real python3)', () => {
  const stops: Record<string, { code: string; stop?: (runner: PyRunner) => void }> = {
    aborted: { code: 'print(await test__echo({}))', stop: (runner) => runner.abort('turn abandoned') },
    crashed: {
      code: 'import asyncio, os\nasyncio.get_running_loop().call_later(0.2, os._exit, 1)\nprint(await test__echo({}))',
    },
  };

  for (const [how, { code, stop }] of Object.entries(stops)) {
    it(`a late result from a script whose interpreter ${how} does not reach the next script`, async () => {
      const calls: Array<(result: string) => void> = [];
      const runner = new PyRunner({
        onToolCall: () => new Promise<string>((resolve) => calls.push(resolve)),
      });
      const logged: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
        consoleError(...args);
      };
      try {
        const first = runner.exec(code, ECHO_TOOLS);
        await until(() => calls.length === 1, 'the first script to call its tool');
        stop?.(runner);
        const stopped = await first;
        assert.strictEqual(stopped.aborted, true, stopped.stderr);

        const second = runner.exec('print(await test__echo({}))', ECHO_TOOLS);
        await until(() => calls.length === 2, 'the second script to call its tool');
        // Both calls are the first of their interpreter.
        calls[0]('stale result of the stopped script');
        await new Promise((r) => setTimeout(r, 300));
        calls[1]('result of this script');
        const result = await second;
        assert.strictEqual(result.returnCode, 0, result.stderr);
        assert.strictEqual(result.stdout, 'result of this script\n');
        assert.ok(
          logged.some((l) => /dropped late result of test--echo call t1: the interpreter that asked for it is gone/.test(l)),
          'the dropped result is logged',
        );
      } finally {
        console.error = consoleError;
        runner.dispose();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Framework integration
// ---------------------------------------------------------------------------

class ScriptToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input. Returns JSON: {"echoed": <input>}.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        name: 'finish',
        description: 'End the turn.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--')
      ? call.name.slice(call.name.lastIndexOf('--') + 2)
      : call.name;
    if (baseName === 'finish') {
      return { success: true, data: { finished: true }, endTurn: true };
    }
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const content = Array.isArray((event as { content?: unknown }).content)
        ? ((event as { content: unknown }).content as Array<{ type: string; text?: string }>)
        : [{ type: 'text', text: String((event as { content?: unknown }).content) }];
      return {
        addMessages: [{ participant: 'User', content: content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function createFrameworkWithCodeExecution(storePath: string, membrane: MockMembrane, module: Module) {
  return AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [],
    modules: [module],
    syncIntervalMs: 0,
    codeExecution: { enabled: true },
  });
}

describe('framework code_execution integration (real python3)', () => {
  it('synthesizes the tool only when enabled', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-tools-');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
    });
    try {
      assert.ok(!framework.getAllTools().some((t) => t.name === 'code_execution'));
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }

    const { tempDir: tempDir2, storePath: storePath2 } = tempStorePath('pytc-tools2-');
    const membrane2 = new MockMembrane();
    const framework2 = await createFrameworkWithCodeExecution(storePath2, membrane2, new ScriptToolModule());
    try {
      const tool = framework2.getAllTools().find((t) => t.name === 'code_execution');
      assert.ok(tool, 'code_execution tool should be synthesized');
      assert.match(tool.description, /async Python function/);
      assert.match(tool.description, /__/);
    } finally {
      await framework2.stop();
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('runs a script that calls module tools; intermediates never reach the model', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-run-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'import json',
      'names = []',
      'for m in ["alpha", "beta"]:',
      '    r = json.loads(await test__echo({"message": m}))',
      '    names.append(r["echoed"]["message"].upper())',
      'print("summary:", "+".join(names))',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me fan out.' },
      { type: 'tool_use', id: 'call_ce_1', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Final answer.' },
    ]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'worker',
        model: 'test-model',
        systemPrompt: 'Do the task.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      assert.strictEqual(result.speech, 'Final answer.');

      // The module saw both inner calls, dispatched with pytc- IDs (waiter
      // path), not the model's call ID.
      const echoCalls = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo');
      assert.strictEqual(echoCalls.length, 2);
      for (const call of echoCalls) {
        assert.match(String(call.id), /^pytc-/);
      }

      // The model-facing tool_result carries the script's stdout...
      const stream = membrane.lastStream!;
      assert.strictEqual(stream.receivedToolResults.length, 1);
      const wireResult = stream.receivedToolResults[0][0] as { toolUseId: string; content: string };
      assert.strictEqual(wireResult.toolUseId, 'call_ce_1');
      assert.match(wireResult.content, /summary: ALPHA\+BETA/);
      assert.match(wireResult.content, /"return_code":\s*0/);
      // ...and NOT the intermediate tool results.
      assert.ok(
        !wireResult.content.includes('"echoed"'),
        'intermediate tool results must not reach the model-facing result',
      );
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('two code_execution calls in one response: one runs, the other is refused, the turn completes', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-two-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = (label: string) => [
      'import asyncio, json',
      `r = json.loads(await test__echo({"message": "${label}"}))`,
      'await asyncio.sleep(0.2)',
      `print("ran:", r["echoed"]["message"])`,
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_two_a', name: 'code_execution', input: { code: code('a') } },
      { type: 'tool_use', id: 'call_two_b', name: 'code_execution', input: { code: code('b') } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both answered.' }]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'pair',
        model: 'test-model',
        systemPrompt: 'Run both.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the turn never completed')), 15_000)),
      ]);
      assert.strictEqual(result.speech, 'Both answered.');

      const [results] = membrane.lastStream!.receivedToolResults as Array<Array<{ toolUseId: string; content: string }>>;
      const byId = new Map(results.map((r) => [r.toolUseId, r.content]));
      assert.match(byId.get('call_two_a') ?? '', /ran: a/, 'the first script ran');
      assert.match(byId.get('call_two_b') ?? '', /already running/, 'the second was refused');
      assert.ok(!(byId.get('call_two_b') ?? '').includes('ran: b'));
      const echoed = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo').map((c) => (c.input as { message: string }).message);
      assert.deepStrictEqual(echoed, ['a']);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers endTurn from inner calls to the code_execution result', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-endturn-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'r = await test__finish({})',
      'print("after finish:", r)',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Finishing via script.' },
      { type: 'tool_use', id: 'call_ce_2', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    // No further response: endTurn must settle the turn without another round.

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'finisher',
        model: 'test-model',
        systemPrompt: 'Finish.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Wrap up.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      // The script ran to completion (endTurn was deferred, not applied
      // mid-script), and the turn then ended without another model round.
      const finishCalls = module.calls.filter((c) => c.name.endsWith('--finish') || c.name === 'finish');
      assert.strictEqual(finishCalls.length, 1);
      assert.strictEqual(result.toolCallsCount, 1); // one model-visible call: code_execution
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a stopped script's late end-turn request does not end the next script's turn", async () => {
    let releaseFinish: () => void = () => {};
    const finishReleased = new Promise<void>((resolve) => { releaseFinish = resolve; });
    let finishStarted = false;
    class SlowFinishModule extends ScriptToolModule {
      override async handleToolCall(call: ToolCall): Promise<ToolResult> {
        if (call.name.endsWith('finish')) {
          finishStarted = true;
          await finishReleased;
        }
        return super.handleToolCall(call);
      }
    }
    const { tempDir, storePath } = tempStorePath('pytc-stale-endturn-');
    const framework = await createFrameworkWithCodeExecution(storePath, new MockMembrane(), new SlowFinishModule());
    const run = (input: Record<string, unknown>) =>
      framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
    framework.start();
    try {
      // The first script is stopped at its time limit while its call that ends the turn is running.
      const stopped = await run({ code: 'await test__finish({})', time_limit_ms: 1000 });
      assert.ok(finishStarted);
      assert.match((stopped.data as { stderr: string }).stderr, /reached its 1s time limit/);
      assert.ok(!stopped.endTurn);

      // The call finishes while the next script runs; its request belonged to the stopped script.
      const next = run({ code: 'import asyncio\nawait asyncio.sleep(1)\nprint("next done")' });
      await new Promise((r) => setTimeout(r, 300));
      releaseFinish();
      const result = await next;
      assert.strictEqual((result.data as { stdout: string }).stdout, 'next done\n');
      assert.ok(!result.endTurn, "the stopped script's request ended the next script's turn");
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Background scripts (wake_agent) + spill-to-file
// ---------------------------------------------------------------------------

describe('PyRunner background mode (real python3)', () => {
  it('wake_agent reports the caller line and payload; log file journals output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'nested', 'bg.log');
    const wakes: Array<{ line: number; payload: unknown }> = [];
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = [
        'print("watcher starting")',        // line 1
        'x = 1',                            // line 2
        'await wake_agent({"hit": x})',     // line 3
        'print("after wake")',              // line 4
      ].join('\n');
      const result = await runner.exec(code, [], {
        logPath,
        lifetimeMs: 30_000,
        onWake: async (line, payload) => {
          wakes.push({ line, payload });
          return null;
        },
      });
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      assert.strictEqual(wakes.length, 1);
      assert.strictEqual(wakes[0].line, 3);
      assert.deepStrictEqual(wakes[0].payload, { hit: 1 });
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(logPath, 'utf8');
      assert.match(log, /watcher starting/);
      assert.match(log, /after wake/);
      assert.match(result.tail ?? '', /after wake/);
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a refused wake raises RuntimeError inside the script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('await wake_agent({"n": 1})', [], {
        logPath: null,
        lifetimeMs: 30_000,
        onWake: async () => 'wake limit reached (test)',
      });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.tail ?? '', /RuntimeError: wake_agent refused by host: wake limit reached/);
    } finally {
      runner.dispose();
    }
  });

  it("the journal holds a script's commands' output and its stderr, in the order written", { skip: process.platform === 'win32' ? 'the script runs POSIX commands' : false }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = [
        'import os, sys',
        'for i in range(50):',
        '    print("out", i)',
        '    print("err", i, file=sys.stderr)',
        'os.system("echo cmd-out; echo cmd-err 1>&2")',
        'print("done")',
      ].join('\n');
      const result = await runner.exec(code, [], { logPath, lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      const written = `${Array.from({ length: 50 }, (_, i) => `out ${i}\nerr ${i}\n`).join('')}cmd-out\ncmd-err\ndone\n`;
      assert.strictEqual(readFileSync(logPath, 'utf8'), written);
      assert.strictEqual(result.tail, written.slice(-4000));
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a background script that crashes leaves the tail of what it wrote, its crash's text included", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec('import ctypes\nprint("watching")\nctypes.pythonapi.Py_FatalError(b"probe reason")', [], {
          logPath: null,
          lifetimeMs: 30_000,
          onWake: async () => null,
        }),
        'the crash to settle',
      );
      assert.strictEqual(result.aborted, true);
      assert.match(result.tail ?? '', /^watching\nFatal Python error: probe reason\n[\s\S]*\npython runtime exited unexpectedly \(code=null, signal=SIGABRT\)$/);
    } finally {
      runner.dispose();
    }
  });

  it("a background script's journal has each line as it's written, and ends saying why the script was stopped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const pending = runner.exec('import asyncio\nprint("watching")\nawait asyncio.sleep(30)', [], {
        logPath,
        lifetimeMs: 60_000,
        onWake: async () => null,
      });
      await until(() => existsSync(logPath) && readFileSync(logPath, 'utf8') === 'watching\n', 'its line in the journal');
      runner.abort('stopped watching');
      const result = await pending;
      assert.strictEqual(result.tail, 'watching\nscript aborted by host: stopped watching');
      assert.strictEqual(readFileSync(logPath, 'utf8'), 'watching\nscript aborted by host: stopped watching\n');
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a journal that can't be written says so once in the host's log, and its tail goes on", { skip: process.platform !== 'linux' ? 'writes to /dev/full fail only on Linux' : false }, async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("one")\nprint("two")', [], { logPath: '/dev/full', lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail);
      assert.strictEqual(result.tail, 'one\ntwo\n');
      assert.strictEqual(logged.filter((l) => /cannot write the log file any more: .*ENOSPC/.test(l)).length, 1, JSON.stringify(logged));
    } finally {
      console.error = consoleError;
      runner.dispose();
    }
  });

  it('wake_agent is absent in foreground scripts', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("wake_agent" in globals())', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /False/);
    } finally {
      runner.dispose();
    }
  });
});

describe('framework background scripts + spill (real python3)', () => {
  async function createBgFramework(storePath: string, membrane: MockMembrane, opts?: {
    mountDir?: string;
    codeExecution?: Record<string, unknown>;
  }) {
    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const modules: Module[] = [new ScriptToolModule()];
    let workspace: InstanceType<typeof WorkspaceModule> | null = null;
    if (opts?.mountDir) {
      workspace = new WorkspaceModule({
        mounts: [{ name: 'files', path: opts.mountDir, mode: 'read-write', watch: 'never' }],
      });
      modules.push(workspace as unknown as Module);
    }
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
      }],
      modules,
      syncIntervalMs: 0,
      codeExecution: {
        enabled: true,
        wakeMinIntervalMs: 0,
        ...(opts?.codeExecution ?? {}),
      },
    });
    // Host wiring (fkm does this in production): mounts populate in initStore.
    workspace?.initStore(framework.getStore());
    return framework;
  }

  it('background script detaches, wakes the agent with provenance, and triggers inference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgfw-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    const bgCode = [
      'import asyncio',
      'await asyncio.sleep(0.2)',
      'await wake_agent({"found": "signal"})',
    ].join('\\n');

    // Turn 1: spawn the background script, then finish the turn.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Arming watcher.' },
      { type: 'tool_use', id: 'call_bg1', name: 'code_execution', input: { code: bgCode.split('\\n').join('\n'), background: true } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Watcher armed; resting.' }]));
    // Turn 2 (the wake): agent answers.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke and handled.' }]));

    const framework = await createBgFramework(storePath, membrane, { mountDir });
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'arm a watcher' }],
        metadata: {},
        triggerInference: true,
      } as unknown as ProcessEvent);

      // Wait for: turn 1 result mentions script started, then wake message lands.
      const deadline = Date.now() + 20_000;
      let wakeMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !wakeMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        wakeMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(wakeMessage, 'wake message should be injected');
      const text = (wakeMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /\[background script bg-\d+\] Woke you/);
      assert.match(text, /line 3 of your script/);
      assert.match(text, /"found": "signal"/);
      assert.match(text, /workspace file files\/background-scripts\/bg-\d+\.log/);
      assert.match(text, /Script status: still running|Script status/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('list and cancel manage the daemon fleet; cap enforced', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bglist-');
    const membrane = new MockMembrane();
    const framework = await createBgFramework(storePath, membrane, {
      codeExecution: { maxBackgroundScripts: 1 },
    });
    try {
      const idle = 'import asyncio\nawait asyncio.sleep(60)';
      const first = await framework.executeToolCall({
        id: 'c1', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(first.success, true, JSON.stringify(first));
      const firstId = (first.data as { script_id: string }).script_id;

      const second = await framework.executeToolCall({
        id: 'c2', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(second.isError, true);
      assert.match(String(second.error), /limit reached/);

      const list = await framework.executeToolCall({
        id: 'c3', name: 'code_execution', input: { action: 'list' }, callerAgentName: 'prime',
      });
      const scripts = (list.data as { background_scripts: Array<{ script_id: string; status: string }> }).background_scripts;
      assert.strictEqual(scripts.filter((s) => s.status === 'running').length, 1);

      const cancel = await framework.executeToolCall({
        id: 'c4', name: 'code_execution', input: { action: 'cancel', script_id: firstId }, callerAgentName: 'prime',
      });
      assert.strictEqual(cancel.success, true);
      assert.strictEqual((cancel.data as { status: string }).status, 'cancelled');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('crashed background script wakes the agent with the error tail', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgcrash-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const framework = await createBgFramework(storePath, membrane, {});
    try {
      framework.start();
      const started = await framework.executeToolCall({
        id: 'c1',
        name: 'code_execution',
        input: { code: 'import asyncio\nawait asyncio.sleep(0.1)\nraise ValueError("watcher exploded")', background: true },
        callerAgentName: 'prime',
      });
      assert.strictEqual(started.success, true, JSON.stringify(started));

      const deadline = Date.now() + 20_000;
      let crashMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !crashMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        crashMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(crashMessage, 'crash wake should be injected');
      const text = (crashMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /DIED/);
      assert.match(text, /ValueError: watcher exploded/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('oversized tool results spill to a workspace file with a reference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-spill-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    // big module: returns ~600KB (strategy default maxMessageTokens absent →
    // maxChars undefined → no spill). Force the cap via agent_settings-style
    // override path by configuring a small maxMessageTokens on the agent.
    class BigToolModule implements Module {
      readonly name = 'big';
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] {
        return [{ name: 'blob', description: 'Returns JSON: huge string.', inputSchema: { type: 'object', properties: {} } }];
      }
      async handleToolCall(): Promise<ToolResult> {
        return { success: true, data: { blob: 'x'.repeat(600_000) } };
      }
      async onProcess(event: ProcessEvent): Promise<EventResponse> {
        if (event.type === 'external-message') {
          return {
            addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
            requestInference: true,
          };
        }
        return {};
      }
    }

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Fetching blob.' },
      { type: 'tool_use', id: 'call_blob', name: 'big--blob', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));

    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const spillWorkspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
    });
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
        strategy: new CappedPassthroughStrategy() as never,
      }],
      modules: [
        new BigToolModule(),
        spillWorkspace as unknown as Module,
      ],
      syncIntervalMs: 0,
      codeExecution: { enabled: true },
    });
    spillWorkspace.initStore(framework.getStore());
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'get the blob' }],
        metadata: {},
        triggerInference: true,
      } as unknown as ProcessEvent);

      const deadline = Date.now() + 20_000;
      let toolResultText: string | null = null;
      while (Date.now() < deadline && !toolResultText) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: Array<{ type: string; content?: string }> }>;
        for (const m of msgs) {
          for (const b of m.content ?? []) {
            if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[truncated')) {
              toolResultText = b.content;
            }
          }
        }
      }
      assert.ok(toolResultText, 'spilled tool result should be stored');
      assert.match(toolResultText, /full content: workspace file files\/tool-results\//);
      assert.match(toolResultText, /tool_result_inline_max_chars/);
      assert.ok(toolResultText.length < 20_000, 'inline copy must be capped');
      // The full content lives in the chronicle tree — the same place the
      // agent's own read tool looks (disk materialization is async and
      // watch-mode-dependent; not what we're testing here).
      const refMatch = toolResultText.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const spilledFile = await spillWorkspace.readBinary(refMatch[1]);
      assert.ok('data' in spilledFile, `spill file should be readable: ${JSON.stringify(spilledFile)}`);
      assert.ok((spilledFile as { data: Buffer }).data.byteLength >= 600_000, 'full content in file');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

type ContentBlockLike = { type: string; text?: string };

import { PassthroughStrategy } from '../src/index.js';
class CappedPassthroughStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

describe('code_execution per-call time limit (time_limit_ms)', () => {
  it('PyRunner: a per-exec deadline replaces scriptTimeoutMs, and the result says the time ran out', async () => {
    const runner = new PyRunner({ scriptTimeoutMs: 600_000, onToolCall: async () => '' });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 15_000, 'the per-exec deadline was not applied');
    } finally {
      runner.dispose();
    }
  });

  it('PyRunner: a script that catches the cancellation and finishes is not reported as stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = 'import asyncio\ntry:\n    await asyncio.sleep(60)\nexcept asyncio.CancelledError:\n    print("cleaned up")';
      const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /cleaned up/);
      assert.doesNotMatch(result.stderr, /script stopped/);
    } finally {
      runner.dispose();
    }
  });

  it('PyRunner: a deadline beyond Node timers (~24.8 days) is clamped, not fired at once', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(0.3)\nprint("done")', [], undefined, { deadlineMs: 30 * 86_400_000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /done/);
    } finally {
      runner.dispose();
    }
  });

  it('a ceiling below the default is refused when the framework is created', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-badcfg-');
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new MockMembrane().asMembrane(),
          agents: [],
          modules: [],
          syncIntervalMs: 0,
          codeExecution: { enabled: true, scriptTimeoutMs: 600_000, maxScriptTimeoutMs: 60_000 },
        }),
        /maxScriptTimeoutMs \(60000\) must be at least scriptTimeoutMs \(600000\)/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function withFramework(
    codeExecution: Record<string, unknown>,
    body: (framework: AgentFramework) => Promise<void>,
  ): Promise<void> {
    const { tempDir, storePath } = tempStorePath('pytc-timeout-');
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, ...codeExecution },
    });
    try {
      await body(framework);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const run = (framework: AgentFramework, input: Record<string, unknown>) =>
    framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
  const dataOf = (r: ToolResult) => r.data as { stdout: string; stderr: string; return_code: number; time_limit_note?: string };

  it('the tool tells the agent its time limit and offers time_limit_ms', async () => {
    await withFramework({ scriptTimeoutMs: 300_000, maxScriptTimeoutMs: 1_800_000 }, async (framework) => {
      const tool = framework.getAllTools().find((t) => t.name === 'code_execution')!;
      assert.match(tool.description, /A foreground script is stopped after 5 min; pass time_limit_ms to set this call's limit \(at most 30 min; a background script runs up to 24 h\)/);
      const props = (tool.inputSchema as { properties: Record<string, { description: string }> }).properties;
      assert.match(props.time_limit_ms.description, /Default 300000, at most 1800000/);
    });
  });

  it('time_limit_ms shortens one call; the deployment default is unchanged for the next', async () => {
    await withFramework({ scriptTimeoutMs: 600_000 }, async (framework) => {
      const short = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 1000 }));
      assert.strictEqual(short.return_code, 1);
      assert.match(short.stderr, /reached its 1s time limit/);
      const normal = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(1.5)\nprint("done")' }));
      assert.strictEqual(normal.return_code, 0);
      assert.match(normal.stdout, /done/);
    });
  });

  it('a request above the ceiling is capped, and the result says so', async () => {
    await withFramework({ scriptTimeoutMs: 1000 }, async (framework) => {
      const started = Date.now();
      const r = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 60_000 }));
      assert.strictEqual(r.return_code, 1);
      assert.strictEqual(r.time_limit_note, "time_limit_ms 60000 was capped at 1000, this deployment's maximum");
      assert.ok(Date.now() - started < 15_000, 'the cap was not applied');
    });
  });

  it('maxScriptTimeoutMs lets an agent ask for longer than the default', async () => {
    await withFramework({ scriptTimeoutMs: 1000, maxScriptTimeoutMs: 10_000 }, async (framework) => {
      const code = 'import asyncio\nawait asyncio.sleep(2)\nprint("long done")';
      const defaulted = dataOf(await run(framework, { code }));
      assert.strictEqual(defaulted.return_code, 1, 'without time_limit_ms the 1s default applies');
      const longer = dataOf(await run(framework, { code, time_limit_ms: 5000 }));
      assert.strictEqual(longer.return_code, 0);
      assert.match(longer.stdout, /long done/);
      assert.strictEqual(longer.time_limit_note, undefined);
    });
  });

  it('an invalid time_limit_ms is refused before anything runs', async () => {
    await withFramework({}, async (framework) => {
      for (const time_limit_ms of ['soon', 10, -5, Number.NaN]) {
        const r = await run(framework, { code: 'print("ran")', time_limit_ms });
        assert.strictEqual(r.success, false, String(time_limit_ms));
        assert.match(String(r.error), /time_limit_ms/);
      }
    });
  });

  it('a background script: time_limit_ms shortens its lifetime, capped at the lifetime ceiling', async () => {
    await withFramework({ backgroundMaxLifetimeMs: 1500 }, async (framework) => {
      const r = await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', background: true, time_limit_ms: 60_000 });
      assert.strictEqual(r.success, true);
      const data = r.data as { script_id: string; time_limit_note?: string; lifetime: string };
      assert.strictEqual(data.time_limit_note, "time_limit_ms 60000 was capped at 1500, this deployment's maximum");
      assert.strictEqual(data.lifetime, '2s', 'a short lifetime is reported exactly, not rounded to 0 hours');
      let status = 'running';
      const until = Date.now() + 15_000;
      while (status === 'running' && Date.now() < until) {
        await new Promise((res) => setTimeout(res, 200));
        const listed = (await run(framework, { action: 'list' })).data as { background_scripts: Array<{ script_id: string; status: string }> };
        status = listed.background_scripts.find((s) => s.script_id === data.script_id)?.status ?? 'gone';
      }
      assert.strictEqual(status, 'died', 'the script was stopped at its capped lifetime');
    });
  });
});

// The deadline's cancel op is an asyncio cancellation, which lands only when a
// script awaits; the SIGINT that follows it stops blocking code (#235 F3).
describe('code_execution time limit vs blocking code (real python3)', { skip: process.platform === 'win32' }, () => {
  const pidOf = (stdout: string) => /pid=(\d+)/.exec(stdout)?.[1];

  it('blocking code stops at the time limit, keeping its output, and the interpreter survives', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      const pid = pidOf(first.stdout);
      assert.ok(pid, first.stdout);
      const blocking: Record<string, string> = {
        sleep: 'import time\nprint("before")\ntime.sleep(60)\nprint("after")',
        'busy loop': 'print("before")\nn = 0\nwhile True:\n    n += 1\nprint("after")',
        'blocking read': 'import socket\nprint("before")\na, b = socket.socketpair()\na.recv(1)\nprint("after")',
      };
      for (const [shape, code] of Object.entries(blocking)) {
        const started = Date.now();
        const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
        const elapsed = Date.now() - started;
        assert.strictEqual(result.returnCode, 1, shape);
        assert.strictEqual(result.aborted, undefined, `${shape}: interrupted, not killed`);
        assert.strictEqual(result.stdout, 'before\n', `${shape}: output before the limit is kept`);
        assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/, shape);
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/, shape);
        assert.match(result.stderr, /File "<script>", line \d+/, `${shape}: says where the script was`);
        assert.doesNotMatch(result.stderr, /runtime\.py/, `${shape}: no runtime frames`);
        assert.ok(elapsed < 5000, `${shape}: stopped at the limit, not the kill grace (${elapsed}ms)`);
      }
      const last = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(pidOf(last.stdout), pid, 'same interpreter: nothing was killed');
    } finally {
      runner.dispose();
    }
  });

  it('variables survive an interrupted script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const set = await runner.exec('x = 41', []);
      assert.strictEqual(set.returnCode, 0, set.stderr);
      const stopped = await runner.exec('import time\ny = 1\ntime.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.match(stopped.stderr, /reached its 1s time limit/);
      const after = await runner.exec('print(x + y)', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, '42\n');
    } finally {
      runner.dispose();
    }
  });

  it('a script waiting on an await is still stopped by the cancel', async () => {
    const runner = new PyRunner({
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const started = Date.now();
      const result = await runner.exec('print("before")\nawait test__echo({})\nprint("after")', ECHO_TOOLS, undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script cancelled by host/);
      assert.doesNotMatch(result.stderr, /interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 5000, 'stopped at the limit');
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT between scripts does nothing', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nx = 1\nprint(f"pid={os.getpid()}")', []);
      const pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      process.kill(pid, 'SIGINT');
      await new Promise((r) => setTimeout(r, 200));
      const result = await runner.exec('print(x)\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `1\npid=${pid}\n`);
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT while a script waits cancels it before it can resume into blocking code', async () => {
    let pid = 0;
    const runner = new PyRunner({
      onToolCall: async () => {
        // The script is suspended on this call. The signal arrives with no cancel op behind it;
        // the result does, and the script would then block.
        process.kill(pid, 'SIGINT');
        await new Promise((r) => setTimeout(r, 200));
        return 'tool ok';
      },
    });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      const started = Date.now();
      const result = await runner.exec('import time\nprint(await test__echo({}))\ntime.sleep(30)', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, '');
      // Cancelled at its await (or, if the signal beat the script to it, interrupted there).
      assert.match(result.stderr, /KeyboardInterrupt: script (cancelled|interrupted) by host/);
      assert.ok(Date.now() - started < 5000, 'stopped at once, not after the blocking call');
      const after = await runner.exec('print(f"pid={os.getpid()}")', []);
      assert.strictEqual(after.stdout, `pid=${pid}\n`, 'same interpreter');
    } finally {
      runner.dispose();
    }
  });

  it('a script that resumes from an await into blocking code at its limit is stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const result = await runner.exec('import asyncio, time\nawait asyncio.sleep(1)\ntime.sleep(5)\nprint("after")', [], undefined, { deadlineMs: 1000 });
        assert.strictEqual(result.returnCode, 1, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
        assert.ok(Date.now() - started < 3000, `stopped at the limit (${Date.now() - started}ms)`);
      }
    } finally {
      runner.dispose();
    }
  });

  it("the runtime's stop table: each place a signal or cancel op can land stops the script once", () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-stop-rows-'));
    try {
      writeFileSync(join(dir, 'runtime.py'), PYTHON_RUNTIME_SOURCE);
      writeFileSync(join(dir, 'driver.py'), PYTC_STOP_ROWS_DRIVER);
      type Row = { rc: number | null; tail: string; secs: number; ops: string[] };
      const rows = JSON.parse(
        execFileSync('python3', [join(dir, 'driver.py'), join(dir, 'runtime.py')], { encoding: 'utf8', timeout: 60_000 }),
      ) as Record<string, Row>;
      const printed = (row: Row, line: string) => row.tail.split('\n').includes(line);
      const interrupted = /KeyboardInterrupt: script interrupted by host/;
      const cancelled = /KeyboardInterrupt: script cancelled by host/;
      const stopped = (name: string, how: RegExp, has: string[] = [], hasNot: string[] = []) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 1, `${name}: ${row.tail}`);
        assert.match(row.tail, how, name);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        for (const w of hasNot) assert.ok(!printed(row, w), `${name}: did not print ${w}`);
        assert.ok(row.secs < 2, `${name}: stopped at once (${row.secs}s)`);
      };
      const finished = (name: string, has: string[]) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 0, `${name}: ${row.tail}`);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        assert.doesNotMatch(row.tail, /by host/, `${name}: never stopped (again) by us`);
      };

      stopped('1 own code', interrupted, ['a'], ['b']);
      stopped('2 waiting on an await', cancelled, [], ['b']);
      // Cancelling inside the handler here raised InvalidStateError out of main().
      stopped('3 mid-dispatch, reply behind', cancelled, [], ['woke']);
      stopped('4 protocol write', cancelled, [], ['b']);
      assert.ok(rows['4 protocol write'].ops.includes('tool_call'), 'the protocol line stayed whole');
      stopped('5 reply ahead, then await', cancelled, ['woke'], ['b']);
      // Interrupted in its blocking code; the queued cancellation must not cut its cleanup short.
      finished('6 reply ahead, then block', ['woke', 'cleaned']);
      finished('7 reply ahead, then finish', ['woke']);
      finished('7 next script', ['ok']);
      stopped('8 before start, signal', cancelled, [], ['ran']);
      // The cancel op before the script started used to leave it reporting nothing.
      stopped('8 before start, cancel op', cancelled, [], ['ran']);
      finished('9 cancel op first', ['cleaned']);
      finished('10 after delivery', ['cleaned']);
      finished('11 reporting', ['done']);
      finished('12 between scripts', ['ok']);
      if (rows['13 next script blocks']) {
        // Python 3.12+: an eager task factory left installed by an earlier script.
        finished('13 eager task factory installed', ['installed']);
        stopped('13 next script blocks', interrupted, ['a'], ['b']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an eager task factory installed by an earlier script does not hide the next one from the deadline', async (t) => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 3000 });
    try {
      const install = await runner.exec(
        'import asyncio, sys\nif sys.version_info >= (3, 12):\n    asyncio.get_running_loop().set_task_factory(asyncio.eager_task_factory)\n    print("installed")',
        [],
      );
      assert.strictEqual(install.returnCode, 0, install.stderr);
      if (install.stdout !== 'installed\n') {
        t.skip('asyncio.eager_task_factory needs Python 3.12+');
        return;
      }
      const started = Date.now();
      const result = await runner.exec('import time\nprint("before")\ntime.sleep(30)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.aborted, undefined, 'interrupted, not killed');
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 2500, `stopped at the limit (${Date.now() - started}ms)`);
    } finally {
      runner.dispose();
    }
  });

  it('a script that ignores the interrupt is killed after the grace, and its interpreter state is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      assert.strictEqual((await runner.exec('x = 41', [])).returnCode, 0);
      const code = 'import time\ntry:\n    time.sleep(60)\nexcept KeyboardInterrupt:\n    time.sleep(60)';
      const started = Date.now();
      const killed = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(killed.returnCode, 1);
      assert.strictEqual(
        killed.stderr,
        'script stopped: it reached its 1s time limit and did not respond, so it was killed and the interpreter restarted (variables from earlier scripts are gone)',
      );
      assert.ok(Date.now() - started < 5000, `killed after the grace (${Date.now() - started}ms)`);
      const after = await runner.exec('print(x)', []);
      assert.strictEqual(after.returnCode, 1);
      assert.match(after.stderr, /NameError: name 'x' is not defined/);
    } finally {
      runner.dispose();
    }
  });

  it('the time-limit note starts on a line of its own after an interpreter exit, whose text ends without one', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The interrupt at the limit ends the interpreter, so the exit handler settles the exec.
      const code = 'import os, signal, time\nsignal.signal(signal.SIGINT, lambda *_: os._exit(3))\ntime.sleep(30)';
      const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(
        result.stderr,
        'python runtime exited unexpectedly (code=3, signal=none)\nscript stopped: it reached its 1s time limit\n',
      );
    } finally {
      runner.dispose();
    }
  });
});
