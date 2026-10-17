- A tune-out's `durationSeconds` or `cadenceSeconds` longer than about 24.8
  days (2^31 - 1 ms, the longest delay one Node timer holds) now holds.
  Before, Node fired the timer almost at once, so such a tune-out ended as
  "duration elapsed" moments after it began, waking the resident with its
  backlog, and such a cadence re-armed about every millisecond, giving the
  subconscious a turn as soon as anything was diverted, after every restart
  too. Both timers now re-arm in steps no longer than one timer, each step
  reading the clock against its deadline; the end time's deadline is the
  stored one, so a host that runs through it and one that restarts end the
  tune-out at the same time.
- `tune_out` refuses a `durationSeconds`, `cadenceSeconds`, `backlogCap` or
  `maxWakes` that gives no finite number, such as `"abc"`, and a duration
  whose end time is too far off to store, naming the option and saying
  nothing was tuned out, before anything changes. Before, the store's write
  threw after the channel had been marked tuned out in memory, so the call
  failed and left the channel diverted with no cadence or end timer until
  the next restart. A numeric string such as `"3600"` is still read as its
  number.
- A `null` `durationSeconds` now means no end time, as leaving it out does.
  Before, it gave a tune-out of 60 seconds, the shortest duration.
