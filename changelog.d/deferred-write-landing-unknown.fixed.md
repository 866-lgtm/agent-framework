- A deferred context write whose write threw, and whose store then couldn't
  be read to tell whether it had landed, is no longer put back as one that
  wasn't stored. Until now a later flush stored it again, so a write that
  had landed appeared twice. It's now put back marked as unknown, and before
  it's written again the store is searched for its id: found, it counts as
  written and isn't stored again; not found, it's written; and while the
  store can't be searched, it stays queued, holding what's queued behind it
  for that agent, as a write that keeps failing does. Such an entry's mark
  is persisted with the queue, so after a restart it's still looked up
  before it's written.
  - A write found this way is carried at the flush that finds it, after
    what the turn stored since, though the store holds it before those, so
    later requests place it earlier.
  - A conversation fork's or ephemeral run's queue, stored when it's
    released, looks such an entry up the same way: found, it's neither
    stored again nor passed to the primary as a failed reply; where the
    store can't be searched, it's stored anyway, and the log says it may now
    be stored twice.
  - A module's handle to such a held write reaches its stored copy too: an
    edit or a removal applies to both, and throws with nothing changed when
    the store can't be searched, and a query shows the write once. The
    coalescer removes the stored copy only where nothing may have shown it.
