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
  - A write found this way at a flush is carried there, after what the turn
    stored since, though the store holds it before those, so later requests
    place it earlier.
  - Wherever held writes are read or changed, by a module's context, the
    coalescer, a wake's check or a tune-out's backlog, such a write is
    looked up first. One that landed is a stored message from then on, read
    and changed as one, and isn't carried into the turn; one that didn't is
    an ordinary held write. Where the store can't be searched, a module's
    edit or removal of it throws with nothing changed, and the coalescer
    reads it as possibly read and shown.
  - A conversation fork's or ephemeral run's queue, stored when it's
    released, looks such an entry up the same way: found, it's neither
    stored again nor passed to the primary as a failed reply; where the
    store can't be searched, it's stored anyway, and the log says it may now
    be stored twice.
