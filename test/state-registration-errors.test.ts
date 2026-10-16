/**
 * Registering a state treats "already exists" as done, since a store reopened
 * after a restart already holds the state. Every other failure, such as a
 * closed store or an I/O error, reaches the caller of the call that
 * registered it, rather than surfacing at a later write with another call's
 * name in its error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import type {
  FrameworkConfig,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { ensureStateRegistered } from '../src/module-registry.js';
import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** assert.throws and assert.rejects test a RegExp against the error's toString(). */
function injected(id: string): RegExp {
  return new RegExp(`^Error: injected EIO registering ${id.replace(/[/.]/g, '\\$&')}$`);
}

/** A real store whose registerState fails for one id, as an I/O error would. */
function failingOn(store: JsStore, failId: string): JsStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'registerState') {
        return (registration: Parameters<JsStore['registerState']>[0]) => {
          if (registration.id === failId) {
            throw Object.assign(new Error(`injected EIO registering ${registration.id}`), { code: 'EIO' });
          }
          target.registerState(registration);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function withStore(prefix: string, body: (store: JsStore, dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try {
      await body(store, dir);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function probeModule(name: string, onStart?: (ctx: ModuleContext) => void): Module {
  return {
    name,
    async start(ctx: ModuleContext) { onStart?.(ctx); },
    async stop() {},
    getTools(): ToolDefinition[] { return []; },
    async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; },
    async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; },
  };
}

describe('ensureStateRegistered', () => {
  it('treats a state that already exists as registered', withStore('state-reg-exists-', (store) => {
    ensureStateRegistered(store, { id: 'probe/state', strategy: 'snapshot' });
    ensureStateRegistered(store, { id: 'probe/state', strategy: 'snapshot' });
    store.setStateJson('probe/state', { ok: true });
    assert.deepEqual(store.getStateJson('probe/state'), { ok: true });
  }));

  it('throws every other failure', withStore('state-reg-other-', (store) => {
    assert.throws(
      () => ensureStateRegistered(failingOn(store, 'probe/state'), { id: 'probe/state', strategy: 'snapshot' }),
      injected('probe/state'),
    );
  }));
});

describe('AgentFramework.create() lets a failed registration through', () => {
  const trunk = { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' };
  const cases: Array<{ id: string; config?: Partial<FrameworkConfig> }> = [
    { id: 'framework/state' },
    { id: 'framework/deferred-writes' },
    { id: 'mcpl/coalescing' },
    { id: 'mcpl/coalescing-recent' },
    { id: 'framework/inference-log' },
    { id: 'framework/turn-checkpoints/tree' },
    { id: 'framework/process-log', config: { processLogging: { persist: true } } },
    { id: 'framework/conversation-router', config: { agents: [trunk], conversations: { templateAgent: 'trunk' } } },
    { id: 'modules/probe/state', config: { modules: [probeModule('probe')] } },
    { id: 'modules/probe/events', config: { modules: [probeModule('probe', (ctx) => ctx.registerLogState('events'))] } },
  ];
  for (const { id, config } of cases) {
    it(`fails when ${id} can't be registered`, withStore('state-reg-create-', async (store) => {
      let framework: AgentFramework | undefined;
      try {
        await assert.rejects(
          async () => {
            framework = await AgentFramework.create({
              store: failingOn(store, id),
              membrane: new MockMembrane().asMembrane(),
              agents: [],
              modules: [],
              syncIntervalMs: 0,
              ...config,
            });
          },
          injected(id),
        );
      } finally {
        await framework?.stop();
      }
    }));
  }
});

describe('MCPL state lets a failed registration through', () => {
  it('a checkpoint manager', withStore('state-reg-checkpoints-', (store) => {
    assert.throws(() => new CheckpointManager(failingOn(store, 'mcpl/checkpoints'), () => {}), injected('mcpl/checkpoints'));
  }));

  it("a feature set's host state", withStore('state-reg-hoststate-', (store) => {
    const manager = new CheckpointManager(failingOn(store, 'mcpl/state/srv/fs'), () => {});
    assert.throws(
      () => manager.registerFeatureSet('srv', 'fs', { hostState: true, rollback: false }),
      injected('mcpl/state/srv/fs'),
    );
  }));

  const channelRegistry = (store: JsStore) => new ChannelRegistry(
    { getServer: (_id: string) => null } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { store },
  );

  for (const id of ['mcpl/channel-lifecycle', 'mcpl/channel-label-history']) {
    it(`a channel registry's ${id}`, withStore('state-reg-channels-', (store) => {
      assert.throws(() => channelRegistry(failingOn(store, id)), injected(id));
    }));
  }

  it("the tune-out coordinator's state, read and written", withStore('state-reg-coordinator-', (store) => {
    const registry = channelRegistry(failingOn(store, 'tune-out/probe'));
    assert.throws(() => registry.readCoordinatorState('tune-out/probe'), injected('tune-out/probe'));
    assert.throws(() => registry.writeCoordinatorState('tune-out/probe', { a: 'b' }), injected('tune-out/probe'));
  }));
});

describe("the workspace's mount state lets a failed registration through", () => {
  for (const id of ['workspace/files/tree', 'workspace/files/intent']) {
    it(id, withStore('state-reg-workspace-', (store, dir) => {
      const workspace = new WorkspaceModule({
        mounts: [{ name: 'files', path: join(dir, 'files'), mode: 'read-write', watch: 'never' }],
      });
      assert.throws(() => workspace.initStore(failingOn(store, id)), injected(id));
    }));
  }
});

it('every state the framework registers goes through ensureStateRegistered', () => {
  // A registration written as its own try/catch is how the catch-alls this
  // file tests came about, beside a helper that already did it right. The one
  // registerState call in src is the helper's own.
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const calls: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
        if (/\.registerState\(/.test(code)) calls.push(`${full.slice(src.length)}:${i + 1}`);
      });
    }
  };
  walk(src);
  assert.equal(calls.length, 1, `registerState calls outside ensureStateRegistered: ${calls.join(', ')}`);
  assert.match(calls[0], /^module-registry\.ts:/);
});
