import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  StrategyContext,
  TokenBudget,
} from '@animalabs/context-manager';
import type {
  Module,
  ModuleContext,
  EventResponse,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

class QueuedStrategy implements ContextStrategy {
  readonly name = 'queued-test';
  ticks = 0;
  toolCounts: number[] = [];
  thinkDescriptions: string[] = [];

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 2, description: 'test maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    this.toolCounts.push(ctx.tools?.length ?? 0);
    const think = ctx.tools?.find((tool) => tool.name === 'think');
    if (think) this.thinkDescriptions.push(think.description);
    this.ticks++;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class ProviderBoundMaintenanceStrategy implements ContextStrategy {
  readonly name = 'provider-bound-maintenance-test';
  ticks = 0;

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 1, description: 'provider-bound maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    await ctx.membrane?.complete({
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'maintenance request' }],
      }],
      tools: ctx.tools,
    } as unknown as NormalizedRequest);
    this.ticks++;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class FailingStrategy implements ContextStrategy {
  readonly name = 'failing-maintenance-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression blocked' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    throw new Error('provider rejected maintenance request');
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose initialization always fails. */
class RefusingInitStrategy implements ContextStrategy {
  readonly name = 'refusing-init-test';

  async initialize(_ctx: StrategyContext): Promise<void> {
    throw new Error('strategy initialization failed for the test');
  }

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'not expected' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy that refuses on its own, as the autobiographical one does for a branch it hasn't reloaded. */
class StaleStrategy implements ContextStrategy {
  readonly name = 'stale-test';

  checkReadiness(): ReadinessState {
    throw new Error('StaleStrategy.checkReadiness requires reinitialization for the current branch generation');
  }

  getProgressSnapshot(): Record<string, unknown> {
    throw new Error('StaleStrategy.getProgressSnapshot requires reinitialization for the current branch generation');
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy with work pending that no tick finishes. */
class NeverReadyStrategy implements ContextStrategy {
  readonly name = 'never-ready-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'never ready' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose tick fences its own manager with a failed initialization. */
class FencingTickStrategy implements ContextStrategy {
  readonly name = 'fencing-tick-test';
  manager?: { setStrategy(strategy: ContextStrategy): Promise<void> };

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'fencing tick queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    await this.manager?.setStrategy(new RefusingInitStrategy()).catch(() => undefined);
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class ToolModule implements Module {
  readonly name = 'maintenance-tools';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'inspect',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'not expected', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

const membrane = {
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    throw new Error('not expected');
  },
} as unknown as import('@animalabs/membrane').Membrane;

class CapturingMembrane {
  calls: NormalizedRequest[] = [];

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    return {
      content: [],
      stopReason: 'end_turn',
      rawAssistantText: '',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      details: { raw: {} },
    } as unknown as NormalizedResponse;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for maintenance');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('queued context maintenance timer', () => {
  it('drains without a new message and refreshes tools before ticking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
        allowedTools: 'all',
      }],
      modules: [new ToolModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });

    try {
      framework.start();
      await waitFor(() => strategy.ticks >= 2);
      // Module tool + synthesized agent_settings are both supplied to
      // maintenance/compression requests.
      assert.deepEqual(strategy.toolCounts, [2, 2]);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length === 1);
      const snapshot = framework.getContextMaintenanceSnapshot();
      assert.equal(snapshot.current, null);
      assert.equal(snapshot.history[0].agents[0].ticks, 2);
      assert.equal(snapshot.history[0].agents[0].readyAfter, true);
      assert.deepEqual(snapshot.agents, [{ agentName: 'agent', ready: true }]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be disabled explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-disabled-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    try {
      framework.start();
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(strategy.ticks, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a policy-correct dynamic think definition into the provider-bound maintenance request', async () => {
    const cases: Array<{
      label: string;
      sameRoundThinkTextPolicy?: 'public' | 'private';
      expected: RegExp;
    }> = [
      {
        label: 'private',
        sameRoundThinkTextPolicy: 'private',
        expected: /withheld from channel routing/,
      },
      {
        label: 'compatibility-public',
        expected: /may still be routed publicly as your speech/,
      },
    ];

    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), `af-maintenance-think-${testCase.label}-`));
      const strategy = new ProviderBoundMaintenanceStrategy();
      const capture = new CapturingMembrane();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: capture.asMembrane(),
        agents: [{
          name: 'agent',
          model: 'test-model',
          systemPrompt: 'test',
          strategy,
          ...(testCase.sameRoundThinkTextPolicy !== undefined
            ? { sameRoundThinkTextPolicy: testCase.sameRoundThinkTextPolicy }
            : {}),
          allowedTools: 'all',
        }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      (framework as unknown as {
        channelRegistry: { getChannelTools: () => ToolDefinition[]; stopAll: () => void };
      }).channelRegistry = {
        getChannelTools: () => [
          {
            name: 'think',
            description: 'static channel think',
            inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: [] },
          },
        ],
        stopAll: () => {},
      };

      try {
        framework.start();
        await waitFor(() => capture.calls.length === 1);
        const think = capture.calls[0].tools?.find((tool) => tool.name === 'think');
        assert.ok(think, 'think tool should be present on the maintenance request');
        assert.match(think.description, testCase.expected);
        assert.notEqual(think.description, 'static channel think');
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('routes a maintenance failure through the ops-alert pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-alert-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy: new FailingStrategy(),
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{
      kind: string;
      agentName: string;
      message: string;
      data?: Record<string, unknown>;
    }> = [];
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, message, data: opts?.data });

    try {
      framework.start();
      await waitFor(() => alerts.length > 0);
      assert.deepEqual(alerts[0], {
        kind: 'context-maintenance-failed',
        agentName: 'agent',
        message: 'provider rejected maintenance request',
        data: {
          scope: 'agent',
          pending: 'compression blocked',
        },
      });
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length > 0);
      assert.equal(
        framework.getContextMaintenanceSnapshot().history[0].agents[0].error,
        'provider rejected maintenance request',
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an agent whose readiness can\'t be read fails alone: its run records the error and it gets its own alert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-refused-'));
    const healthy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'fenced', model: 'test-model', systemPrompt: 'test', strategy: new QueuedStrategy() },
        { name: 'healthy', model: 'test-model', systemPrompt: 'test', strategy: healthy },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

    // A failed strategy initialization fences the context manager: its state
    // queries throw until a successful switchBranch or setStrategy.
    const fenced = framework.getAgent('fenced')!.getContextManager();
    await assert.rejects(fenced.setStrategy(new RefusingInitStrategy()), /strategy initialization failed for the test/);
    assert.throws(() => fenced.isReady(), /requires successful strategy initialization/);

    try {
      framework.start();
      await waitFor(() => healthy.ticks >= 2);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some(
        (run) => run.agents.some((agent) => agent.agentName === 'healthy' && agent.readyAfter === true),
      ));
      const snapshot = framework.getContextMaintenanceSnapshot();
      const run = snapshot.history.find((r) => r.agents.some((agent) => agent.agentName === 'healthy'))!;
      const fencedRun = run.agents.find((agent) => agent.agentName === 'fenced');
      assert.equal(fencedRun?.ticks, 0);
      assert.match(fencedRun?.error ?? '', /requires successful strategy initialization/);
      const entry = snapshot.agents.find((agent) => agent.agentName === 'fenced');
      assert.equal(entry?.ready, false);
      assert.match(entry?.error ?? '', /requires successful strategy initialization/);
      assert.ok(alerts.some((alert) => alert.agentName === 'fenced' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
      assert.equal(alerts.some((alert) => alert.agentName === 'healthy'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure that begins during the pass is that agent\'s error and alert, not the pass\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-refused-after-'));
    const strategy = new FencingTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    strategy.manager = framework.getAgent('agent')!.getContextManager();
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
      assert.equal(run.agentName, 'agent');
      assert.equal(run.ticks, 1);
      assert.match(run.error ?? '', /requires successful strategy initialization/);
      assert.equal(run.readyAfter, undefined);
      assert.ok(alerts.some((alert) => alert.agentName === 'agent' && alert.kind === 'context-maintenance-failed' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a strategy that can\'t report its readiness or its progress fails that agent alone, and the snapshot still answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-stale-'));
    const healthy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'stale', model: 'test-model', systemPrompt: 'test', strategy: new StaleStrategy() },
        { name: 'healthy', model: 'test-model', systemPrompt: 'test', strategy: healthy },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

    try {
      framework.start();
      await waitFor(() => healthy.ticks >= 2);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some(
        (run) => run.agents.some((agent) => agent.agentName === 'healthy' && agent.readyAfter === true),
      ));
      const snapshot = framework.getContextMaintenanceSnapshot();
      const entry = snapshot.agents.find((agent) => agent.agentName === 'stale');
      assert.equal(entry?.ready, false);
      assert.match(entry?.error ?? '', /requires reinitialization for the current branch generation/);
      assert.equal(entry?.progress, undefined);
      assert.ok(alerts.some((alert) => alert.agentName === 'stale' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no pass starts while a surgery holds the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-hold-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const internals = framework as unknown as { surgeryHold: { verb: string; agentName: string; since: number } | null };
    internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
    try {
      framework.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(strategy.ticks, 0);
      assert.equal(framework.getContextMaintenanceSnapshot().history.length, 0);
      internals.surgeryHold = null;
      await waitFor(() => strategy.ticks >= 2);
    } finally {
      internals.surgeryHold = null;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pass that ends before its agent is ready records what is still pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pending-after-'));
    const strategy = new NeverReadyStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history.at(-1)!.agents[0];
      assert.equal(run.ticks, 8);
      assert.equal(run.readyAfter, false);
      assert.equal(run.pendingBefore, 'never ready');
      assert.equal(run.pendingAfter, 'never ready');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
