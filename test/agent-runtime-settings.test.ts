import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';

import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager';
import { AgentFramework, BudgetPreflightError } from '../src/index.js';

const membrane = {} as any;

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

describe('agent runtime settings', () => {
it('agent_settings is one typed tool for the hot runtime surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    const tool = framework.getAllTools().find((candidate) => candidate.name === 'agent_settings');
    assert.ok(tool, 'general-purpose settings tool is exposed');
    assert.deepEqual(
      (tool!.inputSchema as { properties: Record<string, unknown> }).properties.same_round_think_text_policy,
      {
        type: 'string',
        enum: ['public', 'private'],
        description:
          'Routing policy for ordinary text emitted in the same native assistant round as think(). ' +
          "Omitted in the recipe preserves the compatibility carry-forward: public.",
      },
    );
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      effectiveContextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 60_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
      }),
      {
        contextBudgetTokens: 60_000,
        effectiveContextBudgetTokens: 100_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'converging',
      },
    );
    assert.equal(
      framework.cancelAgentRuntimeSettingsTransition('agent').transition,
      'stable',
    );
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      effectiveContextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('runtime overrides persist across framework restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-persist-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
      sameRoundThinkTextPolicy: 'public' as const,
    }],
    modules: [],
  });

  let framework = await AgentFramework.create(config());
  framework.updateAgentRuntimeSettings('agent', {
    contextBudgetTokens: 70_000,
    tailTokens: 18_000,
    transitionPaceTokens: 5_000,
    sameRoundThinkTextPolicy: 'private',
  });
  await framework.stop();

  try {
    framework = await AgentFramework.create(config());
    // The descent was still running at the stop, so it resumes paced from the
    // recipe's budget.
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 70_000,
      effectiveContextBudgetTokens: 100_000,
      tailTokens: 18_000,
      transitionPaceTokens: 5_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'runtime_override',
      transition: 'converging',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// context-manager #162: a lower budget the agent had reached comes back reached.
describe('a reached budget across a restart', () => {
  type Record = { [key: string]: unknown };
  const persisted = (framework: AgentFramework) =>
    (framework.getStore().getStateJson('framework/state') as { agentRuntimeSettings?: { [name: string]: Record } } | null)
      ?.agentRuntimeSettings?.agent;
  const writeRecord = (framework: AgentFramework, record: Record) => {
    const store = framework.getStore();
    const state = (store.getStateJson('framework/state') ?? {}) as { agentRuntimeSettings?: { [name: string]: Record } };
    store.setStateJson('framework/state', { ...state, agentRuntimeSettings: { ...state.agentRuntimeSettings, agent: record } });
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-settings-reached-'));
    const config = () => ({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent', model: 'test-model', systemPrompt: 'test',
        strategy: strategy(), contextBudgetTokens: 100_000, maxTokens: 10_000,
      }],
      modules: [],
    });
    return { dir, config };
  };
  const budgets = (framework: AgentFramework) => {
    const s = framework.getAgentRuntimeSettings('agent');
    return { target: s.contextBudgetTokens, effective: s.effectiveContextBudgetTokens, transition: s.transition };
  };
  const compile = (framework: AgentFramework) => framework.getAgent('agent')!.compileContext();
  /** Run `fn` with ContextManager.prototype[method] replaced. */
  async function withPatched<T>(method: string, impl: unknown, fn: () => Promise<T>): Promise<T> {
    const proto = ContextManager.prototype as unknown as { [key: string]: unknown };
    const original = proto[method];
    proto[method] = impl;
    try { return await fn(); } finally { proto[method] = original; }
  }
  const quietErrors = () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = original; } };
  };
  /** Each test's framework, stopped and removed afterwards. */
  async function run(fn: (h: { config: ReturnType<typeof setup>['config']; framework: () => AgentFramework; restart: () => Promise<AgentFramework> }) => Promise<void>) {
    const { dir, config } = setup();
    let framework = await AgentFramework.create(config());
    try {
      await fn({
        config,
        framework: () => framework,
        restart: async () => { await framework.stop(); framework = await AgentFramework.create(config()); return framework; },
      });
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a descent that settled comes back settled, and the first compile plans at it', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 100_000, transition: 'converging' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 }, 'not reached yet');
      // The store is empty, so the first compile's frontier fits and the descent settles.
      await compile(framework());
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the settle is recorded');
      const restarted = await restart();
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 60_000, transition: 'stable' });
      // The record's proof stands until a compile here says otherwise, so a
      // persisting call before any compile keeps it.
      restarted.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.equal(persisted(restarted)?.contextBudgetReachedTokens, 60_000);
      const planned: number[] = [];
      const cm = restarted.getAgent('agent')!.getContextManager() as unknown as { compile: (budget?: { maxTokens: number }) => Promise<unknown> };
      const original = cm.compile.bind(cm);
      cm.compile = (budget, ...rest) => { planned.push(budget?.maxTokens ?? -1); return (original as (...a: unknown[]) => Promise<unknown>)(budget, ...rest); };
      await compile(restarted);
      assert.deepEqual(planned, [60_000], 'the first compile after the restart plans at the reached budget');
    });
  });

  it('a restored descent that settles after the restart is recorded then', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const restarted = await restart();
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'converging' });
      await compile(restarted);
      assert.deepEqual(persisted(restarted), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('an immediate decrease is recorded once a compile fits at it, not before', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 }, 'nothing has compiled at it yet');
      await compile(framework());
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 60_000, transition: 'stable' });
    });
  });

  it('an immediate decrease that never compiled comes back paced', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('a compile refused at the reached budget withdraws the record, and the restart paces', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      await withPatched('compile', async () => { throw refusal; }, async () => {
        await assert.rejects(() => compile(framework()), /over budget/);
      });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('a reached budget the preflight says no longer fits restores paced, with a line saying why', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      const log = quietErrors();
      try {
        // A restart with a new maxTokens or strategy configuration raised the folded floor.
        const restarted = await withPatched('previewContext', (budget: { maxTokens: number }) => ({
          finalTokens: 70_000, budgetTokens: budget.maxTokens, fits: 70_000 <= budget.maxTokens,
        }), restart);
        assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'converging' });
      } finally {
        log.restore();
      }
      assert.ok(log.lines.some((line) => line.includes('folded floor renders 70000 tokens against it now')), log.lines.join('\n'));
    });
  });

  it('a record without the field, or with one for another budget, restores paced', async () => {
    await run(async ({ framework, restart }) => {
      // An earlier release's record; then one an older release carried
      // forward beside a budget it changed.
      writeRecord(framework(), { contextBudgetTokens: 60_000 });
      assert.equal(budgets(await restart()).transition, 'converging');
      writeRecord(framework(), { contextBudgetTokens: 70_000, contextBudgetReachedTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 70_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('an invalid field is ignored with a bounded line, and a record holding only it still boots', async () => {
    await run(async ({ framework, restart }) => {
      writeRecord(framework(), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 'yes'.repeat(100) });
      const log = quietErrors();
      try {
        assert.equal(budgets(await restart()).transition, 'converging');
        writeRecord(framework(), { contextBudgetReachedTokens: -5 });
        assert.deepEqual(budgets(await restart()), { target: 100_000, effective: 100_000, transition: 'stable' }, 'the recipe budget');
      } finally {
        log.restore();
      }
      const line = log.lines.find((l) => l.includes('ignoring an invalid persisted contextBudgetReachedTokens'));
      assert.ok(line && line.length < 200, log.lines.join('\n'));
    });
  });

  it('a patch cannot set the field', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 } as never);
      assert.deepEqual(framework().getAgent('agent')!.getRuntimeSettingsOverrides(), { contextBudgetTokens: 60_000 });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
    });
  });

  it('every persisting call keeps the field true to the live state', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      f.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, tailTokens: 20_000, contextBudgetReachedTokens: 60_000 }, 'another setting keeps it');
      f.cancelAgentRuntimeSettingsTransition('agent');
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000, 'a cancel with no descent keeps it');
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 50_000, tailTokens: 20_000 }, 'a new descent has reached nothing');
      f.cancelAgentRuntimeSettingsTransition('agent');
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, tailTokens: 20_000, contextBudgetReachedTokens: 60_000 }, 'cancelled back to the reached budget');
      f.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']);
      assert.deepEqual(persisted(f), { tailTokens: 20_000 }, 'reset to the recipe');
    });
  });

  it('a settle marks only the persisted budget it reached', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }, { persist: false });
      await compile(framework());
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 80_000 }, "the record's 80k was never compiled at");
    });
  });

  it('a descent applied without persisting settles without writing anything', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }, { persist: false });
      const log = quietErrors();
      try {
        await compile(framework());
      } finally {
        log.restore();
      }
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [], 'no record is no error');
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.equal(persisted(framework()), undefined, 'nothing written for an ephemeral descent');
      assert.deepEqual(budgets(await restart()), { target: 100_000, effective: 100_000, transition: 'stable' }, 'the recipe budget');
    });
  });

  it('a failed write of the field is logged, and the compile stands', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      const store = framework().getStore() as unknown as { setStateJson: (...args: unknown[]) => void };
      const original = store.setStateJson.bind(store);
      store.setStateJson = () => { throw new Error('disk full'); };
      const log = quietErrors();
      try {
        await compile(framework());
      } finally {
        store.setStateJson = original;
        log.restore();
      }
      assert.ok(log.lines.some((l) => l.includes("couldn't record agent's compile at budget 60000")), log.lines.join('\n'));
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
      // The next compile at that budget records it, once writes work again.
      await compile(framework());
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('a budget changed while a compile runs is not proven by that compile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      // The compile was asked for at the recipe's 100k; the budget drops to
      // 60k at once while it runs.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the 100k compile proves nothing about 60k');
      await compile(f);
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('a descent ended by an immediate change to its own target is not credited to the compile that ran meanwhile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.equal(budgets(f).transition, 'converging');
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      // The compile plans at the live 100k; the same 60k is applied at once
      // while it runs, ending the descent without a settle.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'nothing settled, and the compile planned at 100k');
    });
  });
});

it('reset-all skips tail controls unsupported by the active strategy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-basic-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      effectiveContextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('same_round_think_text_policy reports recipe/runtime/default sources and rejects invalid values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-think-policy-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      sameRoundThinkTextPolicy: 'private',
    }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      effectiveContextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'recipe',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'public' }),
      {
        contextBudgetTokens: 100_000,
        effectiveContextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'public',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'stable',
      },
    );

    assert.deepEqual(
      framework.resetAgentRuntimeSettings('agent', ['sameRoundThinkTextPolicy']),
      {
        contextBudgetTokens: 100_000,
        effectiveContextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'recipe',
        transition: 'stable',
      },
    );

    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'bogus' as 'public' }),
      /sameRoundThinkTextPolicy must be 'public' or 'private'/,
    );
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails closed on an invalid persisted same_round_think_text_policy override before any provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-invalid-persisted-'));
  const storePath = join(dir, 'store');
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    store.registerState({ id: 'framework/state', strategy: 'snapshot' });
  } catch {
    // Already registered.
  }
  store.setStateJson('framework/state', {
    agentRuntimeSettings: {
      agent: {
        sameRoundThinkTextPolicy: 'bogus',
      },
    },
  });
  store.close();

  let providerCalls = 0;
  const rejectingMembrane = {
    complete: async () => {
      providerCalls++;
      throw new Error('provider should not be called');
    },
    streamYielding: () => {
      providerCalls++;
      throw new Error('provider should not be called');
    },
  } as unknown as import('@animalabs/membrane').Membrane;

  try {
    await assert.rejects(
      () => AgentFramework.create({
        storePath,
        membrane: rejectingMembrane,
        agents: [{
          name: 'agent',
          model: 'test-model',
          systemPrompt: 'test',
        }],
        modules: [],
      }),
      /Invalid persisted sameRoundThinkTextPolicy/,
    );
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});

it('immediate: a budget decrease with immediate=true applies now — no descent, no persisted flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-immediate-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    // Baseline: a plain decrease starts a paced descent.
    const gradual = framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
    assert.equal(gradual.transition, 'converging');
    assert.equal(gradual.contextBudgetTokens, 60_000, 'snapshot reports the TARGET while converging');

    // Immediate: applies now AND cancels the in-flight descent.
    const now = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 50_000,
      immediate: true,
    });
    assert.equal(now.transition, 'stable', 'no descent — the drop is live');
    assert.equal(now.contextBudgetTokens, 50_000);

    // The mode flag is never persisted as an override.
    const overrides = framework.getAgent('agent')!.getRuntimeSettingsOverrides() as Record<string, unknown>;
    assert.equal(overrides.immediate, undefined, 'immediate is a mode, not a setting');
    assert.equal(overrides.contextBudgetTokens, 50_000);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Budget preflight (issue #122; supersedes feat/budget-preflight-guard).
// The preview stub stands in for the strategy's previewContext so verdicts are
// deterministic; the mapping under test is the framework's, not the picker's.
// ---------------------------------------------------------------------------

function stubPreview(
  framework: AgentFramework,
  agentName: string,
  impl: ((budget: { maxTokens: number }) => Record<string, unknown>) | undefined,
): void {
  const cm = framework.getAgent(agentName)!.getContextManager() as unknown as {
    previewContext?: (budget: { maxTokens: number }) => unknown;
  };
  if (impl === undefined) {
    cm.previewContext = undefined;
  } else {
    cm.previewContext = (budget) => impl(budget);
  }
}

const infeasibleAt = (floor: number) => (budget: { maxTokens: number }) => ({
  finalTokens: floor,
  budgetTokens: budget.maxTokens,
  fits: floor <= budget.maxTokens,
  exhausted: floor > budget.maxTokens,
  headTokens: 10_000,
  tailTokens: 30_000,
  middleTokens: floor - 40_000,
  middleChunkCount: 7,
  deepestLevel: 3,
  resolutions: {},
  moves: 0,
  producedCount: 0,
});

async function withPreflightFramework(
  fn: (framework: AgentFramework) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-preflight-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 550_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    await fn(framework);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('preflight: an immediate infeasible budget throws typed, allowInfeasible overrides', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 260_000,
        immediate: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BudgetPreflightError);
        assert.equal(error.preview.path, 'immediate');
        assert.equal(error.preview.effective?.fits, false);
        assert.equal(error.preview.effective?.finalTokens, 450_000);
        assert.match(error.message, /450000 tokens against hard budget 260000/);
        return true;
      },
    );
    // The refused patch must not have been applied.
    assert.equal(framework.getAgentRuntimeSettings('agent').contextBudgetTokens, 550_000);

    const applied = framework.updateAgentRuntimeSettings(
      'agent',
      { contextBudgetTokens: 260_000, immediate: true },
      { allowInfeasible: true },
    );
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('preflight: a paced descent below the floor NEVER blocks — the compile budget is unchanged', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    // 260k < 550k live, no `immediate` → paced. The superseded branch guard
    // previewed 260k as the compile budget and refused this exact patch; the
    // real compile stays at 550k (feasible), so it must apply.
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
    });
    assert.equal(applied.transition, 'converging');
    assert.equal(applied.contextBudgetTokens, 260_000, 'snapshot reports the target');
  });
});

it('preflight: a feasible immediate change applies without ceremony', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(200_000));
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
      immediate: true,
    });
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('preflight: preview-unavailable applies with a warn, never blocks', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', undefined);
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
      immediate: true,
    });
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('previewAgentRuntimeSettings: structured reasons for the strategy throw paths', async () => {
  await withPreflightFramework(async (framework) => {
    const cases: Array<[string, string]> = [
      [
        'AutobiographicalStrategy.previewContext requires reinitialization for the current branch generation',
        'branch_generation_changed',
      ],
      ['previewContext is already running; previews must not overlap', 'preview_in_flight'],
      [
        'previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview',
        'no_adaptive_resolution',
      ],
      ['some novel failure', 'some novel failure'],
    ];
    for (const [message, reason] of cases) {
      stubPreview(framework, 'agent', () => { throw new Error(message); });
      const preview = framework.previewAgentRuntimeSettings('agent', {
        contextBudgetTokens: 600_000,
      });
      assert.equal(preview.available, false, message);
      assert.equal(preview.reason, reason);
    }
  });
});

it('previewAgentRuntimeSettings: paced patches report effective=live plus an advisory target', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    const preview = framework.previewAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
    });
    assert.equal(preview.path, 'paced');
    assert.equal(preview.available, true);
    assert.equal(preview.effective?.budgetTokens, 550_000, 'effective = UNCHANGED live budget');
    assert.equal(preview.effective?.fits, true);
    assert.equal(preview.advisory?.targetTokens, 260_000);
    assert.equal(preview.advisory?.fits, false);

    // No patch = the resume-gate case: verdict for current settings.
    const current = framework.previewAgentRuntimeSettings('agent');
    assert.equal(current.path, 'none');
    assert.equal(current.effective?.budgetTokens, 550_000);
  });
});

it('preflight: boot restore is never preflighted — an infeasible persisted budget cannot brick startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-preflight-boot-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 550_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    framework.updateAgentRuntimeSettings(
      'agent',
      { contextBudgetTokens: 260_000, immediate: true },
      { allowInfeasible: true },
    );
    await framework.stop();
    // Recreate WITHOUT a stub: restore goes through Agent.restoreRuntimeSettings,
    // bypassing the framework wrapper — must not throw regardless of feasibility.
    framework = await AgentFramework.create(config());
    assert.equal(framework.getAgentRuntimeSettings('agent').contextBudgetTokens, 260_000);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preflight: no-op and increasing patches never throw on an already-over-floor agent', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(600_000)); // floor above even 550k live
    // No-op rewrite of the current budget: settings-plane writeback shape.
    const rewrite = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 550_000,
      immediate: true,
    });
    assert.equal(rewrite.contextBudgetTokens, 550_000);
    // Strict improvement (increase) on a wedged agent must apply, not throw.
    const raise = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 700_000,
    });
    assert.equal(raise.contextBudgetTokens, 700_000);
    // A LOWERING that does not fit still throws.
    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 500_000,
        immediate: true,
      }),
      BudgetPreflightError,
    );
  });
});
