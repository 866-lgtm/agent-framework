/**
 * A preview's request carries the render stats of the dry compile that built
 * it (`getRequestCompileStats`), so a host can show what the next request
 * would hold, by kind, without sending it (connectome-host#425). The stats
 * read back for a request are that compile's, whatever was compiled since.
 * Needs context-manager 0.20.1 or later, whose compiles carry render stats,
 * and is skipped with an older one, which agent-framework's range allows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, PassthroughStrategy, type CompileResult, type ContextManager } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'request-compile-stats-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new AutobiographicalStrategy() },
      { name: 'plain', model: 'test-model', systemPrompt: 'test', strategy: new PassthroughStrategy() },
    ],
    modules: [],
  });
  return {
    framework,
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A compile's result, with context-manager 0.20.1's `renderStats` read
 *  structurally, as `agent.ts` reads it. */
type Compiled = CompileResult & { renderStats?: unknown };

/** Every result `cm.compile` returns, in order. */
function recordResults(cm: ContextManager): Compiled[] {
  const results: Compiled[] = [];
  const original = cm.compile.bind(cm);
  (cm as unknown as { compile: (...args: unknown[]) => Promise<CompileResult> }).compile = async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<CompileResult>)(...args);
    results.push(result);
    return result;
  };
  return results;
}

const say = (cm: ContextManager, participant: string, text: string) => cm.addMessage(participant, [{ type: 'text', text }]);

/** context-manager 0.20.1 added the strategy method its compiles take
 *  render stats from; with an older one the accessor is always null. */
const compilesCarryStats = typeof (AutobiographicalStrategy.prototype as { getLastSelectStats?: unknown }).getLastSelectStats === 'function';

describe('the render stats of the dry compile behind a preview', {
  skip: compilesCarryStats ? false : 'needs context-manager 0.20.1, whose compiles carry render stats',
}, () => {
  it('are the ones the compile that built each request returned, and a later preview or live compile leaves an earlier request\'s alone', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      const cm = agent.getContextManager();
      const results = recordResults(cm);
      say(cm, 'user', 'the first thing said');
      const first = await x.framework.previewActivation('agent');
      const firstStats = x.framework.getRequestCompileStats(first);
      assert.ok(firstStats, 'the autobiographical strategy records stats for a dry compile');
      assert.equal(firstStats, results[0]!.renderStats, "the first request's are its own compile's");
      const asRead = structuredClone(firstStats);

      say(cm, 'agent', 'an answer');
      say(cm, 'user', 'and something more');
      const second = await x.framework.previewActivation('agent');
      const secondStats = x.framework.getRequestCompileStats(second);
      assert.equal(secondStats, results[1]!.renderStats, "the second request's are its own compile's");
      assert.ok(secondStats!.total.messages > asRead.total.messages, 'setup: the second compile selected more than the first');

      // A live compile, as a turn's request makes it, between the preview and the read.
      say(cm, 'agent', 'a later answer');
      await agent.buildActivationRequest([]);
      assert.ok(results[2]!.renderStats, 'setup: the live compile has stats of its own');

      assert.equal(x.framework.getRequestCompileStats(first), firstStats, 'the first request still reads its own compile\'s stats');
      assert.deepEqual(firstStats, asRead, 'and the later preview and live compile left them as they were');

      // previewActivation's other path, which gathers injections first.
      const gathering = await x.framework.previewActivation('agent', { injections: true });
      assert.ok(results[3]!.renderStats, 'setup: the gathering preview\'s compile has stats');
      assert.equal(x.framework.getRequestCompileStats(gathering), results[3]!.renderStats, "a preview that gathers injections reads back its own compile's");
    } finally { await x.close(); }
  });

  it('are null for a request that is sent, an object no compile built, and an agent whose strategy records none', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      say(agent.getContextManager(), 'user', 'something to compile');
      const results = recordResults(agent.getContextManager());
      // buildActivationRequest without dryRun runs the assembly a sent
      // request goes through, with a live compile: its stats exist, and the
      // accessor keeps none for it.
      const sent = await agent.buildActivationRequest([]);
      assert.ok(results[0]!.renderStats, 'setup: the sent compile has stats of its own');
      assert.equal(x.framework.getRequestCompileStats(sent), null);
      assert.equal(x.framework.getRequestCompileStats({}), null);

      const plain = x.framework.getAgent('plain')!.getContextManager();
      say(plain, 'user', 'something to compile');
      const plainResults = recordResults(plain);
      const plainPreview = await x.framework.previewActivation('plain');
      assert.equal(plainResults.length, 1, 'setup: the passthrough preview compiled');
      assert.equal(plainResults[0]!.renderStats, undefined, 'setup: a passthrough compile carries no stats');
      assert.equal(x.framework.getRequestCompileStats(plainPreview), null);
    } finally { await x.close(); }
  });
});
