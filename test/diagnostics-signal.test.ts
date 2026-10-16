/**
 * `kill -USR2 <pid>` dumps each framework from create() until stop(), through
 * one listener the process keeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-signal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(storePath: string, agent?: string) {
  return { storePath, membrane: new MockMembrane().asMembrane(),
    agents: agent ? [{ name: agent, model: 'test', systemPrompt: 'test' }] : [],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0 };
}

/** The [diagnostics] lines one SIGUSR2 prints, its listeners called as the signal calls them. */
function dump(t: import('node:test').TestContext): string[] {
  const lines: string[] = [];
  const logged = t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try { process.emit('SIGUSR2', 'SIGUSR2'); } finally { logged.mock.restore(); }
  return lines.filter(line => line.startsWith('[diagnostics]'));
}

test('frameworks created and stopped one after another share one SIGUSR2 listener', async t => {
  const dir = tempDir(t);
  const before = process.listenerCount('SIGUSR2');
  for (let i = 0; i < 3; i++) {
    const framework = await AgentFramework.create(config(join(dir, `store-${i}`)));
    await framework.stop();
  }
  assert.ok(process.listenerCount('SIGUSR2') - before <= 1,
    `${process.listenerCount('SIGUSR2') - before} listeners added`);
});

test('a SIGUSR2 dumps each framework from create() until stop(), and says when none is running', async t => {
  const dir = tempDir(t);
  const first = await AgentFramework.create(config(join(dir, 'first'), 'first-agent'));
  const second = await AgentFramework.create(config(join(dir, 'second'), 'second-agent'));
  const agentsOf = (lines: string[]) => lines.map(line => JSON.parse(line.slice('[diagnostics] '.length)).agents);
  assert.deepEqual(agentsOf(dump(t)), [['first-agent'], ['second-agent']]);
  await first.stop();
  assert.deepEqual(agentsOf(dump(t)), [['second-agent']]);
  await second.stop();
  assert.deepEqual(dump(t), ['[diagnostics] no framework is running in this process']);
  // A create() refused after it started its watchdog leaves through stop().
  await assert.rejects(AgentFramework.create({ ...config(join(dir, 'refused'), 'refused-agent'),
    toolResultInlineMaxChars: 1 }), /toolResultInlineMaxChars/);
  assert.deepEqual(dump(t), ['[diagnostics] no framework is running in this process']);
});

// Control: passes on main, whose listeners are never removed. Removing a
// process's last SIGUSR2 listener would restore the signal's default action,
// which ends the process.
test('a SIGUSR2 after every framework has stopped leaves the process running', async t => {
  const dir = tempDir(t);
  const script = join(dir, 'child.mjs');
  const index = pathToFileURL(join(import.meta.dirname, '../src/index.js')).href;
  const membrane = pathToFileURL(join(import.meta.dirname, 'helpers/mock-membrane.js')).href;
  writeFileSync(script, `
    import { AgentFramework } from ${JSON.stringify(index)};
    import { MockMembrane } from ${JSON.stringify(membrane)};
    const framework = await AgentFramework.create({
      storePath: ${JSON.stringify(join(dir, 'store'))}, membrane: new MockMembrane().asMembrane(),
      agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    await framework.stop();
    process.kill(process.pid, 'SIGUSR2');
    setTimeout(() => process.exit(0), 300);
  `);
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const safety = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('exit', (code, signal) => { clearTimeout(safety); resolve({ code, signal }); });
  });
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});
