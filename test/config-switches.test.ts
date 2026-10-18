/**
 * The framework's and each agent's boolean switches take true or false, or
 * can be left out, with null counting as left out. Each was read by
 * truthiness, so a quoted "false", as a JSON config or a `${VAR}`
 * substitution can write it, turned it on, and a falsy non-boolean such as 0
 * turned it off without a word.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

const createWith = (storePath: string, config: Record<string, unknown>) =>
  AgentFramework.create({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [],
    modules: [],
    syncIntervalMs: 0,
    ...config,
  } as never);

const agentWith = (settings: Record<string, unknown>) => ({
  name: 'agent',
  model: 'test-model',
  systemPrompt: 'test',
  ...settings,
});

/** create() refuses each config with exactly its message, before anything
 *  opens: no store is left at storePath. */
async function assertRefused(cases: ReadonlyArray<readonly [Record<string, unknown>, string]>): Promise<void> {
  const { tempDir, storePath } = tempStorePath('config-switches-refused-');
  try {
    for (const [config, message] of cases) {
      await assert.rejects(createWith(storePath, config), (error: Error) => {
        assert.equal(error.message, message);
        return true;
      });
      assert.equal(existsSync(storePath), false, `the refused config opened no store: ${message}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const doesnt = 'and false or leaving it out doesn\'t';
const SUBCONSCIOUS_ENABLED = 'true creates the subconscious resident, a side agent that reads the residents\' timeline and delivers into their window, ' + doesnt;
const ALLOW_CHANNEL_SPEECH = 'true lets the subconscious speak in channels with speak_in_channel, and false or leaving it out refuses it';
const WATCHDOG_ENABLED = 'true arms the liveness watchdog, which ends the process when the main thread misses its heartbeat for thresholdMs, ' + doesnt;
const PERSIST = 'true writes each process event and its responses to Chronicle, ' + doesnt;
const PROMPT_CACHING = 'true or leaving it out marks requests for prompt caching, and false leaves the markers off, for transports that refuse them';
const THINKING_ENABLED = 'true asks the provider for extended thinking, ' + doesnt;
const AUTO_REWIND = 'true redacts the turn that tripped a refusal and runs again, up to maxRewinds times, ' + doesnt;
const TOOL_RESULT_GUARD = 'true turns on tool-output admission, with one guarded retry after a provider refusal, ' + doesnt;
const TOOL_WRAPPER_PROSE_GUARD = 'true keeps a response whose whole prose is a tool-call-shaped wrapper from running or entering the agent\'s history, ' + doesnt;

describe('config switches', () => {
  it('create() refuses a framework switch that is not true or false, and a settings object that is not an object', async () => {
    await assertRefused([
      [{ subconscious: { enabled: 'false', systemPrompt: 'x' } }, `subconscious.enabled must be true or false, unquoted, not a string: ${SUBCONSCIOUS_ENABLED}`],
      [{ subconscious: { enabled: true, systemPrompt: 'x', allowChannelSpeech: 'false' } }, `subconscious.allowChannelSpeech must be true or false, unquoted, not a string: ${ALLOW_CHANNEL_SPEECH}`],
      [{ subconscious: true }, 'subconscious must be an object, such as { enabled: true }, not a boolean'],
      [{ watchdog: { enabled: 1 } }, `watchdog.enabled must be true or false, not a number: ${WATCHDOG_ENABLED}`],
      [{ watchdog: 'on' }, 'watchdog must be an object, such as { enabled: true }, not a string'],
      [{ processLogging: { persist: 'sk-secret-token' } }, `processLogging.persist must be true or false, unquoted, not a string: ${PERSIST}`],
      [{ processLogging: [] }, 'processLogging must be an object, such as { persist: true }, not an array'],
    ]);
  });

  it('create() refuses an agent switch that is not true or false, and a settings object that is not an object', async () => {
    const refused = (settings: Record<string, unknown>, message: string) =>
      [{ agents: [agentWith(settings)] }, `Agent "agent" ${message}`] as const;
    await assertRefused([
      refused({ promptCaching: 'false' }, `promptCaching must be true or false, unquoted, not a string: ${PROMPT_CACHING}`),
      refused({ thinking: { enabled: 'false' } }, `thinking.enabled must be true or false, unquoted, not a string: ${THINKING_ENABLED}`),
      refused({ thinking: true }, 'thinking must be an object, such as { enabled: true }, not a boolean'),
      refused({ refusalHandling: { autoRewind: 'false' } }, `refusalHandling.autoRewind must be true or false, unquoted, not a string: ${AUTO_REWIND}`),
      refused({ refusalHandling: 'on' }, 'refusalHandling must be an object, such as { autoRewind: true }, not a string'),
      refused({ toolResultGuard: 0 }, `toolResultGuard must be true or false, not a number: ${TOOL_RESULT_GUARD}`),
      refused({ toolWrapperProseGuard: { on: true } }, `toolWrapperProseGuard must be true or false, not an object: ${TOOL_WRAPPER_PROSE_GUARD}`),
    ]);
  });

  it('createEphemeralAgent refuses an agent switch that is not true or false, and leaves the name free', async () => {
    const { tempDir, storePath } = tempStorePath('config-switches-ephemeral-');
    let framework: AgentFramework | undefined;
    try {
      framework = await createWith(storePath, {});
      const worker = { name: 'worker', model: 'test-model', systemPrompt: 'Do the task.' };
      await assert.rejects(framework.createEphemeralAgent({ ...worker, toolWrapperProseGuard: 'false' } as never), (error: Error) => {
        assert.equal(error.message, `Agent "worker" toolWrapperProseGuard must be true or false, unquoted, not a string: ${TOOL_WRAPPER_PROSE_GUARD}`);
        return true;
      });
      const created = await framework.createEphemeralAgent(worker);
      created.cleanup();
    } finally {
      await framework?.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a null switch counts as left out, and a subconscious that is off has allowChannelSpeech left unchecked', async () => {
    for (const enabled of [null, false]) {
      const { tempDir, storePath } = tempStorePath('config-switches-unset-');
      let framework: AgentFramework | undefined;
      try {
        framework = await createWith(storePath, {
          subconscious: { enabled, systemPrompt: 'x', allowChannelSpeech: 'yes' },
          watchdog: { enabled: null },
          processLogging: { persist: null },
          agents: [agentWith({
            promptCaching: null,
            thinking: { enabled: null },
            refusalHandling: { autoRewind: null },
            toolResultGuard: null,
            toolWrapperProseGuard: null,
          })],
        });
        assert.equal(framework.getAgent('Subconscious'), null, 'no subconscious resident');
        assert.equal(framework.isProcessLoggingEnabled().persist, false);
        const agent = framework.getAgent('agent');
        assert.ok(agent);
        assert.equal(agent.promptCaching, true, 'promptCaching left out is on');
        assert.equal(agent.toolResultGuard.enabled, false);
        assert.equal(agent.toolWrapperProseGuard, false);
      } finally {
        await framework?.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});
