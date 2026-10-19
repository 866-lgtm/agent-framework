export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost?: { total: number; currency: string };
}

export interface AgentUsage {
  agentName: string;
  usage: SessionUsage;
  inferenceCount: number;
  /** Set on the one entry that holds every ephemeral agent's usage together
   *  (agentName EPHEMERAL_USAGE_NAME), apart from any agent of that name. Each
   *  ephemeral agent runs under a new name, so an entry per name would grow
   *  the record by one for every run, for good. */
  ephemeral?: true;
}

export interface SessionUsageSnapshot {
  totals: SessionUsage;
  byAgent: AgentUsage[];
  inferenceCount: number;
}

/** Trace event emitted by UsageTracker after each inference completion. */
export interface UsageUpdatedEvent {
  type: 'usage:updated';
  totals: SessionUsage;
  agentName: string;
  inferenceCount: number;
}
