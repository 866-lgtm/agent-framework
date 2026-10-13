/**
 * stop() closes the event queue before it stops modules, so a module's event
 * can arrive after the queue closed: from its own stop(), or from a listener
 * that fires while stop() runs. Nothing will process it, and the module's
 * callback has no one to catch a throw, so the event is dropped with a log
 * line. A direct caller of pushEvent() still learns the framework is stopped
 * by its throw.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A module that records the probe events it processes and keeps its context. */
function recorder(onStop?: (ctx: ModuleContext) => void): { module: Module; seen: string[]; context: () => ModuleContext } {
  let context: ModuleContext | undefined;
  const seen: string[] = [];
  return {
    seen,
    context: () => context!,
    module: {
      name: 'recorder',
      async start(ctx) { context = ctx; },
      async stop() { onStop?.(context!); },
      async onProcess(event) { if (event.type.startsWith('probe:')) seen.push(event.type); return {}; },
      getTools: () => [],
      async handleToolCall() { return { success: false, error: 'no tools', isError: true }; },
    },
  };
}

async function makeFramework(t: TestContext, modules: Module[]): Promise<AgentFramework> {
  const dir = mkdtempSync(join(tmpdir(), 'late-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test' }],
    modules,
  });
}

/** What the test logs to console.error. */
function captureErrors(t: TestContext): string[] {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  return logged;
}

/** Fails, rather than hangs, when what the test waits on never comes. */
async function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const dropped = (type: string, module: string) =>
  `[framework] a '${type}' event from module ${module} arrived after stop() began — dropped`;

test("a module's events are queued through pushEvent() and its deprecated queue handle while the framework runs", async (t) => {
  const probe = recorder();
  const framework = await makeFramework(t, [probe.module]);
  t.after(() => framework.stop().catch(() => {}));
  const traced: string[] = [];
  framework.onTrace((event) => { if (event.type === 'process:received') traced.push(event.processEvent.type); });
  probe.context().pushEvent({ type: 'probe:through-push-event' } as ProcessEvent);
  probe.context().queue.push({ type: 'probe:through-queue' } as ProcessEvent);
  await within(framework.runUntilIdle(), 'the events processed');
  assert.deepEqual(probe.seen, ['probe:through-push-event', 'probe:through-queue']);
  assert.deepEqual(traced.filter((type) => type.startsWith('probe:')), ['probe:through-push-event'], 'only pushEvent() traces, as before');
});

test("a module's event from its own stop() is dropped with a log line, and stop() completes", async (t) => {
  const probe = recorder((ctx) => {
    ctx.pushEvent({ type: 'probe:from-stop' } as ProcessEvent);
    ctx.queue.push({ type: 'probe:from-stop-queue' } as ProcessEvent);
  });
  const framework = await makeFramework(t, [probe.module]);
  const logged = captureErrors(t);
  await within(framework.stop(), 'stop()');
  for (const type of ['probe:from-stop', 'probe:from-stop-queue']) {
    assert.ok(logged.some((line) => line.includes(dropped(type, 'recorder'))), `${type}'s drop is logged:\n${logged.join('\n')}`);
  }
  assert.equal(logged.some((line) => /Queue is closed/.test(line)), false, logged.join('\n'));
});

test("a module's event after stop() finished is dropped with a log line, not thrown into its callback", async (t) => {
  const probe = recorder();
  const framework = await makeFramework(t, [probe.module]);
  const logged = captureErrors(t);
  await within(framework.stop(), 'stop()');
  assert.doesNotThrow(() => probe.context().pushEvent({ type: 'probe:late-push-event' } as ProcessEvent));
  assert.doesNotThrow(() => probe.context().queue.push({ type: 'probe:late-queue' } as ProcessEvent));
  for (const type of ['probe:late-push-event', 'probe:late-queue']) {
    assert.ok(logged.some((line) => line.includes(dropped(type, 'recorder'))), `${type}'s drop is logged:\n${logged.join('\n')}`);
  }
});

test('a direct caller of pushEvent() still learns the framework is stopped', async (t) => {
  const framework = await makeFramework(t, []);
  await within(framework.stop(), 'stop()');
  assert.throws(() => framework.pushEvent({ type: 'probe:direct' } as ProcessEvent), /Queue is closed/);
});
