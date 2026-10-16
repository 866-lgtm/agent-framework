/**
 * A name for a new branch: `base` when `taken(base)` is false, else the first
 * of `base-2`, `base-3`, … that isn't taken.
 *
 * Default operator branch names carry the time in milliseconds
 * (`suppress/<agent>/<ts>`, `rollback/<agent>/<ts>`, …), so two changes of
 * one kind in the same millisecond would otherwise share a name, and the
 * second would fail creating its branch. Callers pass what counts as taken,
 * at least every branch the store holds, which makes the name hold across
 * processes and restarts as a per-process counter wouldn't.
 */
export function firstFreeBranchName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken(name)) return name;
  }
}
