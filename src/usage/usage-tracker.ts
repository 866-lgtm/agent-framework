import type { SessionUsage, SessionUsageSnapshot, UsageUpdatedEvent } from './types.js';

function snapshotUsage(usage: SessionUsage): SessionUsage {
  return {
    ...usage,
    estimatedCost: usage.estimatedCost ? { ...usage.estimatedCost } : undefined,
  };
}

function accumulateUsage(
  target: SessionUsage,
  tokens: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
  estimatedCost?: { total: number; currency: string }
): void {
  // A provider's usage can lack a count (membrane 0.5.87's Bedrock stream
  // takes a message_delta's output count as reported); adding it would make
  // the total NaN, which is stored as null.
  const count = (n: number): number => (Number.isFinite(n) ? n : 0);
  target.inputTokens += count(tokens.inputTokens);
  target.outputTokens += count(tokens.outputTokens);
  target.cacheCreationTokens += count(tokens.cacheCreationTokens);
  target.cacheReadTokens += count(tokens.cacheReadTokens);
  // The cost membrane computes from such a count is NaN: an unknown cost,
  // which is left out as an absent one is, rather than added as zero.
  if (estimatedCost && Number.isFinite(estimatedCost.total)) {
    if (!target.estimatedCost) {
      target.estimatedCost = { total: 0, currency: estimatedCost.currency };
    } else if (target.estimatedCost.currency !== estimatedCost.currency) {
      // Mixed currencies — drop cost tracking rather than produce garbage
      target.estimatedCost = undefined;
      return;
    }
    target.estimatedCost.total += estimatedCost.total;
  }
}

function parseUsage(raw: unknown): SessionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // A count stored as null is a NaN total, as JSON stores one: an earlier
  // release could write it when a provider's usage lacked a count. The sum
  // before it was lost when it became NaN, so it reads as 0.
  const count = (v: unknown): number | undefined => (v === null ? 0 : typeof v === 'number' ? v : undefined);
  // A cost is kept as a finite total with its currency. Anything else, such
  // as the null JSON stores for a NaN total, is an unknown cost, as an
  // absent one is.
  const cost = o.estimatedCost as { total?: unknown; currency?: unknown } | null | undefined;
  const estimatedCost = cost && typeof cost === 'object' && typeof cost.total === 'number'
    && Number.isFinite(cost.total) && typeof cost.currency === 'string'
    ? { total: cost.total, currency: cost.currency }
    : undefined;
  const inputTokens = count(o.inputTokens);
  const outputTokens = count(o.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: typeof o.cacheCreationTokens === 'number' ? o.cacheCreationTokens : 0,
    cacheReadTokens: typeof o.cacheReadTokens === 'number' ? o.cacheReadTokens : 0,
    estimatedCost,
  };
}

export interface PersistedUsageState {
  totals: SessionUsage;
  byAgent: Array<{ agentName: string; usage: SessionUsage; inferenceCount: number }>;
  inferenceCount: number;
}

/** What keeps a stored usage record from restoring, or undefined when it
 *  restores: it must be an object whose totals are token counts and whose
 *  byAgent, if it has one, is a list. Its per-agent entries are checked one
 *  by one as they restore, and one that isn't an agent's usage is skipped. */
export function persistedUsageProblem(value: unknown): 'not a record' | 'totals' | 'byAgent' | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a record';
  const { totals, byAgent } = value as { totals?: unknown; byAgent?: unknown };
  if (parseUsage(totals) === null) return 'totals';
  if (byAgent !== undefined && !Array.isArray(byAgent)) return 'byAgent';
  return undefined;
}

export class UsageTracker {
  private totals: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  private byAgent: Map<string, { usage: SessionUsage; inferenceCount: number }> = new Map();
  private inferenceCount = 0;
  private emitTrace: (event: UsageUpdatedEvent) => void;

  constructor(opts: {
    emitTrace: (event: UsageUpdatedEvent) => void;
    restored?: PersistedUsageState;
  }) {
    this.emitTrace = opts.emitTrace;
    if (opts.restored) {
      this.restoreFrom(opts.restored);
    }
  }

  private restoreFrom(state: PersistedUsageState): void {
    const totals = parseUsage(state.totals);
    if (!totals) return;
    this.totals = totals;
    this.inferenceCount = typeof state.inferenceCount === 'number' ? state.inferenceCount : 0;
    if (Array.isArray(state.byAgent)) {
      for (const item of state.byAgent as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as { agentName?: unknown; usage?: unknown; inferenceCount?: unknown };
        const usage = parseUsage(entry.usage);
        if (usage && typeof entry.agentName === 'string') {
          this.byAgent.set(entry.agentName, {
            usage,
            inferenceCount: typeof entry.inferenceCount === 'number' ? entry.inferenceCount : 0,
          });
        }
      }
    }
  }

  toJSON(): PersistedUsageState {
    return {
      totals: snapshotUsage(this.totals),
      byAgent: [...this.byAgent.entries()].map(([name, data]) => ({
        agentName: name,
        usage: snapshotUsage(data.usage),
        inferenceCount: data.inferenceCount,
      })),
      inferenceCount: this.inferenceCount,
    };
  }

  onInferenceCompleted(agentName: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }, estimatedCost?: { total: number; currency: string }): void {
    const tokens = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
    };

    accumulateUsage(this.totals, tokens, estimatedCost);
    this.inferenceCount++;

    let agent = this.byAgent.get(agentName);
    if (!agent) {
      agent = { usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, inferenceCount: 0 };
      this.byAgent.set(agentName, agent);
    }
    accumulateUsage(agent.usage, tokens, estimatedCost);
    agent.inferenceCount++;

    this.emitTrace({
      type: 'usage:updated',
      totals: snapshotUsage(this.totals),
      agentName,
      inferenceCount: this.inferenceCount,
    });
  }

  getSnapshot(): SessionUsageSnapshot {
    return {
      totals: snapshotUsage(this.totals),
      byAgent: [...this.byAgent.entries()].map(([name, data]) => ({
        agentName: name,
        usage: snapshotUsage(data.usage),
        inferenceCount: data.inferenceCount,
      })),
      inferenceCount: this.inferenceCount,
    };
  }
}
