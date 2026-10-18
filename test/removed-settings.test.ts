/**
 * `processLogging.broadcast` and an agent's `refusalHandling.announceHumanTurns`
 * are removed, since neither had an effect. A config that still sets either
 * starts as before, with the setting ignored, and the types no longer take
 * them, so a typed config that writes one doesn't compile.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, type AgentConfig, type ProcessLoggingConfig } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

// Compiled, never run: each @ts-expect-error fails the build once its line
// compiles, as it would if the setting came back.
const typedProcessLogging: ProcessLoggingConfig = {
  persist: false,
  // @ts-expect-error processLogging.broadcast is removed
  broadcast: true,
};
const typedRefusalHandling: NonNullable<AgentConfig['refusalHandling']> = {
  autoRewind: false,
  // @ts-expect-error refusalHandling.announceHumanTurns is removed
  announceHumanTurns: true,
};

it('a config that still sets processLogging.broadcast or refusalHandling.announceHumanTurns starts, and isProcessLoggingEnabled() reports only persist', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'removed-settings-'));
  let framework: AgentFramework | undefined;
  try {
    // Untyped, as a JSON config or a host passing its own config on gives it.
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        refusalHandling: { autoRewind: false, announceHumanTurns: true },
      }],
      modules: [],
      syncIntervalMs: 0,
      processLogging: { persist: false, broadcast: true },
    } as never);
    assert.ok(framework.getAgent('agent'));
    assert.deepEqual(framework.isProcessLoggingEnabled(), { persist: false });
  } finally {
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
