/**
 * autoContinue (AgentConfig.autoContinue, docs/auto-continue.md): a turn the
 * model ends itself is followed by another, unless it ended on a skip. This
 * module holds what doesn't need the framework: which ends continue, and the
 * notice the next turn reads.
 */

/**
 * Stop reasons of a turn the model ended itself. The others don't continue:
 * a refusal has its own handling (retries, rewind, the reaction), a
 * `max_tokens` end was cut off rather than chosen, and `no_progress` and
 * `round_limit` are the stall guard's verdict that the turn wasn't moving.
 */
/** The reason on a continuation's wake (InferenceRequest.reason). */
export const AUTO_CONTINUE_REASON = 'auto-continue';

/** What a queued continuation's notice says, held until its turn starts. */
export interface PendingAutoContinue {
  /** This continuation's place in the run, 1 to `max`. */
  count: number;
  max: number;
  /** How the agent stops (autoContinueNotice's `stop`), if it can. */
  stop: string | undefined;
}

export const AUTO_CONTINUE_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence']);

/**
 * The notice a continuation's turn reads: that the last turn ended without a
 * skip so another one starts, how to stop (`stop`, an imperative such as
 * "call skip_reply"; left out when the agent has no way to skip), and, near
 * the cap, how many continuations are left. `count` is this continuation's
 * place in the run, 1 to `max`. Short and event-shaped on purpose: it rides
 * as a system row in the window, where instruction blocks about output have
 * tripped classifiers.
 */
export function autoContinueNotice(count: number, max: number, stop: string | undefined): string {
  const opening = stop
    ? `[continue] Your last turn ended without skip_reply, so another one starts now. To stop and wait for the next event, ${stop}.`
    : '[continue] Your last turn ended on its own, so another one starts now.';
  const left = max - count;
  if (left <= 0) {
    return `${opening} This is the last continuation in a row (${count} of ${max}): after this turn you wait for the next event either way.`;
  }
  if (left === 1) return `${opening} Continuation ${count} of ${max} in a row: one more is left.`;
  return opening;
}
