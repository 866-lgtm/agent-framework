/**
 * The default error policy decides the framework's turn retries on membrane's
 * own schedules (@animalabs/membrane/retry), and the framework's turns pass
 * `retry: false` to membrane, so the framework is the one retry layer.
 */
import { describe, it, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import { MEMBRANE_RETRY_SETTINGS, type RetrySettings } from '@animalabs/membrane/retry';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, DefaultErrorPolicy } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const err = (info: { type: string; retryable: boolean; httpStatus?: number; retryAfterMs?: number; message?: string }) =>
  new MembraneError({ message: info.message ?? `zz ${info.type}`, rawError: undefined, ...info } as ConstructorParameters<typeof MembraneError>[0]);

/** The retries a policy grants a failure, attempt by attempt, until it stops. */
function delays(policy: DefaultErrorPolicy, error: Error): number[] {
  const out: number[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const action = policy.onInferenceError(error, 'resident', attempt);
    if (!action.retry) return out;
    out.push(action.delayMs);
  }
  throw new Error('the policy never stopped retrying');
}

describe('DefaultErrorPolicy on membrane\'s schedules', () => {
  const policy = new DefaultErrorPolicy();

  it('ends a failure the provider says may not be retried at once', () => {
    assert.deepEqual(delays(policy, err({ type: 'invalid_request', retryable: false, httpStatus: 400 })), []);
    assert.deepEqual(delays(policy, err({ type: 'auth', retryable: false, httpStatus: 401 })), []);
  });

  it('retries any other retryable failure on the base schedule: three tries, 1 s then 2 s', () => {
    assert.deepEqual(delays(policy, err({ type: 'server', retryable: true, httpStatus: 502 })), [1000, 2000]);
  });

  it('retries a stream deadline as a retryable failure, as before membrane 0.7, where membrane gives it none', () => {
    assert.deepEqual(delays(policy, err({ type: 'timeout', retryable: true, message: 'SSE stream idle timeout' })), [1000, 2000]);
  });

  it('retries a rate limit with no stated wait at least five tries', () => {
    assert.deepEqual(delays(policy, err({ type: 'rate_limit', retryable: true, httpStatus: 429 })), [1000, 2000, 4000, 8000]);
  });

  it('waits a stated wait longer than the backoff, and ends past its ceiling', () => {
    const stated = err({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 20_000 });
    assert.deepEqual(policy.onInferenceError(stated, 'resident', 0), { retry: true, delayMs: 20_000 });
    const past = err({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 120_000 });
    assert.deepEqual(policy.onInferenceError(past, 'resident', 0), { retry: false });
  });

  it('gives a 529 the overloaded schedule: seven tries, jittered waits from 10 s doubling to 5 min', () => {
    const overloaded = err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' });
    const waits = delays(policy, overloaded);
    assert.equal(waits.length, 6, 'six retries after the first send');
    const steps = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
    waits.forEach((w, i) => assert.ok(w >= Math.floor(steps[i] / 2) && w < steps[i], `retry ${i + 1} waits ${w} ms, in [${steps[i] / 2}, ${steps[i]})`));
    // An overloaded error mid-stream carries no status, only its message.
    assert.equal(delays(policy, err({ type: 'server', retryable: true, message: 'overloaded_error: Overloaded' })).length, 6);
  });

  it('takes the settings it is given, as a host would pass a recipe\'s', () => {
    const { overloaded: _off, ...noOverloaded } = MEMBRANE_RETRY_SETTINGS as RetrySettings;
    const custom = new DefaultErrorPolicy(noOverloaded);
    // With no overloaded schedule a 529 is retried as any retryable failure.
    assert.deepEqual(delays(custom, err({ type: 'server', retryable: true, httpStatus: 529 })), [1000, 2000]);
    assert.equal(custom.maxRetries, 4, 'its largest class allows four retries (rate_limited)');
    assert.equal(policy.maxRetries, 6, 'the defaults allow six (overloaded)');
  });

  it('retries an error that is not a MembraneError as before: three times, 1, 2 then 4 s', () => {
    assert.deepEqual(delays(policy, new Error('zz local failure')), [1000, 2000, 4000]);
  });
});

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

/** Records the options each streamYielding call is given. */
class OptionsMembrane extends MockMembrane {
  readonly streamOptions: unknown[] = [];
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.streamOptions.push(options);
    return super.streamYielding(request, options);
  }
}

test('a turn asks membrane for no retries of its own: the framework is the one retry layer', async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const membrane = new OptionsMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-reply' }]));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  t.after(() => fw.stop().catch(() => {}));
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([fw.runUntilIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the turn never went idle')), 15_000); })]).finally(() => clearTimeout(timer));
  assert.ok(membrane.streamOptions.length >= 1, 'the turn streamed');
  for (const options of membrane.streamOptions) {
    assert.equal((options as { retry?: unknown }).retry, false);
  }
});
