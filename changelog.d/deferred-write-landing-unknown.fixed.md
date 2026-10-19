- A deferred context write whose write threw, and whose store then couldn't
  be read back to tell whether it had landed, is no longer put back as one
  that wasn't stored. Until now a later flush stored it again, so a write
  that had landed appeared twice. It's now put back marked as unknown, and
  before it's written again the store is searched for its id: found, it
  counts as written and isn't stored again; not found, it's written; and
  while the store can't be searched, it stays queued, holding what's queued
  behind it for that agent, as a write that keeps failing does. A store that
  couldn't say how many messages it held before the write is taken the same
  way. Such an entry's mark is persisted with the queue, and boot looks for
  it in its agent's whole store.
  - A write found this way is carried at the flush that finds it, after
    what the turn stored since, though the store holds it before those, so
    later requests place it earlier.
