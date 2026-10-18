/**
 * What the model reads when a foreground code_execution script ends: how it
 * ended first, then stderr, then stdout, kept within the agent's inline cap
 * by cutting each stream to its head and tail, with the whole text in the
 * tool result's file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Module, ToolResult } from '../src/index.js';
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import { scriptEndText, scriptEndTextWithin } from '../src/code-execution/result-text.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const CUT = /\[… (\d+) characters cut …\]\n/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A stream's body under its label in `text`, up to the next label or the end. */
function bodyOf(text: string, name: 'stderr' | 'stdout'): string | null {
  const start = text.indexOf(`--- ${name} ---\n`);
  if (start < 0) return null;
  const from = start + `--- ${name} ---\n`.length;
  const next = text.indexOf('\n--- stdout ---\n', from - 1);
  return name === 'stderr' && next >= 0 ? text.slice(from, next + 1) : text.slice(from);
}

/**
 * A cut body's head, the count it says was cut, and its tail. The marker
 * starts a line: after a head that ends a line, or after a newline of its own.
 */
function cutOf(body: string, original?: string): { head: string; cut: number; tail: string } {
  const m = CUT.exec(body);
  assert.ok(m, `no cut in ${JSON.stringify(body.slice(0, 80))}`);
  assert.ok(m.index === 0 || body[m.index - 1] === '\n', 'the marker starts a line');
  const cut = Number(m[1]);
  const tail = body.slice(m.index + m[0].length);
  const before = body.slice(0, m.index);
  const endsALine = original !== undefined && original.startsWith(before)
    && before.length + cut + tail.length === original.length;
  return { head: endsALine || before === '' ? before : before.slice(0, -1), cut, tail };
}

const numbered = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(5, '0')}\n`).join('');

describe('code_execution result text', () => {
  it('says how the script ended first, then stderr, then stdout, each under its label', () => {
    assert.strictEqual(scriptEndText({ stdout: 'hi\n', stderr: '', returnCode: 0 }), 'exit code: 0\n--- stdout ---\nhi\n');
    assert.strictEqual(
      scriptEndText({ stdout: 'out', stderr: 'warn', returnCode: 2, timeLimitNote: "time_limit_ms 60000 was capped at 1000, this deployment's maximum" }),
      "exit code: 2\ntime limit: time_limit_ms 60000 was capped at 1000, this deployment's maximum\n--- stderr ---\nwarn\n--- stdout ---\nout\n",
    );
    assert.strictEqual(scriptEndText({ stdout: '', stderr: '', returnCode: 0 }), 'exit code: 0\n');
  });

  it('is whole when it fits the budget', () => {
    const end = { stdout: 'a\n'.repeat(100), stderr: 'b\n', returnCode: 0 };
    const whole = scriptEndText(end);
    assert.strictEqual(scriptEndTextWithin(end, whole.length), whole);
  });

  it('keeps stderr whole ahead of a long stdout, and stdout\'s head and tail around the count cut', () => {
    // A script that prints 33,000 characters of numbered lines to stdout,
    // then an error line to stderr, then exits 5: stderr after stdout would
    // fall in the cut.
    const stdout = numbered(3000, 'line');
    const end = { stdout, stderr: 'an error line\n', returnCode: 5 };
    const text = scriptEndTextWithin(end, 24_000)!;
    assert.ok(text.length <= 24_000, String(text.length));
    assert.ok(text.startsWith('exit code: 5\n--- stderr ---\nan error line\n--- stdout ---\n'), text.slice(0, 120));
    const { head, cut, tail } = cutOf(bodyOf(text, 'stdout')!, stdout);
    assert.ok(head.startsWith('line 00000\nline 00001\n'), head.slice(0, 40));
    assert.ok(tail.endsWith('line 02998\nline 02999\n'), tail.slice(-40));
    assert.strictEqual(head.length + cut + tail.length, stdout.length, 'the count is what was cut');
    assert.strictEqual(stdout.slice(0, head.length), head);
    assert.strictEqual(stdout.slice(stdout.length - tail.length), tail);
    // Each cut falls at a line's end, so no part line reads as a whole one,
    // and the count follows on the next line, with no blank line between.
    assert.ok(head.endsWith('\n'), JSON.stringify(head.slice(-20)));
    assert.match(tail, /^line \d{5}\n/);
    assert.ok(!text.includes('\n\n['), 'a blank line before the count');
  });

  it('falls at a line\'s end on each side of a cut, whatever the budget', () => {
    const stdout = numbered(3000, 'line');
    // Eleven budgets in a row: cut at the length each side is given, most of
    // them would fall mid-line, since each line is 11 characters.
    for (let budget = 24_000; budget <= 24_010; budget++) {
      const text = scriptEndTextWithin({ stdout, stderr: '', returnCode: 0 }, budget)!;
      const { head, tail } = cutOf(bodyOf(text, 'stdout')!, stdout);
      assert.ok(head.endsWith('\n'), `the head at budget ${budget}: ${JSON.stringify(head.slice(-12))}`);
      assert.match(tail, /^line \d{5}\n/, `the tail at budget ${budget}`);
    }
  });

  it('cuts mid-line when no line ends near the cut, and the count still says what was cut', () => {
    const stdout = 'a'.repeat(20_000) + '\n' + 'b'.repeat(20_000);
    const text = scriptEndTextWithin({ stdout, stderr: '', returnCode: 0 }, 4000)!;
    const { head, cut, tail } = cutOf(bodyOf(text, 'stdout')!.replace(/\n$/, ''), stdout);
    assert.ok(/^a+$/.test(head) && /^b+$/.test(tail), `${head.slice(-5)} | ${tail.slice(0, 5)}`);
    assert.strictEqual(head.length + cut + tail.length, stdout.length);
  });

  it('gives stderr a third of the room when both streams are long, and keeps the end of each', () => {
    const stderr = numbered(2000, 'err');
    const stdout = numbered(2000, 'out');
    const end = { stdout, stderr, returnCode: 1 };
    const budget = 9000;
    const text = scriptEndTextWithin(end, budget)!;
    assert.ok(text.length <= budget, String(text.length));
    const room = budget - 'exit code: 1\n'.length - 2 * ('--- stderr ---\n'.length + 1);
    const err = bodyOf(text, 'stderr')!;
    const out = bodyOf(text, 'stdout')!;
    // A third of the room, less what falling at a line's end left out: under
    // a 10-character line on each side of the cut.
    assert.ok(err.length <= Math.ceil(room / 3) && err.length > Math.ceil(room / 3) - 20, `${err.length} of ${room}`);
    assert.ok(cutOf(err).tail.endsWith('err 01999\n'));
    assert.ok(cutOf(out).tail.endsWith('out 01999\n'));
    assert.ok(out.length > err.length);
  });

  it('keeps stderr\'s last line whole in its tail when the line fits, and the end of a longer one', () => {
    const stdout = numbered(2000, 'out');
    const budget = 9000;
    // Its default tail would be about 1,480 characters, shorter than this line.
    const lastLine = `ValueError: ${'v'.repeat(1500)}\n`;
    const stderr = numbered(2000, 'tb') + lastLine;
    const text = scriptEndTextWithin({ stdout, stderr, returnCode: 1 }, budget)!;
    assert.ok(text.length <= budget, String(text.length));
    assert.strictEqual(cutOf(bodyOf(text, 'stderr')!, stderr).tail, lastLine);
    // A last line longer than stderr's room keeps its end.
    const longest = `ValueError: ${'w'.repeat(4000)}\n`;
    const over = scriptEndTextWithin({ stdout, stderr: numbered(2000, 'tb') + longest, returnCode: 1 }, budget)!;
    assert.ok(over.length <= budget, String(over.length));
    const { tail } = cutOf(bodyOf(over, 'stderr')!);
    assert.ok(/^w+\n$/.test(tail) && longest.endsWith(tail), tail.slice(0, 20));
  });

  it('gives stderr the room stdout leaves, and all of it when stdout is empty', () => {
    const stderr = numbered(2000, 'err');
    const short = scriptEndTextWithin({ stdout: 'done\n', stderr, returnCode: 1 }, 5000)!;
    assert.ok(short.length <= 5000);
    assert.ok(short.endsWith('--- stdout ---\ndone\n'), 'a short stdout stays whole');
    assert.ok(cutOf(bodyOf(short, 'stderr')!).tail.endsWith('err 01999\n'));
    const alone = scriptEndTextWithin({ stdout: '', stderr, returnCode: 1 }, 5000)!;
    assert.strictEqual(bodyOf(alone, 'stdout'), null);
    assert.ok(alone.length <= 5000 && alone.length >= 4990, String(alone.length));
  });

  it('never splits a surrogate pair at a cut', () => {
    const stdout = '🌱'.repeat(10_000);
    const stderr = 'é🌱'.repeat(5_000);
    for (let budget = 3001; budget <= 3012; budget++) {
      const text = scriptEndTextWithin({ stdout, stderr, returnCode: 0 }, budget)!;
      assert.ok(text.length <= budget, `${text.length} > ${budget}`);
      assert.ok(!LONE_SURROGATE.test(text), `a lone surrogate at budget ${budget}`);
    }
  });

  it('is null when the budget cannot hold the heading and a cut of each stream', () => {
    assert.strictEqual(scriptEndTextWithin({ stdout: 'x'.repeat(1000), stderr: '', returnCode: 0 }, 60), null);
  });
});

describe('code_execution result text, through the framework (real python3)', () => {
  /** An agent whose strategy bounds its inline cap at 4 characters a token. */
  const agentWithTokenBound = (maxMessageTokens: number) => {
    class Bounded extends PassthroughStrategy { readonly maxMessageTokens = maxMessageTokens; }
    return { name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' as const, strategy: new Bounded() as never };
  };

  async function withFramework(
    opts: {
      workspace: boolean;
      codeExecution?: Record<string, unknown>;
      agents?: Parameters<typeof AgentFramework.create>[0]['agents'];
      toolResultInlineMaxChars?: number;
    },
    body: (framework: AgentFramework, readSpill: (path: string) => Promise<string>, failWrites: () => void) => Promise<void>,
  ): Promise<void> {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-text-'));
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const workspace = opts.workspace
      ? new WorkspaceModule({ mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }] })
      : null;
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: opts.agents ?? [],
      modules: workspace ? [workspace as unknown as Module] : [],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, ...opts.codeExecution },
      ...(opts.toolResultInlineMaxChars !== undefined ? { toolResultInlineMaxChars: opts.toolResultInlineMaxChars } : {}),
    });
    workspace?.initStore(framework.getStore());
    try {
      await body(
        framework,
        async (path) => {
          const read = await workspace!.readBinary(path);
          assert.ok('data' in read, JSON.stringify(read));
          return (read as { data: Buffer }).data.toString('utf8');
        },
        () => { workspace!.writeBinary = async () => ({ success: false, error: 'disk full', isError: true }); },
      );
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const run = (framework: AgentFramework, id: string, input: Record<string, unknown>, callerAgentName?: string) =>
    framework.executeToolCall({ id, name: 'code_execution', input, ...(callerAgentName ? { callerAgentName } : {}) });
  const textOf = (r: ToolResult) => {
    assert.ok(Array.isArray(r.data), JSON.stringify(r.data).slice(0, 200));
    const blocks = r.data as Array<{ type: string; text: string }>;
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'text');
    return blocks[0].text;
  };

  // 30,000 characters to stdout, then an error line to stderr, then
  // SystemExit(5). The runtime reports a script's SystemExit as an
  // exception: exit code 1, and its traceback after the error line.
  const outputTail = 'import sys\nsys.stdout.write("x" * 30000)\nsys.stderr.write("an error line\\n")\nraise SystemExit(5)';

  it('a long stdout keeps stderr and the exit code in view, and the whole output goes to the tool result\'s file', async () => {
    await withFramework({ workspace: true }, async (framework, readSpill) => {
      const r = await run(framework, 'ce-output-tail', { code: outputTail });
      assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
      const text = textOf(r);
      assert.ok(text.length <= 24_000, `${text.length} characters, over the default inline cap`);
      const { stderr } = r.structured as { stderr: string };
      assert.match(stderr, /^an error line\nTraceback \(most recent call last\):\n[\s\S]*SystemExit: 5\n$/);
      assert.ok(text.startsWith(`exit code: 1\n--- stderr ---\n${stderr}--- stdout ---\nxxx`), text.slice(0, 400));
      const notice = /\n\[cut to fit; the whole output \((\d+) chars\): workspace file (files\/tool-results\/\S+-ce-output-tail\.txt)\. Page with workspace--read \{"path":"files\/tool-results\/\S+","offsetChars":0,"limitChars":\d+\}; use nextOffsetChars as offsetChars until null, keeping limitChars\. Or raise the inline cap via agent_settings update tool_result_inline_max_chars\.\]$/.exec(text);
      assert.ok(notice, text.slice(-400));
      const whole = await readSpill(notice[2]);
      assert.strictEqual(whole, `exit code: 1\n--- stderr ---\n${stderr}--- stdout ---\n${'x'.repeat(30_000)}\n`);
      assert.strictEqual(Number(notice[1]), whole.length);
      // Hosts read the fields, whole, in structured.
      assert.deepStrictEqual(r.structured, { stdout: 'x'.repeat(30_000), stderr, return_code: 1 });
    });
  });

  it('a stopped script\'s reason stays in view ahead of a long stdout', async () => {
    await withFramework({ workspace: false, codeExecution: { scriptTimeoutMs: 600_000 } }, async (framework) => {
      const code = 'import sys, asyncio\nsys.stdout.write("y" * 30000)\nsys.stdout.flush()\nawait asyncio.sleep(60)';
      const r = await run(framework, 'ce-stopped', { code, time_limit_ms: 1000 });
      const text = textOf(r);
      assert.ok(text.length <= 24_000, String(text.length));
      const stderr = bodyOf(text, 'stderr');
      assert.ok(stderr, text.slice(0, 300));
      assert.match(stderr, /\nscript stopped: it reached its 1s time limit\. [^\n]*To give it longer, pass time_limit_ms up to 600000 \(10 min\)\.\n$/);
      assert.ok(text.startsWith(`exit code: ${(r.structured as { return_code: number }).return_code}\n--- stderr ---\n`), text.slice(0, 120));
      assert.ok(text.indexOf('script stopped') < text.indexOf('--- stdout ---\nyyy'));
      assert.match(text, /\n\[cut to fit; the whole output was \d+ chars, and with no writable workspace, what was cut was not retained\]$/);
    });
  });

  it('a failed write of the whole output says so', async () => {
    await withFramework({ workspace: true }, async (framework, _readSpill, failWrites) => {
      failWrites();
      const text = textOf(await run(framework, 'ce-write-fails', { code: outputTail }));
      assert.ok(text.length <= 24_000, String(text.length));
      assert.ok(text.startsWith('exit code: 1\n--- stderr ---\nan error line\nTraceback'), text.slice(0, 80));
      assert.match(text, /\n\[cut to fit; writing the whole output \(\d+ chars\) to workspace file files\/tool-results\/\S+-ce-write-fails\.txt FAILED \(disk full\); what was cut was not retained\]$/);
    });
  });

  it('the calling agent\'s own inline cap bounds the text', async () => {
    await withFramework({ workspace: true, toolResultInlineMaxChars: 5000, agents: [agentWithTokenBound(0)] }, async (framework) => {
      const text = textOf(await run(framework, 'ce-agent-cap', { code: outputTail }, 'prime'));
      assert.ok(text.length <= 5000 && text.length > 4500, String(text.length));
      assert.ok(text.startsWith('exit code: 1\n--- stderr ---\nan error line\n'), text.slice(0, 80));
      assert.match(text, /\n\[cut to fit; the whole output \(\d+ chars\): workspace file files\/tool-results\/\S+-ce-agent-cap\.txt\. /);
    });
  });

  it('a cap too small for a cut of each stream leaves the whole text to the inline cap\'s spill', async () => {
    // 50 tokens bound the cap at 200 characters, less than the notice alone.
    await withFramework({ workspace: true, agents: [agentWithTokenBound(50)] }, async (framework) => {
      const r = await run(framework, 'ce-tiny-cap', { code: outputTail }, 'prime');
      const { stderr } = r.structured as { stderr: string };
      assert.strictEqual(textOf(r), `exit code: 1\n--- stderr ---\n${stderr}--- stdout ---\n${'x'.repeat(30_000)}\n`);
    });
  });

  it('a short run reads as its text, whole, with nothing written', async () => {
    await withFramework({ workspace: true }, async (framework) => {
      const r = await run(framework, 'ce-short', { code: 'print("hello")' });
      assert.strictEqual(textOf(r), 'exit code: 0\n--- stdout ---\nhello\n');
      assert.deepStrictEqual(r.structured, { stdout: 'hello\n', stderr: '', return_code: 0 });
    });
  });
});
