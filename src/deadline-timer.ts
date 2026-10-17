/** The longest delay one setTimeout holds (2^31 - 1 ms, about 24.8 days).
 *  Node fires a longer one almost at once, with a TimeoutOverflowWarning. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Call `fire` once the clock reaches `deadlineMs` (epoch ms), through timers
 * no longer than one holds, so a deadline weeks away fires then rather than
 * at once. Each step reads the clock against the deadline and re-arms for
 * what's left, so a deadline kept in storage ends at the same time whether
 * the process runs through it or restarts and arms it again. `hold` gets each
 * step's timer: clearing the latest one stops the rest.
 */
export function armAt(
  deadlineMs: number,
  hold: (timer: ReturnType<typeof setTimeout>) => void,
  fire: () => void,
): void {
  const arm = (): void => {
    hold(setTimeout(step, Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMER_MS)));
  };
  const step = (): void => {
    if (deadlineMs - Date.now() > 0) arm();
    else fire();
  };
  arm();
}
